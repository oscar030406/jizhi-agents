"""域级学习路径：把接入流水线造的前置图排成「先学什么、再学什么」。

## 为什么不是复用那份手工路径

`apps/classroom/data/learning-path.json` 是人手策展的 AI 域产物，30 个节点，
只对 AI 域成立。非 AI 域的 /path 页此前只显示一句「本页只覆盖 AI 领域」——
建了七个库，六个库的学习者点进去看到的是一句道歉。

路径的原料其实早就在盘上：每个库跑接入流水线时都造了自己的前置图，落在
`<corpus>_intake/readiness.json` 的 `prereq_graph`（智能制造 66 概念 / 51 条 clause）。
这里做的只是把它按拓扑深度分档。

## 口径：这不是教学大纲，是软推荐

边来自成对分类器、一律 `reviewed: false`（§7.6：只有人工签字的边才能当硬前置）。
所以返回体里带一句 {@link CALIBER}，前端必须原样展示——把机器抽的顺序说成
「课程大纲」就是虚报。

## 概念表太薄时的次级来源

词表站对**无章节序的语料**产出很弱：iotdb 有 2716 个证据块，概念表只抽出 2 条，
它的接入报告自己写着「这份语料里没有可用的章节序」。两个概念排不成路径，
但这个库明明有东西可学——语料索引里逐块标着 `concept_tags`（iotdb 18 个、
智能制造 39 个），那是入库时按块打的标注，同样是流水线的自动产出。

所以概念表薄于 {@link THIN_CONCEPTS} 条时，改用索引标注补齐，并且**换一套口径**：
标注之间没有前置关系，只有覆盖块数，所以那种路径的排序含义是「教材着墨多少」
而不是「谁先谁后」。这件事必须在 `source` 与 `caliber` 里说出来，
让页面照原文展示——用覆盖厚度冒充前置顺序，就是换个姿势虚报。

## 没有就说没有

该域没跑过接入流水线、或概念表与索引标注都是空的，就返回 `source="none"` + `reason`。
**不回退到 AI 域的路径**——拿别的域的路径冒充本域，学习者照着学一遍才发现全错，
比直说没有伤害大得多。
"""

from __future__ import annotations

import json
from typing import Any

from backend.rag.ingest import read_index_rows
from backend.services.concept_graph import KB_DIR, read_json_dict

#: 分档上限。超过就按分位合并——十几阶的「路径」在页面上等于没分档，
#: 学习者看不出哪几个概念是同一批要啃的。
MAX_STAGES = 6
#: 每个概念展示几条出处。多了页面塞不下，少了不足以让人判断这条边靠不靠谱。
SECTIONS_PER_CONCEPT = 3

#: 概念表薄于这个数就转用索引标注。6 = 至少要能分出三阶、每阶两个概念，
#: 再少的「路径」画在页面上跟没有一样。
THIN_CONCEPTS = 6
#: 索引标注路径的分阶数。没有深度可分，只能按覆盖厚度切三档。
TAG_STAGES = 3

CALIBER = (
    "阶段由前置图拓扑深度分档，边来自接入流水线的成对分类器，"
    "一律未经人工复核，只作推荐不拦人"
)
TAG_CALIBER = (
    "这个库的概念表太薄（语料没有章节序，词表站抽不出足够概念），"
    "本路径改用语料索引里逐块的概念标注，按覆盖块数分档——"
    "它表示教材在哪些概念上着墨最多，**不是前置顺序**，不代表要按这个次序学"
)


