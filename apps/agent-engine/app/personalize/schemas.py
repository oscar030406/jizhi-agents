from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field


class PersonalizeModelConfig(BaseModel):
    """Java 后端按请求透传的模型配置。"""

    model: str = ""
    baseUrl: str = ""
    apiKey: str = ""
    configFingerprint: str = ""


class PersonalizeProfile(BaseModel):
    """个性化引擎需要的最小学习者画像。"""

    background: str = ""
    programming_level: int = Field(default=1, ge=0, le=4)
    python_level: int = Field(default=1, ge=0, le=4)
    agent_level: int = Field(default=1, ge=0, le=4)
    rag_level: int = Field(default=1, ge=0, le=4)
    engineering_level: int = Field(default=1, ge=0, le=4)
    time_budget_hours: int = Field(default=24, ge=1, le=200)
    learning_preference: str = "可运行示例与分步练习"
    constraints: list[str] = Field(default_factory=list)


class PersonalizeFeedback(BaseModel):
    """学习者完成当前资源后的结构化反馈。"""

    learner_profile_id: str = Field(min_length=1, max_length=128)
    quiz_score: float = Field(ge=0.0, le=1.0)
    confidence: int = Field(ge=1, le=5)
    free_text: str | None = Field(default=None, max_length=1000)
    concept_scores: dict[str, Annotated[float, Field(ge=0.0, le=1.0)]] = Field(default_factory=dict)


class PersonalizeGenerateRequest(BaseModel):
    """Spring Boot → ai-service 的内部个性化生成请求。"""

    userId: str = Field(min_length=1, max_length=64)
    learningGoal: str = Field(min_length=1, max_length=500)
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)
    modelConfig: PersonalizeModelConfig | None = None


class CompareProfileSpec(BaseModel):
    """同题异人对比的一列：preset_id 用预设画像，否则用 name+profile 临时画像。"""

    preset_id: str = ""
    name: str = Field(default="", max_length=64)
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)


class CompareRequest(BaseModel):
    """同题异人对比生成请求（赛题第五(1)款：不同背景学习者适配能力演示）。"""

    learningGoal: str = Field(min_length=1, max_length=500)
    profiles: list[CompareProfileSpec] = Field(min_length=2, max_length=4)
    modelConfig: PersonalizeModelConfig | None = None


class TutorHistoryItem(BaseModel):
    question_id: str
    selected_index: int = Field(ge=0, le=7)


class LectureExchange(BaseModel):
    """讲义导学的一轮已判分交互（引擎无状态，客户端每轮全量回传）。"""

    question: str = Field(default="", max_length=500)
    answer: str = Field(default="", max_length=2000)
    verdict: str = Field(default="", max_length=16)


class TutorRequest(BaseModel):
    """动态追问导学单轮请求（探测/降维/推进/进阶；lecture_text 非空走讲义驱动分支）。"""

    concept: str = Field(default="", max_length=64)
    history: list[TutorHistoryItem] = Field(default_factory=list, max_length=64)
    recommended_difficulty: str = "L2"
    # 讲义驱动路径：题从当前讲义节正文现生成；判分轮回传出题轮的 question/expected_points
    lecture_text: str = Field(default="", max_length=6000)
    scene_title: str = Field(default="", max_length=200)
    course_title: str = Field(default="", max_length=200)
    learner_answer: str = Field(default="", max_length=2000)
    question: str = Field(default="", max_length=500)
    expected_points: list[str] = Field(default_factory=list, max_length=8)
    lecture_history: list[LectureExchange] = Field(default_factory=list, max_length=32)
    prior_mastery: float | None = Field(default=None, ge=0.0, le=1.0)


class PersonalizeFollowupRequest(BaseModel):
    """Spring Boot → ai-service 的反馈二次生成请求。"""

    userId: str = Field(min_length=1, max_length=64)
    profile: PersonalizeProfile = Field(default_factory=PersonalizeProfile)
    parentRun: dict[str, Any]
    feedback: PersonalizeFeedback
    modelConfig: PersonalizeModelConfig | None = None


class ReviewCardState(BaseModel):
    """复习卡调度状态（FSRS，由调用方持久化）。空日期字符串 = 从未复习。"""

    item_id: str = Field(min_length=1, max_length=128)
    stability: float | None = None
    difficulty: float | None = None
    last_review: str = ""  # ISO date
    due: str = ""  # ISO date


class PlanConcept(BaseModel):
    """学习路径当前阶段的候选新概念（按优先序）。"""

    concept_id: str = Field(min_length=1, max_length=128)
    title: str = ""


class DailyPlanRequest(BaseModel):
    """今日计划组合请求（复习队列 + 路径概念由调用方传入，纯函数可复算）。"""

    plan_date: str = ""  # ISO date；空 = 服务器当天
    minutes_budget: int = Field(default=25, ge=5, le=200)
    review_cards: list[ReviewCardState] = Field(default_factory=list)
    next_concepts: list[PlanConcept] = Field(default_factory=list)
    concept_titles: dict[str, str] = Field(default_factory=dict)


class GradeReviewRequest(BaseModel):
    """FSRS 复习评分请求。AGAIN=1/HARD=2/GOOD=3/EASY=4。"""

    card: ReviewCardState
    rating: int = Field(ge=1, le=4)
    review_date: str = ""  # ISO date；空 = 服务器当天
