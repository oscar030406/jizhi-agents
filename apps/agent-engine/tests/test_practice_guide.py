"""项目带练：画像 → 教学决策的映射，以及模型输出的校验（出处硬约束、习惯照抄）。"""

from __future__ import annotations

import pytest

from backend.services import practice_guide as pg


def test_profile_key_tracks_only_teaching_knobs():
    base = {"programming_level": 3, "engineering_level": 2, "time_budget_hours": 20}
    same_but_renamed = {**base, "role": "别的身份", "education": "master"}
    assert pg.profile_key(base, 3) == pg.profile_key(same_but_renamed, 3) == "L2-e2-m5"
    assert pg.profile_key({"programming_level": 0}, 3) == "L1-e1-m5"
    assert pg.profile_key({"programming_level": 4, "engineering_level": 3, "time_budget_hours": 4}, 5) == "L3-e3-m3"


def test_milestone_count_follows_budget_and_difficulty():
    assert pg._milestone_count({"time_budget_hours": 3}, 2) == 3
    assert pg._milestone_count({"time_budget_hours": 10}, 2) == 4
    assert pg._milestone_count({}, 2) == 5
    assert pg._milestone_count({}, 5) == 6


def _milestone(i: int, reading=None):
    return {
        "index": i,
        "title": f"第 {i} 段",
        "goal": "跑通示例并看到输出",
        "build": ["main.py"],
        "how": ["装环境", "跑示例"],
        "acceptance": "运行 python main.py 打印结果",
        "engineering_habit": {"title": "模型改写过的", "how": "不该被采纳"},
        "pitfalls": ["依赖版本"],
        "reading": reading or [],
        "check_question": "你是怎么确认示例跑通的？",
        "expected_points": ["提到运行命令", "提到输出"],
        "minutes": 40,
    }


def test_validate_drops_unknown_sources_and_restores_habits():
    evidence = [{"source_id": "ha01s01", "title": "t", "excerpt": "e"}]
    habits = pg._habits(1, 3)
    parsed = {
        "overview": "一个能跑的小系统",
        "fit": "按 L2 拆",
        "milestones": [
            _milestone(1, [{"source_id": "ha01s01", "why": "讲原理"}, {"source_id": "fake99", "why": "编的"}]),
            _milestone(2),
            _milestone(3),
        ],
        "management": {"cadence": "每天一段", "tracking": "notes.md"},
    }
    doc = pg._validate(parsed, evidence, habits, 3)
    assert [r["source_id"] for r in doc["milestones"][0]["reading"]] == ["ha01s01"]
    assert doc["milestones"][0]["engineering_habit"] == habits[0]
    assert doc["milestones"][2]["engineering_habit"] == habits[2]


def test_validate_rejects_too_few_or_garbage():
    with pytest.raises(pg.GuideError):
        pg._validate(None, [], pg._habits(0, 3), 3)
    with pytest.raises(pg.GuideError):
        pg._validate({"overview": "x"}, [], pg._habits(0, 3), 3)


def test_repo_full_name_from_links():
    assert pg._repo_full_name({"links": [{"url": "https://github.com/a/b.git"}]}) == "a/b"
    assert pg._repo_full_name({"links": [{"url": "https://example.com/x"}]}) is None