def build_domain_path(corpus: str) -> dict[str, Any]:
    """某个域的学习路径。查不到就如实返回 source="none" + reason，不编。"""
    name = (corpus or "").strip()
    readiness = read_json_dict(KB_DIR / f"{name}_intake" / "readiness.json") if name else {}
    produced = readiness.get("produced_by") or {}
    out: dict[str, Any] = {
        "corpus": name,
        "label": _label(name),
        "source": "none",
        "generated_at": produced.get("at"),
        "run_id": produced.get("run_id"),
        "concept_count": 0,
        "edge_count": 0,
        "stages": [],
        "cycles_broken": [],
        "reason": None,
        "caliber": CALIBER,
    }

    if not readiness:
        out["reason"] = (
            f"盘上没有 {name}_intake/readiness.json："
            "这个库没跑过接入流水线，或报告读不出来，前置图无从谈起"
        )
        return out

    meta = {
        str(c["concept"]): c
        for c in (readiness.get("concepts") or [])
        if isinstance(c, dict) and c.get("concept")
    }
    graph = readiness.get("prereq_graph") or {}
    clauses = graph.get("clauses") or {}
    # 概念全集以 concepts 表为准，再补上只在图里露过面的名字——图里有边、
    # 词表里查不到 sections 的概念照样要上路径，只是出处栏空着。
    order: list[str] = list(meta)
    for extra in list(graph.get("items") or []) + list(clauses):
        if isinstance(extra, str) and extra and extra not in meta and extra not in order:
            order.append(extra)
    if len(order) < THIN_CONCEPTS:
        tagged = _tag_stages(name)
        if tagged:
            stages, count = tagged
            out.update(
                {
                    "source": "index-tags",
                    "concept_count": count,
                    "edge_count": 0,
                    "stages": stages,
                    "caliber": TAG_CALIBER,
                    "thin_vocabulary": {
                        "concepts_in_report": len(order),
                        "threshold": THIN_CONCEPTS,
                        "why": str(
                            (readiness.get("structure_signals") or {})
                            .get("structure_form", {})
                            .get("why")
                            or readiness.get("vocabulary_note")
                            or ""
                        ),
                    },
                }
            )
            return out
    if not order:
        note = str(readiness.get("vocabulary_note") or "").strip()
        out["reason"] = (
            "这个库的概念表是空的，语料索引里也没有概念标注"
            + (f"：{note}" if note else "，接入报告里也没写原因")
        )
        return out

    universe = set(order)
    prereq: dict[str, list[str]] = {}
    confidence: dict[str, float | None] = {}
    because: dict[str, str] = {}
    edge_count = 0
    for concept, clause_list in clauses.items():
        if concept not in universe or not isinstance(clause_list, list):
            continue
        merged: list[str] = []
        confs: list[float] = []
        for clause in clause_list:
            if not isinstance(clause, dict):
                continue
            edge_count += 1
            for p in clause.get("all") or []:
                # 自环与图外前置直接丢：前者是判定噪声，后者排不进阶（没有它的深度）
                if p in universe and p != concept and p not in merged:
                    merged.append(p)
            raw = clause.get("confidence")
            if isinstance(raw, (int, float)):
                confs.append(float(raw))
        if merged:
            prereq[concept] = merged
            # clause 内取过一次最小值，这里再跨 clause 取最小：这个概念的入边里最弱的那条
            confidence[concept] = round(min(confs), 3) if confs else None
        first = next((c for c in clause_list if isinstance(c, dict) and c.get("because")), None)
        if first:
            because[concept] = str(first["because"])

    depth, cycles_broken = _depths(order, prereq)
    stage_of = _stage_index(order, depth)

    stages: list[dict[str, Any]] = []
    rank = {c: i for i, c in enumerate(order)}
    for index in sorted(set(stage_of.values())):
        members = [c for c in order if stage_of[c] == index]
        # 入边少的排前面：同一阶里，前置越少的越接近「现在就能上手」
        members.sort(key=lambda c: (len(prereq.get(c, [])), rank[c]))
        stages.append(
            {
                "index": index + 1,
                "title": f"第 {index + 1} 阶",
                "concepts": [
                    {
                        "name": c,
                        "depth": depth[c],
                        "prereq": list(prereq.get(c, [])),
                        "confidence": confidence.get(c),
                        "because": because.get(c, ""),
                        "sections": [
                            str(s)
                            for s in (meta.get(c, {}).get("sections") or [])[:SECTIONS_PER_CONCEPT]
                        ],
                    }
                    for c in members
                ],
            }
        )

    out.update(
        {
            "source": "intake",
            "concept_count": len(order),
            "edge_count": edge_count,
            "stages": stages,
            "cycles_broken": cycles_broken,
        }
    )
    return out


def _depths(order: list[str], prereq: dict[str, list[str]]) -> tuple[dict[str, int], list[str]]:
    """每个概念的拓扑深度（无入边 = 0），外加被打破的环。

    接入流水线落盘前已经去过环、做过传递约简（`ingest_domain.build_prereq` 里调的
    `break_cycles` / `transitive_reduction`），所以这里遇到环属于防御路径：
    回边直接跳过并记账，不静默吞掉。

    ponytail：递归 DFS，前置链长过 Python 递归上限（约千级）会炸；实测最长的库
    66 个概念、链深个位数，真到那个量级再改迭代。
    """
    depth: dict[str, int] = {}
    on_stack: set[str] = set()
    broken: list[str] = []

    def walk(node: str) -> int:
        if node in depth:
            return depth[node]
        on_stack.add(node)
        best = 0
        for p in prereq.get(node, []):
            if p in on_stack:
                broken.append(f"{p}→{node}")
                continue
            best = max(best, walk(p) + 1)
        on_stack.discard(node)
        depth[node] = best
        return best

    for c in order:
        walk(c)
    return depth, broken


