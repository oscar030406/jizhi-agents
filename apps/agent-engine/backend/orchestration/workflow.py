"""多智能体协同决策编排 —— LangGraph StateGraph 内核。

2026-07-09 手术式迁移（PLAYBOOK §7 决策更新）：编排壳从自研 while 循环换成
LangGraph 状态图；7 个 Agent 类、全部 Pydantic schema、评测与公共接口零改动。
迁移动机：ai-service 运行环境本就依赖 langgraph（成本=0）、原生逐节点 streaming
（真实时事件流取代 trace 投影）、图结构可直接导出 mermaid 做调度可视化、
行业标准编排的答辩公信力。

图结构：
    START → retrieve → generate → audit ─┬─(通过)────────────→ plan_path → END
                          ↑              ├─(需修订且<2轮)→ revise ─┘(回 audit 再审)
                          │              └─(需修订且到上限)→ arbitrate → plan_path
状态为 Pydantic 模型（结构不变量：Agent 间仍只走 schema）；全图确定性、可复算。
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, ConfigDict, Field

from backend.agents.arbitration_agent import ArbitrationAgent
from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.feedback_decision_agent import FeedbackDecisionAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.learning_path_planner_agent import LearningPathPlannerAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.schemas.learner import DiagnosisResult, FeedbackInput, LearnerProfile, PretestResult
from backend.schemas.resources import (
    AgentTraceStep,
    ArbitrationDecision,
    AuditResult,
    DebateRound,
    FeedbackDecision,
    LearningPath,
    LearningResources,
    RetrievalResult,
    WorkflowRun,
)
from backend.services.claim_dispute_service import build_claim_disputes
from backend.services.data_loader import load_pretest_questions
from backend.services.feedback_adaptation import adapt_feedback
from backend.services.model_routing import route_for
from backend.services.quiz_service import estimate_pretest_from_profile

# 为什么是 2：双审核分歧 → 一轮定向重写 → 复审，第二轮仍分歧就交仲裁终审。
# 加轮次无收益有成本——《Should we be going MAD?》（ICML 2024）及后续受控实验
# 均未测得增加辩论轮次的显著增益（本文档 §2.5 对比定位同一出处）；我们的架构
# 本就不押辩论范式，收敛点在仲裁而不在回合数上。
MAX_DEBATE_ROUNDS = 2


class GraphState(BaseModel):
    """LangGraph 状态：编排期间在节点间流转的全部产物（只走 Pydantic，守结构不变量）。"""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    run_id: str
    learner_profile: LearnerProfile
    learning_goal: str
    retrieval_query: str
    generation_goal: str
    diagnosis: DiagnosisResult
    retrieval: RetrievalResult | None = None
    resources: LearningResources | None = None
    audit: AuditResult | None = None
    learning_path: LearningPath | None = None
    arbitration: ArbitrationDecision | None = None
    trace: list[AgentTraceStep] = Field(default_factory=list)
    debate: list[DebateRound] = Field(default_factory=list)
    # 辩论回合中间量：revise 节点产生，随后的 audit 节点结算成 DebateRound
    pending_objection: AuditResult | None = None
    resources_before_revision: LearningResources | None = None
    pending_action: str = ""
    pending_note: str = ""


class AgentTrainingWorkflow:
    def __init__(self, gateway=None) -> None:
        # gateway 可注入（集成时按每请求 modelConfig 构造）；None=用默认单例（读 env）。
        self.diagnosis_agent = LearnerDiagnosisAgent(gateway=gateway)
        self.retrieval_agent = KnowledgeRetrievalAgent()
        self.generation_agent = ResourceGenerationAgent(gateway=gateway)
        self.audit_agent = ContentAuditAgent(gateway=gateway)
        self.arbitration_agent = ArbitrationAgent()
        self.path_agent = LearningPathPlannerAgent()
        self.feedback_agent = FeedbackDecisionAgent(gateway=gateway)
        # 实际生效的 gateway（None 时 agent 内部落到单例），暴露给成本实测取 telemetry
        self.gateway = self.diagnosis_agent.gateway
        self._graph = self._build_graph()

    # ------------------------------------------------------------- 图定义

    def _build_graph(self):
        graph = StateGraph(GraphState)
        graph.add_node("retrieve", self._node_retrieve)
        graph.add_node("generate", self._node_generate)
        graph.add_node("audit", self._node_audit)
        graph.add_node("revise", self._node_revise)
        graph.add_node("arbitrate", self._node_arbitrate)
        graph.add_node("plan_path", self._node_plan_path)

        graph.add_edge(START, "retrieve")
        graph.add_edge("retrieve", "generate")
        graph.add_edge("generate", "audit")
        graph.add_conditional_edges(
            "audit",
            self._route_after_audit,
            {"revise": "revise", "arbitrate": "arbitrate", "plan_path": "plan_path"},
        )
        graph.add_edge("revise", "audit")
        graph.add_edge("arbitrate", "plan_path")
        graph.add_edge("plan_path", END)
        return graph.compile()

    def _route_after_audit(self, state: GraphState) -> str:
        if state.audit is not None and state.audit.revision_required:
            if len(state.debate) < MAX_DEBATE_ROUNDS:
                return "revise"
            return "arbitrate"
        return "plan_path"

    # ------------------------------------------------------------- 图节点

    def _node_retrieve(self, state: GraphState) -> dict[str, Any]:
        retrieval = self.retrieval_agent.run(state.retrieval_query, state.diagnosis)
        trace = state.trace + [
            self._trace(
                self.retrieval_agent,
                status="completed",
                input_summary=(
                    f"query={state.retrieval_query}, weak={state.diagnosis.weak_concepts}"
                ),
                output_summary=f"sources={retrieval.source_ids[:5]}",
                artifacts={"retrieval": retrieval.model_dump()},
            )
        ]
        return {"retrieval": retrieval, "trace": trace}

    def _node_generate(self, state: GraphState) -> dict[str, Any]:
        resources = self.generation_agent.run(
            state.learner_profile,
            state.generation_goal,
            state.diagnosis,
            state.retrieval,
        )
        trace = state.trace + [
            self._trace(
                self.generation_agent,
                status="completed",
                input_summary=(
                    f"goal={state.generation_goal}, "
                    f"evidence_count={len(state.retrieval.retrieved_chunks)}"
                ),
                output_summary=(
                    f"resources=lecture/practice/{len(resources.graded_quiz)} quiz items"
                ),
                artifacts={"resources": resources.model_dump()},
            )
        ]
        return {"resources": resources, "trace": trace}

    def _node_audit(self, state: GraphState) -> dict[str, Any]:
        audit = self.audit_agent.run(state.resources, state.diagnosis, state.retrieval)
        trace = list(state.trace)
        debate = list(state.debate)
        updates: dict[str, Any] = {"audit": audit}

        if state.pending_objection is None:
            trace.append(self._audit_trace(audit, state.resources, status="initial_review"))
        else:
            # 结算上一轮辩论：disputes/diff 与 resolved 依赖本次再审结果
            disputes, revision_diff = build_claim_disputes(
                state.resources_before_revision,
                state.resources,
                state.pending_objection,
                audit,
            )
            round_record = DebateRound(
                round_index=len(debate) + 1,
                auditor_flags=state.pending_objection.hallucination_risk_flags,
                auditor_factuality=state.pending_objection.factuality_score,
                auditor_challenges=state.pending_objection.challenges,
                generator_action=state.pending_action,
                generator_note=state.pending_note,
                resolved=not audit.revision_required,
                disputes=disputes,
                revision_diff=revision_diff,
            )
            debate.append(round_record)
            trace.append(
                self._trace(
                    self.generation_agent,
                    status=f"debate_round_{round_record.round_index}",
                    input_summary=f"objections={state.pending_objection.hallucination_risk_flags}",
                    output_summary=(
                        f"action={state.pending_action}, resolved={round_record.resolved}"
                    ),
                    artifacts={"debate_round": round_record.model_dump()},
                )
            )
            trace.append(
                self._audit_trace(
                    audit,
                    state.resources,
                    status=f"re_review_round_{round_record.round_index}",
                )
            )
            updates.update(
                {
                    "pending_objection": None,
                    "resources_before_revision": None,
                    "pending_action": "",
                    "pending_note": "",
                }
            )

        updates.update({"trace": trace, "debate": debate})
        return updates

    def _node_revise(self, state: GraphState) -> dict[str, Any]:
        objection = state.audit
        resources_before = state.resources.model_copy(deep=True)
        revised, action, note = self.generation_agent.revise(
            state.resources,
            objection,
            state.retrieval,
            state.diagnosis,
        )
        return {
            "resources": revised,
            "pending_objection": objection,
            "resources_before_revision": resources_before,
            "pending_action": action,
            "pending_note": note,
        }

    def _node_arbitrate(self, state: GraphState) -> dict[str, Any]:
        arbitration = self.arbitration_agent.run(state.audit, state.debate)
        trace = state.trace + [
            self._trace(
                self.arbitration_agent,
                status="completed",
                input_summary=(
                    f"rounds={len(state.debate)}, factuality={state.audit.factuality_score}"
                ),
                output_summary=arbitration.action,
                artifacts={"arbitration": arbitration.model_dump()},
            )
        ]
        return {"arbitration": arbitration, "trace": trace}

    def _node_plan_path(self, state: GraphState) -> dict[str, Any]:
        learning_path = self.path_agent.run(
            state.learner_profile,
            state.diagnosis,
            state.resources,
            state.audit,
        )
        trace = state.trace + [
            self._trace(
                self.path_agent,
                status="completed",
                input_summary=(
                    f"difficulty={state.diagnosis.recommended_difficulty}, "
                    f"audit={state.audit.factuality_score}"
                ),
                output_summary=(
                    f"stages={len(learning_path.learning_path)}, "
                    f"estimated_time={learning_path.estimated_time}"
                ),
                artifacts={"learning_path": learning_path.model_dump()},
            )
        ]
        return {"learning_path": learning_path, "trace": trace}

    # ------------------------------------------------------------- 公共接口（签名不变）

    def run(
        self,
        profile: LearnerProfile,
        learning_goal: str | None = None,
        pretest_result: PretestResult | None = None,
    ) -> WorkflowRun:
        state = self._initial_state(profile, learning_goal, pretest_result)
        final = self._invoke(state)
        run = self._to_workflow_run(final, profile)
        self._commit_state(profile, run.diagnosis, writer=self.diagnosis_agent.name,
                           because=[f"首次诊断：目标「{run.learning_goal}」"])
        return run

    def run_followup(
        self,
        profile: LearnerProfile,
        parent_run: WorkflowRun,
        feedback: FeedbackInput | dict,
    ) -> WorkflowRun:
        """根据反馈更新掌握度并执行一次完整的定向二次生成闭环。"""
        state, decision, adaptation = self._followup_state(profile, parent_run, feedback)
        final = self._invoke(state)
        run = self._to_workflow_run(
            final,
            profile,
            parent_run_id=parent_run.run_id,
            feedback_decision=decision,
            mastery_change=adaptation.mastery_change,
            generation_reason="feedback_followup",
        )
        self._commit_state(profile, run.diagnosis, writer=self.feedback_agent.name,
                           because=decision.because or [decision.explanation],
                           difficulty=decision.updated_difficulty)
        return run

    def _commit_state(self, profile, diagnosis, *, writer: str,
                      because: list[str], difficulty: str | None = None) -> None:
        """单写者状态提交（v4 §2.5）：掌握度/难度的每次变更进版本化审计日志。"""
        from backend.services.learner_state import learner_state_store

        learner_state_store.get_or_init(profile)
        learner_state_store.apply(
            profile.id, writer, "mastery_vector", dict(diagnosis.mastery_vector), because=because)
        learner_state_store.apply(
            profile.id, writer, "weak_concepts", list(diagnosis.weak_concepts), because=because)
        learner_state_store.apply(
            profile.id, writer, "current_difficulty",
            difficulty or diagnosis.recommended_difficulty, because=because)

    def stream_run(
        self,
        profile: LearnerProfile,
        learning_goal: str | None = None,
        pretest_result: PretestResult | None = None,
    ):
        """逐节点事件流（LangGraph 原生 streaming）：yield (node_name, GraphState快照)，
        最后一个事件后可用 to_workflow_run 组装最终结果。供 SSE 实时展示协同过程。"""
        state = self._initial_state(profile, learning_goal, pretest_result)
        latest = state
        for chunk in self._graph.stream(state, stream_mode="values"):
            latest = GraphState.model_validate(chunk)
            yield latest
        return latest

    def to_workflow_run(self, final: GraphState, profile: LearnerProfile) -> WorkflowRun:
        """把 stream_run 的最终状态快照组装成 WorkflowRun（流式消费方的收尾入口）。"""
        return self._to_workflow_run(final, profile)

    def decide_feedback(
        self,
        feedback: FeedbackInput | dict,
        current_difficulty: str = "L2",
    ) -> FeedbackDecision:
        if isinstance(feedback, dict):
            feedback = FeedbackInput(**feedback)
        return self.feedback_agent.run(feedback, current_difficulty=current_difficulty)

    def graph_mermaid(self) -> str:
        """导出编排图的 mermaid 定义（调度可视化/文档用）。"""
        return self._graph.get_graph().draw_mermaid()

    # ------------------------------------------------------------- 状态构造与结果组装

    def _initial_state(
        self,
        profile: LearnerProfile,
        learning_goal: str | None,
        pretest_result: PretestResult | None,
    ) -> GraphState:
        goal = learning_goal or profile.learning_goal
        if pretest_result is None:
            pretest_result = estimate_pretest_from_profile(profile, load_pretest_questions())
        diagnosis = self.diagnosis_agent.run(profile, pretest_result, learning_goal=goal)
        trace = [
            self._trace(
                self.diagnosis_agent,
                status="completed",
                input_summary=f"profile={profile.id}, pretest_score={pretest_result.score}",
                output_summary=(
                    f"difficulty={diagnosis.recommended_difficulty}, "
                    f"weak={diagnosis.weak_concepts}"
                ),
                artifacts={"diagnosis": diagnosis.model_dump()},
            )
        ]
        return GraphState(
            run_id=str(uuid4()),
            learner_profile=profile,
            learning_goal=goal,
            retrieval_query=goal,
            generation_goal=goal,
            diagnosis=diagnosis,
            trace=trace,
        )

    def _followup_state(
        self,
        profile: LearnerProfile,
        parent_run: WorkflowRun,
        feedback: FeedbackInput | dict,
    ) -> tuple[GraphState, FeedbackDecision, Any]:
        if isinstance(feedback, dict):
            feedback = FeedbackInput(**feedback)
        if profile.id != parent_run.learner_profile_id:
            raise ValueError("profile does not match parent run")
        if feedback.learner_profile_id != profile.id:
            raise ValueError("feedback does not match learner profile")
        from backend.rag.retriever import DEFAULT_CORPUS_ALIASES

        def canonical_corpus(value: str | None) -> str:
            name = (value or "").strip().lower()
            return "ai" if name in DEFAULT_CORPUS_ALIASES else name

        blueprint = parent_run.diagnosis.personalization_blueprint
        if blueprint is None:
            raise ValueError("parent run has no corpus-bound blueprint")
        profile_corpus = canonical_corpus(profile.corpus)
        parent_corpora = {
            canonical_corpus(parent_run.diagnosis.coverage.corpus),
            canonical_corpus(blueprint.corpus),
        }
        if parent_corpora != {profile_corpus}:
            raise ValueError("profile corpus does not match parent run")

        decision = self.feedback_agent.run(
            feedback,
            current_difficulty=parent_run.diagnosis.recommended_difficulty,
        )
        adaptation = adapt_feedback(profile, parent_run, feedback, decision)
        trace = [
            self._trace(
                self.feedback_agent,
                status="feedback_applied",
                input_summary=(
                    f"parent_run={parent_run.run_id}, quiz_score={feedback.quiz_score}, "
                    f"confidence={feedback.confidence}"
                ),
                output_summary=(
                    f"decision={decision.decision}, difficulty={decision.updated_difficulty}, "
                    f"focus={adaptation.focus_concepts}"
                ),
                artifacts={
                    "feedback": feedback.model_dump(mode="json"),
                    "feedback_decision": decision.model_dump(),
                    "feedback_adaptation": adaptation.model_dump(),
                    "parent_run_id": parent_run.run_id,
                },
            )
        ]
        state = GraphState(
            run_id=str(uuid4()),
            learner_profile=profile,
            learning_goal=parent_run.learning_goal,
            retrieval_query=adaptation.retrieval_query,
            generation_goal=(
                f"{parent_run.learning_goal}（反馈轮：{adaptation.generation_instruction}）"
            ),
            diagnosis=adaptation.diagnosis,
            trace=trace,
        )
        return state, decision, adaptation

    def _invoke(self, state: GraphState) -> GraphState:
        result = self._graph.invoke(state)
        return GraphState.model_validate(result)

    def _to_workflow_run(
        self,
        final: GraphState,
        profile: LearnerProfile,
        *,
        parent_run_id: str | None = None,
        feedback_decision: FeedbackDecision | None = None,
        mastery_change: dict[str, float] | None = None,
        generation_reason: str = "initial",
    ) -> WorkflowRun:
        return WorkflowRun(
            run_id=final.run_id,
            learner_profile_id=profile.id,
            learning_goal=final.learning_goal,
            diagnosis=final.diagnosis,
            retrieval=final.retrieval,
            resources=final.resources,
            audit=final.audit,
            learning_path=final.learning_path,
            trace=final.trace,
            debate=final.debate,
            arbitration=final.arbitration,
            parent_run_id=parent_run_id,
            feedback_decision=feedback_decision,
            mastery_change=mastery_change or {},
            generation_reason=generation_reason,
        )

    # ------------------------------------------------------------- trace 辅助

    def _trace(
        self,
        agent,
        *,
        status: str,
        input_summary: str,
        output_summary: str,
        artifacts: dict,
    ) -> AgentTraceStep:
        artifacts = dict(artifacts)
        artifacts["engine"] = getattr(agent, "last_engine", "deterministic")
        artifacts["model_route"] = route_for(agent.name).public_dict()
        return AgentTraceStep(
            agent=agent.name,
            status=status,
            input_summary=input_summary,
            output_summary=output_summary,
            artifacts=artifacts,
        )

    def _audit_trace(
        self,
        audit: AuditResult,
        resources: LearningResources,
        *,
        status: str,
    ) -> AgentTraceStep:
        return self._trace(
            self.audit_agent,
            status=status,
            input_summary=(
                f"claims={audit.claims_total}, sources={len(resources.used_sources)}"
            ),
            output_summary=(
                f"factuality={audit.factuality_score}, "
                f"hallucination_rate={audit.hallucination_rate}, "
                f"revision_required={audit.revision_required}"
            ),
            artifacts={"audit": audit.model_dump()},
        )


workflow = AgentTrainingWorkflow()
