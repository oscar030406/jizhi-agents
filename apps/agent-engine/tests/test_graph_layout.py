"""知识宇宙离线布局：每个点都有坐标、同种子可复现、钥匙不对就不贴。"""
import json
import math

import pytest

from backend.services import graph_layout as gl


def _grid_graph(n: int):
    nodes = [{"id": f"n{i}", "type": "chunk"} for i in range(n)]
    links = [{"source": f"n{i}", "target": f"n{i + 1}", "type": "similar"} for i in range(n - 1)]
    return nodes, links


def test_every_node_gets_finite_coordinates():
    nodes, links = _grid_graph(40)
    pos = gl.compute_layout(nodes, links, iterations=20)
    assert set(pos) == {n["id"] for n in nodes}
    for xyz in pos.values():
        assert len(xyz) == 3 and all(math.isfinite(v) for v in xyz)


def test_layout_is_deterministic_for_same_seed():
    nodes, links = _grid_graph(30)
    a = gl.compute_layout(nodes, links, iterations=15, seed=3)
    b = gl.compute_layout(nodes, links, iterations=15, seed=3)
    c = gl.compute_layout(nodes, links, iterations=15, seed=4)
    assert a == b
    assert a != c


def test_linked_nodes_end_up_closer_than_unlinked():
    nodes = [{"id": "a"}, {"id": "b"}, {"id": "c"}, {"id": "d"}]
    links = [{"source": "a", "target": "b"}, {"source": "c", "target": "d"}]
    pos = gl.compute_layout(nodes, links, iterations=60)

    def dist(u, v):
        return math.dist(pos[u], pos[v])

    assert dist("a", "b") < dist("a", "c")
    assert dist("c", "d") < dist("b", "d")


def test_empty_graph_returns_empty():
    assert gl.compute_layout([], []) == {}


def test_scale_tracks_node_count():
    small = gl.compute_layout(*_grid_graph(10), iterations=10)
    big = gl.compute_layout(*_grid_graph(200), iterations=10)
    r_small = max(math.dist(p, (0, 0, 0)) for p in small.values())
    r_big = max(math.dist(p, (0, 0, 0)) for p in big.values())
    assert r_big > r_small


@pytest.fixture()
def layout_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(gl, "LAYOUT_DIR", tmp_path)
    return tmp_path


def test_attach_only_when_key_matches(layout_dir):
    graph = {"corpus": "tiny", "_index_mtime": [1.0, 2.0], "nodes": [{"id": "a"}, {"id": "b"}], "links": []}
    (layout_dir / "tiny.json").write_text(
        json.dumps({"version": gl.LAYOUT_VERSION, "_index_mtime": [1.0, 2.0], "positions": {"a": [1, 2, 3], "b": [4, 5, 6]}}),
        encoding="utf-8",
    )
    out = gl.attach_layout(graph)
    assert out["layout"]["ready"] is True
    assert out["nodes"][0] == {"id": "a", "x": 1, "y": 2, "z": 3}
    # 原图不被改写：缓存里那份是共享对象
    assert "x" not in graph["nodes"][0]

    stale = gl.attach_layout({**graph, "_index_mtime": [9.0, 9.0]})
    assert stale["layout"] == {"ready": False}
    assert "x" not in stale["nodes"][0]


def test_attach_marks_not_ready_when_too_few_placed(layout_dir):
    nodes = [{"id": f"n{i}"} for i in range(10)]
    graph = {"corpus": "tiny", "_index_mtime": 1.0, "nodes": nodes, "links": []}
    (layout_dir / "tiny.json").write_text(
        json.dumps({"version": gl.LAYOUT_VERSION, "_index_mtime": 1.0, "positions": {"n0": [0, 0, 0]}}),
        encoding="utf-8",
    )
    out = gl.attach_layout(graph)
    assert out["layout"]["ready"] is False
    assert out["layout"]["placed"] == 1


def test_build_layout_reuses_when_unchanged(layout_dir, monkeypatch):
    graph = {"corpus": "tiny", "_index_mtime": 5.0, "nodes": [{"id": "a"}, {"id": "b"}], "links": [{"source": "a", "target": "b"}]}
    monkeypatch.setattr("backend.services.knowledge_graph.knowledge_graph", lambda name: graph)
    first = gl.build_layout("tiny")
    assert first["reused"] is False and first["nodes"] == 2
    second = gl.build_layout("tiny")
    assert second["reused"] is True
    forced = gl.build_layout("tiny", force=True)
    assert forced["reused"] is False
    stored = json.loads((layout_dir / "tiny.json").read_text(encoding="utf-8"))
    assert set(stored["positions"]) == {"a", "b"}
