"""动态追问导学：系统主动提问定位盲区，按答题实况裁决降维/追问/进阶。

赛题第五(4)款②「动态追问与启发式交互导学，打破静态资源的单向输入局限」的机制载体。
决策是可见的（decision.because 逐条给依据），题目与解释全部锚定课程语料（source_ids），
LLM 只做苏格拉底式改写（api 模式，失败回退题库原文，engine 如实标注）。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from backend.services.llm_gateway import llm_gateway

ROOT = Path(__file__).resolve().parents[2]
CURRICULUM_DIR = ROOT / "data" / "curriculum"

SOCRATIC_SYSTEM = (
    "你是启发式导学 Agent。把给定的检查题改写成一句自然的苏格拉底式追问，"
    "保持考点与选项完全不变，只改问句口吻（如“如果去掉X会怎样？”“你确定Y吗？”）。"
    '只输出 JSON：{"probe": str}。不得引入资料之外的事实。'
)

ADVANCE_STREAK = 3  # 连对 N 题 → 进阶挑战

# 目标正确率带（Wilson et al. 2019《The Eighty Five Percent Rule for optimal
# learning》，Nature Communications：最优训练正确率 ≈85%）。滚动窗口内正确率
# 高于带顶=内容偏易该进阶，低于带底=偏难该降维，带内=最近发展区维持探测。
# 这同时是「画像-资源难度适配」运行时口径（metric-calibers v1 口径 2B）的
# 测量埋点：带命中与否随 because 链落盘。
BAND_WINDOW = 5
BAND_HIGH = 0.85
BAND_LOW = 0.70


def _band_note(corrects: List[bool]) -> tuple[str, float]:
    window = corrects[-BAND_WINDOW:]
    acc = sum(window) / len(window)
    if acc > BAND_HIGH:
        pos = "高于目标带（内容偏易）"
    elif acc < BAND_LOW:
        pos = "低于目标带（内容偏难）"
    else:
        pos = "落在目标带内（难度适配）"
    return (
        f"近 {len(window)} 题正确率 {acc:.0%}，{pos}——目标带 70%-85%（Wilson 2019 最优学习正确率）",
        acc,
    )

# ---------------------------------------------------------------- 讲义驱动路径
# 概念题库路径只覆盖策展过语料的概念；任意生成课要靠它：从当前讲义节正文现生成
# 定向检查问题并对照原文判分。LLM 不可用时如实返回 unavailable，绝不编造题目。

LECTURE_AGENT = "ConversationTutor"  # fast 档路由（model_routing.AGENT_TIERS）
LECTURE_TEXT_CAP = 3000
LECTURE_VERDICTS = {"correct", "partial", "incorrect"}

LECTURE_ASK_SYSTEM = (
    "你是课堂导学 Agent。根据给定的讲义正文出 1 道定向检查问题，考察学习者是否真正理解本节内容。"
    "问题必须能从讲义正文找到依据，不得引入讲义之外的事实；优先考概念之间的关系或容易误解的点，"
    "不出死记硬背题，也不出选择题——要学习者用自己的话回答。"
    "严格按给定的「出题指令」调整难度与切入角度；「已问过的问题」一条都不许重复，换措辞也算重复。"
    '只输出 JSON：{"question": str, "expected_points": [str, ...]}。'
    "expected_points 是判分要点清单（2-4 条，每条一句话，逐条都要锚定讲义原文）。"
)

#: 按姿态档的措辞硬约束。**这一格 2026-08-13 之前是空的**——导学 prompt 只把
#: 「推荐难度 L1」当一句话塞进画像里，没有任何可执行的约束，模型照旧写长从句。
#:
#: 实测那一句（零基础档，导学的提问里）：
#:   「向量空间中的语义关系学习主要依赖于模型对大量文本上下文的**自监督学习**，
#:     通过**预测下一个词**的任务来学习语义表示，而非仅依赖训练数据中词语的表面**共现频率**。」
#: 三个未定义术语塞进一个从句，给的是刚被告知「不用代码和公式开场」的零基础学员。
#:
#: 讲义自撰区有 lint 兜（L1-TERM 等），**导学这条路 lint 从来没看过**：它是另一条
#: 路由、另一次生成。所以约束只能写进 prompt，判据与讲义侧 L1 硬要求同源。
_TIER_ASK_RULES: dict[str, str] = {
    "L1": (
        "【零基础档硬要求】"
        "①问题里出现的每个专业术语，必须在同一句里用一句大白话解释，不许裸用；"
        "②一个问句最多引入 1 个新术语——宁可拆成两句，也不许术语连发；"
        "③一个问句只问一件事，不许套多重从句"
        "（「主要依赖于…，通过…，而非…」这种连环从句要拆成两句）；"
        "④举例取日常生活场景（排队/做菜/找书），不用技术域例子起手。"
    ),
    "L2": (
        "【转行档要求】假设学习者会编程但没有本领域背景：技术名词可以直接用，"
        "但本领域的专有概念首次出现要一句话交代；类比优先用工程直觉（接口/缓存/日志）。"
    ),
    "L3": (
        "【进阶档要求】可直接进机制、取舍与边界条件，不必铺垫基础概念；"
        "优先问「什么情况下会失效」这类判断题，而不是复述定义。"
    ),
}


def _tier_ask_rules(recommended_difficulty: str) -> str:
    """姿态档 → 出题的措辞约束。档位读不出来时返回空串（保持旧行为，不瞎猜）。"""
    key = (recommended_difficulty or "").strip().upper()
    return _TIER_ASK_RULES.get(key, "")


LECTURE_GRADE_SYSTEM = (
    "你是课堂导学 Agent，负责对照讲义正文给学习者的回答判分。只依据讲义正文与判分要点，不引入外部事实。"
    '只输出 JSON：{"verdict": "correct|partial|incorrect", "because": [str, ...], "explanation": str, "quote": str}。'
    # 口径微调（2026-08-09，线上实测判分偏严）：旧版「表述含糊=partial」让同义转述
    # 被压档——判的是理解不是背诵，含糊与否不进判据，只数要点命中。
    "verdict 判据只看要点命中，不看措辞："
    "每条判分要点的核心意思都被覆盖=correct（同义转述、口语化、自己举的等价例子都算覆盖，不要求用讲义原词）；"
    "明确漏掉至少一条要点的核心意思=partial；答非所问或与讲义矛盾=incorrect。"
    "拿不准某条要点算不算覆盖时从宽计入，并在 because 里说明。"
    "because：逐条给出判分依据（命中了哪个要点、漏掉了哪个要点）。"
    "explanation：面向学习者的降维解释，用讲义里的原有说法把漏掉或说错的要点讲清楚。"
    "quote：从讲义正文里逐字摘一句最能支撑解释的原句；摘不出就留空，不许改写。"
)


class TutorHistoryItem(BaseModel):
    question_id: str
    selected_index: int


class LectureExchange(BaseModel):
    """讲义导学的一轮已判分交互。引擎无状态，客户端每轮全量回传。"""

    question: str
    answer: str = ""
    verdict: str = ""           # correct / partial / incorrect


class TutorRequest(BaseModel):
    concept: str = ""
    history: List[TutorHistoryItem] = Field(default_factory=list)
    recommended_difficulty: str = "L2"
    # 讲义驱动路径载荷：lecture_text 非空即走 lecture_tutor_turn 分支（题从当前讲义节现生成）。
    # 判分轮由客户端把出题轮拿到的 question/expected_points 连同 learner_answer 一起回传——引擎无状态。
    lecture_text: str = ""
    scene_title: str = ""
    course_title: str = ""
    learner_answer: str = ""
    question: str = ""
    expected_points: List[str] = Field(default_factory=list)
    # 多轮状态与画像：决策（降维/推进/进阶）靠这两项，与课程内容无关
    lecture_history: List[LectureExchange] = Field(default_factory=list)
    prior_mastery: Optional[float] = None  # 画像里本节概念的历史掌握度 0-1，None=没见过


class TutorQuestion(BaseModel):
    question_id: str
    lesson_id: str
    lesson_title: str
    probe: str                  # 呈现给学习者的问句（可能是苏格拉底改写）
    original_question: str      # 题库原文（防伪：改写不改考点）
    options: List[str]
    source_ids: List[str]
    engine: str                 # llm=改写成功 / deterministic=题库原文


class TutorExplanation(BaseModel):
    text: str
    section_heading: str
    section_excerpt: str
    source_ids: List[str]


class TutorDecision(BaseModel):
    type: str                   # probe / simplify / advance / challenge / complete
    because: List[str]          # 可见协同决策：逐条依据


class TutorTurn(BaseModel):
    decision: TutorDecision
    question: Optional[TutorQuestion] = None
    explanation: Optional[TutorExplanation] = None
    challenge: Optional[str] = None
    mastery_estimate: float = Field(ge=0.0, le=1.0, default=0.0)
    asked: int = 0
    correct: int = 0


class _PoolItem(BaseModel):
    question_id: str
    lesson_id: str
    lesson_title: str
    question: str
    options: List[str]
    answer_index: int
    explanation: str
    source_ids: List[str]
    section_heading: str
    section_excerpt: str
    order: int


def _load_pool(concept: str) -> List[_PoolItem]:
    path = CURRICULUM_DIR / f"{concept}.json"
    if not path.is_file():
        raise KeyError(f"没有该概念的课程语料：{concept}")
    course = json.loads(path.read_text(encoding="utf-8"))
    pool: List[_PoolItem] = []
    order = 0
    for ch in course.get("chapters", []):
        for lesson in ch.get("lessons", []):
            sections = lesson.get("sections", [])
            for qi, q in enumerate(lesson.get("check_understanding", [])):
                sec_idx = q.get("after_section", -1)
                # after_section=-1 表示"课末题"，应锚到最后一节而非第一节；负索引天然指向末尾。
                sec = sections[sec_idx] if sections and -len(sections) <= sec_idx < len(sections) else {}
                body = sec.get("body_md", "")
                pool.append(_PoolItem(
                    question_id=f"{lesson['lesson_id']}#q{qi}",
                    lesson_id=lesson["lesson_id"],
                    lesson_title=lesson["title"],
                    question=q["question"],
                    options=list(q["options"]),
                    answer_index=int(q["answer_index"]),
                    explanation=q.get("explanation", ""),
                    source_ids=list(q.get("source_ids", [])),
                    section_heading=sec.get("heading", ""),
                    section_excerpt=body[:400],
                    order=order,
                ))
                order += 1
    if not pool:
        raise KeyError(f"课程 {concept} 没有检查题可用作导学探测")
    return pool


def _socratic_probe(item: _PoolItem) -> tuple[str, str]:
    """api 模式下把题干改写成追问口吻；失败回退原文。返回 (probe, engine)。"""
    if not llm_gateway.is_enabled("LearnerDiagnosisAgent"):
        return item.question, "deterministic"
    user = f"检查题：{item.question}\n选项：{item.options}\n锚定小节：{item.section_heading}"
    parsed = llm_gateway.structured_chat(
        "LearnerDiagnosisAgent", SOCRATIC_SYSTEM, user, max_tokens=300, temperature=0.3)
    probe = (parsed or {}).get("probe", "")
    if isinstance(probe, str) and probe.strip():
        return probe.strip(), "llm"
    return item.question, "deterministic"


def _to_question(item: _PoolItem) -> TutorQuestion:
    probe, engine = _socratic_probe(item)
    return TutorQuestion(
        question_id=item.question_id,
        lesson_id=item.lesson_id,
        lesson_title=item.lesson_title,
        probe=probe,
        original_question=item.question,
        options=item.options,
        source_ids=item.source_ids,
        engine=engine,
    )


def tutor_turn(request: TutorRequest) -> TutorTurn:
    pool = _load_pool(request.concept)
    by_id: Dict[str, _PoolItem] = {p.question_id: p for p in pool}

    graded = [(h, by_id[h.question_id]) for h in request.history if h.question_id in by_id]
    asked_ids = {h.question_id for h, _ in graded}
    corrects = [h.selected_index == item.answer_index for h, item in graded]
    asked, correct = len(corrects), sum(corrects)
    mastery = correct / asked if asked else 0.0
    remaining = [p for p in pool if p.question_id not in asked_ids]

    # 首轮：主动探测（从课程最早的考点开始，打破单向输入——是系统在问学习者）
    if not graded:
        item = remaining[0]
        return TutorTurn(
            decision=TutorDecision(type="probe", because=[
                f"初始定位：无作答历史，从「{item.lesson_title}」的最早考点开始探测盲区",
                f"诊断推荐难度 {request.recommended_difficulty}",
            ]),
            question=_to_question(item), mastery_estimate=0.0, asked=0, correct=0)

    last_h, last_item = graded[-1]
    last_correct = corrects[-1]

    band_line, band_acc = _band_note(corrects)

    # 答错 → 降维解释（引用锚定小节）+ 换一题再探
    if not last_correct:
        followup = next((p for p in remaining if p.lesson_id == last_item.lesson_id), None) \
            or (remaining[0] if remaining else None)
        return TutorTurn(
            decision=TutorDecision(type="simplify", because=[
                f"上一题（{last_item.question_id}）答错，选了第 {last_h.selected_index + 1} 项",
                f"盲区定位到小节「{last_item.section_heading}」，先降维解释再追问",
                f"当前掌握度估计 {mastery:.2f}（{correct}/{asked}）",
                band_line,
            ]),
            explanation=TutorExplanation(
                text=last_item.explanation,
                section_heading=last_item.section_heading,
                section_excerpt=last_item.section_excerpt,
                source_ids=last_item.source_ids,
            ),
            question=_to_question(followup) if followup else None,
            mastery_estimate=mastery, asked=asked, correct=correct)

    # 连对或滚动正确率冲破带顶 → 进阶挑战（指向判题练习/实操，不再喂选择题）
    streak = 0
    for ok in reversed(corrects):
        if not ok:
            break
        streak += 1
    band_break = len(corrects) >= 4 and band_acc > BAND_HIGH
    if streak >= ADVANCE_STREAK or band_break or not remaining:
        trigger = (
            f"连对 {streak} 题" if streak >= ADVANCE_STREAK
            else f"滚动正确率 {band_acc:.0%} 冲破带顶" if band_break
            else "题池已探完"
        )
        return TutorTurn(
            decision=TutorDecision(type="challenge" if remaining else "complete", because=[
                f"{trigger}，掌握度估计 {mastery:.2f}——继续喂选择题是浪费",
                band_line,
                "决策：转入进阶挑战（该课判题练习/实操任务）",
            ]),
            challenge=f"进入「{last_item.lesson_title}」的判题练习与实操任务（learn 页对应课时）",
            mastery_estimate=mastery, asked=asked, correct=correct)

    # 答对但未到挑战线 → 顺序推进，往后面的课时探
    nxt = next((p for p in remaining if p.order > last_item.order), remaining[0])
    return TutorTurn(
        decision=TutorDecision(type="advance", because=[
            f"上一题答对（连对 {streak}），掌握度估计 {mastery:.2f}",
            band_line,
            f"推进到「{nxt.lesson_title}」继续探测",
        ]),
        question=_to_question(nxt), mastery_estimate=mastery, asked=asked, correct=correct)


class ProfileEvidence(BaseModel):
    """画像滚动修订证据（对标 CogEvo-Edu 置信度加权画像演化，arXiv 2512.00331）。

    导学判分是画像最新鲜的证据源——每轮判分产出一条带置信度的概念级证据，
    客户端按置信度加权写回 learnerProfile.conceptMastery，下次生成读修订后
    画像。引擎只出证据不直写画像（画像归属权在客户端会话层）。
    """

    concept: str                # 证据指向的概念（当前讲义节标题）
    verdict: str                # correct / partial / incorrect
    confidence: float           # 判分明确度：correct/incorrect 0.8，partial 0.5
    evidence: str               # 一句话依据（取判分 because 首条）


class LectureTutorTurn(BaseModel):
    mode: str                   # ask=出题 / verdict=判分 / unavailable=LLM 不可用（诚实降级）
    question: str = ""
    expected_points: List[str] = Field(default_factory=list)
    verdict: str = ""           # correct / partial / incorrect（仅 verdict 态）
    because: List[str] = Field(default_factory=list)
    explanation: str = ""       # 降维解释（仅 verdict 态）
    quote: str = ""             # 讲义原句引用；引不出原文一律留空
    engine: str = "llm"
    profile_evidence: Optional[ProfileEvidence] = None  # 仅 verdict 态
    # 可见决策：这一轮为什么出这种题 / 判完分下一步走哪（probe/simplify/advance/challenge）
    decision_type: str = "probe"
    mastery_estimate: float = 0.0
    asked: int = 0
    correct: int = 0


def _lecture_unavailable(reason: str) -> LectureTutorTurn:
    return LectureTutorTurn(mode="unavailable", engine="unavailable", because=[reason])


# 掌握度按档记分；目标正确率带只数 correct（partial 不算对，带口径偏保守）
_VERDICT_SCORE = {"correct": 1.0, "partial": 0.5, "incorrect": 0.0}

_ASK_INTENT = {
    "probe": "定向检查问题",
    "simplify": "降维小切口问题",
    "advance": "推进问题",
    "challenge": "进阶应用题",
}


def _lecture_decision(corrects: List[bool]) -> tuple[str, str, str]:
    """按本节已判分历史裁决下一步。返回 (decision_type, 出题指令, 目标带说明)。

    课程无关：只看答对与否的序列 + Wilson 目标带，不看课上的是什么内容。
    """
    if not corrects:
        return "probe", "这是本节第一问：挑本节最核心的概念出题，先探底，不刻意压难度。", ""
    band_line, band_acc = _band_note(corrects)
    streak = 0
    for ok in reversed(corrects):
        if not ok:
            break
        streak += 1
    if not corrects[-1]:
        return ("simplify",
                "上一问学习者没答到位：换一个更基础的切入点重问同一个知识点，把问题拆小、拆具体，先补漏再推进。",
                band_line)
    if streak >= ADVANCE_STREAK or (len(corrects) >= 4 and band_acc > BAND_HIGH):
        return ("challenge",
                "学习者连续答对：出一道进阶应用题，要求把本节概念用到讲义没直接给出的新情境里。",
                band_line)
    if len(corrects) >= 3 and band_acc < BAND_LOW:
        return ("simplify",
                "上一问虽然答对，但滚动正确率低于目标带：这一问不要加难度，换个更具体的小切口巩固。",
                band_line)
    return ("advance", "学习者上一问答对：换一个还没考察过的角度继续推进。", band_line)


def lecture_tutor_turn(request: TutorRequest, gateway=None) -> LectureTutorTurn:
    """讲义驱动导学：出题/判分/决策全部只吃「这一节讲了什么」+ 画像 + 对话历史。

    不读任何课程生成期预制的导学字段，所以任意一门没见过的课扔进来都能跑。
    出题轮（无 learner_answer）：讲义正文 + 决策指令 → 1 道定向问题 + 判分要点清单。
    判分轮（有 learner_answer）：对照讲义正文与要点判 correct/partial/incorrect，
    because 逐条给依据，降维解释引讲义原句（引不出原文的引用直接丢弃），
    并按目标正确率带（Wilson 70-85%）裁决下一步降维/推进/进阶。
    LLM 不可用或输出不合法 → mode=unavailable，不编题不猜分。
    """
    gw = gateway or llm_gateway
    if not gw.is_enabled(LECTURE_AGENT):
        return _lecture_unavailable(
            "LLM 路由未启用（AGENT_GENERATION_MODE≠api 或缺 key）——讲义驱动探问必须真模型出题，不编造题目")
    text = " ".join(request.lecture_text.split())[:LECTURE_TEXT_CAP]
    header = (
        f"课程：{request.course_title or '（未提供）'}\n"
        f"当前小节：{request.scene_title or '（未提供）'}\n"
        f"讲义正文：\n{text}"
    )
    verdicts = [h.verdict for h in request.lecture_history if h.verdict in LECTURE_VERDICTS]
    corrects = [v == "correct" for v in verdicts]

    def _stats(vs: List[str]) -> tuple[float, int, int]:
        if not vs:
            return 0.0, 0, 0
        return (sum(_VERDICT_SCORE[v] for v in vs) / len(vs), len(vs), sum(v == "correct" for v in vs))

    if request.learner_answer.strip():
        points = "\n".join(f"- {p}" for p in request.expected_points) or "（未提供，直接对照讲义正文判）"
        user = (
            f"{header}\n\n检查问题：{request.question}\n判分要点：\n{points}\n\n"
            f"学习者的回答：{request.learner_answer.strip()}"
        )
        parsed = gw.structured_chat(LECTURE_AGENT, LECTURE_GRADE_SYSTEM, user, max_tokens=900, temperature=0.2)
        verdict = str((parsed or {}).get("verdict", "")).strip().lower()
        if verdict not in LECTURE_VERDICTS:
            return _lecture_unavailable("判分模型未返回合法裁决——不猜测对错，本轮如实中止")
        because = [str(b).strip() for b in (parsed.get("because") or []) if str(b).strip()]
        quote = str(parsed.get("quote") or "").strip()
        if quote and quote not in text:
            quote = ""  # 锚定讲义原文是硬约束：引不出原句就不展示引用
        decision_type, _, band_line = _lecture_decision(corrects + [verdict == "correct"])
        mastery, asked, correct = _stats(verdicts + [verdict])
        return LectureTutorTurn(
            mode="verdict", verdict=verdict,
            because=(because or [f"模型裁决为 {verdict}，未给出细则"])
            + ([band_line] if band_line else [])
            + [f"下一步：{_ASK_INTENT[decision_type]}"],
            explanation=str(parsed.get("explanation") or "").strip(),
            quote=quote, question=request.question,
            expected_points=list(request.expected_points),
            decision_type=decision_type, mastery_estimate=mastery, asked=asked, correct=correct,
            profile_evidence=ProfileEvidence(
                concept=request.scene_title or request.course_title or "未命名小节",
                verdict=verdict,
                confidence=0.5 if verdict == "partial" else 0.8,
                evidence=(because[0] if because else f"判分 {verdict}"),
            ))

    decision_type, steer, band_line = _lecture_decision(corrects)
    profile_bits = [f"推荐难度 {request.recommended_difficulty}"]
    if request.prior_mastery is not None:
        profile_bits.append(f"本节历史掌握度 {request.prior_mastery:.0%}（越低越要从基础问起）")
    asked_before = "\n".join(f"- {h.question}" for h in request.lecture_history if h.question.strip())
    tier_rules = _tier_ask_rules(request.recommended_difficulty)
    user = (
        f"{header}\n\n学习者画像：{'；'.join(profile_bits)}\n出题指令：{steer}"
        # 姿态档约束跟在出题指令后面：出题指令管「问什么」，这条管「怎么说」。
        # 两者分开写，是因为 decision_type 会变（probe/simplify/advance/challenge），
        # 而措辞档位不随答题实况变——降维是换切口，不是换读者。
        + (f"\n{tier_rules}" if tier_rules else "")
        + (f"\n已问过的问题：\n{asked_before}" if asked_before else "")
    )
    parsed = gw.structured_chat(LECTURE_AGENT, LECTURE_ASK_SYSTEM, user, max_tokens=600, temperature=0.3)
    question = str((parsed or {}).get("question") or "").strip()
    if not question:
        return _lecture_unavailable("出题模型未返回有效问题——不用兜底模板凑题，本轮如实中止")
    points = [str(p).strip() for p in ((parsed or {}).get("expected_points") or []) if str(p).strip()][:4]
    mastery, asked, correct = _stats(verdicts)
    return LectureTutorTurn(
        mode="ask", question=question, expected_points=points,
        decision_type=decision_type, mastery_estimate=mastery, asked=asked, correct=correct,
        because=[f"从当前讲义节「{request.scene_title or request.course_title or '未命名'}」"
                 f"现生成{_ASK_INTENT[decision_type]}：{steer}"]
        + ([band_line] if band_line else []))