def _stage_index(order: list[str], depth: dict[str, int]) -> dict[str, int]:
    """深度 → 阶号（从 0 起）。深度相同的进同一阶；阶太多就按分位合并。

    分位而不是等宽：深度分布是长尾的（大多数概念挤在浅层），等宽合并会造出
    一个塞了四十个概念的第一阶加五个各含两三个概念的尾阶。按概念数均分才能
    让每一阶的分量差不多。
    """
    levels = sorted(set(depth.values()))
    if len(levels) <= MAX_STAGES:
        return {c: levels.index(depth[c]) for c in order}

    total = len(order)
    counts = {lv: sum(1 for c in order if depth[c] == lv) for lv in levels}
    bucket: dict[int, int] = {}
    acc = 0
    slot = 0
    for lv in levels:
        bucket[lv] = min(slot, MAX_STAGES - 1)
        acc += counts[lv]
        if acc >= total * (slot + 1) / MAX_STAGES:
            slot += 1
    # 分位切下来可能留空档（某一层独占大半概念时），重排成连号
    used = sorted(set(bucket.values()))
    remap = {b: i for i, b in enumerate(used)}
    return {c: remap[bucket[depth[c]]] for c in order}


def _tag_stages(corpus: str) -> tuple[list[dict[str, Any]], int] | None:
    """索引标注兜底：按 `concept_tags` 的覆盖块数分三档。读不到返回 None。

    只读一次索引（几千行 jsonl，实测毫秒级），不建缓存——这条路径只在概念表薄的
    库上走，且页面请求频次低。真成热点了再说。
    """
    index = KB_DIR / "corpora" / corpus / "knowledge_index.jsonl"
    if not index.exists():
        return None
    counts: dict[str, int] = {}
    titles: dict[str, list[str]] = {}
    try:
        # 必须走 read_index_rows：重建过的库里归档块（superseded）也带 concept_tags，
        # 自己逐行读会把它们数进覆盖厚度，档位当场排错（tests/test_index_readers_filter_superseded.py）。
        # 坏行照该入口的口径整个抛，不逐行跳过——这里的排序全靠计数，少几块看不出来。
        rows = read_index_rows(index)
    except OSError:
        return None
    for row in rows:
        for tag in row.get("concept_tags") or []:
            if not isinstance(tag, str) or not tag.strip():
                continue
            key = tag.strip()
            counts[key] = counts.get(key, 0) + 1
            seen = titles.setdefault(key, [])
            title = str(row.get("section") or row.get("title") or "").strip()
            if title and title not in seen and len(seen) < SECTIONS_PER_CONCEPT:
                seen.append(title)
    if not counts:
        return None

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    size = max(1, -(-len(ranked) // TAG_STAGES))  # 向上取整，尾档可以少
    labels = ("教材着墨最多", "覆盖中等", "覆盖较薄")
    stages: list[dict[str, Any]] = []
    for i in range(0, len(ranked), size):
        chunk = ranked[i : i + size]
        index_no = len(stages)
        stages.append(
            {
                "index": index_no + 1,
                "title": f"第 {index_no + 1} 组 · {labels[min(index_no, len(labels) - 1)]}",
                "concepts": [
                    {
                        "name": tag,
                        "depth": index_no,
                        "prereq": [],
                        "confidence": None,
                        "because": f"语料里有 {n} 个证据块标着这个概念",
                        "sections": titles.get(tag, []),
                    }
                    for tag, n in chunk
                ],
            }
        )
    return stages, len(ranked)


def _label(corpus: str) -> str:
    """域的中文名，取注册表里的 label；没有就回落库名，不自己编一个。"""
    registry = read_json_dict(KB_DIR / "domain_registry.json")
    for row in registry.get("corpora") or []:
        if isinstance(row, dict) and row.get("corpus") == corpus:
            return str(row.get("label") or corpus)
    return corpus


if __name__ == "__main__":  # 手跑一眼：python -m backend.services.domain_path
    print(json.dumps(build_domain_path("smart-manufacturing"), ensure_ascii=False, indent=1))
