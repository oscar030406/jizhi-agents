from __future__ import annotations

import csv
import json
import os
import time
from pathlib import Path
from typing import Iterable, Literal, Sequence

from pydantic import BaseModel, Field

from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.orchestration.workflow import AgentTrainingWorkflow, MAX_DEBATE_ROUNDS
from backend.rag.claims import claim_statistics, extract_claims, verify_claims
from backend.schemas.evaluation import E2ECase
from backend.schemas.learner import DiagnosisResult
from backend.schemas.resources import (
    AuditResult,
    LectureResource,
    LectureSection,
    LearningResources,
    PracticeTask,
    QuizItem,
    RetrievalResult,
)
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.evaluation_service import (
    context_concept_recall,
    context_precision,
    faithfulness,
)
from backend.services.goal_concepts import goal_concepts
from backend.services.llm_gateway import LLMGateway
from backend.services.quiz_service import estimate_pretest_from_profile

SC_SAMPLES = 3  # self_consistency 采样数（文献常用 3-5，取下限控成本）


def _hetero_generation_agent() -> ResourceGenerationAgent:
    """hetero_debate 档的修订器：换到与生成器不同厂商的模型（只改路由不改机制）。
    默认借用 judge 档模型配置（已与生成器异厂商）；可用 ABLATION_HETERO_MODEL/
    ABLATION_HETERO_PROVIDER 指向第三家。"""
    env = dict(os.environ)
    model = env.get("ABLATION_HETERO_MODEL") or env.get("LLM_MODEL_JUDGE", "")
    provider = env.get("ABLATION_HETERO_PROVIDER") or env.get("LLM_PROVIDER_JUDGE", "")
    if model:
        env["LLM_MODEL_STRONG"] = model
    if provider:
        env["LLM_PROVIDER_STRONG"] = provider
    return ResourceGenerationAgent(gateway=LLMGateway(env=env))

AblationMode = Literal[
    "direct",
    "cot_single",
    "self_consistency",
    "rag",
    "self_refine",
    "rag_audit",
    "rag_audit_debate",
    "hetero_debate",
    "full_personalized",
]

LLM_CAPABLE_AGENTS = {
    "LearnerDiagnosisAgent",
    "ResourceGenerationAgent",
    "ContentAuditAgent",
    "FeedbackDecisionAgent",
}

# 九档消融矩阵（2026-07-22 论文级扩展，见 action_guide_v4 §1.1）：
# direct/cot_single/self_consistency = 无检索或单模型基线（MAD 批评文献的标准对照）
# rag → self_refine → rag_audit → rag_audit_debate → hetero_debate = 验证机制阶梯
#   （self_refine=同模型自批评修订；hetero_debate=修订换异厂商——两者对照是核心贡献）
ABLATION_MODES: tuple[AblationMode, ...] = (
    "direct",
    "cot_single",
    "self_consistency",
    "rag",
    "self_refine",
    "rag_audit",
    "rag_audit_debate",
    "hetero_debate",
    "full_personalized",
)


class AblationMetrics(BaseModel):
    faithfulness: float = Field(ge=0.0, le=1.0)
    context_precision: float = Field(ge=0.0, le=1.0)
    context_concept_recall: float = Field(ge=0.0, le=1.0)
    concept_coverage: float = Field(ge=0.0, le=1.0)
    citation_coverage: float = Field(ge=0.0, le=1.0)
    difficulty_match: float = Field(ge=0.0, le=1.0)
    hallucination_rate: float = Field(ge=0.0, le=1.0)
    fallback_rate: float = Field(ge=0.0, le=1.0)
    debate_rounds: int = Field(ge=0)


class AblationResult(BaseModel):
    case_id: str
    mode: AblationMode
    stages: list[str]
    executed_agents: list[str]
    personalized: bool
    has_learning_path: bool
    duration_ms: int = Field(ge=0)
    metrics: AblationMetrics


