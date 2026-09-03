"""个性化生成服务（框架无关业务层，PLAYBOOK Phase C）。

对接 ai_learn 的约定：入参含每请求 modelConfig，出参是 WorkflowRun dict + 可观测指标。
可直接 vendor 进 ai_learn 的 ai-service（app/personalize/）。
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import asdict
from datetime import date
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator, Optional

from pydantic import BaseModel, Field

from backend.orchestration.workflow import AgentTrainingWorkflow, workflow as default_workflow
from backend.schemas.learner import FeedbackInput, LearnerProfile
from backend.schemas.resources import WorkflowRun
from backend.services.daily_plan import build_daily_plan
from backend.services.learning_mode import all_modes, resolve_learning_mode
from backend.services.llm_gateway import LLMGateway
from backend.services.tutor_service import (
    TutorRequest as TutorTurnRequest,
    hint_ladder_turn,
    lecture_tutor_turn,
    tutor_turn,
)
from backend.services.model_routing import route_for
from backend.services.review_scheduler import ReviewCard, review

CHAT_TIERS = ("FAST", "STRONG", "JUDGE")
CORPUS_PATTERN = r"^[a-z0-9][a-z0-9_-]{0,31}$"


class ModelConfig(BaseModel):
    model: str = ""
    baseUrl: str = ""
    apiKey: str = ""
    configFingerprint: str = ""


class PersonalizeProfile(BaseModel):
    background: str = ""
    programming_level: int = Field(default=1, ge=0, le=4)
    python_level: int = Field(default=1, ge=0, le=4)
    agent_level: int = Field(default=1, ge=0, le=4)
    rag_level: int = Field(default=1, ge=0, le=4)
    engineering_level: int = Field(default=1, ge=0, le=4)
    time_budget_hours: int = Field(default=24, ge=1, le=200)
    learning_preference: str = "可运行示例与分步练习"
    constraints: list[str] = Field(default_factory=list)


class PersonalizeRequest(BaseModel):
    userId: str
    corpus: str = Field(min_length=1, max_length=32, pattern=CORPUS_PATTERN)
    learningGoal: str
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)
    modelConfig: Optional[ModelConfig] = None


class PersonalizeFollowupRequest(BaseModel):
    userId: str
    corpus: str = Field(min_length=1, max_length=32, pattern=CORPUS_PATTERN)
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)
    parentRun: WorkflowRun
    feedback: FeedbackInput
    modelConfig: Optional[ModelConfig] = None


class PersonalizeMetrics(BaseModel):
    traceId: str
    scene: str = "personalize_generate"
    model: str = ""
    success: bool = True
    fallbackUsed: bool = False
    durationMs: int = 0
    engines: list[str] = Field(default_factory=list)
    debateRounds: int = 0
    hallucinationRate: float = 0.0
    factualityScore: float = 0.0


def env_from_model_config(cfg: ModelConfig) -> dict[str, str]:
    """把 ai_learn 的每请求 modelConfig 映射为引擎各 tier 的 env（模型层桥接）。

    ai_learn 单请求单模型 → 引擎所有 chat tier 用同一模型/地址/key。
    无有效配置时返回空（引擎走确定性兜底）。
    """
    if not (cfg and cfg.model.strip() and cfg.baseUrl.strip() and cfg.apiKey.strip()):
        return {}
    env: dict[str, str] = {"PERSONALIZE_API_KEY": cfg.apiKey.strip()}
    for tier in CHAT_TIERS:
        env[f"LLM_PROVIDER_{tier}"] = "custom"
        env[f"LLM_MODEL_{tier}"] = cfg.model.strip()
        env[f"LLM_BASE_URL_{tier}"] = cfg.baseUrl.strip()
        env[f"LLM_API_KEY_ENV_{tier}"] = "PERSONALIZE_API_KEY"
    return env


def _to_profile(
    request: PersonalizeRequest | PersonalizeFollowupRequest,
    learning_goal: str | None = None,
) -> LearnerProfile:
    p = request.profile
    goal = learning_goal or getattr(request, "learningGoal", "")
    return LearnerProfile(
        id=f"user_{request.userId}",
        name=f"学习者{request.userId}",
        background=p.background or "未提供背景",
        programming_level=p.programming_level,
        python_level=p.python_level,
        agent_level=p.agent_level,
        rag_level=p.rag_level,
        engineering_level=p.engineering_level,
        learning_goal=goal,
        time_budget_hours=p.time_budget_hours,
        learning_preference=p.learning_preference,
        constraints=p.constraints,
        corpus=request.corpus,
    )


def _build_workflow(cfg: Optional[ModelConfig]) -> AgentTrainingWorkflow:
    env = env_from_model_config(cfg) if cfg else {}
    if not env:
        return default_workflow  # 确定性/默认 env
    return AgentTrainingWorkflow(gateway=LLMGateway(env=env))


def run_personalize(request: PersonalizeRequest, trace_id: str) -> tuple[dict[str, Any], PersonalizeMetrics]:
    """运行首次多智能体闭环，返回 WorkflowRun 与可观测指标。"""
    start = time.perf_counter()
    wf = _build_workflow(request.modelConfig)
    profile = _to_profile(request)
    run = wf.run(profile, learning_goal=request.learningGoal)
    metrics = _build_metrics(
        run,
        trace_id=trace_id,
        scene="personalize_generate",
        model_config=request.modelConfig,
        started_at=start,
    )
    return run.model_dump(mode="json"), metrics


class CompareProfileSpec(BaseModel):
    """对比列：preset_id 用预设画像；否则用 name+profile 现场拼临时画像（评委自定义列）。"""
    preset_id: str = ""
    name: str = ""
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)


class CompareRequest(BaseModel):
    learningGoal: str
    profiles: list[CompareProfileSpec] = Field(min_length=2, max_length=4)
    modelConfig: Optional[ModelConfig] = None


def run_compare(request: CompareRequest, trace_id: str) -> dict[str, Any]:
    """同题异人对比生成：同一目标 × N 画像并排 + 逐处差异归因（赛题第五(1)款演示）。"""
    from backend.services.compare_service import compare_generate_profiles
    from backend.services.data_loader import get_learner_profile

    env = env_from_model_config(request.modelConfig) if request.modelConfig else {}
    profiles = []
    for i, spec in enumerate(request.profiles):
        if spec.preset_id:
            profiles.append(get_learner_profile(spec.preset_id))
        else:
            p = spec.profile
            profiles.append(LearnerProfile(
                id=f"custom_{i}",
                name=spec.name or f"自定义画像{i + 1}",
                background=p.background or "评委现场自定义",
                programming_level=p.programming_level,
                python_level=p.python_level,
                agent_level=p.agent_level,
                rag_level=p.rag_level,
                engineering_level=p.engineering_level,
                learning_goal=request.learningGoal,
                time_budget_hours=p.time_budget_hours,
                learning_preference=p.learning_preference,
                constraints=p.constraints,
            ))
    gateway = LLMGateway(env=env) if env else None
    report = compare_generate_profiles(request.learningGoal, profiles, gateway=gateway)
    payload = report.model_dump(mode="json")
    payload["traceId"] = trace_id
    return payload


def run_tutor_turn(request: "TutorTurnRequest", trace_id: str) -> dict[str, Any]:
    """动态追问导学单轮：探测/降维/推进/进阶的可见决策（赛题第五(4)款②）。

    hint_request>0 走三级提示阶梯（hint→scaffold 子题→兜底答案，解锁判据写死在代码里）；
    lecture_text 非空走讲义驱动分支（题从当前讲义节现生成，LLM 不可用如实 unavailable）；
    否则走概念题库分支（确定性，语料覆盖的概念）。两个 HTTP 层都从这里过，分流只做一次。
    """
    if request.hint_request:
        # 三级提示阶梯：卡住时按 hint→scaffold→兜底答案逐级放行，解锁判据确定性（不调模型）。
        # 分流放在最前面——要提示就不该再出新题，出了新题原来那道题的提示状态就断了。
        payload = hint_ladder_turn(request).model_dump(mode="json")
        payload["agent"] = "tutor:hint"
    elif request.lecture_text.strip():
        payload = lecture_tutor_turn(request).model_dump(mode="json")
        payload["agent"] = "tutor:lecture"
    else:
        payload = tutor_turn(request).model_dump(mode="json")
        payload["agent"] = "tutor:pool"
    # agent 标：协同闭环遥测口径——「这步是谁决策的」（tutor-consolidation §一）
    payload["traceId"] = trace_id
    return payload


def run_personalize_followup(
    request: PersonalizeFollowupRequest,
    trace_id: str,
) -> tuple[dict[str, Any], PersonalizeMetrics]:
    """执行反馈驱动的二次检索、生成、审核与路径规划。"""
    start = time.perf_counter()
    wf = _build_workflow(request.modelConfig)
    profile = _to_profile(request, learning_goal=request.parentRun.learning_goal)
    run = wf.run_followup(profile, request.parentRun, request.feedback)
    metrics = _build_metrics(
        run,
        trace_id=trace_id,
        scene="personalize_followup",
        model_config=request.modelConfig,
        started_at=start,
    )
    return run.model_dump(mode="json"), metrics


def _build_metrics(
    run: WorkflowRun,
    *,
    trace_id: str,
    scene: str,
    model_config: Optional[ModelConfig],
    started_at: float,
) -> PersonalizeMetrics:
    engines = [step.artifacts.get("engine", "?") for step in run.trace]
    return PersonalizeMetrics(
        traceId=trace_id,
        scene=scene,
        model=(model_config.model if model_config else "") or "deterministic",
        success=True,
        fallbackUsed=all(engine == "deterministic" for engine in engines),
        durationMs=int((time.perf_counter() - started_at) * 1000),
        engines=engines,
        debateRounds=len(run.debate),
        hallucinationRate=run.audit.hallucination_rate,
        factualityScore=run.audit.factuality_score,
    )


def stream_personalize_events(
    request: PersonalizeRequest,
    trace_id: str,
) -> Iterator[dict[str, Any]]:
    """逐节点事件流（Agent 协同剧场的数据源，P-2）。

    产出 dict 事件：run_started → agent_step*（trace 增量）→ final（完整 WorkflowRun+指标）。
    由 ai-service 侧编码成 SSE；本层保持传输无关，便于单测。
    """
    start = time.perf_counter()
    wf = _build_workflow(request.modelConfig)
    profile = _to_profile(request)
    emitted = 0
    latest = None
    for snapshot in wf.stream_run(profile, learning_goal=request.learningGoal):
        if latest is None:
            yield {
                "event": "run_started",
                "data": {
                    "run_id": snapshot.run_id,
                    "learning_goal": snapshot.learning_goal,
                    "trace_id": trace_id,
                },
            }
        latest = snapshot
        for step in snapshot.trace[emitted:]:
            yield {"event": "agent_step", "data": step.model_dump(mode="json")}
        emitted = len(snapshot.trace)
    run = wf.to_workflow_run(latest, profile)
    metrics = _build_metrics(
        run,
        trace_id=trace_id,
        scene="personalize_stream",
        model_config=request.modelConfig,
        started_at=start,
    )
    yield {
        "event": "final",
        "data": {"run": run.model_dump(mode="json"), "metrics": metrics.model_dump(mode="json")},
    }


def decide_feedback(feedback: FeedbackInput, current_difficulty: str = "L2") -> dict[str, Any]:
    return default_workflow.decide_feedback(feedback, current_difficulty=current_difficulty).model_dump(mode="json")


def route_snapshot() -> list[dict]:
    """当前各 Agent 的模型路由与启用状态（供前端展示，对接 ai_learn 的 model 面板）。"""
    from backend.services.model_routing import AGENT_TIERS

    return [route_for(agent).public_dict() for agent in AGENT_TIERS]


# ---------------------------------------------------------------- 产品层三件套 API（P-2）
# 无状态纯函数：卡片状态/路径概念由调用方（ai-service / Java / BFF）持有并传入，
# 日期走 ISO 字符串便于跨服务传输；同输入必同输出，可复算。


class ReviewCardState(BaseModel):
    """复习卡调度状态（调用方持久化）。空字符串日期 = 从未复习。"""

    item_id: str = Field(min_length=1)
    stability: Optional[float] = None
    difficulty: Optional[float] = None
    last_review: str = ""  # ISO date
    due: str = ""  # ISO date


class PlanConcept(BaseModel):
    """学习路径当前阶段的候选新概念（按优先序）。"""

    concept_id: str = Field(min_length=1)
    title: str = ""


class DailyPlanRequest(BaseModel):
    plan_date: str = ""  # ISO date；空 = 服务器当天
    minutes_budget: int = Field(default=25, ge=5, le=200)
    review_cards: list[ReviewCardState] = Field(default_factory=list)
    next_concepts: list[PlanConcept] = Field(default_factory=list)
    concept_titles: dict[str, str] = Field(default_factory=dict)


class GradeReviewRequest(BaseModel):
    card: ReviewCardState
    rating: int = Field(ge=1, le=4)  # AGAIN=1/HARD=2/GOOD=3/EASY=4
    review_date: str = ""  # ISO date；空 = 服务器当天


def _parse_date(value: str) -> date | None:
    return date.fromisoformat(value) if value.strip() else None


def _to_review_card(state: ReviewCardState) -> ReviewCard:
    return ReviewCard(
        item_id=state.item_id,
        stability=state.stability,
        difficulty=state.difficulty,
        last_review=_parse_date(state.last_review),
        due=_parse_date(state.due),
    )


def _card_dict(card: ReviewCard) -> dict[str, Any]:
    return {
        "item_id": card.item_id,
        "stability": card.stability,
        "difficulty": card.difficulty,
        "last_review": card.last_review.isoformat() if card.last_review else "",
        "due": card.due.isoformat() if card.due else "",
    }


def build_daily_plan_api(request: DailyPlanRequest) -> dict[str, Any]:
    """组合今日计划：FSRS 到期复习 + 1 新知识点 + 时间有余加挑战题。"""
    today = _parse_date(request.plan_date) or date.today()
    plan = build_daily_plan(
        today,
        request.minutes_budget,
        [_to_review_card(c) for c in request.review_cards],
        [(c.concept_id, c.title or c.concept_id) for c in request.next_concepts],
        request.concept_titles,
    )
    return plan.model_dump(mode="json")


def grade_review_api(request: GradeReviewRequest) -> dict[str, Any]:
    """按 FSRS 复习一张卡：更新记忆状态并排定下次到期日。"""
    today = _parse_date(request.review_date) or date.today()
    updated = review(_to_review_card(request.card), request.rating, today)
    return {
        "card": _card_dict(updated),
        "interval_days": (updated.due - today).days if updated.due else 0,
    }


def list_learning_modes_api(stuck_style: str = "", approach_style: str = "") -> dict[str, Any]:
    """全部学习模式；给了两道情景题答案则同时返回判定结果（非法输入回退默认模式）。"""
    resolved = None
    if stuck_style.strip() and approach_style.strip():
        resolved = asdict(resolve_learning_mode(stuck_style, approach_style))
    return {"modes": [asdict(m) for m in all_modes()], "resolved": resolved}


def profile_intake_api(text: str) -> dict[str, Any]:
    """一句话自述 → 画像种子（确定性关键词抽取，逐条附命中证据）。"""
    from backend.services.profile_intake import extract_profile_seed

    return extract_profile_seed(text).model_dump(mode="json")


def profile_appeal_challenge_api(dimension: str, claimed_level: int) -> dict[str, Any]:
    """画像申诉出题：2 道对应概念×目标档位的验证题（negotiated OLM）。"""
    from backend.services.profile_appeal import build_appeal_challenge

    return build_appeal_challenge(dimension, claimed_level).model_dump(mode="json")


def profile_appeal_grade_api(dimension: str, claimed_level: int,
                             answers: dict[str, str]) -> dict[str, Any]:
    """画像申诉判分：全对才允许改档，because 链逐题留证。"""
    from backend.services.profile_appeal import grade_appeal

    return grade_appeal(dimension, claimed_level, answers).model_dump(mode="json")


def learner_blueprint_api(
    learning_goal: str,
    background: str = "",
    programming_level: int = 1,
    python_level: int = 1,
    agent_level: int = 1,
    rag_level: int = 1,
    engineering_level: int = 1,
    learning_preference: str = "可运行示例与分步练习",
    time_budget_hours: int = 24,
    corpus: str = "",
    concept_mastery: dict[str, float] | None = None,
) -> dict[str, Any]:
    """画像 → 学情诊断 + 个性化蓝图（含资源配比计划），纯确定性无 LLM 调用。

    给外部课堂系统（OpenMAIC 接地改造）当"学情诊断 Agent"用：
    毫秒级返回掌握度向量、薄弱概念、推荐难度、技能缺口与 ResourceMix 配比，
    每项配比带 because 链可追问。
    """
    from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
    from backend.schemas.learner import PretestResult

    profile = LearnerProfile(
        id="external_maic",
        name="外部学习者",
        background=background or "未提供背景",
        programming_level=max(0, min(4, programming_level)),
        python_level=max(0, min(4, python_level)),
        agent_level=max(0, min(4, agent_level)),
        rag_level=max(0, min(4, rag_level)),
        engineering_level=max(0, min(4, engineering_level)),
        learning_goal=learning_goal,
        time_budget_hours=max(1, min(200, time_budget_hours)),
        learning_preference=learning_preference,
        # 决定学情诊断用哪个域的概念集。不传就是跟随培训领域（主域 ai）。
        corpus=(corpus or "").strip(),
    )
    # 学情诊断的本体是规则+掌握度模型（设计如此，可复算）；fast 档 LLM 只做
    # 摘要与风险补充，路由不可用时规则本体独立成立——这不是生成侧那种兜底，
    # 诊断输出是下游约束，带采样随机性反而有害。engine 字段如实带出。
    _diag_agent = LearnerDiagnosisAgent(gateway=_bridge_gateway())
    measured = {
        str(key): float(value)
        for key, value in (concept_mastery or {}).items()
        if str(key).strip()
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
        and 0 <= float(value) <= 1
    }
    diagnosis = _diag_agent.run(
        profile,
        PretestResult(learner_profile_id=profile.id, concept_scores=measured),
        learning_goal,
    )
    blueprint = diagnosis.personalization_blueprint
    return {
        "mastery_vector": diagnosis.mastery_vector,
        "weak_concepts": diagnosis.weak_concepts,
        "unmeasured_concepts": diagnosis.unmeasured_concepts,
        "coverage": diagnosis.coverage.model_dump(mode="json"),
        "recommended_difficulty": diagnosis.recommended_difficulty,
        "learning_risks": diagnosis.learning_risks,
        "diagnosis_summary": diagnosis.diagnosis_summary,
        "blueprint": blueprint.model_dump(mode="json") if blueprint else None,
        "engine": getattr(_diag_agent, "last_engine", "deterministic"),
    }


def quiz_decision_api(
    quiz_score: float,
    current_difficulty: str = "L2",
    confidence: int | None = None,
    concept_scores: dict[str, float] | None = None,
    free_text: str = "",
    learner_rating: float | None = None,
) -> dict[str, Any]:
    """反馈决策 Agent：答题正确率 → 降维解释 / 补充练习 / 进阶挑战 / 保持路线。

    给外部课堂系统（OpenMAIC）在测验场景交卷后调用，闭合"分析-生成-校验-决策"的决策环。
    确定性规则判定，because 链逐条给出越过了哪条阈值——可追问、可复算。
    """
    from backend.agents.feedback_decision_agent import FeedbackDecisionAgent
    from backend.schemas.learner import FeedbackInput

    feedback = FeedbackInput(
        learner_profile_id="external_maic",
        quiz_score=max(0.0, min(1.0, quiz_score)),
        confidence=max(1, min(5, confidence)) if confidence is not None else None,
        free_text=free_text or None,
        concept_scores={k: max(0.0, min(1.0, v)) for k, v in (concept_scores or {}).items()},
    )
    _fb_agent = FeedbackDecisionAgent(gateway=_bridge_gateway())
    decision = _fb_agent.run(feedback, current_difficulty)
    payload = decision.model_dump(mode="json")
    # 判定是谁做的必须带出去，UI 按此如实展示。措辞更正两处（旧注释两处都失真）：
    # 单个 FeedbackDecisionAgent 不是「协同决策」；deterministic 也不是「降级」——
    # 设计稿 §7.3 把反馈决策列为按需 agent，常规本就该走确定性计算。
    # 前端一度把这个字段丢了、横幅无条件写「多智能体协同决策」，正是 PLAYBOOK
    # 不变量 7 点名的那类不一致。
    payload["engine"] = getattr(_fb_agent, "last_engine", "deterministic")

    # Elo 能力评级（场景级）：整场测验当一个 item，rating 由当前难度档映射，
    # 得分 ≥0.6 记胜。冷启动无历史数据时 Elo 是 BKT/IRT/Elo 三者唯一可行解
    # （Pelánek 2016），初始分由外部传入（画像映射，协变量初始化，Park 2019）。
    # 评级是「难度行走」的连续状态，看累积；决策裁决看本次作答。
    from backend.services.elo_rating import (
        DEFAULT_RATING,
        initial_item_rating,
        pick_target_rating,
        rating_to_difficulty,
        update,
    )

    rating = learner_rating if learner_rating is not None else DEFAULT_RATING
    item = initial_item_rating(current_difficulty)
    new_rating, _ = update(rating, item, feedback.quiz_score >= 0.6)
    payload["elo"] = {
        "rating": round(new_rating, 1),
        "suggested_difficulty": rating_to_difficulty(pick_target_rating(new_rating)),
    }

    # 决策点的协商（设计稿 §7.4）。两路信号本来就会打架，旧注释写的是
    # 「决策 agent 的 L 档裁决仍是权威」——那是把一次仲裁**无声地**判给了一方。
    # 这里把它显式化：一致就不开会，打架才唤起仲裁并留下协商记录。
    from backend.agents.decision_negotiation import negotiate

    negotiation = negotiate(
        current_difficulty=current_difficulty,
        rule_decision=str(payload["decision"]),
        rule_difficulty=str(payload["updated_difficulty"]),
        rule_because=list(payload.get("because") or []),
        rule_engine=str(payload["engine"]),
        elo_rating=new_rating,
        elo_difficulty=str(payload["elo"]["suggested_difficulty"]),
        concept_scores=feedback.concept_scores,
        free_text=free_text,
        gateway=_bridge_gateway(),
    )
    payload["negotiation"] = negotiation

    # 裁决要真的生效，否则协商就是摆拍。被推翻的那一路原样留在 negotiation.proposals 里可查。
    if negotiation["conflict"]:
        arb = negotiation["arbitration"]
        payload["decision"] = arb["decision"]
        payload["updated_difficulty"] = arb["difficulty"]
        payload["next_action"] = arb["next_action"] or payload["next_action"]
        payload["feedback_type"] = "negotiated"
        payload["because"] = list(payload.get("because") or []) + [
            f"两路信号冲突，仲裁采信：{arb['rationale']}"
        ]
    return payload


def verify_content_bridge_api(
    code_blocks: list[str] | None = None,
    texts: list[str] | None = None,
) -> dict[str, Any]:
    """可执行验证（KR2）：课堂交付前机械验算生成内容里的代码与数值等式。

    零 LLM 调用：代码进隔离子进程真跑（三态：passed/failed/unverifiable），
    数值等式 AST 白名单复核。幻觉治理从「文本 claim 审核」延伸到
    「算得对不对、跑不跑得起来」。
    """
    from backend.services.content_verification import verify_content_api

    # 代码块上限 3：每块最长 10s，桥超时预算内最多跑三块，多余的如实不验
    blocks = list(code_blocks or [])[:3]
    return verify_content_api(blocks, list(texts or []))


@lru_cache(maxsize=1)
def _bridge_gateway() -> LLMGateway:
    """课堂桥的共享网关（前身是永远禁用 LLM 的 _NullGateway）。

    路由可用性由密钥决定（fast 档 key 在则诊断/反馈的 LLM 摘要层生效）；
    规则本体不依赖路由，永远可复算。延迟上限 = LLM_TIMEOUT_SECONDS
    （演示环境建议 8-10 秒，默认 30 偏大）。
    """
    return LLMGateway()


def _resolve_mastery(mastery_raw: str, corpus: str) -> dict[str, float]:
    """把外部系统送来的「自由文本键→分数」解析成「概念 id→掌握度」。

    键可能是引擎概念 id（rag），也可能是课堂场景标题（「注意力权重可视化」）——
    客户端不该背我们的概念词表，映射在词表所在的这一侧做；独立域只在自己的
    readiness 概念表里映射，不能借 AI 主域的同名概念。
    同一概念多个键命中时取最新写入（dict 顺序即写入序）。解析失败一律返回空：
    画像数据坏了不能让检索跟着崩。
    """
    from backend.rag.retriever import DEFAULT_CORPUS_ALIASES
    from backend.services.concept_graph import load_graph
    from backend.services.goal_concepts import domain_concepts, goal_concepts, matched_goal_concepts

    try:
        data = json.loads(mastery_raw) if mastery_raw else {}
        if not isinstance(data, dict):
            return {}
    except (ValueError, TypeError):
        return {}
    name = corpus.strip().lower()
    is_main = name in DEFAULT_CORPUS_ALIASES
    known = set(load_graph()) if is_main else set(domain_concepts(name))
    resolved: dict[str, float] = {}
    for key, value in data.items():
        try:
            score = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            continue
        if key in known:
            resolved[key] = score
            continue
        mapped = matched_goal_concepts(str(key)) if is_main else goal_concepts(str(key), name)
        for concept in mapped:
            resolved[concept] = score
    return resolved


# 掌握线：概念分 ≥ 此值视为已会。与 quiz 决策的薄弱线（<0.6）留一段缓冲带，
# 0.6~0.7 之间的概念既不算薄弱也不算已会——避免两套规则在边界上打架。
MASTERY_THRESHOLD = 0.7

_CODE_FENCE = re.compile(r"```[^\n]*\n(.*?)(?:```|\Z)", re.S)


_CODE_LINE = re.compile(
    r"^\s*(?:def |class |import |from \w+ import|@\w|if __name__|return |print\(|"
    r"[A-Za-z_][\w.]*\s*=\s*\S|[A-Za-z_][\w.]*\(.*\)\s*:?\s*$|"
    r"(?:try|except|else|elif|finally|for |while |with )\b.*:\s*$)"
)


def longest_code_block(text: str) -> int:
    """chunk 里最长代码块的非空行数；无代码块返回 0。

    三种形态都要认，缺一就漏（都是实测踩出来的）：
    ① 成对围栏——常规形态；
    ② 未闭合围栏按到文末算——摘录注入器按盒宽预算截断原文，半截围栏照样把整段
       代码贴进正文；
    ③ **裸代码块**：切分把一段代码劈到两个 chunk 里时，后半个 chunk 开头没有起始
       围栏（只剩一个收尾的），成对匹配返回 0，上限形同虚设——b1/b2/b3-tool-calling
       三例 beginner miss 就是这么漏过去的（ha04s01#s4 整块是 20 行 `if __name__`
       生产代码，围栏计数 1，旧实现判 0 行直接放行）。所以围栏之外的散文区再按
       代码行特征扫一遍连续段。
    """
    fenced = max(
        (len([ln for ln in m.group(1).split("\n") if ln.strip()])
         for m in _CODE_FENCE.finditer(text)),
        default=0,
    )
    # 围栏区挖掉后剩下的才按裸代码扫，避免把围栏内的行重复计一遍
    outside = _CODE_FENCE.sub("\n", text)
    bare = run = 0
    for ln in outside.split("\n"):
        if not ln.strip():
            continue  # 空行不断开代码段（函数体之间常有空行）
        if _CODE_LINE.match(ln) or (ln.startswith(("    ", "\t")) and run):
            run += 1
            bare = max(bare, run)
        else:
            run = 0
    return max(fenced, bare)


#: 入门教材里不出现的代码结构。判据是外部尺子，不是我们拍的——
#: 《Python 编程：从入门到实践》（蟒蛇书）配套源码 1-6 章 129 个文件实测：
#: **含 import 0%、含 def 0%、含 class 0%**；行数中位 4、≤5 行占 65%。
#: 全书 563 个文件才是 import 57% / def 31% / class 25%。
#: 也就是说「零基础能读的代码」的真分界不是长度，是**有没有这三种结构**——
#: 一段 3 行的 `from x import y` + `def f():` 比 5 行的 `print` 序列难得多。
#: 2026-08-13 实测事故：零基础学员拿到的摘录是 `import numpy` + `def query(...)` +
#: `np.array(...)`，行数没超上限，形态整段超纲。
_BEGINNER_FORBIDDEN_CODE = re.compile(
    r"^\s*(?:from\s+\S+\s+import\s|import\s|def\s|class\s|@\w)", re.M
)


def has_beyond_beginner_code(text: str) -> bool:
    """代码里出现入门段不该有的结构（import / def / class / 装饰器）。"""
    return bool(_BEGINNER_FORBIDDEN_CODE.search(text))


def evidence_retrieve_api(
    query: str,
    top_k: int = 6,
    corpus: str = "default",
    mastery: str = "",
    max_difficulty: str = "",
    max_code_lines: int = 0,
    beginner_code_form: bool = False,
) -> dict[str, Any]:
    """受控知识库检索（供外部课堂系统做证据接地）：query → 带 source_id 的证据块。

    `corpus` 选领域语料库（default/ai = 现有 AI 语料）。**该领域未建库就如实返回空**，
    不拿别的领域语料冒充命中。命中不足同样返回空/警告——宁可外部系统退回裸生成
    并被审核标记，不硬凑证据。

    `mastery` 是可选的掌握度 JSON（键=概念 id 或场景标题，值=0-1 分）。给了就走
    outer-fringe 选段（知识空间理论，ALEKS 的机制）：全部概念已达标的块跳过并给理由，
    留下的块按概念前置图拓扑序排——「只装缺口」的机制实现。不给则行为与旧版逐字节一致。

    `max_difficulty`（L1-L4）与 `max_code_lines`（>0 生效）是摘录的两道机械上限：
    前者管难度档，后者管代码形态。自撰区的姿态由 lint 管，摘录区 prompt 明令原样保留、
    lint 改不动，只能在检索侧不让它进来。
    """
    from backend.rag.retriever import get_corpus_retriever
    from backend.services.goal_concepts import goal_concepts

    retriever = get_corpus_retriever(corpus)
    if retriever is None:
        return {
            "query": query,
            "corpus": corpus,
            "matched_concepts": [],
            "chunks": [],
            "evidence_summary": "",
            "missing_evidence_warning": (
                f"领域语料库「{corpus}」尚未建设或尚未完成接入，系统当前无法检索相关材料。"
                "请由所属机构的管理者在知识库管理页完成接入后重试。"
                "本次不会回退到其他领域语料。"
            ),
        }
    tags = goal_concepts(query, corpus)
    top_k = max(1, min(12, top_k))
    mastery_map = _resolve_mastery(mastery, corpus)
    order = {"L1": 1, "L2": 2, "L3": 3, "L4": 4}
    cap = order.get(max_difficulty.strip().upper())
    max_code_lines = max(0, max_code_lines)
    # 任何一道过滤开着都先多捞一倍再筛，不然筛完凑不满 top_k——
    # 上限收得越紧越要多捞，否则「过滤生效」实际表现为「证据变薄」
    fetch_k = (
        min(12, top_k * 2)
        if (mastery_map or cap or max_code_lines or beginner_code_form)
        else top_k
    )
    result = retriever.search(query, concept_tags=tags, top_k=fetch_k)

    chunks = list(result.retrieved_chunks)
    skipped: list[dict[str, Any]] = []
    selection_mode = "plain"

    # 摘录的两道机械上限。共用一条判定：任一条不合规即跳过并带理由；
    # 全部不合规时保留「最易且代码最短」的一块并照常带走其余理由——
    # 零证据=裸生成，幻觉风险比超档更糟，这个权衡轮不到检索层拍板但要兜底。
    #
    # ① 难度档（2A 纯净测 beginner 44.4% 的病根修复）：摘录带着自己的难度进正文，
    #    姿态指令压不住摘录——L1 学习者拿到策略梯度公式块，讲义整段就滑向 L2/L3。
    # ② 代码形态（2A 复测 beginner 摘录区代码违规的定向修复）：难度档管不住代码长度。
    #    b1-tool-calling 命中的 ha04s01#s2 是 L2 档——正好落在 beginner 的难度上限之内，
    #    难度这一刀放行——却带 22 行无注释的生产级 class（import/typing/raise 齐全），
    #    判官 A 据此判 transition。自撰区的代码归 lint 管，摘录区 prompt 明令原样保留、
    #    lint 改不动，只能在检索侧不让它进来。
    # ③ 代码结构（2026-08-13 补，判据来自外部教材）：长度管不住结构。
    #    实测那份零基础课的摘录是 `import numpy` + `def query(...)` + `np.array(...)`——
    #    行数没超上限，形态整段超纲。蟒蛇书入门段 129 个文件里 import/def/class
    #    出现率**都是 0%**，全书才 57%/31%/25%，所以「入门能读的代码」的真分界是结构。
    def rejection(c) -> str:
        """不合规的理由；合规返回空串。"""
        difficulty = getattr(c, "difficulty", "")
        if cap and order.get(difficulty, 2) > cap:
            return f"难度 {difficulty or '?'} 超出学习者档位上限 {max_difficulty}"
        lines = longest_code_block(c.content)
        if max_code_lines and lines > max_code_lines:
            return f"含 {lines} 行代码块，超出该档位摘录代码上限 {max_code_lines} 行"
        if beginner_code_form and has_beyond_beginner_code(c.content):
            return "含 import/def/class 结构，超出入门段代码形态（外部基线：蟒蛇书 1-6 章 0%）"
        return ""

    # 保底块「只接地不引用」（2A 复测 66.7% 的定向修复）：
    # 原保底逻辑让全军覆没时最温和的一块照常进摘录——b1-tool-calling 那段 20 行
    # 生产代码就是这么进零基础讲义的（判官据此判 transition）。但直接丢掉它会退回
    # 零证据裸生成（幻觉风险更大）。两难的解法是拆开证据的两个用途：
    # 事实接地照常用它（不裸生成），摘录引用不用它（不把超档形态印进正文）。
    # 产品侧按 quotable 分流：evidenceDirective 吃全部，excerptDirective 只吃 quotable。
    non_quotable: set[int] = set()
    if cap or max_code_lines or beginner_code_form:
        verdicts = [(c, rejection(c)) for c in chunks]
        within = [c for c, reason in verdicts if not reason]
        if not within and chunks:
            fallback = min(chunks, key=lambda c: (order.get(getattr(c, "difficulty", ""), 2),
                                                  longest_code_block(c.content)))
            within = [fallback]
            non_quotable.add(id(fallback))
            suffix = "，且无合规替代块（保底块仅用于事实接地，不作摘录引用）"
        else:
            suffix = "，跳过以保姿态一致"
        kept = set(id(c) for c in within)
        skipped.extend(
            {"source_id": c.source_id, "title": c.title, "reason": reason + suffix}
            for c, reason in verdicts
            if reason and id(c) not in kept
        )
        chunks = within
    if mastery_map:
        from backend.rag.retriever import DEFAULT_CORPUS_ALIASES
        from backend.services.concept_graph import known_concepts, load_graph, topological_order

        selection_mode = "fringe"
        corpus_name = corpus.strip().lower()
        domain = None if corpus_name in DEFAULT_CORPUS_ALIASES else corpus_name
        known = set(load_graph()) if domain is None else known_concepts(domain)
        topo_rank = {
            concept: index
            for index, concept in enumerate(topological_order(list(known), domain))
        }

        def chunk_state(c) -> tuple[str, str]:
            """(判定, 理由)。判定 keep/skip。"""
            tags_known = [t for t in c.concept_tags if t in known]
            if not tags_known:
                return "keep", ""     # 没打概念标的块不敢跳，保守保留
            unmastered = [t for t in tags_known if mastery_map.get(t, 0.0) < MASTERY_THRESHOLD]
            if not unmastered:
                done = "、".join(tags_known)
                return "skip", f"概念（{done}）掌握度均已达标（≥{MASTERY_THRESHOLD}），跳过以省篇幅"
            return "keep", ""

        kept = []
        for c in chunks:
            verdict, reason = chunk_state(c)
            if verdict == "skip" and len(chunks) - len(skipped) > 1:
                # 最后一块不跳：全跳光=检索空手而归，外部系统会退裸生成，
                # 「你全会了」这种判断轮不到检索层拍板
                skipped.append({"source_id": c.source_id, "title": c.title, "reason": reason})
            else:
                kept.append(c)

        def sort_key(c) -> int:
            unmastered = [t for t in c.concept_tags if t in known and mastery_map.get(t, 0.0) < MASTERY_THRESHOLD]
            return min((topo_rank.get(t, 999) for t in unmastered), default=999)

        # 前置图拓扑序：依赖靠前的概念先出现——学习顺序即依赖顺序
        kept.sort(key=sort_key)
        chunks = kept

    # 过滤路径多捞了一倍，这里收回 top_k（没开过滤时本就不超，等价空操作）
    chunks = chunks[:top_k]

    return {
        "query": query,
        "corpus": corpus,
        "matched_concepts": tags,
        "selection_mode": selection_mode,
        "chunks": [
            {
                "source_id": c.source_id,
                "title": c.title,
                "content": c.content,
                "concept_tags": list(c.concept_tags),
                "difficulty": getattr(c, "difficulty", ""),
                # False = 形态超出该档位上限的保底块：可用于事实接地，不得作摘录引用
                "quotable": id(c) not in non_quotable,
            }
            for c in chunks
        ],
        # 跳过清单带理由——前端做「选段理由芯片」的数据源，
        # 「跳过已会内容」从静默省钱变成看得见的个性化决策
        "skipped": skipped,
        "evidence_summary": result.evidence_summary,
        "missing_evidence_warning": result.missing_evidence_warning,
    }


# ---------------------------------------------------------------- 摘录咬合打分（只读）

# 「讲义前文 ↔ 教材引文」咬合下限。低于此线判定为不咬合（用户原话「牛头不对马嘴」）。
#
# **不是拍的**：scripts/calibrate_excerpt_relevance.py 在 91 条判官三档标注
# （data/eval/excerpt_relevance/verdicts-20260810-065004.jsonl + -20260811-043314.jsonl）
# 上扫出来的。bge-m3 余弦中位数：supports 0.686 / related 0.644 / unrelated 0.553，
# supports|unrelated 分离度 0.83（置换检验 p=0.001），两批标注各自 0.90 / 0.80——
# 单批不塌，不是一次抽样运气。
#
# 同批淘汰的度量（不要再回头试）：字符 2/3/4-gram 重合（Dice/containment）、
# 最长公共子串、共享 4-gram 计数、TF-IDF 余弦。全部分离度 0.04~0.37、置换 p ≥0.11，
# 且在 08-11 那批（unrelated 占比最高的一批）上几乎归零（sep 0.02~0.13）。
# 教材引文和讲义前文本来就在同一主题域内，字面重合量不出「这段是否支撑那句话」。
#
# 0.60 这个点的代价（`python scripts/calibrate_excerpt_relevance.py --embedding --at bge:0.60`
# 复算，91 条口径）：拦下 6/7 unrelated、11/35 related，误伤 5/49 supports（10.2%）。
# unrelated 只有 7 条，85.7% 的拦截率 bootstrap 95%CI 是 [50%, 100%]——点估计别当准数用。
# 另：91 条里有 16 条是 0810/0811 两批判了同一条（输入逐字相同，判词 13/16 一致），
# 去重后 75 条唯一样本、unrelated 只剩 4 条，sep 0.83→0.79，阈值仍扫出 0.5996。
# 与 EMB_MIN_SCORE 数值相同纯属同模型同量纲的巧合，两个门用途不同，不许互相引用。
EXCERPT_MIN_RELEVANCE = 0.60

# 打分窗口：必须与校准时判官看到的一致（audit_excerpt_relevance.py 落盘时
# context[-160:] / excerpt[:160]），换了窗口就换了量纲，上面那个阈值立刻作废。
EXCERPT_CTX_WINDOW = 160
EXCERPT_TEXT_WINDOW = 160


def excerpt_relevance_api(
    contexts: list[str],
    source_ids: list[str],
    corpus: str = "default",
) -> dict[str, Any]:
    """摘录咬合打分（零 LLM，只读）：contexts × source_ids 的 bge-m3 余弦矩阵。

    引文侧用预建向量索引里的块向量（`knowledge_embeddings.npz`，线上检索用的同一份），
    前文侧一次批量嵌入。任一侧不可用就返回空 scores + reason——调用方**必须放行**，
    打分器不可用不是「摘录不咬合」的证据（证据桥的老规矩：UX 不依赖桥）。
    """
    from backend.rag.embedding_retriever import EMBED_MODEL, embed_texts
    from backend.rag.retriever import get_corpus_retriever

    empty = {
        "model": EMBED_MODEL,
        "threshold": EXCERPT_MIN_RELEVANCE,
        "source_ids": list(source_ids),
        "scores": [],
    }
    if not contexts or not source_ids:
        return {**empty, "reason": "contexts / source_ids 为空"}

    retriever = get_corpus_retriever(corpus)
    matrix = getattr(retriever, "matrix", None)
    # `matrix is None` 挡不住 TF-IDF 检索器——它**也有** `.matrix`，只是那是稀疏
    # TF-IDF 矩阵（实测 iotdb 是 csr_matrix (3202, 477516)、odoo 是 (307, 307659)），
    # 而下面拿的是 bge-m3 的 1024 维稠密向量。两者点乘直接抛
    # `ValueError: matmul: dimension mismatch`，而这段没有 try/except。
    #
    # 触发条件恰好是**新领域**：主语料 ai 有 `knowledge_embeddings.npz`、走
    # EmbeddingKnowledgeRetriever（ndarray (1704, 1024)，对得上）；
    # 没建向量索引的域一律落到 TF-IDF。2026-08-14 实测发现，见
    # `docs/05-evidence/domain-generalization-boundary-20260814.md`。
    #
    # 判据用「是不是稠密 ndarray」而不是检索器类名：类名会变，量纲不会。
    import numpy as np

    if retriever is None or not isinstance(matrix, np.ndarray) or matrix.ndim != 2:
        return {**empty, "reason": f"语料「{corpus}」无向量索引，无法打分"}

    row_of = {c.source_id: i for i, c in enumerate(retriever.chunks)}
    vecs = embed_texts([c[-EXCERPT_CTX_WINDOW:] for c in contexts])
    if vecs is None:
        return {**empty, "reason": "前文嵌入不可用（无 key 或调用失败）"}
    # 维度对不上就放行，不硬算。换嵌入模型而索引没重建时会走到这里——
    # 那种情况下算出来的余弦是无意义的数，比不打分更糟。
    if matrix.shape[1] != len(vecs[0]):
        return {
            **empty,
            "reason": (
                f"语料「{corpus}」的向量维度 {matrix.shape[1]} 与当前嵌入模型的 "
                f"{len(vecs[0])} 维对不上——索引需要用同一模型重建"
            ),
        }

    scores: list[list[float | None]] = []
    for vec in vecs:
        row: list[float | None] = []
        for sid in source_ids:
            idx = row_of.get(sid)
            if idx is None:
                row.append(None)  # 索引里没有这块：不打分，调用方放行
                continue
            chunk_vec = matrix[idx]
            norm = float(np.linalg.norm(chunk_vec))
            row.append(float(np.dot(vec, chunk_vec / norm)) if norm else None)
        scores.append(row)
    return {**empty, "scores": scores}


# ---------------------------------------------------------------- 岗位技能地图（行业延伸入口）

#: 种子名单：产品声明的培训领域。**建没建库都要在枚举里如实出现**（未建的 available=false），
#: 所以它不能只靠扫盘得出——扫盘看不见「声明了但还没建」的域。
DOMAIN_CORPORA = ("ai", "manufacturing", "industrial-internet", "software", "iotdb", "odoo")
JOB_SKILL_MAP_PATH = Path(__file__).resolve().parents[2] / "data" / "jobs" / "job_skill_map.json"
#: 知识库根目录。各库的就绪度报告在 `<name>_intake/readiness.json`。
KB_DIR = Path(__file__).resolve().parents[2] / "data" / "knowledge_base"


def domain_corpora() -> tuple[str, ...]:
    """语料库枚举 = 种子名单 ∪ 磁盘上**已落索引**的语料目录。

    以前这里就是 `DOMAIN_CORPORA` 那个写死的元组，后果是接入流水线建出来的新库
    在枚举里永远不出现——建好了也等于不存在。改成动态之后，落一个
    `corpora/<name>/knowledge_index.jsonl` 就自动进枚举，不需要改代码、不需要重启。

    判据是**索引文件在不在**，不是目录在不在：正在建的库会先有目录后有索引，
    拿目录当判据会让半成品库提前露面。种子六个一个不少，既有行为不变。
    """
    from backend.rag.retriever import CORPORA_DIR, CORPUS_NAME_RE

    found: list[str] = []
    try:
        for path in sorted(CORPORA_DIR.iterdir()):
            if (
                path.is_dir()
                and CORPUS_NAME_RE.fullmatch(path.name)
                and (path / "knowledge_index.jsonl").is_file()
            ):
                found.append(path.name)
    except OSError:
        pass  # 没有 corpora 目录：只剩种子名单
    return DOMAIN_CORPORA + tuple(n for n in found if n not in DOMAIN_CORPORA)


#: 一个库要能撑起一门课，最少得有多少块。
#:
#: **不是拍的**：一门课中位 10 屏、每屏取 6 块，同一块不重复用就要 60 块才铺得满；
#: 最长的一门 13 屏要 78 块。取 80 作为下限，即「至少够铺满我们生成过的最长一门课」。
#: 实测分布也正好在这里断开——真库 iotdb 3202 / odoo 3046 / vecdb 807 / rag-adv 310，
#: 接入流水线的先期小样 pv-ops 12 / cold-chain-ops 4，中间空着一个数量级。
#: 改这个数要连带说明依据，别只改数字。
MIN_CORPUS_CHUNKS = 80

#: 跨大类泛化域：与主库（AI 教材）分属完全异质的知识大类，可作「换库即换域」的实证。
#: 这是**叙事口径**不是能力判据——不在这里不代表库不能用，只代表它不算跨大类证据。
#: vecdb（向量数据库）、rag-adv（RAG 进阶）块数够、照常可用，但它们是 AI 大类内部的
#: 课程扩展语料，拿它们证明泛化等于自己跟自己比。新域建成后要手工加进这个集合，
#: 因为「算不算跨大类」是人的判断，机器判不了。
CROSS_DOMAIN_CORPORA = frozenset({"iotdb", "odoo"})


#: 一次性验证用的库名后缀/前缀。**约定而非名单**——名单要人记得维护，约定不用。
#: 2026-08-23 实锤：全链验证建的 `fullpath-probe`（300 块随机字节）过了块数闸，
#: 出现在学习者的知识库下拉里；选中它会拿乱码生成一门课。
#: 无分隔符的 `probe` 结尾也算（`sigprobe` 这类）——前端 SCRATCH_PATTERN 同日一起改。
SCRATCH_SUFFIXES = ("-probe", "-test", "-tmp", "-scratch", "probe")
SCRATCH_PREFIXES = ("probe-", "test-", "tmp-", "scratch-")
LEGACY_SCRATCH_PREFIX = "fullprobe"


def is_scratch_corpus(name: str) -> bool:
    """这个库是不是一次性验证用的。是就不对学习者露面。

    只影响「露不露面」，不影响它建成、不影响管理端看得见——
    管理者要能看到自己建过什么，包括测试库。
    """
    n = (name or "").strip().lower()
    return (
        n.endswith(SCRATCH_SUFFIXES)
        or n.startswith(SCRATCH_PREFIXES)
        or n.startswith(LEGACY_SCRATCH_PREFIX)
    )


def _vocabulary_verdict(name: str) -> tuple[str, str]:
    """词表闸三态：`passed` / `failed` / `skipped`。

    **`skipped` 不拦。** `extract_concepts` 是可选开关、默认关（抽概念要调 LLM，
    真花钱），没开时 `gate1_vocabulary` 也写成 `False`——但那是「这次没做」，
    不是「做了没达标」。2026-08-23 线上实锤：`smart-manufacturing` 1412 块、
    三指标全过，就因为没开概念抽取被判不合格，学习端整个不认这个库。

    与 ⑦ 站 `trial_verdict` 的三态同一个道理：把没测当没过就是虚报。
    区分的依据是 readiness 里的 `vocabulary_note`——接入链在没抽时会写明原因。
    """
    flag = _readiness_flag(name, "gate1_vocabulary")
    if flag is True:
        return "passed", ""
    note = str(_readiness(name).get("vocabulary_note") or "")
    if "未抽取" in note or "extract_concepts" in note:
        return "skipped", note
    if flag is False:
        return "failed", "概念词表少于 2 条（gate1_vocabulary）"
    return "skipped", "没有就绪度记录，无从判断"


def _corpus_gate(name: str, chunks: int, retrievable: bool) -> dict[str, Any]:
    """一个库够不够格对外露面。四条**取与**，缺一不可。

    取与不取或：能检索到 ≠ 有足够素材，有素材 ≠ 词表建起来了，词表建起来了 ≠ 试跑过线。
    任一条不满足，拿它生成课程都会在下游以别的形态爆出来（检索空手、素材不够铺屏、
    概念标不上、生成的课经不起判官核），不如在入口处如实拦下并说清缺哪一条。

    第四条是接入链 ⑦ 站的判词（`domain_intake._grade_trial` 写进 readiness.json）。
    只有 `degraded`（测了没过线）才拦；`unknown`（没勾试跑体检，或样本不足以判定）
    不拦——⑦ 站本来就是 optional，把没测当没过是虚报。三态一并挂在返回里，
    ⑧ 站的清单要能把「没测」和「测了没过」分开显示。
    """
    reasons: list[str] = []
    if is_scratch_corpus(name):
        reasons.append("一次性验证库（按命名约定识别），不对学习者露面")
    if not retrievable:
        reasons.append("知识库索引尚未完成，或检索服务当前不可用")
    if chunks < MIN_CORPUS_CHUNKS:
        reasons.append(f"证据块 {chunks} 不足 {MIN_CORPUS_CHUNKS}（撑不满一门课）")

    # 主库没有 intake 记录（它不是接入链建的），词表闸对它不适用，视为通过
    if name != "ai":
        verdict, why = _vocabulary_verdict(name)
        if verdict == "failed":
            reasons.append(f"词表闸未通过：{why}")

    trial = _readiness(name).get("trial_verdict")
    trial = trial if isinstance(trial, dict) else {}
    verdict = trial.get("verdict") if trial.get("verdict") in _TRIAL_VERDICTS else "unknown"
    if verdict == "degraded":
        reasons.append(f"试跑体检未过线：{trial.get('reason') or '见 readiness.json 的 trial_verdict'}")

    return {
        "passed": not reasons,
        "chunks": chunks,
        "floor": MIN_CORPUS_CHUNKS,
        "reasons": reasons,
        "trial_verdict": verdict,
        "trial_reason": str(trial.get("reason") or ""),
        "trial_checks": trial.get("checks") or [],
    }


#: ⑦ 站判词的三态。`unknown` = 没测或样本不足以判定，`degraded` = 测了没过线，
#: 两者永不合并——混为一谈就是虚报。别的值一律当 unknown。
_TRIAL_VERDICTS = ("passed", "degraded", "unknown")


def _readiness(name: str) -> dict[str, Any]:
    """读某个库的就绪度报告。读不到就返回空字典（未知，不当失败）。"""
    path = KB_DIR / f"{name}_intake" / "readiness.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _readiness_flag(name: str, key: str) -> bool | None:
    """读就绪度报告里的闸位。报告不存在或该位不是布尔就返回 None（未知，不当失败）。"""
    value = (_readiness(name).get("readiness") or {}).get(key)
    return bool(value) if isinstance(value, bool) else None


def _corpus_status() -> list[dict[str, Any]]:
    """各培训领域的语料库建设状态（未建设的如实标 available=false）。

    **扫盘发现 + 质量闸**，不用写死的名单。

    这里曾经是一个硬编码元组（`DOMAIN_CORPORA`），本意是挡掉接入流水线跑通时建的
    先期小样（冷链 4 块、光伏 12 块）被同一个徽标抬到与 iotdb（3202 块）同级。
    但那个改法把「管理者上传新库后自动注册」的路一起堵死了——按名单走，管理者传进来
    一个真库，它在画像下拉里根本不会出现，除非有人回来改代码。而「上传完剩下都是
    系统的事」正是本项目对泛化的定义。

    换成数据判据：扫盘发现所有已落索引的库，过闸的对外可见，没过的**如实标出原因**
    （`eligible=False` + `gate`），不静默消失——管理者传了个小库，得看见「未达标，
    当前 12 块 / 门限 80 块」，而不是以为系统把它吞了。
    """
    from backend.rag.retriever import get_corpus_retriever

    status = []
    for name in domain_corpora():
        retriever = get_corpus_retriever(name)
        chunks = len(retriever.chunks) if retriever is not None else 0
        gate = _corpus_gate(name, chunks, retriever is not None)
        status.append({
            "corpus": name,
            "available": retriever is not None,
            "chunk_count": chunks,
            "eligible": gate["passed"],
            "gate": gate,
            # 过闸 ≠ 跨大类泛化域。vecdb / rag-adv 块数够、能当知识库正常用，
            # 但它们是 AI 大类**内部**的课程扩展语料，与主库同属一个知识大类；
            # 对外讲「换个库就换个领域」时只能拿 iotdb / odoo 这种跨大类的当证据。
            # 两件事分开标，别让「能用」自动升格成「泛化实证」。
            "cross_domain": name in CROSS_DOMAIN_CORPORA,
            "index_path": (
                "data/knowledge_base/knowledge_index.jsonl"
                if name == "ai"
                else f"data/knowledge_base/corpora/{name}/knowledge_index.jsonl"
            ),
        })
    return status


#: 复合技能名的机械拆分符。只拆顶层并列词，**不拆括号内**——括号里通常是同一主题的
#: 变体枚举（「注意力机制及其升级变体（MHA/GQA/MQA）」「RLHF 及其变种（PPO/DPO）」），
#: 拆成 "MHA"、"GQA" 会变成无意义的查询噪声。斜杠同理，一律不拆。
#: 「及」只在不跟「其」时才算并列词：「及其升级变体」是承接不是并列，拆了会切出
#: 「其升级变体」这种没有主语的碎片，当查询用只会制造假阴性。
_SKILL_SPLIT_CHARS = "、与及"
#: 纯中文子项的最短长度。「超参」「检索」「更新」这类脱离上下文就没有检索意义，
#: 单独查会捞回一堆无关块。**带 ASCII 字母的一律保留**，不卡长度——CoT / MCP /
#: RAG / A2A 这些三字母缩写恰恰是最该单独查的子主题，用长度筛会把它们全丢掉
#: （第一版就是这么把 CoT 和 MCP 丢了的，正好丢掉了要救的那两个）。
_MIN_CJK_PART_CHARS = 4


def _is_meaningful_part(part: str) -> bool:
    return any("a" <= c.lower() <= "z" for c in part) or len(part) >= _MIN_CJK_PART_CHARS


def split_skill_name(name: str) -> list[str]:
    """把复合技能名拆成可独立检索的子项；不含并列词就原样返回单元素列表。

    为什么要拆：复合名整体向量化后，主导子主题会把其余子项挤出 top-k。实测
    「ReAct、CoT 与工具增强推理设计模式」召回的四块全是 ReAct，而 CoT 的教材
    （`pg08#s1~s3`：少样本 CoT / 零样本 CoT / Auto-CoT）明明在库里——单独查
    「链式思考 CoT 提示」立刻命中。这不是语料缺口，是检索粒度问题。

    规则写死，不按结果调：只在括号外按「、与及」切，切完去空白、丢掉长度 <2 的碎片。
    括号内容跟随它前面的那一段，不单独成项。
    """
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for i, ch in enumerate(name):
        nxt = name[i + 1] if i + 1 < len(name) else ""
        if ch in "（(":
            depth += 1
        elif ch in "）)":
            depth = max(0, depth - 1)
        if depth == 0 and ch in _SKILL_SPLIT_CHARS and not (ch == "及" and nxt == "其"):
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    cleaned = [p.strip() for p in parts]
    cleaned = [p for p in cleaned if _is_meaningful_part(p)]
    # 只有一项等于没拆；碎片全被丢掉也等于没拆。两种情况都回退成整名单查。
    return cleaned if len(cleaned) >= 2 else [name.strip()]


def _judge(retriever, query: str) -> dict[str, Any]:
    """跑一次只认语义的检索，返回是否够格与命中块。向量后端缺席时一律判未覆盖。"""
    from backend.schemas.resources import RetrievalResult

    r = (
        retriever.search(query, allow_lexical_fallback=False)
        if hasattr(retriever, "fallback")
        else RetrievalResult(
            retrieved_chunks=[], source_ids=[], evidence_summary="",
            missing_evidence_warning="向量后端不可用，覆盖判定不接受词法兜底结果。",
        )
    )
    return {
        "covered": r.missing_evidence_warning is None and len(r.retrieved_chunks) >= 2,
        "chunks": list(r.retrieved_chunks),
    }


def _domain_job_requirements(corpus: str) -> Any:
    """域注册清单里这个库登记的岗位要求（⑧ 站写的 `job_requirements` 槽）。

    没登记返回 None。**没登记就是没有**，不拿主库那 14 个 AI 岗位顶替——
    接入时管理者没投岗位/技能清单，这个域就没有岗位数据，如实说没有比给别人的答案强。
    """
    try:
        data = json.loads((KB_DIR / "domain_registry.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None  # 清单不在盘上/坏了：未知，不当作「登记过空清单」
    for row in data.get("corpora", []):
        if isinstance(row, dict) and row.get("corpus") == corpus:
            return row.get("job_requirements")
    return None


#: 覆盖判定口径。主域与外域共用这一份说明——尺子只有一把，不许各域各表。
SKILL_COVERAGE_RULE = (
    "覆盖 = 该技能（按完整技能名检索）在受控知识库拿到 ≥2 块语义相关证据"
    "（bge-m3 余弦 ≥0.60，正文 ≥80 字符）。**不接受词法兜底**：兜底供生成用"
    "（没素材总比空手强），但弱词面重叠不足以证明教材覆盖了该技能。"
    "复合技能名另按顶层并列词（、与及，不拆括号、不拆「及其」）拆项各查一遍，"
    "结果只用于补齐证据集与列出无料子项（missing_parts），不改判覆盖。"
)


def _jobs_coverage(retriever, jobs_raw: Any) -> list[dict[str, Any]]:
    """岗位清单 × 某个域的知识库 → 逐技能覆盖判定。主域与外域共用同一把尺子。

    岗位清单由调用方给：主域来自 `data/jobs/job_skill_map.json`，其他域来自域注册清单的
    `job_requirements`。检索器也由调用方给——判哪个域的覆盖，就用哪个域的库。

    **覆盖判定与生成/评测同源**：直接走检索器的 `search()`，用它自带的充分性门
    （bge-m3 语义余弦 ≥0.60，查询嵌入不可用时降级 TF-IDF ≥0.05；正文 ≥80 字符；
    可用块 ≥2），命中即覆盖，回带全部 source_id 供复核。

    2026-08-21 换掉了原来那套自立门户的判据（TF-IDF top-1 ≥0.12）。旧判据有两个毛病：
    一是与生成链路不同源——技能地图说"覆盖"，真去造课却因为过不了 0.60 语义门而没素材；
    二是 top-1 单块即判覆盖，一块能顶多项技能。实测 `ag020#s1`（一篇讲 Agent 生产环境
    挑战的博客，topic=deployment）同时"覆盖"了规划-执行-反思、记忆类型设计、AgentOps
    运维、编码 Agent、Harness Engineering、自进化 Agent、企业级平台落地七项——
    十分钟读完的经验帖教不了这七件事，是词面碰瓷。充分性门的 ≥2 块要求会把这类挤掉。
    """
    jobs = []
    for job in jobs_raw if isinstance(jobs_raw, list) else []:
        # 外域岗位清单是管理者投的料，形不对就跳过——不让一条脏数据把整张图谱带崩
        if not isinstance(job, dict):
            continue
        skills = []
        for text in [s for s in (job.get("skills") or []) if isinstance(s, str)]:
            # 覆盖判定只认语义门（≥0.60），**不吃词法兜底**。兜底对生成是对的
            # （没素材总比空手强），对判定是后门：2026-08-21 实测两条语义 top1 只有
            # 0.153/0.276 的技能，落到词法 0.05 后各拿 6 块判成「已覆盖」，
            # 亲读那 6 块全是同一篇博客的开头与总结。判定与生成各用各的尺子。
            # 词法后端本身没有语义门，给不出这个区分，只能整体判未覆盖。
            # 复合技能名逐项检索：**每一项都要过门才算覆盖**，缺哪项如实列出。
            # 这一条同时修两个反方向的错：整体查会漏召子项（CoT 被 ReAct 挤掉），
            # 而只要一项命中就算覆盖又会虚报（「A 与 B」只有 A 有料也叫覆盖）。
            # 覆盖判定仍按**完整技能名**——口径不变，与历史序列可比。
            # 拆项检索只做两件事：把被主导子主题挤掉的证据补进来，
            # 以及指出哪个子项在库里没有料（missing_parts），供人工亲读时对照。
            # 不拿拆项结果改判覆盖：碎片查询的假阴性风险比它能修的假阴性更大。
            whole = _judge(retriever, text)
            covered = whole["covered"]
            per_part: list[dict[str, Any]] = []
            hits: list[Any] = list(whole["chunks"])
            seen: set[str] = {c.source_id for c in hits}
            parts = split_skill_name(text)
            for part in (parts if len(parts) > 1 else []):
                sub = _judge(retriever, part)
                per_part.append({
                    "part": part,
                    "covered": sub["covered"],
                    "chunk_count": len(sub["chunks"]),
                    "source_ids": [c.source_id for c in sub["chunks"]],
                })
                for c in sub["chunks"]:
                    if c.source_id not in seen:
                        seen.add(c.source_id)
                        hits.append(c)
            hits.sort(key=lambda c: float(c.score or 0.0), reverse=True)
            top = hits[0] if hits else None
            skills.append({
                "skill": text,
                "covered": covered,
                "score": round(float(top.score or 0.0), 3) if top is not None else 0.0,
                "chunk_count": len(hits),
                "parts": per_part,
                "missing_parts": [p["part"] for p in per_part if not p["covered"]],
                "source_id": top.source_id if (covered and top is not None) else "",
                "source_title": top.title if (covered and top is not None) else "",
                # 全部命中块都回带，便于逐条亲读复核"是不是词面碰瓷"
                "source_ids": [c.source_id for c in hits] if covered else [],
            })
        jobs.append({
            "job_id": job.get("job_id", ""),
            "title": job.get("title", ""),
            "summary": job.get("summary", ""),
            "core_concepts": job.get("core_concepts", []),
            "skills": skills,
            "covered_count": sum(1 for s in skills if s["covered"]),
        })
    return jobs


@lru_cache(maxsize=8)
def skill_map_api(domain: str = "ai") -> dict[str, Any]:
    """某个域的岗位技能地图 + 岗位市场事实 + 各领域语料库状态（转岗培训入口页数据源）。

    `domain` 决定这份图谱属于谁。主域（ai / default / 不传）走
    `data/jobs/job_skill_map.json` 那 14 个 AI 岗位、用主库判覆盖，口径一字不改。
    **其他域只认它自己登记的岗位要求**（域注册清单的 `job_requirements`），没登记就返回
    空 jobs + reason —— 智能制造的学员看到 AI Agent 岗位是静默错配，比看到「暂无数据」
    糟得多，而且返回体里以前连一格「这是哪个域」都没有，绕过页面直取接口就穿帮。
    所以两条路都带 `domain`：调用方永远知道这份答案属于哪个域。
    """
    # ponytail: 按域整表 lru_cache（一个域约 150 次检索，进程内算一次）。
    # 天花板：换库要 cache_clear（接入链 ⑧ 站的 _refresh_corpus_caches 已在调）。
    from backend.rag.retriever import DEFAULT_CORPUS_ALIASES, get_corpus_retriever, get_retriever

    name = (domain or "").strip().lower()
    # corpora 两条路都带：外域没岗位数据时，这一格就是「为什么没有」的现场证据
    base: dict[str, Any] = {
        "domain": name or "ai",
        "provenance": {},
        "market_stats": {},
        "corpora": _corpus_status(),
        "coverage_rule": SKILL_COVERAGE_RULE,
    }

    if name in DEFAULT_CORPUS_ALIASES:
        data = json.loads(JOB_SKILL_MAP_PATH.read_text(encoding="utf-8"))
        return {
            **base,
            "domain": "ai",
            "provenance": data.get("_provenance", {}),
            "market_stats": data.get("market_stats", {}),
            "jobs": _jobs_coverage(get_retriever(), data.get("jobs", [])),
        }

    declared = _domain_job_requirements(name)
    jobs_raw = declared.get("jobs") if isinstance(declared, dict) else declared
    if not isinstance(jobs_raw, list) or not jobs_raw:
        return {
            **base,
            "jobs": [],
            "reason": "本机构管理者在接入该领域时未提供岗位/技能清单",
        }
    # 判哪个域的覆盖就用哪个域的库：未建库时 get_corpus_retriever 返回 None，
    # 绝不回退主库——拿 AI 教材去证明制造岗位「已覆盖」正是这次要修的病。
    retriever = get_corpus_retriever(name)
    if retriever is None:
        return {
            **base,
            "jobs": [],
            "reason": f"领域语料库「{name}」尚未建成，岗位技能覆盖无从判定",
        }
    return {**base, "jobs": _jobs_coverage(retriever, jobs_raw)}


# ---------------------------------------------------------------- 前测校准（自评当先验、前测校正档位）

# 画像维度 → 题库 concept_tags 的映射。题库标签比画像维度细，engineering 覆盖
# 部署/评测/护栏三个工程侧标签。改题库标签时同步改这里。
PRETEST_DIM_CONCEPTS: dict[str, tuple[str, ...]] = {
    "programming": ("programming",),
    "python": ("python",),
    "agent": ("agent_basics", "tool_calling", "langgraph"),
    "rag": ("rag",),
    "engineering": ("deployment", "evaluation", "guardrails"),
}

# 校正规则（自评与实测相关仅 r≈.29，自评只能当先验；协变量初始化先例：Park 2019）：
# - 测出档与自评档差 ≥ PRETEST_DIVERGENCE_GAP：自评严重失真，取两者均值四舍五入
#   （既不全信 2 道题的实测，也不全信自评）；
# - 差 < GAP（自评 ±1 内）：实测可信，直接取测出档。
PRETEST_DIVERGENCE_GAP = 2


def _pretest_tested_level(correct: int, total: int) -> int:
    """答对率 → 0-4 档。int(x+0.5) 是四舍五入（round() 是银行家舍入，2.5→2 会压档）。"""
    return int(correct / total * 4 + 0.5) if total else 0


def pretest_questions_api(dims: str = "programming,python,agent,rag,engineering", per_dim: int = 2) -> dict[str, Any]:
    """按画像维度出前测题（id/题干/选项，不含答案与解析）。

    每维取 per_dim 道，按题目 id 排序保证可复算；未知维度直接跳过。
    """
    from backend.services.data_loader import load_pretest_questions

    questions = sorted(load_pretest_questions(), key=lambda q: q.id)
    per_dim = max(1, min(5, per_dim))
    out = []
    for dim in [d.strip() for d in dims.split(",") if d.strip()]:
        tags = PRETEST_DIM_CONCEPTS.get(dim)
        if not tags:
            continue
        picked = [q for q in questions if any(t in tags for t in q.concept_tags)][:per_dim]
        out.extend(
            {"id": q.id, "dim": dim, "question": q.question, "options": q.options}
            for q in picked
        )
    return {"questions": out, "per_dim": per_dim}


def pretest_grade_api(answers: dict[str, str], self_levels: dict[str, int]) -> dict[str, Any]:
    """前测判分 + 档位校正：{维度: {self, tested, corrected, evidence}}。

    只对既有自评档、又至少答了一道该维题目的维度出结论；没答题的维度不硬猜。
    """
    from backend.services.data_loader import load_pretest_questions

    question_by_id = {q.id: q for q in load_pretest_questions()}
    result: dict[str, Any] = {}
    for dim, self_level in self_levels.items():
        tags = PRETEST_DIM_CONCEPTS.get(dim)
        if not tags:
            continue
        self_level = max(0, min(4, int(self_level)))
        correct = total = 0
        for qid, selected in answers.items():
            q = question_by_id.get(qid)
            if q is None or not any(t in tags for t in q.concept_tags):
                continue
            total += 1
            correct += int(selected == q.answer)
        if not total:
            continue
        tested = _pretest_tested_level(correct, total)
        if abs(tested - self_level) >= PRETEST_DIVERGENCE_GAP:
            corrected = int((tested + self_level) / 2 + 0.5)
        else:
            corrected = tested
        result[dim] = {
            "self": self_level,
            "tested": tested,
            "corrected": corrected,
            "evidence": f"答对{correct}/{total}",
        }
    return result
