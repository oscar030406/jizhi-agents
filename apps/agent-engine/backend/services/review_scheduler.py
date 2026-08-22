"""错题/概念复习调度器 —— FSRS 算法的确定性最小移植（产品层「错题回炉」的心脏）。

算法：FSRS（Free Spaced Repetition Scheduler，新版 Anki 官方调度算法），基于
难度-稳定性-可提取性（DSR）记忆模型。核心公式逐行移植自 open-spaced-repetition/py-fsrs
（MIT License, Copyright (c) 2022 Open Spaced Repetition），仅保留长期调度路径，
去掉 optimizer/torch/短期学习步/模糊化——守极简门：零新依赖、纯确定性、可复算。

无状态设计：调用方（ai-service / Java 后端）持有卡片状态（stability/difficulty/last_review），
本模块只做纯函数变换，天然适配跨服务调用与单测。

评分语义（对接产品）：
    AGAIN=1 答错 / HARD=2 勉强对 / GOOD=3 答对 / EASY=4 秒杀
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date, timedelta

AGAIN, HARD, GOOD, EASY = 1, 2, 3, 4
_VALID_RATINGS = {AGAIN, HARD, GOOD, EASY}

# py-fsrs DEFAULT_PARAMETERS（v6，21 个权重）
_W = (
    0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
    1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
)
_DECAY = -_W[20]
_FACTOR = 0.9 ** (1 / _DECAY) - 1

STABILITY_MIN = 0.001
MIN_DIFFICULTY, MAX_DIFFICULTY = 1.0, 10.0
DESIRED_RETENTION = 0.9
MAXIMUM_INTERVAL_DAYS = 60  # 备赛场景：60 天封顶，别把复习排到比赛之后


@dataclass(frozen=True)
class ReviewCard:
    """一张复习卡的调度状态（由调用方持久化）。"""

    item_id: str
    stability: float | None = None  # None = 从未复习
    difficulty: float | None = None
    last_review: date | None = None
    due: date | None = None


def _clamp_stability(s: float) -> float:
    return max(s, STABILITY_MIN)


def _clamp_difficulty(d: float) -> float:
    return min(max(d, MIN_DIFFICULTY), MAX_DIFFICULTY)


def _initial_stability(rating: int) -> float:
    return _clamp_stability(_W[rating - 1])


def _initial_difficulty(rating: int, clamp: bool = True) -> float:
    d = _W[4] - math.e ** (_W[5] * (rating - 1)) + 1
    return _clamp_difficulty(d) if clamp else d


def retrievability(stability: float, elapsed_days: float) -> float:
    """可提取性 R(t)：当下还能答对的概率。"""
    if elapsed_days <= 0:
        return 1.0
    return (1 + _FACTOR * elapsed_days / stability) ** _DECAY


def _next_interval(stability: float) -> int:
    interval = (stability / _FACTOR) * ((DESIRED_RETENTION ** (1 / _DECAY)) - 1)
    return max(1, min(round(interval), MAXIMUM_INTERVAL_DAYS))


def _next_difficulty(difficulty: float, rating: int) -> float:
    arg_1 = _initial_difficulty(EASY, clamp=False)
    delta = -(_W[6] * (rating - 3))
    arg_2 = difficulty + (10.0 - difficulty) * delta / 9.0  # linear damping
    return _clamp_difficulty(_W[7] * arg_1 + (1 - _W[7]) * arg_2)  # mean reversion


def _next_forget_stability(difficulty: float, stability: float, r: float) -> float:
    long_term = (
        _W[11] * (difficulty ** -_W[12]) * (((stability + 1) ** _W[13]) - 1)
        * math.e ** ((1 - r) * _W[14])
    )
    short_term = stability / math.e ** (_W[17] * _W[18])
    return min(long_term, short_term)


def _next_recall_stability(difficulty: float, stability: float, r: float, rating: int) -> float:
    hard_penalty = _W[15] if rating == HARD else 1.0
    easy_bonus = _W[16] if rating == EASY else 1.0
    return stability * (
        1
        + math.e ** _W[8]
        * (11 - difficulty)
        * (stability ** -_W[9])
        * (math.e ** ((1 - r) * _W[10]) - 1)
        * hard_penalty
        * easy_bonus
    )


def review(card: ReviewCard, rating: int, today: date) -> ReviewCard:
    """复习一张卡：按 FSRS 更新 stability/difficulty，排定下次到期日。纯函数。"""
    if rating not in _VALID_RATINGS:
        raise ValueError(f"rating must be 1-4, got {rating}")

    if card.stability is None or card.difficulty is None or card.last_review is None:
        stability = _initial_stability(rating)
        difficulty = _initial_difficulty(rating)
    else:
        elapsed = max(0, (today - card.last_review).days)
        r = retrievability(card.stability, elapsed)
        difficulty = _next_difficulty(card.difficulty, rating)
        if rating == AGAIN:
            stability = _clamp_stability(_next_forget_stability(card.difficulty, card.stability, r))
        else:
            stability = _clamp_stability(_next_recall_stability(card.difficulty, card.stability, r, rating))

    return ReviewCard(
        item_id=card.item_id,
        stability=round(stability, 4),
        difficulty=round(difficulty, 4),
        last_review=today,
        due=today + timedelta(days=_next_interval(stability)),
    )


def due_cards(cards: list[ReviewCard], today: date, limit: int = 10) -> list[ReviewCard]:
    """今日到期的复习队列：过期最久/记忆最不稳的优先。从未复习的卡视为立即到期。"""

    def sort_key(card: ReviewCard) -> tuple:
        overdue = (today - card.due).days if card.due else 9999
        return (-overdue, card.stability or 0.0)

    due = [c for c in cards if c.due is None or c.due <= today]
    return sorted(due, key=sort_key)[:limit]
