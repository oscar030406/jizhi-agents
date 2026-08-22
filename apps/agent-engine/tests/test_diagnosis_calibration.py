"""诊断难度定标测试（Phase A）：锁定「目标感知 + 能力尊重就绪度」两个修复。"""

from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile

_LEVELS = ["L1", "L2", "L3", "L4"]


def _diagnose(profile_id: str, goal: str | None = None) -> str:
    profile = get_learner_profile(profile_id)
    pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
    return LearnerDiagnosisAgent().run(profile, pretest, learning_goal=goal).recommended_difficulty


def test_difficulty_is_goal_aware():
    """同一画像、任务形态不同的目标 → 推荐难度不同（修复「目标盲」缺陷）。"""
    easy = _diagnose("backend_to_agent", "完成 RAG 文档问答 Agent")
    hard = _diagnose("backend_to_agent", "从零构建一个带审核和部署的文档问答助手")
    assert _LEVELS.index(easy) < _LEVELS.index(hard)


def test_goal_complexity_distinguishes_guided_implementation_and_composition():
    from backend.services.concept_difficulty import goal_difficulty_level

    assert goal_difficulty_level("实现工具调用 Agent 并记录 trace") == "L2"
    assert goal_difficulty_level("把学习助手部署为 API 服务") == "L2"
    assert goal_difficulty_level("用 LangGraph 思想组织多 Agent 工作流") == "L3"
    assert goal_difficulty_level("设计证据门控的检索增强生成流程") == "L3"
    assert goal_difficulty_level("实现检索结果重排与引用面板") == "L3"
    assert goal_difficulty_level("从零构建一个带审核和部署的文档问答助手") == "L4"


def test_recommended_never_exceeds_goal_or_readiness():
    """推荐难度 = min(就绪度, 目标难度)：不超过目标本身需要的水平。"""
    agent = LearnerDiagnosisAgent()
    profile = get_learner_profile("competition_sprint")
    pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
    readiness = agent._readiness_level(agent.run(profile, pretest).mastery_vector)
    rec = agent.run(profile, pretest, learning_goal="完成 RAG 文档问答 Agent").recommended_difficulty
    assert _LEVELS.index(rec) <= _LEVELS.index(readiness)


def test_strong_generalist_not_dragged_to_beginner():
    """资深工程师的可迁移工程能力允许其在有脚手架时进入 L4。"""
    agent = LearnerDiagnosisAgent()
    profile = get_learner_profile("backend_to_agent")
    pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
    diagnosis = agent.run(profile, pretest)
    readiness = agent._effective_readiness(diagnosis.mastery_vector, profile)
    assert readiness == "L4"
    end_to_end = agent.run(
        profile,
        pretest,
        learning_goal="从零构建一个带审核和部署的文档问答助手",
    )
    assert end_to_end.recommended_difficulty == "L4"


def test_zero_beginner_stays_l1_without_goal():
    """向后兼容：不传目标时返回就绪度；零基础仍 L1。"""
    assert _diagnose("zero_beginner") == "L1"
