"""从知识库推出每个概念的固有难度，进而估计学习目标的难度（Phase A 难度定标校准）。

独立性说明（避免循环论证）：目标难度来自**知识库 chunk 的难度标注**（数据驱动），
与金标 `gold_labeler.py` 的**人工目标难度表**是不同来源；诊断难度用它做上限，
与金标的一致率因此是两个独立估计的一致，而非同一逻辑自证。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from backend.rag.retriever import DEFAULT_CORPUS_ALIASES
from backend.services.concept_graph import concept_meta
from backend.services.goal_concepts import goal_concepts

_LEVELS = ["L1", "L2", "L3", "L4"]
PROJECT_ROOT = Path(__file__).resolve().parents[2]
INDEX_PATH = PROJECT_ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"


def _level_to_int(level: str) -> int:
    return _LEVELS.index(level) + 1 if level in _LEVELS else 2


def _int_to_level(value: int) -> str:
    return _LEVELS[max(0, min(3, value - 1))]


@lru_cache(maxsize=1)
def concept_difficulty_map() -> dict[str, int]:
    """每个概念的固有难度 = 以它为**主题(primary topic)**的文档难度中位数（L1-L4 → 1-4）。

    用主题而非任意提及，避免长的进阶文档（提及很多概念）把入门概念的难度抬高——
    例如 agent_basics 应取「什么是 Agent(L1)」这类主讲它的文档难度，而非某篇 L4 harness
    里顺带提到它。缺主题数据时回退到 concept_tags。
    """
    primary: dict[str, list[int]] = {}
    tagged: dict[str, list[int]] = {}
    if INDEX_PATH.exists():
        # 只数活块：归档块进来会让同一个 topic 的难度被旧块摊一遍
        from backend.rag.ingest import read_index_rows

        for chunk in read_index_rows(INDEX_PATH):
            level = _level_to_int(str(chunk.get("difficulty", "L2")))
            topic = chunk.get("topic")
            if topic:
                primary.setdefault(topic, []).append(level)
            for tag in chunk.get("concept_tags", []):
                tagged.setdefault(tag, []).append(level)

    def entry_level(levels: list[int]) -> int:
        """入门难度 = 该概念主讲文档难度的 25 分位。目标只需其必备概念的入门水平，
        不需要该概念进阶材料的难度——用低分位避免长进阶文档把入门概念抬高。"""
        levels = sorted(levels)
        return levels[int(0.25 * (len(levels) - 1) + 0.5)]

    concepts = set(primary) | set(tagged)
    return {c: entry_level(primary.get(c) or tagged.get(c, [2])) for c in concepts}


def goal_difficulty(goal: str, corpus: str) -> int:
    """目标难度 = 概念入门难度 + 任务动作复杂度。

    仅用概念难度会把“部署一个 API”误判成研究级部署，也会把“设计门控/重排/多 Agent”
    误判成普通 RAG 入门。因此在知识库概念难度之外加入与金标表独立的任务语义规则：
    单组件按步实现通常为 L2；组合、排错、门控和多 Agent 协作为 L3；同时覆盖检索、
    审核、部署的端到端工程任务为 L4。规则描述任务形态，不读取 gold_labeler 的目标表。
    """
    normalized = goal.lower()
    name = corpus.strip().lower()
    concepts = goal_concepts(goal, name)
    is_main = name in DEFAULT_CORPUS_ALIASES
    if is_main:
        diff_map = concept_difficulty_map()
        concept_level = max((diff_map.get(concept, 2) for concept in concepts), default=2)
    else:
        concept_level = max(
            (
                _level_to_int(str(concept_meta(concept, name).get("difficulty") or "L2"))
                for concept in concepts
            ),
            default=2,
        )

    end_to_end_markers = (
        "从零构建",
        "端到端",
        "生产级",
        "生产系统",
        "完整交付",
        "全链路",
    )
    composition_markers = (
        "多 agent",
        "多智能体",
        "组织",
        "规划",
        "设计",
        "建立",
        "编排",
        "分工",
        "重排",
        "排序",
        "审核",
        "复核",
        "裁决",
        "校验",
        "拒答",
        "门控",
        "评测看板",
        "评估面板",
        "权限",
        "边界",
        "拦截",
        "故障",
        "仲裁",
    )
    guided_implementation_markers = (
        "完成",
        "实现",
        "按教程",
        "依照步骤",
        "按照模板",
        "封装",
        "现有",
        "测试环境",
        "部署为 api",
        "docker 部署",
    )

    if not concepts:
        return 2

    simplification_markers = ("只做", "仅做", "仅实现", "移除", "不包含", "不需要")
    if any(marker in normalized for marker in simplification_markers) and any(
        marker in normalized for marker in ("基础", "按教程", "按照模板", "单个")
    ):
        return 2

    advanced_bundle = {"rag", "guardrails", "deployment"}
    if is_main and advanced_bundle <= set(concepts) and any(
        marker in normalized for marker in end_to_end_markers
    ):
        return 4
    if len(concepts) >= 4 and any(marker in normalized for marker in end_to_end_markers):
        return 4
    if any(marker in normalized for marker in composition_markers):
        return max(3, min(concept_level, 4))
    if len(concepts) <= 2 and any(marker in normalized for marker in guided_implementation_markers):
        return 2
    return concept_level


def goal_difficulty_level(goal: str) -> str:
    return _int_to_level(goal_difficulty(goal, "ai"))
