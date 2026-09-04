"""知识宇宙图：钉住「点数对得上」和「每条边两头都有点」。

后一条是这类图最容易静默出错的地方——少一个端点，3d-force-graph 不会报错，
它会自己造一个没有 type 的孤点浮在那里，看起来像数据里真有这么个东西。
"""

import json

import pytest

from backend.services import knowledge_graph as kg

FIXTURE_ROWS = [
    {
        "source_id": "xx01s01#s1",
        "title": "第1章 开头",
        "topic": "alpha",
        "difficulty": "L1",
        "concept_tags": ["alpha"],
        "url": "https://github.com/someone/tiny-book/blob/main/a.md",
        "content": "…",
    },
    {
        "source_id": "xx01s01#s2",
        "title": "第1章 续",
        "topic": "alpha",
        "difficulty": "L2",
        "concept_tags": ["alpha", "beta"],
        "url": "https://github.com/someone/tiny-book/blob/main/a.md",
        "content": "…",
    },
    {
        "source_id": "yy02s01#s1",
        "title": "另一本 第2章",
        "topic": "beta",
        "difficulty": "L3",
        "concept_tags": ["beta"],
        "url": "https://github.com/other/second-book/blob/main/b.md",
        "content": "…",
    },
    # 归档块：不该出现在图里
    {
        "source_id": "yy02s01#s2",
        "title": "旧的一节",
        "topic": "beta",
        "difficulty": "L3",
        "concept_tags": ["beta"],
        "superseded": True,
        "content": "…",
    },
]

FIXTURE_PATH = {
    "label": "测试库",
    "stages": [
        {"index": 1, "concepts": [{"id": "alpha", "name": "alpha", "prereq_ids": []}]},
        {"index": 2, "concepts": [{"id": "beta", "name": "beta", "prereq_ids": ["alpha"]}]},
    ],
}


@pytest.fixture()
def tiny_graph(tmp_path, monkeypatch):
    index = tmp_path / "knowledge_index.jsonl"
    index.write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in FIXTURE_ROWS),
        encoding="utf-8",
    )
    monkeypatch.setattr(kg, "corpus_index_path", lambda name: index)
    monkeypatch.setattr(kg, "build_domain_path", lambda name: FIXTURE_PATH)
    return kg.build_knowledge_graph("tiny")


def test_counts_match_the_fixture(tiny_graph):
    counts = tiny_graph["counts"]
    # 2 概念 + 2 教材（xx / yy）+ 2 章节 + 3 活块（归档那条不算）
    assert counts["byType"] == {"concept": 2, "textbook": 2, "section": 2, "chunk": 3}
    assert counts["nodes"] == len(tiny_graph["nodes"]) == 9
    assert counts["links"] == len(tiny_graph["links"])
    # 前置 1 条；覆盖：xx01s01→alpha/beta，yy02s01→beta 共 3 条；
    # 包含：教材→章节 2 条 + 章节→块 3 条 = 5 条
    assert counts["byLink"] == {"prerequisite": 1, "covers": 3, "contains": 5}


def test_every_link_endpoint_exists(tiny_graph):
    ids = {node["id"] for node in tiny_graph["nodes"]}
    dangling = [
        link
        for link in tiny_graph["links"]
        if link["source"] not in ids or link["target"] not in ids
    ]
    assert dangling == []


def test_textbook_label_comes_from_the_source_url(tiny_graph):
    labels = {n["id"]: n["label"] for n in tiny_graph["nodes"] if n["type"] == "textbook"}
    assert labels == {"b:xx": "tiny-book", "b:yy": "second-book"}


def test_missing_corpus_returns_empty_graph_with_reason():
    graph = kg.build_knowledge_graph("nonexistent-corpus")
    assert graph["nodes"] == []
    assert graph["counts"]["nodes"] == 0
    assert graph["reason"]


def test_real_ai_corpus_is_big_and_consistent():
    """盘上真库：点要够多（页面上那句读数就是它），边的两头都得在。"""
    graph = kg.build_knowledge_graph("ai")
    assert graph["counts"]["nodes"] > 1000
    ids = {node["id"] for node in graph["nodes"]}
    assert all(link["source"] in ids and link["target"] in ids for link in graph["links"])
    assert graph["counts"]["byType"]["concept"] > 0
    assert graph["counts"]["byLink"]["covers"] > 0
