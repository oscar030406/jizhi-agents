"""知识宇宙：把一个库的「概念 / 教材 / 章节 / 证据块」摊成一张可视化图。

## 它和 domain_path 的分工

`domain_path` 回答「按什么顺序学」，只出概念和前置边（AI 库 11 个概念 9 条边）。
这里回答「这个库里到底有什么」：概念之下还挂着 388 篇章节、1752 个证据块，
路径页上一个都看不见。**概念与前置边直接吃 `build_domain_path`**，不另起一份
读盘逻辑——那样两处口径迟早分叉，而「同一份数据两条读取路径只改了一条」是这个
库反复吃过的亏。

## 教材这一层是推出来的，不是盘上现成的

索引行里没有「哪本教材」这个字段。两种库各有一条线索：

- 接入库（智能制造）的 `topic` 形如 `智能制造/d2l-ros2/docs/foxy/chapt4`，
  第二段就是教材目录名；
- 主库 `ai` 的 `topic` 是概念名（`llm_basics`）没有层级，只能退回 `source_id`
  的字母前缀（`ha01s01` → `ha`）。

教材的**显示名不编**：取该组切片 `url` 里的 GitHub 仓库名（`hello-agents`），
取不到就把分组键原样上屏。ATTRIBUTION.md 那张表是人工维护的，不作为运行时来源。

## 缓存

按索引文件 mtime 失效，落 `data/knowledge_base/graph_cache/<corpus>.json`。
2vCPU 的线上机现建一次 AI 库约 1s（读 3456 行 + 建 domain_path），命中缓存后是
一次 json.load。索引重建会改 mtime，不必手工清。
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.rag.ingest import read_index_rows
from backend.rag.retriever import corpus_index_path
from backend.services.concept_graph import KB_DIR, read_json_dict
from backend.services.domain_path import build_domain_path

#: 证据块节点上限。三千个点是 WebGL 力导向在集成显卡上还能转得动的量级；
#: 超了按等距抽样，不是截断——截断会让最后几本教材整本消失。
MAX_CHUNKS = 3000

CACHE_DIR = KB_DIR / "graph_cache"

_GITHUB_REPO = re.compile(r"github\.com/[^/]+/([^/#?]+)")
_ALPHA_PREFIX = re.compile(r"^[A-Za-z]+")


def _book_key(row: dict[str, Any]) -> str:
    topic = str(row.get("topic") or "")
    if "/" in topic:
        parts = [p for p in topic.split("/") if p]
        if len(parts) > 1:
            return parts[1]
        return parts[0]
    matched = _ALPHA_PREFIX.match(str(row.get("source_id") or ""))
    return matched.group(0) if matched else "other"


def _section_id(source_id: str) -> str:
    return source_id.split("#", 1)[0]


def _short(text: str, limit: int = 40) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _index_mtime(path: Path) -> float:
    return path.stat().st_mtime if path.exists() else 0.0


def build_knowledge_graph(corpus: str) -> dict[str, Any]:
    """建一个库的知识宇宙。库不存在返回空图 + reason，不抛异常也不换库。"""
    name = (corpus or "").strip().lower()
    index_path = corpus_index_path(name)
    if index_path is None or not index_path.exists():
        return {
            "corpus": name,
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "counts": {"nodes": 0, "links": 0, "byType": {}, "byLink": {}},
            "nodes": [],
            "links": [],
            "reason": f"没有找到「{corpus}」的知识库索引",
        }

    path = build_domain_path(name)
    rows = read_index_rows(index_path)

    nodes: list[dict[str, Any]] = []
    links: list[dict[str, str]] = []

    # —— 概念层：id 与前置边全部沿用 domain_path，页面上的两张图才是同一批概念 ——
    concept_difficulty = {
        key: value.get("difficulty")
        for key, value in read_json_dict(KB_DIR / "concept_graph.json").items()
        if isinstance(value, dict)
    }
    concept_ids: set[str] = set()
    concept_stage: dict[str, int] = {}
    degree: Counter[str] = Counter()
    prereq_pairs: list[tuple[str, str]] = []
    for stage in path.get("stages") or []:
        for concept in stage.get("concepts") or []:
            cid = str(concept.get("id") or concept.get("name") or "").strip()
            if not cid:
                continue
            concept_ids.add(cid)
            concept_stage[cid] = int(stage.get("index") or 1)
    for stage in path.get("stages") or []:
        for concept in stage.get("concepts") or []:
            cid = str(concept.get("id") or concept.get("name") or "").strip()
            for prereq in concept.get("prereq_ids") or concept.get("prereq") or []:
                pid = str(prereq).strip()
                if pid in concept_ids and cid in concept_ids:
                    prereq_pairs.append((pid, cid))
                    degree[pid] += 1
                    degree[cid] += 1

    # —— 教材 / 章节 / 证据块三层 ——
    section_title: dict[str, str] = {}
    section_book: dict[str, str] = {}
    book_repos: defaultdict[str, Counter[str]] = defaultdict(Counter)
    covers: set[tuple[str, str]] = set()
    for row in rows:
        source_id = str(row.get("source_id") or "")
        if not source_id:
            continue
        sid = _section_id(source_id)
        book = _book_key(row)
        section_book.setdefault(sid, book)
        section_title.setdefault(sid, str(row.get("title") or sid))
        repo = _GITHUB_REPO.search(str(row.get("url") or ""))
        if repo:
            book_repos[book][repo.group(1)] += 1
        for tag in row.get("concept_tags") or []:
            tag = str(tag).strip()
            if tag in concept_ids:
                covers.add((sid, tag))

    for cid in sorted(concept_ids):
        nodes.append(
            {
                "id": f"c:{cid}",
                "type": "concept",
                "label": cid,
                "group": f"stage-{concept_stage.get(cid, 1)}",
                "size": 4 + degree[cid],
                **(
                    {"difficulty": concept_difficulty[cid]}
                    if concept_difficulty.get(cid)
                    else {}
                ),
            }
        )
    for source, target in prereq_pairs:
        links.append({"source": f"c:{source}", "target": f"c:{target}", "type": "prerequisite"})

    for book in sorted(set(section_book.values())):
        repo = book_repos[book].most_common(1)
        nodes.append(
            {
                "id": f"b:{book}",
                "type": "textbook",
                "label": repo[0][0] if repo else book,
                "group": book,
                "size": 12,
            }
        )
    for sid in sorted(section_title):
        book = section_book[sid]
        nodes.append(
            {
                "id": f"s:{sid}",
                "type": "section",
                "label": _short(section_title[sid]),
                "group": book,
                "size": 3,
                "sourceId": sid,
            }
        )
        links.append({"source": f"b:{book}", "target": f"s:{sid}", "type": "contains"})
    for sid, cid in sorted(covers):
        links.append({"source": f"s:{sid}", "target": f"c:{cid}", "type": "covers"})

    # 超上限按等距抽样：每 stride 个留一个，十本教材各留一截，不会整本蒸发。
    stride = max(1, math.ceil(len(rows) / MAX_CHUNKS))
    for row in rows[::stride]:
        source_id = str(row.get("source_id") or "")
        if not source_id:
            continue
        sid = _section_id(source_id)
        nodes.append(
            {
                "id": f"k:{source_id}",
                "type": "chunk",
                "label": _short(str(row.get("title") or source_id), 28),
                "group": section_book.get(sid, "other"),
                "size": 1,
                "sourceId": source_id,
                **({"difficulty": row["difficulty"]} if row.get("difficulty") else {}),
            }
        )
        links.append({"source": f"s:{sid}", "target": f"k:{source_id}", "type": "contains"})

    by_type = Counter(node["type"] for node in nodes)
    by_link = Counter(link["type"] for link in links)
    return {
        "corpus": name,
        "label": path.get("label") or name,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "counts": {
            "nodes": len(nodes),
            "links": len(links),
            "byType": dict(by_type),
            "byLink": dict(by_link),
        },
        "nodes": nodes,
        "links": links,
        "reason": None,
    }


def knowledge_graph(corpus: str) -> dict[str, Any]:
    """带盘上缓存的入口。缓存键是索引文件的 mtime。"""
    name = (corpus or "").strip().lower()
    index_path = corpus_index_path(name)
    if index_path is None:
        return build_knowledge_graph(name)
    mtime = _index_mtime(index_path)
    cache_file = CACHE_DIR / f"{name}.json"
    if cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if cached.get("_index_mtime") == mtime:
                return cached
        except (json.JSONDecodeError, OSError):
            pass  # 缓存坏了就当没有，重建一份盖掉
    graph = build_knowledge_graph(name)
    graph["_index_mtime"] = mtime
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(graph, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # 只读盘上也要能出图，缓存写不下就每次现建
    return graph
