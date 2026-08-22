"""概念前置图加载与拓扑排序。

## 两个数据源，各管各的（2026-08-12 起）

设计稿 §10 第 1 条点的偏差是「编排层直接读表示层：路径规划直接读硬编码的
`concept_graph.json`」，后果是**换域即坏**——那份文件只有 10 个概念、全是 AI 域，
具身域一个都没有，路径退化成章节顺序。

现在分成两份：

- **边**（前置关系）来自 `prereq_graph.json`：由 `build_prereq_graph.py` 从语料造，
  按域分、带 clause 分组与置信度、AI 与具身域都有。换域就是换这份表。
- **元数据**（难度档、常见误区、标题）仍来自 `concept_graph.json`：新图不产出这些，
  而且难度那一列的自动化实测没通过验收（重测 κ=0.292，见
  `backend/rag/difficulty.py` 模块头），保留人工值是实测结论不是偷懒。

四个调用点（learning_path_planner / personalization_service / personalize_service）
**一行不改**：接口形状没变，换的是 `prerequisites()` 底下取哪份表。

## 未复核的边只作软前置

`prereq_graph.json` 里的边一律 `reviewed: false`（§7.6：只有人工签字的边才能当硬前置）。
这里的用途是**扩展目标闭包与排序**，属于推荐不属于拦截，用软前置是恰当的；
真要拿它拦人，得先过人工确认那一关。{@link graph_source} 供报告层如实展示用的是哪份。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GRAPH_PATH = PROJECT_ROOT / "data" / "knowledge_base" / "concept_graph.json"
#: 由语料造出来的前置图（`scripts/build_prereq_graph.py` 的产物）。
PREREQ_GRAPH_PATH = PROJECT_ROOT / "data" / "knowledge_base" / "prereq_graph.json"


@lru_cache(maxsize=1)
def load_graph() -> dict[str, dict]:
    """元数据表：难度、误区、标题、以及旧的 prerequisites（作兜底）。"""
    if not GRAPH_PATH.exists():
        return {}
    data = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


@lru_cache(maxsize=1)
def load_prereq_edges() -> dict[str, list[str]]:
    """概念 → 前置概念列表。跨域合并成一张平表。

    clause 之间是 OR（满足其中一组即可，§4.2），但这里的用途是**扩展闭包与排序**，
    取并集是安全的方向：多带上几个前置只会让顺序更保守，不会漏掉该先学的。
    真正要做「选哪条 clause」的决策在选点那一层（`selection.ts`），不在这儿。
    """
    if not PREREQ_GRAPH_PATH.exists():
        return {}
    data = json.loads(PREREQ_GRAPH_PATH.read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for domain, payload in data.items():
        if domain.startswith("_") or not isinstance(payload, dict):
            continue
        for concept, clauses in (payload.get("clauses") or {}).items():
            merged: list[str] = []
            for clause in clauses:
                for p in clause.get("all", []):
                    if p not in merged:
                        merged.append(p)
            if merged:
                out.setdefault(concept, [])
                for p in merged:
                    if p not in out[concept]:
                        out[concept].append(p)
    return out


def graph_source() -> str:
    """当前边取自哪份表。降级要可见（§7.7）——报告层拿它写字，别猜。"""
    return "prereq_graph" if load_prereq_edges() else "concept_graph(legacy)"


def prerequisites(concept: str) -> list[str]:
    """前置概念：**两份表取并集**，人工策展的在前。

    一版写的是「有新图就不看旧图」，被用例判死：`langgraph` 在人工图里有
    `tool_calling` 这条边，模型图里没有，于是闭包把它整个丢了。
    那个取舍方向是反的——§7.6 的排序是**人工确认过的边才是可信的那一档**，
    模型抽的边只能当软前置。让模型的表顶掉人工的表，等于把可信度高的那份废了。

    并集的代价是多带几个前置，方向安全：闭包多算只会让顺序更保守，不会漏掉该先学的。
    两份都没有就是真没有——空列表，不编。
    """
    curated = list(load_graph().get(concept, {}).get("prerequisites", []))
    built = load_prereq_edges().get(concept) or []
    out = list(curated)
    for p in built:
        if p not in out:
            out.append(p)
    return out


def concept_meta(concept: str) -> dict:
    return load_graph().get(concept, {})


def known_concepts() -> set[str]:
    """两份表里出现过的全部概念。新图的 items 覆盖具身域，旧图只有 AI 域。"""
    out = set(load_graph())
    edges = load_prereq_edges()
    out |= set(edges)
    for prereqs in edges.values():
        out |= set(prereqs)
    return out


def prerequisite_closure(concepts: list[str]) -> list[str]:
    """把目标概念扩展为包含所有（递归）前置概念的集合。

    走 {@link prerequisites}，所以新图一上线这里自动跟着变——
    这正是「编排层不直读表示层」要的效果：换域换表，编排层不动。
    """
    known = known_concepts()
    seen: set[str] = set()
    stack = list(concepts)
    while stack:
        c = stack.pop()
        if c in seen or c not in known:
            continue
        seen.add(c)
        stack.extend(prerequisites(c))
    return list(seen)


def topological_order(concepts: list[str]) -> list[str]:
    """按前置关系拓扑排序（前置在前）。图外概念放最后，保持稳定。"""
    graph = load_graph()
    universe = known_concepts()
    target = [c for c in dict.fromkeys(concepts)]
    known = [c for c in target if c in universe]
    unknown = [c for c in target if c not in universe]

    ordered: list[str] = []
    visiting: set[str] = set()

    def visit(c: str) -> None:
        if c in ordered or c not in universe:
            return
        if c in visiting:  # 环保护（造图时已去环，这里防御）
            return
        visiting.add(c)
        for pre in prerequisites(c):
            if pre in known:
                visit(pre)
        visiting.discard(c)
        if c not in ordered:
            ordered.append(c)

    # 难度只在元数据表里有；新图独有的概念（具身域那批）取默认 L2，不编一个假难度
    for c in sorted(known, key=lambda x: _difficulty_rank(graph.get(x, {}).get("difficulty", "L2"))):
        visit(c)
    return ordered + unknown


def _difficulty_rank(level: str) -> int:
    return {"L1": 1, "L2": 2, "L3": 3, "L4": 4}.get(level, 2)
