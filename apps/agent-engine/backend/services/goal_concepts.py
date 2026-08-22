from __future__ import annotations

KEYWORD_CONCEPTS = {
    "大模型": "llm_basics",
    "大语言模型": "llm_basics",
    "llm": "llm_basics",
    "gpt": "llm_basics",
    "transformer": "llm_basics",
    "注意力": "llm_basics",
    "attention": "llm_basics",
    "分词": "llm_basics",
    "tokenizer": "llm_basics",
    "预训练": "llm_basics",
    "微调": "llm_basics",
    "rlhf": "llm_basics",
    "卷积": "deep_learning",
    "cnn": "deep_learning",
    "池化": "deep_learning",
    "lenet": "deep_learning",
    "深度学习": "deep_learning",
    "神经网络": "deep_learning",
    "rag": "rag",
    "检索": "rag",
    "文档问答": "rag",
    "问答": "rag",
    "重排": "rag",
    "排序": "rag",
    "retrieval": "rag",
    "tool": "tool_calling",
    "工具": "tool_calling",
    "function": "tool_calling",
    "函数调用": "tool_calling",
    "langgraph": "langgraph",
    "工作流": "langgraph",
    "编排": "langgraph",
    "状态图": "langgraph",
    "evaluate": "evaluation",
    "eval": "evaluation",
    "评测": "evaluation",
    "评估": "evaluation",
    "指标": "evaluation",
    "看板": "evaluation",
    "审核": "guardrails",
    "复核": "guardrails",
    "裁决": "guardrails",
    "校验": "guardrails",
    "拒答": "guardrails",
    "拦截": "guardrails",
    "权限": "guardrails",
    "安全": "guardrails",
    "guardrail": "guardrails",
    "deploy": "deployment",
    "部署": "deployment",
    "上线": "deployment",
    "api": "deployment",
    "http": "deployment",
    "接口": "deployment",
    "docker": "deployment",
    "agent": "agent_basics",
    "智能体": "agent_basics",
    "助手": "agent_basics",
}


def matched_goal_concepts(learning_goal: str) -> list[str]:
    """Return only concepts explicitly recognized from the goal text."""
    goal = learning_goal.lower()
    concepts: list[str] = []
    for keyword, concept in KEYWORD_CONCEPTS.items():
        if keyword in goal and concept not in concepts:
            concepts.append(concept)
    return concepts


def goal_concepts(learning_goal: str) -> list[str]:
    """从学习目标中提取稳定的领域概念列表；未知目标保留兼容性回退。"""
    return matched_goal_concepts(learning_goal) or ["agent_basics", "rag", "evaluation"]