def run_ablation_case(case: E2ECase, mode: AblationMode) -> AblationResult:
    if mode not in ABLATION_MODES:
        raise ValueError(f"unsupported ablation mode: {mode}")
    started = time.perf_counter()
    profile = get_learner_profile(case.learner_profile_id)

    if mode == "direct":
        # 反面基线：裸 LLM 直生（无检索无审核门禁）。为了让幻觉率是"测量值"而非
        # "无引用即判死"的定义产物，另跑一次【仅测量】的检索+审核：审核结果只进指标，
        # 不触发修订/拦截。LLM 不可用（确定性模式）退回模板，保持机制可复现性验证口径。
        generation_agent = ResourceGenerationAgent()
        bare = generation_agent.run_bare(profile, case.learning_goal)
        difficulty = "L2"
        debate_rounds = 0
        personalized = False
        has_learning_path = False
        if bare is not None:
            resources = bare
            diagnosis_agent = LearnerDiagnosisAgent()
            pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
            diagnosis = diagnosis_agent.run(profile, pretest, learning_goal=case.learning_goal)
            generic_diagnosis = DiagnosisResult.model_validate(
                diagnosis.model_dump(mode="python") | {"personalization_blueprint": None}
            )
            retrieval = KnowledgeRetrievalAgent().run(case.learning_goal, generic_diagnosis)
            audit = ContentAuditAgent().run(resources, generic_diagnosis, retrieval)
            executed_agents = [generation_agent.name]
            stages = ["bare_generation", "measurement_only_audit"]
            fallback_rate = 0.0
        else:
            resources = _direct_resources(case)
            retrieval = RetrievalResult(
                retrieved_chunks=[],
                source_ids=[],
                evidence_summary="direct mode: retrieval disabled",
                missing_evidence_warning="未执行检索，所有事实性声明均应视为未锚定。",
            )
            audit = _evaluate_without_audit(resources, retrieval)
            executed_agents = ["DirectGenerator"]
            stages = ["direct_generation"]
            fallback_rate = 1.0
    elif mode == "full_personalized":
        workflow = AgentTrainingWorkflow()
        run = workflow.run(profile, learning_goal=case.learning_goal)
        resources = run.resources
        retrieval = run.retrieval
        difficulty = run.diagnosis.recommended_difficulty
        # 统一测量口径：与其他档一致，指标来自对最终资源的独立测量审核
        measure_diag = DiagnosisResult.model_validate(
            run.diagnosis.model_dump(mode="python") | {"personalization_blueprint": None}
        )
        audit = ContentAuditAgent().run(resources, measure_diag, retrieval)
        executed_agents = [step.agent for step in run.trace]
        stages = ["diagnosis", "retrieval", "generation", "audit_loop", "learning_path"]
        fallback_rate = _fallback_rate_from_trace(run.trace)
        debate_rounds = len(run.debate)
        personalized = True
        has_learning_path = True
    else:
        diagnosis_agent = LearnerDiagnosisAgent()
        retrieval_agent = KnowledgeRetrievalAgent()
        generation_agent = ResourceGenerationAgent()
        audit_agent = ContentAuditAgent()
        pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
        diagnosis = diagnosis_agent.run(profile, pretest, learning_goal=case.learning_goal)
        generic_diagnosis = DiagnosisResult.model_validate(
            diagnosis.model_dump(mode="python") | {"personalization_blueprint": None}
        )
        retrieval = retrieval_agent.run(case.learning_goal, generic_diagnosis)
        difficulty = generic_diagnosis.recommended_difficulty
        executed_agents = [diagnosis_agent.name, retrieval_agent.name, generation_agent.name]
        debate_rounds = 0
        extra_fallback_agents: list = []

        if mode == "cot_single":
            # 单模型 CoT 基线（MAD 批评文献标准对照）：同证据、同模型，仅提示词加逐步推理
            resources = generation_agent.run(
                profile, case.learning_goal, generic_diagnosis, retrieval, prompt_style="cot")
            stages = ["diagnosis", "retrieval", "cot_generation"]
        elif mode == "self_consistency":
            # 采样 N 份，按确定性 claim 支持率选优（选择器不用 LLM，避免判官污染）
            candidates = []
            for _ in range(SC_SAMPLES):
                cand = generation_agent.run(profile, case.learning_goal, generic_diagnosis, retrieval)
                score = faithfulness(verify_claims(extract_claims(cand), retrieval.retrieved_chunks))
                candidates.append((score, cand))
            resources = max(candidates, key=lambda x: x[0])[1]
            executed_agents += [generation_agent.name] * (SC_SAMPLES - 1)
            stages = ["diagnosis", "retrieval", "self_consistency_generation"]
        elif mode == "self_refine":
            # 同模型自批评修订（validate-refine 前作的代表形态，与 hetero_debate 对照）
            resources = generation_agent.run(profile, case.learning_goal, generic_diagnosis, retrieval)
            problems = generation_agent.self_critique(resources, retrieval)
            if problems:
                pseudo_audit = AuditResult(
                    factuality_score=0.0, citation_coverage=0.0,
                    difficulty_match=1.0, concept_coverage=1.0,
                    revision_required=True, revision_suggestions=problems,
                    challenges=problems[:6], auditor_engine="self",
                )
                resources, _, _ = generation_agent.revise(
                    resources, pseudo_audit, retrieval, generic_diagnosis)
                executed_agents.append(generation_agent.name)
                debate_rounds = 1
            stages = ["diagnosis", "retrieval", "generation", "self_critique", "self_revision"]
        elif mode == "rag":
            resources = generation_agent.run(profile, case.learning_goal, generic_diagnosis, retrieval)
            stages = ["diagnosis", "retrieval", "generation"]
        elif mode == "rag_audit":
            resources = generation_agent.run(profile, case.learning_goal, generic_diagnosis, retrieval)
            audit_agent.run(resources, generic_diagnosis, retrieval)
            executed_agents.append(audit_agent.name)
            extra_fallback_agents.append(audit_agent)
            stages = ["diagnosis", "retrieval", "generation", "audit"]
        else:  # rag_audit_debate / hetero_debate
            resources = generation_agent.run(profile, case.learning_goal, generic_diagnosis, retrieval)
            mech_audit = audit_agent.run(resources, generic_diagnosis, retrieval)
            executed_agents.append(audit_agent.name)
            extra_fallback_agents.append(audit_agent)
            revisor = generation_agent if mode == "rag_audit_debate" else _hetero_generation_agent()
            while mech_audit.revision_required and debate_rounds < MAX_DEBATE_ROUNDS:
                resources, _, _ = revisor.revise(resources, mech_audit, retrieval, generic_diagnosis)
                executed_agents.append(
                    revisor.name + ("(hetero)" if mode == "hetero_debate" else ""))
                mech_audit = audit_agent.run(resources, generic_diagnosis, retrieval)
                executed_agents.append(audit_agent.name)
                debate_rounds += 1
            if mode == "hetero_debate":
                extra_fallback_agents.append(revisor)
            stages = ["diagnosis", "retrieval", "generation",
                      "hetero_audit_loop" if mode == "hetero_debate" else "audit_loop"]

        fallback_rate = _fallback_rate_from_agents(
            [diagnosis_agent, retrieval_agent, generation_agent] + extra_fallback_agents)
        personalized = False
        has_learning_path = False
        # 统一测量口径（论文级公平性）：九档指标一律来自对最终资源的独立测量审核，
        # 机制审核只决定流程（打回/辩论轮次），不当指标来源
        audit = ContentAuditAgent().run(resources, generic_diagnosis, retrieval)

    metrics = _metrics(
        case,
        resources,
        retrieval,
        audit,
        difficulty,
        fallback_rate,
        debate_rounds,
    )
    # 复判持久化（去混杂用）：落盘最终资源+检索+审核判定，供独立尺子重打分
    save_dir = os.environ.get("ABLATION_SAVE_RESOURCES_DIR")
    if save_dir:
        out = Path(save_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{case.id}__{mode}.json").write_text(json.dumps({
            "case_id": case.id,
            "mode": mode,
            "resources": resources.model_dump(mode="json"),
            "retrieval": retrieval.model_dump(mode="json"),
            "audit_verdicts": [v.model_dump(mode="json") for v in audit.claim_verdicts],
            "fallback_rate": fallback_rate,
        }, ensure_ascii=False), encoding="utf-8")
    return AblationResult(
        case_id=case.id,
        mode=mode,
        stages=stages,
        executed_agents=executed_agents,
        personalized=personalized,
        has_learning_path=has_learning_path,
        duration_ms=int((time.perf_counter() - started) * 1000),
        metrics=metrics,
    )


