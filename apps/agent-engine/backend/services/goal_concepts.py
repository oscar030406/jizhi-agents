from __future__ import annotations

import json
import re
from pathlib import Path

from backend.rag.retriever import DEFAULT_CORPUS_ALIASES


KB_DIR = Path(__file__).resolve().parents[2] / "data" / "knowledge_base"

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
    "提示词": "llm_basics",
    "prompt": "llm_basics",
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


def domain_concepts(corpus: str) -> list[str]:
    """Return the exact concept IDs published by one external corpus intake."""
    name = corpus.strip().lower()
    if not name or name in DEFAULT_CORPUS_ALIASES:
        return []
    path = KB_DIR / f"{name}_intake" / "readiness.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    concepts: list[str] = []
    for item in payload.get("concepts") or []:
        concept = str(item.get("concept") or "").strip() if isinstance(item, dict) else ""
        if concept and concept not in concepts:
            concepts.append(concept)
    return concepts


def _normalized(text: str) -> str:
    text = re.sub(r"(?<=[a-zA-Z])\s+(?=\d)", "", text.lower())
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", text)


def _latin_tokens(text: str) -> set[str]:
    normalized = re.sub(r"(?<=[a-zA-Z])\s+(?=\d)", "", text.lower())
    return {
        token
        for token in re.findall(r"[a-z]+[a-z0-9]*|[a-z]*\d+[a-z0-9]*", normalized)
        if len(token) >= 2
    }


def _cjk_bigrams(text: str) -> set[str]:
    return {
        chunk[index : index + 2]
        for chunk in re.findall(r"[\u4e00-\u9fff]+", text)
        for index in range(len(chunk) - 1)
    }


def _external_goal_concepts(learning_goal: str, catalog: list[str]) -> list[str]:
    """Lexically map a goal into one corpus catalog; below-threshold goals stay unmapped."""
    goal_normalized = _normalized(learning_goal)
    goal_latin = _latin_tokens(learning_goal)
    goal_cjk = _cjk_bigrams(learning_goal)
    scored: list[tuple[int, int, str]] = []
    for order, concept in enumerate(catalog):
        concept_normalized = _normalized(concept)
        exact = bool(
            concept_normalized
            and (
                concept_normalized in goal_normalized
                or (len(goal_normalized) >= 4 and goal_normalized in concept_normalized)
            )
        )
        latin_overlap = goal_latin & _latin_tokens(concept)
        cjk_overlap = goal_cjk & _cjk_bigrams(concept)
        if not exact and not latin_overlap and len(cjk_overlap) < 2:
            continue
        score = (100 if exact else 0) + 20 * len(latin_overlap) + len(cjk_overlap)
        scored.append((-score, order, concept))
    return [concept for _, _, concept in sorted(scored)[:6]]


def goal_concepts(learning_goal: str, corpus: str) -> list[str]:
    """Map a goal only inside the selected corpus; external misses return an empty list."""
    name = corpus.strip().lower()
    if name in DEFAULT_CORPUS_ALIASES:
        return matched_goal_concepts(learning_goal) or ["agent_basics", "rag", "evaluation"]
    return _external_goal_concepts(learning_goal, domain_concepts(name))
