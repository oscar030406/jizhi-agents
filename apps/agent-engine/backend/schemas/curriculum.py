"""策展课程库 schema（产品层「真讲义」，市场调研 §六 决策的落地）。

设计来源（docs/market_research_ai_learning_platforms.md）：
- 课时解剖学照 Google MLCC：目标 → 正文（逐段引用）→ 即时反馈选择题 → 术语 → 动手；
- 内容配比图文为主，视频只嵌 B 站官方号 iframe（uid 白名单，合规做成数据结构）；
- 生产方式=人写脚手架（课程大纲）+ LLM 即兴（正文）+ 审核门禁（引用覆盖 + judge 复核）。

课程 JSON 是静态资产（生成一次、入库、可审计），不是运行时生成——
这保证「平台上的每一课都经过七智流水线生产并审核」的答辩口径可复算。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class VideoIntro(BaseModel):
    """课程/课时的官方源视频引子。只允许白名单官方账号（调研 §五 第一档）。"""

    bvid: str
    title: str
    account: str  # B 站账号名
    uid: str  # 账号 uid（白名单核验依据）
    duration_hint: str = ""  # 如 "12min"
    license_note: str = "经 B 站官方外链播放器嵌入，源为版权方官方账号"


class Section(BaseModel):
    """正文小节：body_md 内每个自然段末尾带 [source_id] 引用标记。"""

    heading: str
    body_md: str
    source_ids: list[str] = Field(default_factory=list)


class CheckQuestion(BaseModel):
    """内嵌即时反馈选择题（MLCC 'Check Your Understanding'）。

    after_section：穿插位——渲染在第 N 小节（0 起）之后辅助理解；-1=课时末尾。"""

    question: str
    options: list[str] = Field(min_length=2, max_length=4)
    answer_index: int = Field(ge=0)
    explanation: str
    source_ids: list[str] = Field(default_factory=list)
    after_section: int = Field(default=-1, ge=-1)


class KeyTerm(BaseModel):
    term: str
    definition: str
    source_id: str = ""


class HandsOn(BaseModel):
    """动手任务：前期给判题式引导，后期只给验收标准（Codecademy 二分，机制 #9）。"""

    title: str
    instructions_md: str
    acceptance_criteria: list[str] = Field(default_factory=list)
    colab_hint: str = ""  # 外部环境提示（不自建沙盒，调研 §六.4）


class TestCase(BaseModel):
    """判题用例（LeetCode 形制）：expression 在提交代码的命名空间里求值，
    repr 与 expected_repr 完全一致即通过。hidden=True 的用例前端只显示通过/失败。"""

    name: str
    expression: str  # 如 "predict_next(counts, 'the')"
    expected_repr: str  # 如 "'cat'"
    hidden: bool = False
    weight: int = Field(default=1, ge=1)  # capstone 计分用；练习题一律 1


class GradedExercise(BaseModel):
    """课时判题练习（浏览器内 Pyodide 运行，纯标准库）。
    入库门禁：solution_code 必须通过全部用例，starter_code 必须至少挂一个用例。"""

    exercise_id: str
    title: str
    prompt_md: str
    function_name: str
    starter_code: str
    test_cases: list[TestCase] = Field(min_length=3)
    solution_code: str  # 学习产品口径：随包发布（拉帘子不加密），服务端判分是升级路径
    hints: list[str] = Field(default_factory=list)


class InteractiveEmbed(BaseModel):
    """交互教具嵌入（如 poloclub transformer-explainer，MIT）。"""

    name: str
    url: str
    license_note: str = ""
    guide: str = ""  # 建议学习者在教具里做什么


class Capstone(BaseModel):
    """项目（Kaggle 形制）：public 用例实时可见分，private 用例交卷揭晓，
    加权得分 = Σ(通过用例权重)/Σ(全部权重)×100。人工策展 + 机器验证入库。

    level：分级阶梯——L1 入门（跑通即结业线）/ L2 进阶 / L3 求职级。"""

    project_id: str = ""
    level: str = "L1"
    level_note: str = ""  # 这一级对应什么人群/能力（如「大一零基础：能跑通即达结业线」）
    title: str
    brief_md: str
    dataset_name: str = ""
    dataset_code: str = ""  # 以 Python 字面量形式内置的小数据集（如唐诗语料 list）
    starter_code: str
    test_cases: list[TestCase] = Field(min_length=4)  # 含 hidden(private) 与非 hidden(public)
    solution_code: str
    pass_score: int = 60
    excellent_score: int = 85
    open_ended_md: str = ""  # 浏览器判不了的开放部分（如真机训练），给验收标准清单


