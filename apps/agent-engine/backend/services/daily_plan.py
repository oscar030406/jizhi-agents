"""每日计划组合器（产品层「今日计划」卡的心脏）——确定性、可复算、无状态。

配方（借鉴多邻国 Daily Goal + 学而思每日任务，落在实施意图/目标设定理论上）：
    到期复习优先（FSRS 队列，防遗忘是刚性任务）→ 1 个新知识点（来自学习路径当前阶段）
    → 时间有余则加 1 道挑战题。总时长贴合用户承诺的每日预算——
    「完成今天的 25 分钟」永远比「学完一章」容易开始。

无状态：复习队列与路径由调用方传入，本模块只做纯函数组合，便于跨服务调用与单测。
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from backend.services.review_scheduler import ReviewCard, due_cards

# 三个用时是**工程估值，未经实测标定**（如实记录，2026-08-28 清查 L2）：
# 复习卡 3 分钟≈间隔重复类产品的单卡节奏量级；新概念 12 分钟≈一屏讲义+一道
# 检查题的估读写时长；挑战 8 分钟为二者之间取值。它们只决定「今日约 N 分钟」
# 的展示预算与条目配比，不进任何对外指标；要标定应回收真实停留时长再回填。
REVIEW_MINUTES_PER_CARD = 3
NEW_CONCEPT_MINUTES = 12
CHALLENGE_MINUTES = 8
REVIEW_TIME_CAP_RATIO = 0.5  # 复习最多占预算一半，保证每天都有新内容的获得感


class PlanItem(BaseModel):
    item_type: str  # review | new_concept | challenge
    title: str
    concept: str = ""
    ref_id: str = ""  # 复习项=卡片id；新知识=概念id
    estimated_minutes: int = Field(ge=1)


class DailyPlan(BaseModel):
    plan_date: str
    total_minutes: int
    items: list[PlanItem] = Field(default_factory=list)
    encouragement: str = ""
    review_count: int = 0
    has_new_concept: bool = False


def build_daily_plan(
    today: date,
    minutes_budget: int,
    review_cards: list[ReviewCard],
    next_concepts: list[tuple[str, str]],  # [(concept_id, 标题)] 路径当前阶段未掌握概念，按优先序
    concept_titles: dict[str, str] | None = None,
) -> DailyPlan:
    """按时长预算组合今日计划。纯函数：同输入必同输出。"""
    minutes_budget = max(10, min(minutes_budget, 120))
    concept_titles = concept_titles or {}
    items: list[PlanItem] = []
    used = 0

    # 1) 到期复习（FSRS 队列，最多占预算一半）
    review_budget = int(minutes_budget * REVIEW_TIME_CAP_RATIO)
    max_reviews = max(1, review_budget // REVIEW_MINUTES_PER_CARD)
    todays_due = due_cards(review_cards, today, limit=max_reviews)
    for card in todays_due:
        title = concept_titles.get(card.item_id, card.item_id)
        items.append(
            PlanItem(
                item_type="review",
                title=f"错题回炉：{title}",
                concept=card.item_id,
                ref_id=card.item_id,
                estimated_minutes=REVIEW_MINUTES_PER_CARD,
            )
        )
        used += REVIEW_MINUTES_PER_CARD

    # 2) 一个新知识点（时间够才排，保证不过载）
    has_new = False
    if next_concepts and used + NEW_CONCEPT_MINUTES <= minutes_budget:
        concept_id, title = next_concepts[0]
        items.append(
            PlanItem(
                item_type="new_concept",
                title=f"新知识：{title}",
                concept=concept_id,
                ref_id=concept_id,
                estimated_minutes=NEW_CONCEPT_MINUTES,
            )
        )
        used += NEW_CONCEPT_MINUTES
        has_new = True

    # 3) 时间有余加一道挑战题（合意困难）
    if has_new and used + CHALLENGE_MINUTES <= minutes_budget:
        concept_id, title = next_concepts[0]
        items.append(
            PlanItem(
                item_type="challenge",
                title=f"进阶挑战：{title} 变式题",
                concept=concept_id,
                ref_id=concept_id,
                estimated_minutes=CHALLENGE_MINUTES,
            )
        )
        used += CHALLENGE_MINUTES

    # 空计划兜底：至少给一个新知识点，避免「今天没事做」
    if not items and next_concepts:
        concept_id, title = next_concepts[0]
        items.append(
            PlanItem(
                item_type="new_concept",
                title=f"新知识：{title}",
                concept=concept_id,
                ref_id=concept_id,
                estimated_minutes=min(NEW_CONCEPT_MINUTES, minutes_budget),
            )
        )
        used += items[-1].estimated_minutes
        has_new = True

    encouragement = _encouragement(len(todays_due), has_new, used)
    return DailyPlan(
        plan_date=today.isoformat(),
        total_minutes=used,
        items=items,
        encouragement=encouragement,
        review_count=len(todays_due),
        has_new_concept=has_new,
    )


def _encouragement(review_count: int, has_new: bool, minutes: int) -> str:
    if review_count and has_new:
        return f"今天 {minutes} 分钟：先把 {review_count} 个旧知识点焊牢，再推进一步。完成就是胜利。"
    if review_count:
        return f"今天是巩固日：{review_count} 个到期知识点，趁记忆还热把它们焊牢。"
    if has_new:
        return f"没有欠账，轻装上阵：{minutes} 分钟拿下一个新知识点。"
    return "今天的路径已全部完成，去挑战页看看进阶任务？"
