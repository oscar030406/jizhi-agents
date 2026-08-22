"""画像申诉（negotiated OLM，Bull & Kay SMILI 范式，见 docs/personalization_research.md §1.3）。

学习者说「这一维我其实会」→ 系统出 2 道对应概念、对应目标档位的验证题 →
全对才改档，且改动走 LearnerStateStore 单写者留审计（谁改的/依据哪两题）。
比 editable（随便改）保画像质量，比 inspectable（只能看）给学习者控制权。
题源复用前测题库——不新造题，难度经 1PL 定标。
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from backend.services.data_loader import load_pretest_questions

# 画像维度 → 前测题概念标签（题库五维各 6 题，programming/python 已有直接概念题，
# 不再用邻近概念代理；bool 位保留 proxy 标注机制备用）。
_DIMENSION_CONCEPTS: dict[str, tuple[list[str], bool]] = {
    "agent": (["agent_basics", "tool_calling", "langgraph"], False),
    "rag": (["rag"], False),
    "engineering": (["deployment", "guardrails", "evaluation"], False),
    "programming": (["programming"], False),
    "python": (["python"], False),
}

# 目标档位 → 验证题难度（申诉 N 档 → 用 N 档语义附近的题验证）
_LEVEL_DIFFICULTY = {1: "L1", 2: "L2", 3: "L3", 4: "L4"}


class AppealQuestion(BaseModel):
    id: str
    question: str
    options: dict[str, str]
    concept_tags: list[str]
    difficulty: str


class AppealChallenge(BaseModel):
    dimension: str
    claimed_level: int = Field(ge=1, le=4)
    questions: list[AppealQuestion]
    proxy_note: str = ""  # programming/python 用邻近概念题近似时如实标注


class AppealVerdict(BaseModel):
    dimension: str
    claimed_level: int
    passed: bool
    correct: int
    total: int
    because: list[str] = Field(default_factory=list)  # 审计链：逐题对错


def build_appeal_challenge(dimension: str, claimed_level: int) -> AppealChallenge:
    """出 2 道验证题：维度对应概念 × 目标档位难度；不足则放宽到相邻难度。"""
    concepts, is_proxy = _DIMENSION_CONCEPTS.get(dimension, ([], False))
    if not concepts:
        raise ValueError(f"不支持申诉的维度：{dimension}")
    claimed_level = max(1, min(4, claimed_level))
    want = _LEVEL_DIFFICULTY[claimed_level]
    pool = [q for q in load_pretest_questions()
            if set(q.concept_tags) & set(concepts)]
    exact = [q for q in pool if q.difficulty == want]
    picked = (exact + [q for q in pool if q not in exact])[:2]
    if len(picked) < 2:
        raise ValueError(f"题库不足以验证 {dimension} 档 {claimed_level}")
    return AppealChallenge(
        dimension=dimension,
        claimed_level=claimed_level,
        questions=[
            AppealQuestion(
                id=q.id, question=q.question, options=dict(q.options),
                concept_tags=list(q.concept_tags), difficulty=q.difficulty,
            )
            for q in picked
        ],
        proxy_note=(
            f"{dimension} 维无直接概念题，用 {'/'.join(concepts)} 的代码语义题近似验证"
            if is_proxy else ""
        ),
    )


def grade_appeal(dimension: str, claimed_level: int,
                 answers: dict[str, str]) -> AppealVerdict:
    """判申诉：出题时的题目全对才通过。because 链逐题记录，供审计与前端回执。"""
    challenge = build_appeal_challenge(dimension, claimed_level)
    key = {q.id: q for q in load_pretest_questions()}
    because: list[str] = []
    correct = 0
    for q in challenge.questions:
        given = (answers.get(q.id) or "").strip().upper()
        truth = key[q.id].answer
        ok = given == truth
        correct += int(ok)
        because.append(f"{q.id}（{q.difficulty}）：答 {given or '空'}，{'✓ 正确' if ok else f'✗ 应为 {truth}'}")
    passed = correct == len(challenge.questions)
    because.append(
        f"判定：{correct}/{len(challenge.questions)} 全对才改档 → "
        + (f"通过，{dimension} 档可调至 {claimed_level}" if passed else "未通过，档位维持")
    )
    return AppealVerdict(
        dimension=dimension, claimed_level=claimed_level,
        passed=passed, correct=correct, total=len(challenge.questions),
        because=because,
    )