class LessonAudit(BaseModel):
    """课时审核结果（生产流水线落盘，答辩可指认）。"""

    sections_total: int = 0
    sections_supported: int = 0
    citation_coverage: float = 0.0  # 带有效引用的小节比例
    judge_model: str = ""
    notes: list[str] = Field(default_factory=list)


class Lesson(BaseModel):
    lesson_id: str
    title: str
    estimated_minutes: int = Field(ge=3, le=60)  # 学期课口径：45min/节（用户定标）
    objectives: list[str] = Field(min_length=2)
    video_intro: VideoIntro | None = None
    interactive_embed: InteractiveEmbed | None = None
    sections: list[Section] = Field(min_length=2)
    check_understanding: list[CheckQuestion] = Field(min_length=1)
    key_terms: list[KeyTerm] = Field(default_factory=list)
    hands_on: HandsOn | None = None  # 无判题的开放任务（脚手架渐撤后期用）
    graded_exercise: GradedExercise | None = None  # LeetCode 式判题练习
    audit: LessonAudit = Field(default_factory=LessonAudit)


class Reference(BaseModel):
    """课程参考与延伸条目（书/视频/代码仓），课程页底部展示——
    喜欢听课的用户由此跳转官方视频/录播（合规源：官方号、开源仓、出版社）。"""

    kind: str  # book / video / repo / tool
    title: str
    note: str = ""
    url: str = ""


class Chapter(BaseModel):
    """章：学期课的组织单元（模块 → 章 → 45min 节）。"""

    chapter_id: str
    title: str
    intro: str = ""
    lessons: list[Lesson] = Field(min_length=1)


class GeneratedBy(BaseModel):
    mode: str  # api / deterministic
    generator_model: str = ""
    judge_model: str = ""
    date: str = ""
    pipeline: str = "retrieve → generate(grounded) → citation-gate → judge-audit"


class Course(BaseModel):
    course_id: str
    title: str
    tagline: str = ""
    difficulty: str = "L1"
    prerequisites: list[str] = Field(default_factory=list)
    minutes_total: int = 0
    knowledge_source: str = "hello-agents（datawhalechina，CC BY-NC-SA 4.0，署名见各节引用）"
    generated_by: GeneratedBy
    video_intro: VideoIntro | None = None
    chapters: list[Chapter] = Field(default_factory=list)  # 学期课形态（v2）
    lessons: list[Lesson] = Field(default_factory=list)  # 扁平形态（短课/旧资产，chapters 为空时用）
    final_quiz: list[CheckQuestion] = Field(default_factory=list)
    capstone: Capstone | None = None  # 单项目形态（旧资产）
    projects: list[Capstone] = Field(default_factory=list)  # 分级项目阶梯 L1→L3（v2）
    theory_exam: list[CheckQuestion] = Field(default_factory=list)  # 结业理论卷（面试题库出题）
    textbooks: list[str] = Field(default_factory=list)  # 引用教材登记表条目（title）
    references: list[Reference] = Field(default_factory=list)  # 参考与延伸（书/官方视频/代码仓）

    def all_lessons(self) -> list[Lesson]:
        if self.chapters:
            return [lesson for ch in self.chapters for lesson in ch.lessons]
        return self.lessons


class TextbookEntry(BaseModel):
    """教材登记（把授权做成数据结构：站底与课程页展示，评委可查）。"""

    title: str
    author: str = ""
    source: str = ""  # 出版社 / GitHub repo
    license_basis: str  # 开源协议名 / 高校教学授权 / 公版
    usage: str  # 正文语料（逐句引用） / 深度骨架参照 / 判题出题参照
    ingested: bool = False  # 是否已进知识库（参照类=False）


class CatalogConcept(BaseModel):
    """目录条目（含守门关键词：目标输入未命中任何概念时，前端展示目录而非乱生成）。"""

    concept_id: str
    title: str
    difficulty: str
    prerequisites: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)
    course_available: bool = False
    tagline: str = ""
    minutes_total: int = 0
    lesson_count: int = 0


class Catalog(BaseModel):
    """data/curriculum/catalog.json：目录 + 守门关键词 + 视频白名单 + 教材登记，均由引擎侧生成保持单一事实源。"""

    concepts: list[CatalogConcept]
    video_account_whitelist: list[dict[str, str]] = Field(default_factory=list)
    textbook_registry: list[TextbookEntry] = Field(default_factory=list)
    generated_date: str = ""
