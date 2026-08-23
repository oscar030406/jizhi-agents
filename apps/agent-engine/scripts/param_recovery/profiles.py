# -*- coding: utf-8 -*-
"""Ground-truth 学习者画像 = 显式参数表（parameter recovery 实验的真值）。

设计维度（覆盖矩阵，写死不采样）：
- 总体掌握水平：high（7/8）/ mid（4-5/8）/ low（0-2/8）
- 特定误解/特长：高掌握但个别概念空白（*_gap）、低掌握但个别概念已会（*_strength）
- 噪声参数：slip（会而答错）、guess（不会而蒙对）
  默认 slip=0.15 / guess=0.25 —— 待用 XES3G5M 作答分布校准，当前为文献常用先验。

概念集：取自 data/knowledge_base/concept_graph.json 的 AI 主域真实概念（8 个），
run_experiment.py 启动时会对照图谱断言存在。
"""

# 8 个真实概念（concept_graph.json AI 域；未取 deployment / deep_learning）
CONCEPTS = [
    "llm_basics",
    "agent_basics",
    "tool_calling",
    "rag",
    "context_engineering",
    "langgraph",
    "evaluation",
    "guardrails",
]

DEFAULT_SLIP = 0.15
DEFAULT_GUESS = 0.25


def _mastery(known: set[str]) -> dict[str, bool]:
    return {c: (c in known) for c in CONCEPTS}


# profile_id -> {mastery: {concept: bool}, slip, guess, design: 设计维度说明}
PROFILES = {
    "high_clean": {
        "mastery": _mastery(set(CONCEPTS) - {"langgraph"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "高掌握（7/8）× 无特定误解 × 默认噪声",
    },
    "high_rag_gap": {
        "mastery": _mastery(set(CONCEPTS) - {"rag"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "高掌握 × 特定空白=rag（高手带盲区）× 默认噪声",
    },
    "high_careless": {
        "mastery": _mastery(set(CONCEPTS) - {"guardrails"}),
        "slip": 0.25, "guess": DEFAULT_GUESS,
        "design": "高掌握 × 无特定误解 × 高 slip=0.25（粗心型）",
    },
    "mid_prefix": {
        "mastery": _mastery({"llm_basics", "agent_basics", "tool_calling", "rag"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "中掌握（4/8，前置概念连片）× 默认噪声",
    },
    "mid_scattered": {
        "mastery": _mastery({"llm_basics", "rag", "evaluation", "guardrails"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "中掌握（4/8，非连片=散点误解形态）× 默认噪声",
    },
    "mid_lucky_guess": {
        "mastery": _mastery({"llm_basics", "agent_basics", "context_engineering", "evaluation", "rag"}),
        "slip": DEFAULT_SLIP, "guess": 0.35,
        "design": "中掌握（5/8）× 高 guess=0.35（会蒙型，考察假阳性）",
    },
    "low_clean": {
        "mastery": _mastery({"llm_basics", "agent_basics"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "低掌握（2/8）× 无特定特长 × 默认噪声",
    },
    "low_isolated_strength": {
        "mastery": _mastery({"rag"}),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "低掌握 × 特定特长=rag（新手带单点强项）× 默认噪声",
    },
    "low_high_guess": {
        "mastery": _mastery({"tool_calling"}),
        "slip": DEFAULT_SLIP, "guess": 0.35,
        "design": "低掌握 × 高 guess=0.35（低掌握+会蒙=最难判别）",
    },
    "zero_mastery": {
        "mastery": _mastery(set()),
        "slip": DEFAULT_SLIP, "guess": DEFAULT_GUESS,
        "design": "零掌握（0/8）极端点 × 默认噪声",
    },
}
