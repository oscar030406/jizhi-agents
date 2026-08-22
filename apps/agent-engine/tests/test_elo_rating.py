"""Elo 难度评级模块单测：纯函数，直接验数学性质与边界。"""

import pytest

from backend.services.elo_rating import (
    DEFAULT_RATING,
    K_ITEM,
    K_LEARNER,
    expected_score,
    initial_item_rating,
    initial_learner_rating,
    pick_target_rating,
    rating_to_difficulty,
    update,
)


def test_expected_score_symmetric():
    # 相等 rating 期望必为 0.5，且双方期望之和恒为 1
    assert expected_score(1200, 1200) == pytest.approx(0.5)
    assert expected_score(1400, 1100) + expected_score(1100, 1400) == pytest.approx(1.0)


def test_update_correct_raises_learner_lowers_item():
    new_l, new_i = update(1200, 1200, correct=True)
    assert new_l > 1200
    assert new_i < 1200


def test_update_wrong_lowers_learner_raises_item():
    new_l, new_i = update(1200, 1200, correct=False)
    assert new_l < 1200
    assert new_i > 1200


def test_k_asymmetry():
    # 同一次作答，学习者变动幅度是题目的 K_LEARNER/K_ITEM 倍
    new_l, new_i = update(1200, 1200, correct=True)
    assert abs(new_l - 1200) == pytest.approx(abs(new_i - 1200) * K_LEARNER / K_ITEM)


def test_pick_target_rating_inverts_expected_score():
    for target in (0.5, 0.7, 0.75, 0.8):
        item = pick_target_rating(1300, target)
        assert expected_score(1300, item) == pytest.approx(target, abs=1e-6)
    # 默认 75% 甜区：目标题应比学习者当前分低
    assert pick_target_rating(1200) < 1200


def test_rating_difficulty_roundtrip():
    for level in ("L1", "L2", "L3", "L4"):
        assert rating_to_difficulty(initial_item_rating(level)) == level
        # bloom 加成不应把题推出本档
        assert rating_to_difficulty(initial_item_rating(level, "应用")) == level


def test_initial_learner_rating_bounds():
    dims = ["a", "b", "c", "d", "e"]
    assert initial_learner_rating({d: 0 for d in dims}) == pytest.approx(1000.0)
    assert initial_learner_rating({d: 4 for d in dims}) == pytest.approx(1400.0)
    # 越界档位被夹回，封顶 1600
    assert initial_learner_rating({d: 99 for d in dims}) == pytest.approx(1400.0)
    assert initial_learner_rating({}) == DEFAULT_RATING


def test_initial_item_rating_unknown_fallback():
    assert initial_item_rating("L9") == DEFAULT_RATING
    assert initial_item_rating("") == DEFAULT_RATING
    # 未知难度不吃 bloom 加成
    assert initial_item_rating("weird", "应用") == DEFAULT_RATING


def test_initial_item_rating_bloom_bonus():
    assert initial_item_rating("L2") == 1150.0
    assert initial_item_rating("L2", "应用") == 1200.0
    assert initial_item_rating("L2", "分析与评价") == 1200.0
    assert initial_item_rating("L2", "记忆") == 1150.0
