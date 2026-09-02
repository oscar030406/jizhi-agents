"""域级学习路径：把接入流水线造的前置图排成「先学什么、再学什么」。

## 唯一内容来源

所有领域都从接入引擎落下的索引与前置图生成。AI 主库是早期扁平布局，原料位于
根 `knowledge_index.jsonl` 与 `prereq_graph.json["ai"]`；后接入的库位于
`<corpus>_intake/readiness.json`。前端那份手工 `learning-path.json` 不再参与。

路径的原料其实早就在盘上：每个库跑接入流水线时都造了自己的前置图，落在
`<corpus>_intake/readiness.json` 的 `prereq_graph`（智能制造 66 概念 / 51 条 clause）。
这里做的只是把它按拓扑深度分档。

## 口径：这不是教学大纲，是软推荐

边来自成对分类器、一律 `reviewed: false`（§7.6：只有人工签字的边才能当硬前置）。
所以返回体里带一句 {@link CALIBER}，前端必须原样展示——把机器抽的顺序说成
「课程大纲」就是虚报。

## 概念表太薄时也不换空间

`readiness.json` 的概念 ID 是非 AI 域在路径、画像、诊断和蓝图之间共享的唯一概念空间。
即使词表很薄，也只如实标记 `thin_vocabulary`；索引块上的 `concept_tags` 不能拿来补概念，
否则同一学习者会在路径和诊断里得到两套互不相交的 ID。

## 没有就说没有

该域没跑过接入流水线、或概念表为空，就返回 `source="none"` + `reason`。
**不回退到 AI 域的路径**——拿别的域的路径冒充本域，学习者照着学一遍才发现全错，
比直说没有伤害大得多。
"""

from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any

from backend.rag.ingest import read_index_rows
from backend.rag.retriever import DEFAULT_CORPUS_ALIASES
from backend.services.concept_graph import KB_DIR, read_json_dict

#: 分档上限。超过就按分位合并——十几阶的「路径」在页面上等于没分档，
#: 学习者看不出哪几个概念是同一批要啃的。
MAX_STAGES = 6
#: 每个概念展示几条出处。多了页面塞不下，少了不足以让人判断这条边靠不靠谱。
SECTIONS_PER_CONCEPT = 3

#: 概念表薄于这个数就在结果里显式标记，但不切换概念来源。
THIN_CONCEPTS = 6
MASTERY_THRESHOLD = 0.7

CALIBER = (
    "阶段由前置图拓扑深度分档，边来自接入流水线的成对分类器，"
    "一律未经人工复核，只作推荐不拦人"
)
def _root_ai_readiness() -> dict[str, Any]:
    """把早期 AI 主库的扁平引擎产物适配为 readiness 形状。"""
    graph_path = KB_DIR / "prereq_graph.json"
    index_path = KB_DIR / "knowledge_index.jsonl"
    graph = read_json_dict(graph_path).get("ai") if graph_path.exists() else None
    if not isinstance(graph, dict) or not index_path.exists():
        return {}

    sections: dict[str, list[str]] = {}
    for row in read_index_rows(index_path):
        title = str(row.get("section") or row.get("title") or "").strip()
        for raw_tag in row.get("concept_tags") or []:
            tag = str(raw_tag).strip() if isinstance(raw_tag, str) else ""
            if not tag or not title:
                continue
            seen = sections.setdefault(tag, [])
            if title not in seen and len(seen) < SECTIONS_PER_CONCEPT:
                seen.append(title)

    order = [str(item) for item in graph.get("items") or [] if str(item)]
    for concept in graph.get("clauses") or {}:
        if str(concept) and str(concept) not in order:
            order.append(str(concept))
    digest = hashlib.sha256(graph_path.read_bytes() + b"\0" + index_path.read_bytes()).hexdigest()
    produced_at = datetime.fromtimestamp(
        max(graph_path.stat().st_mtime, index_path.stat().st_mtime),
        timezone.utc,
    ).isoformat(timespec="seconds")
    return {
        "produced_by": {
            "at": produced_at,
            "artifact_id": f"sha256:{digest[:16]}",
        },
        "concepts": [
            {"concept": concept, "sections": sections.get(concept, [])}
            for concept in order
        ],
        "prereq_graph": graph,
    }


