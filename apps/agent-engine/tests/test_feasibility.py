"""时间预算够不够的三档判定（设计稿 §5.4「系统必须能说做不到」）。

判据全部来自 `data/course_volume_stats.json` 的实测分位数，所以用例里不写死小时数，
一律从快照现算——快照重新量过之后这些用例仍然成立，不用手改数字。
"""
from __future__ import annotations

import math

from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.schemas.learner import LearnerProfile, PretestResult
from backend.services.feasibility import assess_feasibility, load_volume_stats


def _stats():
    stats = load_volume_stats()
    assert stats, "缺 data/course_volume_stats.json，先跑 scripts/measure_course_volume.py"
    return stats


def _hours(concepts: int, key: str) -> float:
    return concepts * _stats()["read_minutes"][key] / 60


def test_verdict_ok_when_budget_covers_typical_volume():
    concepts = 5
    budget = math.ceil(_hours(concepts, "median")) + 1
    result = assess_feasibility(budget, concepts)
    assert result and result.verdict == "ok"
    assert result.suggested_goal is None
    assert str(result.required_hours_typical) in result.reason


def test_verdict_tight_between_smallest_and_typical_volume():
    concepts = 5
    budget = math.ceil(_hours(concepts, "min"))  # 够最小体量，不够中位体量
    assert budget < _hours(concepts, "median")
    result = assess_feasibility(budget, concepts)
    assert result and result.verdict == "tight"
    assert result.suggested_goal  # 紧张档也要给出改小的目标


def test_verdict_infeasible_below_smallest_observed_volume():
    concepts = 8
    budget = max(1, int(_hours(concepts, "min")) - 1)
    assert budget < _hours(concepts, "min")
    result = assess_feasibility(budget, concepts)
    assert result and result.verdict == "infeasible"
    assert "做不到" in result.reason
    assert result.suggested_goal


def test_no_budget_or_no_concepts_means_no_verdict():
    # 缺预算不判，不是判可行——None 是「不判」。
    assert assess_feasibility(None, 5) is None
    assert assess_feasibility(0, 5) is None
    assert assess_feasibility(24, 0) is None


def test_missing_stats_snapshot_means_no_verdict():
    # 快照读不到就不判，绝不拿编的数顶上。
    assert load_volume_stats("data/course_volume_stats.__missing__.json") is None


def test_diagnosis_carries_feasibility_and_risk_flag():
    profile = LearnerProfile(
        id="p_feasibility", name="测试者", background="转岗", programming_level=2,
        python_level=2, agent_level=0, rag_level=0, engineering_level=1,
        learning_goal="从零构建带 RAG、护栏、评测和部署的完整系统", time_budget_hours=1,
        learning_preference="示例")
    diagnosis = LearnerDiagnosisAgent().run(
        profile, PretestResult(learner_profile_id=profile.id), learning_goal=profile.learning_goal)
    assert diagnosis.feasibility is not None
    assert diagnosis.feasibility.verdict in {"ok", "tight", "infeasible"}
    # 1 小时预算不可能排下整个目标，判词要出现在风险里，不能只躺在字段里。
    assert diagnosis.feasibility.verdict != "ok"
    assert f"time_budget_{diagnosis.feasibility.verdict}" in diagnosis.learning_risks
