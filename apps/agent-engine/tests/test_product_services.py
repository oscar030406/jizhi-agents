"""产品层三件套测试：FSRS 复习调度 / 每日计划 / 学习模式（PLAYBOOK 产品层）。"""

from datetime import date, timedelta

from backend.services.daily_plan import build_daily_plan
from backend.services.learning_mode import DEFAULT_MODE, all_modes, resolve_learning_mode
from backend.services.review_scheduler import (
    AGAIN,
    EASY,
    GOOD,
    HARD,
    ReviewCard,
    due_cards,
    retrievability,
    review,
)

TODAY = date(2026, 7, 9)


# ---------------------------------------------------------------- FSRS 调度

def test_first_review_initializes_state_and_due():
    card = review(ReviewCard(item_id="rag"), GOOD, TODAY)
    assert card.stability is not None and card.difficulty is not None
    assert card.last_review == TODAY
    assert card.due is not None and card.due > TODAY


def test_again_schedules_sooner_than_easy():
    """答错的卡应比秒杀的卡更快回炉——间隔重复的最基本性质。"""
    wrong = review(ReviewCard(item_id="a"), AGAIN, TODAY)
    aced = review(ReviewCard(item_id="b"), EASY, TODAY)
    assert wrong.due < aced.due
    assert wrong.stability < aced.stability


def test_successful_reviews_grow_interval():
    """连续答对 → 间隔单调拉长（稳定性增长）。"""
    card = review(ReviewCard(item_id="x"), GOOD, TODAY)
    first_interval = (card.due - TODAY).days
    second = review(card, GOOD, card.due)
    second_interval = (second.due - card.due).days
    assert second.stability > card.stability
    assert second_interval >= first_interval


def test_forgetting_shrinks_stability():
    card = review(ReviewCard(item_id="x"), EASY, TODAY)
    later = card.due
    forgotten = review(card, AGAIN, later)
    assert forgotten.stability < card.stability


def test_retrievability_decays_over_time():
    r_now = retrievability(stability=5.0, elapsed_days=0)
    r_week = retrievability(stability=5.0, elapsed_days=7)
    r_month = retrievability(stability=5.0, elapsed_days=30)
    assert r_now == 1.0
    assert r_now > r_week > r_month > 0.0


def test_interval_capped_for_competition_window():
    """备赛封顶：无论多稳的卡也不会排到 60 天以后。"""
    card = ReviewCard(item_id="x", stability=500.0, difficulty=3.0, last_review=TODAY - timedelta(days=90))
    reviewed = review(card, EASY, TODAY)
    assert (reviewed.due - TODAY).days <= 60


def test_due_cards_prioritizes_overdue_and_unseen():
    never_seen = ReviewCard(item_id="new")
    overdue = ReviewCard(item_id="old", stability=1.0, difficulty=5.0,
                         last_review=TODAY - timedelta(days=10), due=TODAY - timedelta(days=9))
    future = ReviewCard(item_id="future", stability=9.0, difficulty=3.0,
                        last_review=TODAY, due=TODAY + timedelta(days=5))
    queue = due_cards([future, overdue, never_seen], TODAY, limit=10)
    ids = [c.item_id for c in queue]
    assert "future" not in ids
    assert set(ids) == {"new", "old"}
    assert ids[0] == "new"  # 从未复习视为最紧急


def test_invalid_rating_rejected():
    import pytest

    with pytest.raises(ValueError):
        review(ReviewCard(item_id="x"), 5, TODAY)


# ---------------------------------------------------------------- 每日计划

def _due(item_id: str) -> ReviewCard:
    return ReviewCard(item_id=item_id, stability=1.0, difficulty=5.0,
                      last_review=TODAY - timedelta(days=3), due=TODAY)


def test_daily_plan_mixes_review_and_new():
    plan = build_daily_plan(TODAY, 25, [_due("rag"), _due("agent_basics")],
                            [("langgraph", "状态图编排")])
    types = [i.item_type for i in plan.items]
    assert "review" in types and "new_concept" in types
    assert plan.total_minutes <= 25
    assert plan.encouragement


def test_daily_plan_respects_budget():
    many = [_due(f"c{i}") for i in range(30)]
    plan = build_daily_plan(TODAY, 15, many, [("rag", "RAG")])
    assert plan.total_minutes <= 15
    # 复习不吞掉全部预算：15 分钟预算下复习最多 ~7 分钟
    review_minutes = sum(i.estimated_minutes for i in plan.items if i.item_type == "review")
    assert review_minutes <= 15 * 0.5 + 3


def test_daily_plan_adds_challenge_when_time_allows():
    plan = build_daily_plan(TODAY, 45, [_due("rag")], [("langgraph", "状态图编排")])
    assert any(i.item_type == "challenge" for i in plan.items)


def test_daily_plan_empty_reviews_still_gives_new_concept():
    plan = build_daily_plan(TODAY, 25, [], [("rag", "RAG 检索")])
    assert plan.has_new_concept
    assert plan.review_count == 0


def test_daily_plan_deterministic():
    args = (TODAY, 25, [_due("rag")], [("langgraph", "状态图编排")])
    assert build_daily_plan(*args).model_dump() == build_daily_plan(*args).model_dump()


# ---------------------------------------------------------------- 学习模式

def test_four_modes_are_distinct():
    modes = all_modes()
    assert len(modes) == 4
    assert len({m.mode_id for m in modes}) == 4
    assert len({m.avatar_seed for m in modes}) == 4


def test_resolve_matches_situational_answers():
    solo_visual = resolve_learning_mode("solo", "visual")
    social_hands = resolve_learning_mode("social", "hands_on")
    assert solo_visual.mode_id == "deep_diver"
    assert social_hands.mode_id == "sprint_partner"
    assert solo_visual.community_default == "solo"
    assert social_hands.community_default == "team"


def test_mode_feeds_existing_preference_field():
    """零 schema 入侵：preference_text 可直接写入 LearnerProfile.learning_preference。"""
    from backend.schemas.learner import LearnerProfile

    mode = resolve_learning_mode("solo", "hands_on")
    profile = LearnerProfile(
        id="onboarding_user", name="新用户", background="onboarding",
        programming_level=2, python_level=2, agent_level=0, rag_level=0,
        engineering_level=1, learning_goal="完成 RAG 文档问答 Agent",
        time_budget_hours=20, learning_preference=mode.preference_text,
    )
    assert "代码" in profile.learning_preference


def test_invalid_answers_fall_back_to_default():
    assert resolve_learning_mode("", "???") is DEFAULT_MODE