def build_domain_path(
    corpus: str,
    mastery_vector: Any = None,
    mastery_corpus: Any = None,
) -> dict[str, Any]:
    """某个域的学习路径。查不到就如实返回 source="none" + reason，不编。"""
    raw_name = (corpus or "").strip().lower()
    name = "ai" if raw_name in DEFAULT_CORPUS_ALIASES else raw_name
    readiness = (
        _root_ai_readiness()
        if name == "ai"
        else read_json_dict(KB_DIR / f"{name}_intake" / "readiness.json")
        if name
        else {}
    )
    produced = readiness.get("produced_by") or {}
    out: dict[str, Any] = {
        "corpus": name,
        "label": _label(name),
        "source": "none",
        "generated_at": produced.get("at"),
        "run_id": produced.get("run_id"),
        "artifact_id": produced.get("artifact_id"),
        "concept_count": 0,
        "edge_count": 0,
        "stages": [],
        "cycles_broken": [],
        "reason": None,
        "caliber": CALIBER,
    }

    if not readiness:
        out["reason"] = (
            "该领域尚未生成可用的学习路径：知识库未完成接入，"
            "或接入报告当前不可用。请由所属机构的管理者完成知识库接入后重试"
        )
        return _personalize(out, mastery_vector, mastery_corpus)

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
        out["thin_vocabulary"] = {
            "concepts_in_report": len(order),
            "threshold": THIN_CONCEPTS,
            "why": str(
                (readiness.get("structure_signals") or {})
                .get("structure_form", {})
                .get("why")
                or readiness.get("vocabulary_note")
                or ""
            ),
        }
    if not order:
        note = str(readiness.get("vocabulary_note") or "").strip()
        out["reason"] = "这个库的接入报告没有产出概念词表" + (
            f"：{note}" if note else "，接入报告里也没写原因"
        )
        return _personalize(out, mastery_vector, mastery_corpus)

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
                        "id": c,
                        "name": c,
                        "depth": depth[c],
                        "prereq": list(prereq.get(c, [])),
                        "prereq_ids": list(prereq.get(c, [])),
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
            "source": "index-graph" if name == "ai" else "intake",
            "concept_count": len(order),
            "edge_count": edge_count,
            "stages": stages,
            "cycles_broken": cycles_broken,
        }
    )
    return _personalize(out, mastery_vector, mastery_corpus)


def _personalize(
    path: dict[str, Any], raw_mastery: Any, mastery_corpus: Any
) -> dict[str, Any]:
    """同域、同概念 ID 才移动游标；场景标题与子串一律不参与匹配。"""
    vector = {
        str(key): float(value)
        for key, value in (raw_mastery.items() if isinstance(raw_mastery, dict) else [])
        if str(key)
        and isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
        and 0 <= float(value) <= 1
    }
    raw_vector_corpus = str(mastery_corpus or "").strip().lower()
    vector_corpus = (
        "ai" if raw_vector_corpus in DEFAULT_CORPUS_ALIASES else raw_vector_corpus
    )
    path_corpus = str(path.get("corpus") or "").strip()
    corpus_matches = bool(path_corpus) and vector_corpus == path_corpus
    mastery = vector if corpus_matches else {}
    concepts = [
        concept
        for stage in path.get("stages") or []
        if isinstance(stage, dict)
        for concept in stage.get("concepts") or []
        if isinstance(concept, dict)
    ]
    matched = 0
    mastered_ids: set[str] = set()
    for concept in concepts:
        concept_id = str(concept.get("id") or "")
        score = mastery.get(concept_id) if concept_id else None
        if score is not None:
            matched += 1
            concept["mastery"] = score
        if score is None:
            concept["status"] = "unmeasured"
        elif score >= MASTERY_THRESHOLD:
            concept["status"] = "mastered"
            mastered_ids.add(concept_id)
        else:
            concept["status"] = "future"

    for concept in concepts:
        if concept.get("status") in {"mastered", "unmeasured"}:
            continue
        prereq_ids = [str(item) for item in concept.get("prereq_ids") or [] if str(item)]
        if all(item in mastered_ids for item in prereq_ids):
            concept["status"] = "current"

    counts = {"mastered": 0, "current": 0, "future": 0, "unmeasured": 0}
    current: list[str] = []
    for concept in concepts:
        status = str(concept.get("status") or "future")
        counts[status] += 1
        if status == "current":
            current.append(str(concept.get("name") or ""))
    for stage in path.get("stages") or []:
        statuses = [str(concept.get("status") or "future") for concept in stage.get("concepts") or []]
        stage["status"] = (
            "mastered"
            if statuses and all(status == "mastered" for status in statuses)
            else "current"
            if "current" in statuses
            else "unmeasured"
            if statuses and all(status == "unmeasured" for status in statuses)
            else "future"
        )
    path["personalization"] = {
        "mastery_source": "learner_blueprint.mastery_vector",
        "mastery_corpus": vector_corpus,
        "corpus_match": corpus_matches,
        "match_mode": "exact-concept-id",
        "mastery_entries": len(vector),
        "matched_mastery": matched,
        "mastery_threshold": MASTERY_THRESHOLD,
        "counts": counts,
        "current": current,
        "reason": (
            None
            if matched
            else "当前账户在该领域尚无与路径概念 ID 同源的测评记录；"
            "系统不会使用账户全局或场景标题掌握度猜测。"
        ),
    }
    return path


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


def _label(corpus: str) -> str:
    """域的中文名，取注册表里的 label；没有就回落库名，不自己编一个。"""
    registry = read_json_dict(KB_DIR / "domain_registry.json")
    for row in registry.get("corpora") or []:
        if isinstance(row, dict) and row.get("corpus") == corpus:
            return str(row.get("label") or corpus)
    return corpus


if __name__ == "__main__":  # 手跑一眼：python -m backend.services.domain_path
    print(json.dumps(build_domain_path("smart-manufacturing"), ensure_ascii=False, indent=1))