def run_ablation_suite(
    cases: Sequence[E2ECase],
    modes: Iterable[AblationMode] = ABLATION_MODES,
) -> list[AblationResult]:
    selected_modes = tuple(modes)
    results: list[AblationResult] = []
    total = len(cases) * len(selected_modes)
    for ci, case in enumerate(cases):
        for mode in selected_modes:
            t0 = time.time()
            result = run_ablation_case(case, mode)
            results.append(result)
            print(
                f"[ablation {len(results)}/{total}] {case.id} · {mode} · "
                f"{time.time() - t0:.0f}s · faith={result.metrics.faithfulness:.3f} · "
                f"halluc={result.metrics.hallucination_rate:.3f}",
                flush=True,
            )
    return results


def write_ablation_results(results: list[AblationResult], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_payload = [result.model_dump(mode="json") for result in results]
    (output_dir / "ablation_results.json").write_text(
        json.dumps(json_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    csv_path = output_dir / "ablation_results.csv"
    with csv_path.open("w", encoding="utf-8", newline="") as file:
        fieldnames = [
            "case_id",
            "mode",
            "stages",
            "executed_agents",
            "personalized",
            "has_learning_path",
            "duration_ms",
            *AblationMetrics.model_fields.keys(),
        ]
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        for result in results:
            row = result.model_dump(mode="json")
            metrics = row.pop("metrics")
            row["stages"] = ">".join(row["stages"])
            row["executed_agents"] = ">".join(row["executed_agents"])
            writer.writerow(row | metrics)

    summary = summarize_ablation(results)
    lines = [
        "# Five-level Ablation Summary",
        "",
        "Each mode reports the stages it actually executed. Deterministic results validate mechanism and reproducibility; they are not a substitute for a real-LLM ablation.",
        "",
        "| Mode | N | Faithfulness | Context precision | Concept recall | Concept coverage | Difficulty | Hallucination | Fallback | Duration ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for mode in ABLATION_MODES:
        if mode not in summary:
            continue
        item = summary[mode]
        lines.append(
            f"| {mode} | {item['n']} | {item['faithfulness']:.3f} | "
            f"{item['context_precision']:.3f} | {item['context_concept_recall']:.3f} | "
            f"{item['concept_coverage']:.3f} | {item['difficulty_match']:.3f} | "
            f"{item['hallucination_rate']:.3f} | {item['fallback_rate']:.3f} | "
            f"{item['duration_ms']:.1f} |"
        )
    (output_dir / "ablation_results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def summarize_ablation(results: list[AblationResult]) -> dict[str, dict[str, float | int]]:
    summary: dict[str, dict[str, float | int]] = {}
    for mode in ABLATION_MODES:
        rows = [result for result in results if result.mode == mode]
        if not rows:
            continue
        n = len(rows)
        summary[mode] = {
            "n": n,
            "faithfulness": sum(row.metrics.faithfulness for row in rows) / n,
            "context_precision": sum(row.metrics.context_precision for row in rows) / n,
            "context_concept_recall": sum(row.metrics.context_concept_recall for row in rows) / n,
            "concept_coverage": sum(row.metrics.concept_coverage for row in rows) / n,
            "citation_coverage": sum(row.metrics.citation_coverage for row in rows) / n,
            "difficulty_match": sum(row.metrics.difficulty_match for row in rows) / n,
            "hallucination_rate": sum(row.metrics.hallucination_rate for row in rows) / n,
            "fallback_rate": sum(row.metrics.fallback_rate for row in rows) / n,
            "debate_rounds": sum(row.metrics.debate_rounds for row in rows) / n,
            "duration_ms": sum(row.duration_ms for row in rows) / n,
        }
    return summary


def _direct_resources(case: E2ECase) -> LearningResources:
    concepts = goal_concepts(case.learning_goal)
    return LearningResources(
        lecture=LectureResource(
            title=f"直接生成：{case.learning_goal}",
            sections=[
                LectureSection(
                    heading="未经检索的直接回答",
                    body=(
                        f"围绕 {case.learning_goal} 直接给出方案。"
                        "该模式没有检索上下文，也没有审核步骤，因此不能证明事实性声明可靠。"
                    ),
                    source_ids=[],
                )
            ],
        ),
        practice_task=PracticeTask(
            title="直接实现任务",
            scenario="按照目标直接完成一个最小实现，不提供证据边界。",
            steps=["实现最小功能", "自行判断结果是否正确"],
            deliverable="一个未经审核的直接生成结果。",
            acceptance_checks=["结果可以展示"],
            difficulty="L2",
            source_ids=[],
        ),
        graded_quiz=[
            QuizItem(
                question="该直接生成结果是否已经被证据验证？",
                options={"A": "是", "B": "否"},
                answer="B",
                explanation="直接模式未执行检索与审核。",
                concept_tags=concepts,
                difficulty="L2",
                source_ids=[],
            )
        ],
        used_sources=[],
        target_concepts=concepts,
    )


def _evaluate_without_audit(
    resources: LearningResources,
    retrieval: RetrievalResult,
) -> AuditResult:
    claims = extract_claims(resources)
    verdicts = verify_claims(claims, retrieval.retrieved_chunks)
    stats = claim_statistics(verdicts)
    cited = sum(1 for _, source_ids in claims if source_ids)
    citation_coverage = cited / len(claims) if claims else 1.0
    return AuditResult(
        factuality_score=float(stats["support_rate"]),
        citation_coverage=round(citation_coverage, 3),
        difficulty_match=1.0,
        concept_coverage=1.0,
        hallucination_risk_flags=[
            verdict.claim for verdict in verdicts if verdict.verdict == "unsupported"
        ],
        revision_required=False,
        claims_total=int(stats["claims_total"]),
        claims_supported=int(stats["claims_supported"]),
        hallucination_rate=float(stats["hallucination_rate"]),
        claim_verdicts=verdicts,
        auditor_engine="independent_evaluator",
    )


def _metrics(
    case: E2ECase,
    resources: LearningResources,
    retrieval: RetrievalResult,
    audit: AuditResult,
    difficulty: str,
    fallback_rate: float,
    debate_rounds: int,
) -> AblationMetrics:
    expected = {concept.lower() for concept in case.expected_concepts}
    actual = {concept.lower() for concept in resources.target_concepts}
    concept_coverage = len(expected & actual) / max(1, len(expected))
    relevant_sources = set(resources.used_sources)
    relevant_sources.update(
        verdict.matched_source_id
        for verdict in audit.claim_verdicts
        if verdict.matched_source_id
    )
    ranked_precision = (
        context_precision(retrieval.source_ids, relevant_sources)
        if retrieval.source_ids
        else 0.0
    )
    return AblationMetrics(
        faithfulness=round(faithfulness(audit.claim_verdicts), 3),
        context_precision=round(ranked_precision, 3),
        context_concept_recall=round(
            context_concept_recall(case.expected_concepts, retrieval.retrieved_chunks),
            3,
        ),
        concept_coverage=round(concept_coverage, 3),
        citation_coverage=round(audit.citation_coverage, 3),
        difficulty_match=1.0 if difficulty == case.expected_difficulty else 0.0,
        hallucination_rate=round(audit.hallucination_rate, 3),
        fallback_rate=round(fallback_rate, 3),
        debate_rounds=debate_rounds,
    )


def _fallback_rate_from_trace(trace) -> float:
    relevant = [step for step in trace if step.agent in LLM_CAPABLE_AGENTS]
    if not relevant:
        return 0.0
    deterministic = sum(
        1 for step in relevant if step.artifacts.get("engine", "deterministic") == "deterministic"
    )
    return deterministic / len(relevant)


def _fallback_rate_from_agents(agents: list[object]) -> float:
    relevant = [agent for agent in agents if getattr(agent, "name", "") in LLM_CAPABLE_AGENTS]
    if not relevant:
        return 0.0
    deterministic = sum(
        1 for agent in relevant if getattr(agent, "last_engine", "deterministic") == "deterministic"
    )
    return deterministic / len(relevant)
