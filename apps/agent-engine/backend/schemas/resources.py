from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from backend.schemas.learner import DiagnosisResult, PersonalizationBlueprint


class KnowledgeChunk(BaseModel):
    source_id: str
    title: str
    topic: str
    difficulty: str
    concept_tags: List[str]
    section: str
    url: Optional[str] = None
    content: str
    score: float = 0.0
    #: 整库重建时旧块不删，原样留在索引里打上这一格（增量补币 T1）。
    #:
    #: 为什么是 bool 而不是 `superseded_by`：重建之后顶替它的那一块，source_id 与它
    #: **一模一样**（同一个文件、同一个节序，`_build_chunks` 的配方决定的），
    #: 指过去等于指自己；而文件被从语料里删掉的那种情况，压根没有顶替者可指。
    #: 我们真正知道的只有「这一块不再是活的版本」，那就只记这一件事。
    #: 只加不减、默认 False——存量六个库的索引都不带这一格，照样解析。
    superseded: bool = False


class RetrievalResult(BaseModel):
    retrieved_chunks: List[KnowledgeChunk]
    source_ids: List[str]
    evidence_summary: str
    missing_evidence_warning: Optional[str] = None


class QuizItem(BaseModel):
    question: str
    options: Dict[str, str]
    answer: str
    explanation: str
    concept_tags: List[str]
    difficulty: str
    source_ids: List[str] = Field(default_factory=list)


class LectureSection(BaseModel):
    heading: str
    body: str
    source_ids: List[str] = Field(default_factory=list)


class LectureResource(BaseModel):
    title: str
    sections: List[LectureSection]


class PracticeTask(BaseModel):
    """实操指南（赛题三形态之二）：不只是任务描述，而是可执行、可检查、可验收的
    分步指南。2026-07 按赛题措辞补齐三要素（字段只加不减，默认空保旧数据可解析）。"""
    title: str
    scenario: str
    steps: List[str]
    deliverable: str
    acceptance_checks: List[str]
    difficulty: str
    source_ids: List[str] = Field(default_factory=list)
    environment_setup: List[str] = Field(default_factory=list)   # 环境与前置条件
    verification_points: List[str] = Field(default_factory=list)  # 每步/关键步的预期与自检
    common_pitfalls: List[str] = Field(default_factory=list)      # 常见失败与排查


class EvidencePlan(BaseModel):
    """溯源前移：生成正文之前先声明「将引用哪些证据 + 只输出被证据支持的内容」。

    借鉴 Parlant ARQ 引导阶段——把证据锚定从事后审核提前到生成时，与 claim 级
    审核构成「约束生成 + 事后核验」双保险。planned_source_ids 必须是本次检索结果的子集。
    """

    planned_source_ids: List[str] = Field(default_factory=list)
    constraint_restatement: str = ""
    out_of_scope_note: str = ""


class LearningResources(BaseModel):
    lecture: LectureResource
    practice_task: PracticeTask
    graded_quiz: List[QuizItem]
    used_sources: List[str]
    target_concepts: List[str]
    evidence_plan: Optional[EvidencePlan] = None
    personalization_blueprint: Optional[PersonalizationBlueprint] = None


class ClaimVerdict(BaseModel):
    claim: str
    source_ids: List[str] = Field(default_factory=list)
    # not_a_claim = 判官认定这句不是领域事实断言（教学类比 / 面向学习者的指令 /
    # 对本讲义结构的回指），从幻觉率分母里剔除并单独计数
    verdict: str = "unsupported"  # supported | weak | unsupported | not_a_claim
    support_score: float = Field(default=0.0, ge=0.0, le=1.0)
    matched_source_id: Optional[str] = None


