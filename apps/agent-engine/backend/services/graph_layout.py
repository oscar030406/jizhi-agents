"""知识宇宙的离线布局：把力导向算好的三维坐标随图一起下发，浏览器直接摆点、不再模拟。

线上 2 vCPU 的机器建一次图约 1 秒，但浏览器那头要跑 60 tick 预热加最多 220 tick 冷却，
七千个点在集成显卡上是好几秒的乱飞——评委等的就是这段。坐标离线算一次，
键与 graph_cache 一样是索引文件的 mtime，语料一变自动失效。

算法是 Fruchterman–Reingold 的三维版，numpy 分块算斥力（不建 n×n 距离矩阵，
线上机只有 1.3 GB 可用内存），加一个很弱的向心力免得孤点飞走。固定随机种子，
同一份图两次算出来一样，截图对得上。

用法：
    python -m backend.services.graph_layout ai iotdb smart-manufacturing
或引擎起来后 POST /api/knowledge-graph/<corpus>/layout（带内部令牌）。
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np

from backend.services.concept_graph import KB_DIR

LAYOUT_DIR = KB_DIR / "graph_layout"
LAYOUT_VERSION = 1

#: 迭代次数与尺度。尺度对齐前端：相机初始距离是 cbrt(n)×230，图的半径要落在它的三分之一上下，
#: 否则第一帧要么只见几粒尘、要么撑出画面。
ITERATIONS = 80
RADIUS_PER_CBRT = 75.0
BLOCK = 512


def layout_path(corpus: str) -> Path:
    return LAYOUT_DIR / f"{corpus}.json"


def compute_layout(
    nodes: list[dict[str, Any]],
    links: list[dict[str, Any]],
    *,
    iterations: int = ITERATIONS,
    seed: int = 7,
) -> dict[str, list[float]]:
    """返回 {节点 id: [x, y, z]}。空图回空表。"""
    ids = [str(node["id"]) for node in nodes if node.get("id")]
    n = len(ids)
    if n == 0:
        return {}
    index = {node_id: i for i, node_id in enumerate(ids)}
    edges = [
        (index[str(link["source"])], index[str(link["target"])])
        for link in links
        if str(link.get("source")) in index and str(link.get("target")) in index
        and link.get("source") != link.get("target")
    ]
    rng = np.random.default_rng(seed)
    # 初始撒在球面附近，不能全在原点：重合点的斥力是无穷大，一开跑就炸
    pos = rng.normal(size=(n, 3)).astype(np.float32)
    pos *= (np.cbrt(n) * 30.0) / (np.linalg.norm(pos, axis=1, keepdims=True) + 1e-6)
    k = 30.0  # 理想边长，与前端 d3 forceLink 的默认距离同阶
    if edges:
        src = np.fromiter((e[0] for e in edges), dtype=np.int64, count=len(edges))
        dst = np.fromiter((e[1] for e in edges), dtype=np.int64, count=len(edges))
    else:
        src = dst = np.zeros(0, dtype=np.int64)
    temperature = np.cbrt(n) * 10.0
    cooling = temperature / max(1, iterations)
    for _ in range(iterations):
        disp = np.zeros((n, 3), dtype=np.float32)
        # 斥力：分块算，每块与全体的距离，k²/d
        for start in range(0, n, BLOCK):
            block = pos[start : start + BLOCK]
            delta = block[:, None, :] - pos[None, :, :]
            dist = np.linalg.norm(delta, axis=2) + 1e-6
            # 超过 700 就不推了，与前端 charge.distanceMax(700) 同一口径；否则孤点无限外扩
            weight = np.where(dist < 700.0, (k * k) / dist, 0.0).astype(np.float32)
            disp[start : start + BLOCK] += (delta * (weight / dist)[:, :, None]).sum(axis=1)
        # 引力：沿边拉，d²/k
        if len(src):
            delta = pos[src] - pos[dst]
            dist = np.linalg.norm(delta, axis=1) + 1e-6
            pull = (delta * ((dist * dist) / k / dist)[:, None]).astype(np.float32)
            np.add.at(disp, src, -pull)
            np.add.at(disp, dst, pull)
        # 弱向心力：相当于 forceCenter，别让没边的点漂到天边
        disp -= pos * 0.02
        length = np.linalg.norm(disp, axis=1, keepdims=True) + 1e-6
        step = np.minimum(length, temperature)
        pos += disp / length * step
        temperature = max(temperature - cooling, 1.0)
    # 尺度归一：最外一圈落在 cbrt(n)×RADIUS_PER_CBRT，与相机初始距离配套
    radius = np.percentile(np.linalg.norm(pos, axis=1), 98) + 1e-6
    pos *= (np.cbrt(n) * RADIUS_PER_CBRT) / radius
    return {node_id: [round(float(v), 1) for v in pos[i]] for node_id, i in index.items()}


def build_layout(corpus: str, *, force: bool = False) -> dict[str, Any]:
    """按当前图算坐标并落盘。已有且键相同就不重算，除非 force。"""
    from backend.services.knowledge_graph import knowledge_graph

    name = (corpus or "").strip().lower()
    graph = knowledge_graph(name)
    key = graph.get("_index_mtime")
    path = layout_path(name)
    if not force and path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
            if existing.get("_index_mtime") == key and existing.get("version") == LAYOUT_VERSION:
                return {"corpus": name, "nodes": len(existing.get("positions") or {}), "reused": True}
        except (OSError, json.JSONDecodeError):
            pass
    started = time.perf_counter()
    positions = compute_layout(graph.get("nodes") or [], graph.get("links") or [])
    payload = {
        "corpus": name,
        "version": LAYOUT_VERSION,
        "_index_mtime": key,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "positions": positions,
    }
    LAYOUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(path)
    return {
        "corpus": name,
        "nodes": len(positions),
        "reused": False,
        "seconds": round(time.perf_counter() - started, 1),
    }


def attach_layout(graph: dict[str, Any]) -> dict[str, Any]:
    """坐标文件存在且与图同版本时，把 x/y/z 写进节点；否则原样返回并标 layout.ready=false。

    不改缓存里那份图（调用方每次拿到的是同一个对象），这里复制一层再写。
    """
    name = str(graph.get("corpus") or "").strip().lower()
    result = dict(graph)
    result["layout"] = {"ready": False}
    if not name:
        return result
    path = layout_path(name)
    if not path.exists():
        return result
    try:
        stored = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return result
    if stored.get("_index_mtime") != graph.get("_index_mtime") or stored.get("version") != LAYOUT_VERSION:
        return result
    positions = stored.get("positions") or {}
    nodes = []
    placed = 0
    for node in graph.get("nodes") or []:
        coords = positions.get(str(node.get("id")))
        if coords and len(coords) == 3:
            nodes.append({**node, "x": coords[0], "y": coords[1], "z": coords[2]})
            placed += 1
        else:
            nodes.append(node)
    result["nodes"] = nodes
    total = len(nodes)
    result["layout"] = {
        "ready": total > 0 and placed >= total * 0.95,
        "placed": placed,
        "generated_at": stored.get("generated_at"),
    }
    return result


def main(argv: list[str]) -> int:
    names = [a for a in argv if not a.startswith("-")]
    force = "--force" in argv
    if not names:
        print("用法：python -m backend.services.graph_layout <corpus> [...] [--force]")
        return 2
    for name in names:
        info = build_layout(name, force=force)
        print(json.dumps(info, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
