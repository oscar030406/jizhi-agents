from __future__ import annotations

from typing import Annotated, Dict, List, Optional

from pydantic import BaseModel, Field


class LearnerProfile(BaseModel):
    id: str
    name: str
    background: str
    programming_level: int = Field(ge=0, le=4)
    python_level: int = Field(ge=0, le=4)
    agent_level: int = Field(ge=0, le=4)
    rag_level: int = Field(ge=0, le=4)
    engineering_level: int = Field(ge=0, le=4)
    learning_goal: str
    time_budget_hours: int = Field(ge=1, le=200)
    learning_preference: str
    constraints: List[str] = Field(default_factory=list)
    #: 这个学习者选定的知识库。决定学情诊断用哪个域的概念集——
    #: 缺省（跟随培训领域）按主域 ai 处理。没有它，`concept_floors_for` 拿到 None、
    #: 永远走主域分支，AI 概念会被补进别的领域的课程（#6 跨域污染）。
    corpus: str = ""


class PretestAnswer(BaseModel):
    question_id: str
    selected: str


class PretestQuestion(BaseModel):
    id: str
    question: str
    options: Dict[str, str]
    answer: str
    explanation: str
    concept_tags: List[str]
    difficulty: str


class PretestResult(BaseModel):
    learner_profile_id: str
    answers: List[PretestAnswer] = Field(default_factory=list)
    score: float = Field(default=0.0, ge=0.0, le=1.0)
    concept_scores: Dict[str, float] = Field(default_factory=dict)


class SkillRequirement(BaseModel):
    concept: str
    required_level: str
    target_mastery: float = Field(ge=0.0, le=1.0)
    reason: str


class SkillGap(BaseModel):
    concept: str
    current_mastery: float = Field(ge=0.0, le=1.0)
    target_mastery: float = Field(ge=0.0, le=1.0)
    gap: float = Field(ge=0.0, le=1.0)
    priority: int = Field(ge=1)
    reason: str


class ResourceMix(BaseModel):
    """结构化资源配比计划：基础轴调支架与深度，偏好轴只调呈现配比与情境。

    循证口径（docs/personalization_research.md）：支架量按 expertise reversal 随基础反向；
    格式偏好只作参与度杠杆，不宣称改变学习效果机制。每项配比在 rationale 里指回画像维度。
    """

    scaffold_level: str  # full=完整铺垫+工作样例 / faded=渐进撤除步骤 / minimal=直入主题删冗余
    visual_widget_count: int = Field(ge=0, le=4)  # 可交互教具配额（人人≥1，偏好加码）
    diagram_count: int = Field(ge=0, le=4)  # 讲义内文字图示（流程图/结构图）配额
    code_example_count: int = Field(ge=0, le=5)  # 可运行代码示例配额
    analogy_domain: str  # 类比情境领域（由背景推断，兴趣情境化）
    section_length_band: str  # 每节正文字数带，如 "160-220"
    quiz_difficulty_band: List[str] = Field(default_factory=list)  # 测验难度覆盖带
    rationale: List[str] = Field(default_factory=list)  # because 链：配比→画像维度


class PersonalizationBlueprint(BaseModel):
    refined_goal: str
    required_skills: List[SkillRequirement] = Field(default_factory=list)
    skill_gaps: List[SkillGap] = Field(default_factory=list)
    learner_type: str
    content_strategy: List[str] = Field(default_factory=list)
    practice_strategy: List[str] = Field(default_factory=list)
    assessment_strategy: List[str] = Field(default_factory=list)
    resource_mix: Optional[ResourceMix] = None  # 只加不减：旧 JSON 仍可解析


class Feasibility(BaseModel):
    """时间预算够不够的显式判断（设计稿 §5.4「系统必须能说做不到」）。

    全部由确定性代码算出，判据与出处见 `backend/services/feasibility.py`——
    不让模型自觉，也不写死一个学时公式。
    """

    verdict: str  # ok=排得下 / tight=压到最小体量才排得下 / infeasible=做不到
    concept_count: int = Field(ge=0)  # 这个目标要补几个知识点
    required_hours_typical: float = Field(ge=0.0)  # 按实测中位体量需要的小时数
    required_hours_floor: float = Field(ge=0.0)  # 按实测最小体量需要的小时数
    reason: str  # 一句理由，带上面两个数
    suggested_goal: Optional[str] = None  # 建议的替代目标，verdict=ok 时为空
    basis: str  # 判据出处：量了哪些课、速率从哪来


class DiagnosisResult(BaseModel):
    mastery_vector: Dict[str, float]
    weak_concepts: List[str]
    recommended_difficulty: str
    learning_risks: List[str]
    diagnosis_summary: str
    personalization_blueprint: Optional[PersonalizationBlueprint] = None
    feasibility: Optional[Feasibility] = None  # 只加不减：旧 JSON 仍可解析


class FeedbackInput(BaseModel):
    learner_profile_id: str
    quiz_score: float = Field(ge=0.0, le=1.0)
    # None = 前端没采集信心自评。以前默认 3 会让 because 链写出「信心 3/5」——
    # 一个没人填过的数字被当成测量值展示给学习者，审计判为界面说谎。
    confidence: Optional[int] = Field(default=None, ge=1, le=5)
    free_text: Optional[str] = None
    concept_scores: Dict[str, Annotated[float, Field(ge=0.0, le=1.0)]] = Field(default_factory=dict)