class AuditResult(BaseModel):
    factuality_score: float = Field(ge=0.0, le=1.0)
    citation_coverage: float = Field(ge=0.0, le=1.0)
    difficulty_match: float = Field(ge=0.0, le=1.0)
    concept_coverage: float = Field(ge=0.0, le=1.0)
    hallucination_risk_flags: List[str] = Field(default_factory=list)
    revision_required: bool
    revision_suggestions: List[str] = Field(default_factory=list)
    claims_total: int = 0
    claims_supported: int = 0
    hallucination_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    claim_verdicts: List[ClaimVerdict] = Field(default_factory=list)
    auditor_engine: str = "deterministic"
    # 辩论结构化收敛信号（借鉴 DeepResearchAgent 四段结构）：把辩论从「再答一遍」
    # 升级为「逐条挑证据」。challenges 是审核方对具体声明的质疑清单，
    # should_continue 是显式的「是否需要再辩一轮」信号（供仲裁/循环消费）。
    challenges: List[str] = Field(default_factory=list)
    should_continue: bool = False


class ClaimDispute(BaseModel):
    claim: str
    auditor_position: str
    cited_evidence: List[str] = Field(default_factory=list)
    generator_response: str
    revised_claim: str
    judge_decision: str
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class DebateRound(BaseModel):
    round_index: int
    auditor_flags: List[str] = Field(default_factory=list)
    auditor_factuality: float = Field(default=0.0, ge=0.0, le=1.0)
    auditor_challenges: List[str] = Field(default_factory=list)
    generator_action: str = ""
    generator_note: str = ""
    resolved: bool = False
    disputes: List[ClaimDispute] = Field(default_factory=list)
    revision_diff: str = ""


class ArbitrationDecision(BaseModel):
    action: str  # publish_with_warnings | block_pending_human_review
    rationale: str
    final_factuality: float = Field(default=0.0, ge=0.0, le=1.0)


class LearningPathStage(BaseModel):
    stage_id: str
    title: str
    difficulty: str
    goals: List[str]
    concepts: List[str]
    practice_task: str
    assessment: str
    estimated_hours: int


class LearningPath(BaseModel):
    learning_path: List[LearningPathStage]
    stage_goals: List[str]
    prerequisites: List[str]
    estimated_time: int
    assessment_plan: List[str]


class FeedbackDecision(BaseModel):
    feedback_type: str
    decision: str
    updated_difficulty: str
    next_action: str
    explanation: str
    # 可见协同决策（赛题第五(3)②）：裁决依据逐条列出——用了哪些信号、越过了哪条阈值。
    # 字段只加不减，默认空保旧数据可解析。
    because: List[str] = Field(default_factory=list)


class FeedbackAdaptation(BaseModel):
    diagnosis: DiagnosisResult
    mastery_change: Dict[str, float] = Field(default_factory=dict)
    focus_concepts: List[str] = Field(default_factory=list)
    retrieval_query: str
    generation_instruction: str


class AgentTraceStep(BaseModel):
    agent: str
    status: str
    input_summary: str
    output_summary: str
    artifacts: Dict[str, Any] = Field(default_factory=dict)


class WorkflowRun(BaseModel):
    run_id: str
    learner_profile_id: str
    learning_goal: str
    diagnosis: DiagnosisResult
    retrieval: RetrievalResult
    resources: LearningResources
    audit: AuditResult
    learning_path: LearningPath
    trace: List[AgentTraceStep]
    debate: List[DebateRound] = Field(default_factory=list)
    arbitration: Optional[ArbitrationDecision] = None
    parent_run_id: Optional[str] = None
    feedback_decision: Optional[FeedbackDecision] = None
    mastery_change: Dict[str, float] = Field(default_factory=dict)
    generation_reason: str = "initial"


class RunHistoryItem(BaseModel):
    run_id: str
    created_at: str
    learner_profile_id: str
    learning_goal: str
    recommended_difficulty: str
    weak_concept_count: int
    source_count: int
    factuality_score: float
    citation_coverage: float
    concept_coverage: float
    revision_required: bool
    trace_count: int
    debate_rounds: int = 0
    hallucination_rate: float = 0.0
    parent_run_id: Optional[str] = None
    generation_reason: str = "initial"
