"""学习路径测试（Phase B-2）：路径按概念前置图动态生成、因人而异、前置在前。"""

from backend.orchestration.workflow import workflow
from backend.services.concept_graph import prerequisite_closure, topological_order
from backend.services.data_loader import get_learner_profile

_LEVELS = ["L1", "L2", "L3", "L4"]


def test_topological_order_respects_prerequisites():
    order = topological_order(["deployment", "agent_basics", "langgraph", "tool_calling"])
    assert order.index("agent_basics") < order.index("tool_calling")
    assert order.index("tool_calling") < order.index("langgraph")


def test_prerequisite_closure_pulls_in_prereqs():
    closure = set(prerequisite_closure(["langgraph"]))
    assert {"langgraph", "tool_calling", "agent_basics"} <= closure


def test_paths_differ_by_learner():
    goal = "从零构建一个带审核和部署的文档问答助手"
    beginner = workflow.run(get_learner_profile("zero_beginner"), learning_goal=goal).learning_path
    senior = workflow.run(get_learner_profile("backend_to_agent"), learning_goal=goal).learning_path
    # 不同画像 → 不同阶段结构（阶段数或概念序列不同）
    assert [s.concepts for s in beginner.learning_path] != [s.concepts for s in senior.learning_path]


def test_stage_difficulty_non_decreasing_within_core():
    run = workflow.run(get_learner_profile("competition_sprint"), learning_goal="搭建多 Agent 协作的内容审核工作流")
    core = [s for s in run.learning_path.learning_path if s.stage_id.startswith("stage-") and s.stage_id[6:].isdigit()]
    ranks = [_LEVELS.index(s.difficulty) for s in core]
    assert ranks == sorted(ranks)  # 核心阶段难度不降


def test_path_not_empty_and_does_not_invent_static_prereqs():
    run = workflow.run(get_learner_profile("python_no_agent"))
    assert run.learning_path.learning_path
    assert run.learning_path.prerequisites == []
    assert "Python 基础" not in run.learning_path.prerequisites
    assert "LLM 提示词基础" not in run.learning_path.prerequisites
