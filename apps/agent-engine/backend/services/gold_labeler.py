"""独立金标标注器（PLAYBOOK Phase A-1：破循环论证）。

问题：原 e2e 金标的 `expected_difficulty` 直接由 `LearnerDiagnosisAgent` 生成——
被测算法给自己出金标，`difficulty_match` 天然≈100%，是循环论证。

本模块用**与诊断算法不同的输入和逻辑**独立推出期望难度：
- 输入用画像的**原始等级字段**（programming/agent/engineering），不走诊断的
  mastery_vector + CONCEPT_FLOORS + 均值分档那套。
- 目标的**固有难度**由人工按任务复杂度标定（下表），非算法生成。
- 期望难度 = clamp(画像就绪档, 1, 目标固有难度)：在学习者就绪档接住，但不超过目标本身需要的难度。

因此 `difficulty_match` 变成"诊断算法与独立评分准则的一致率"——一个真实、非自证的数字。
本表是**启发式种子，须经教师人工复核**（见 docs/gold_standard_protocol.md），复核后直接改 jsonl。
"""

from __future__ import annotations

from backend.schemas.learner import LearnerProfile

# 目标固有难度：人工按任务复杂度标定（L1 概念识别 / L2 按步实现 / L3 组合排错 / L4 开放工程化）。
GOAL_INTRINSIC_DIFFICULTY = {
    "完成 RAG 文档问答 Agent": "L2",
    "实现工具调用 Agent 并记录 trace": "L2",
    "用 LangGraph 思想组织多 Agent 工作流": "L3",
    "建立 Agent 评测和审核指标": "L3",
    "把学习助手部署为 API 服务": "L2",
    "设计证据门控的检索增强生成流程": "L3",
    "为工具调用 Agent 增加权限与审核边界": "L3",
    "搭建多 Agent 协作的内容审核工作流": "L3",
    "构建带评测看板的学习 Agent": "L3",
    "用 Docker 部署带检索的问答服务": "L2",
    "实现检索结果重排与引用面板": "L3",
    "从零构建一个带审核和部署的文档问答助手": "L4",
}
DEFAULT_GOAL_DIFFICULTY = "L2"

_LEVELS = ["L1", "L2", "L3", "L4"]


def goal_intrinsic_difficulty(goal: str) -> str:
    return GOAL_INTRINSIC_DIFFICULTY.get(goal, DEFAULT_GOAL_DIFFICULTY)


def profile_readiness_tier(profile: LearnerProfile) -> str:
    """画像就绪档：只用原始等级字段的均值分档，独立于诊断算法。"""
    raw = (profile.programming_level + profile.agent_level + profile.engineering_level) / 3.0
    if raw < 0.75:
        return "L1"
    if raw < 1.75:
        return "L2"
    if raw < 2.75:
        return "L3"
    return "L4"


def independent_expected_difficulty(profile: LearnerProfile, goal: str) -> str:
    """独立期望难度 = clamp(就绪档, L1, 目标固有难度)。"""
    tier_idx = _LEVELS.index(profile_readiness_tier(profile))
    goal_idx = _LEVELS.index(goal_intrinsic_difficulty(goal))
    return _LEVELS[max(0, min(tier_idx, goal_idx))]
