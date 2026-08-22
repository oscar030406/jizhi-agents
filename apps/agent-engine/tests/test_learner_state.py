"""集中版本化学习者状态：单写者、版本递增、审计链、workflow 提交。"""
import os

from backend.schemas.learner import LearnerProfile
from backend.services.learner_state import LearnerStateStore, learner_state_store


def _profile(pid="p1"):
    return LearnerProfile(
        id=pid, name="测试者", background="test", programming_level=2, python_level=2,
        agent_level=1, rag_level=1, engineering_level=2,
        learning_goal="g", time_budget_hours=10, learning_preference="示例")


def test_apply_increments_version_and_logs():
    store = LearnerStateStore()
    store.get_or_init(_profile())
    s = store.apply("p1", "LearnerDiagnosisAgent", "mastery_vector", {"rag": 0.4},
                    because=["先测 4/10"])
    s = store.apply("p1", "FeedbackDecisionAgent", "current_difficulty", "L1",
                    because=["得分 0.3 触发降维"])
    assert s.version == 2
    assert [c.writer for c in s.changelog] == ["LearnerDiagnosisAgent", "FeedbackDecisionAgent"]
    assert s.changelog[1].because == ["得分 0.3 触发降维"]
    assert s.changelog[1].before == "L2" and s.changelog[1].after == "L1"


def test_illegal_field_rejected():
    store = LearnerStateStore()
    store.get_or_init(_profile())
    for field in ("version", "changelog", "nonexistent"):
        try:
            store.apply("p1", "x", field, 99)
            raise AssertionError(f"{field} 不该可写")
        except ValueError:
            pass


def test_snapshot_is_isolated():
    store = LearnerStateStore()
    store.get_or_init(_profile())
    snap = store.snapshot("p1")
    snap.mastery_vector["hack"] = 1.0
    assert "hack" not in store.snapshot("p1").mastery_vector


def test_workflow_commits_state(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    from backend.orchestration.workflow import AgentTrainingWorkflow
    from backend.services.data_loader import get_learner_profile

    profile = get_learner_profile("zero_beginner")
    AgentTrainingWorkflow().run(profile, learning_goal="学会搭一个带审核的 RAG 问答系统")
    state = learner_state_store.snapshot(profile.id)
    assert state.version >= 3  # mastery/weak/difficulty 三笔提交
    assert state.mastery_vector and state.current_difficulty
    writers = {c.writer for c in state.changelog}
    assert "LearnerDiagnosisAgent" in writers
