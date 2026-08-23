# -*- coding: utf-8 -*-
"""增量补币 T1：整库重建时旧块只读保留并标 `superseded`。

T0 解决的是「补几篇文档」，靠的是既有行一个字节不动。重建这条路躲不开重编号——
source_id 是 `{stem}#s{节序}`，节序随切块结果走，同一份文件多切一节，
后面全体位移。已经出过的课正文里挂着 `[docs-plc#s31]`，重建之后这个号指向
另一个段落：课看着没变，引文全错位。

所以重建改成：旧的活块原样留在索引里、打上 `superseded`，检索永远看不见它们，
按 id 精确查却查得到。下面每条都盯着这两句里的一句。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

import ingest_domain  # noqa: E402
from backend.rag import embedding_retriever as emb_mod  # noqa: E402
from backend.rag import retriever as rt  # noqa: E402

# 够长的正文：检索侧有 80 字下限（裸标题不算证据），太短的块根本进不了结果，
# 「没返回归档块」就会变成一条永远为真的空断言。
LONG = "这一节讲逆变器巡检的完整流程，从停机确认、直流侧放电、绝缘电阻测量" \
       "到并网点电压核对，每一步都写清预期读数与异常处置，篇幅足够越过检索侧的正文长度下限。"


def _rows(path: Path) -> list[dict]:
    return [json.loads(ln) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]


def _sections(*bodies: str) -> list[tuple[str, str, list[str]]]:
    """`_build_chunks` 吃的形状：(「相对路径#节序 标题」, 正文, 标题路径)。"""
    return [(f"plc.md#{i} 第{i}节", body, [f"第{i}节"]) for i, body in enumerate(bodies, 1)]


def _row(source_id: str, content: str = LONG, **extra) -> dict:
    row = {
        "source_id": source_id,
        "title": source_id,
        "topic": "probe",
        "difficulty": "L2",
        "concept_tags": [],
        "section": "section-1",
        "url": None,
        "content": content,
    }
    row.update(extra)
    return row


@pytest.fixture
def index(tmp_path, monkeypatch):
    """一个临时库。真语料一个字节不碰。"""
    kb = tmp_path / "knowledge_base"
    (kb / "corpora" / "probe").mkdir(parents=True)
    monkeypatch.setattr(ingest_domain, "KB", kb)
    monkeypatch.setattr(rt, "CORPORA_DIR", kb / "corpora")
    monkeypatch.setattr(rt, "DEFAULT_INDEX_PATH", kb / "knowledge_index.jsonl")
    monkeypatch.setenv("RETRIEVER_BACKEND", "embedding")
    for cache in (rt.get_retriever, rt.get_corpus_retriever, emb_mod.get_embedding_retriever):
        cache.cache_clear()
    yield kb / "corpora" / "probe" / "knowledge_index.jsonl"
    for cache in (rt.get_retriever, rt.get_corpus_retriever, emb_mod.get_embedding_retriever):
        cache.cache_clear()


# ── 旧块保留 ────────────────────────────────────────────────────────────────

def test_rebuild_archives_old_blocks_instead_of_dropping_them(index):
    ingest_domain.write_corpus_index("probe", _sections(LONG, LONG), [], "L1-L3")
    first = _rows(index)
    assert [r["source_id"] for r in first] == ["plc#s1", "plc#s2"]

    # 重切之后只剩一节：旧的 plc#s2 在新的活层里已经不存在了
    ingest_domain.write_corpus_index("probe", _sections(LONG + "改过"), [], "L1-L3")
    after = _rows(index)
    live = [r for r in after if not r.get("superseded")]
    archived = [r for r in after if r.get("superseded")]

    assert [r["source_id"] for r in live] == ["plc#s1"]
    assert [r["source_id"] for r in archived] == ["plc#s1", "plc#s2"]
    # 「原样保留」：除了那一格标记，归档行与重建前逐字段一致
    bare = lambda rows: [{k: v for k, v in r.items() if k != "superseded"} for r in rows]
    assert bare(archived) == bare(first)


def test_archived_block_keeps_its_source_id_verbatim(index):
    """归档块的 id 一个字符都不能改——改了旧课的 `[plc#s2]` 当场断链。"""
    ingest_domain.write_corpus_index("probe", _sections(LONG, LONG), [], "L1-L3")
    ingest_domain.write_corpus_index("probe", _sections(LONG), [], "L1-L3")
    ids = [r["source_id"] for r in _rows(index) if r.get("superseded")]
    assert ids == ["plc#s1", "plc#s2"]  # 没有 @v1、没有后缀、没有重编号


# ── 撞号 ────────────────────────────────────────────────────────────────────

def test_collision_is_accepted_two_rows_share_one_id(index):
    """同名文件重切必然产出同样的 `stem#sN`。撞号是常态，两条并存，读取侧消歧。"""
    ingest_domain.write_corpus_index("probe", _sections("旧版正文。" + LONG), [], "L1-L3")
    ingest_domain.write_corpus_index("probe", _sections("新版正文。" + LONG), [], "L1-L3")

    same_id = [r for r in _rows(index) if r["source_id"] == "plc#s1"]
    assert len(same_id) == 2
    assert sorted(bool(r.get("superseded")) for r in same_id) == [False, True]
    assert [r["content"][:4] for r in same_id if not r.get("superseded")] == ["新版正文"]
    assert [r["content"][:4] for r in same_id if r.get("superseded")] == ["旧版正文"]


def test_archive_layer_dedups_by_source_id(index):
    """归档层封在一代。不去重的话每重建一次就整库复制一份（odoo 3046 块 × N 轮）。"""
    for tag in ("一", "二", "三", "四"):
        ingest_domain.write_corpus_index("probe", _sections(f"{tag}版正文。" + LONG), [], "L1-L3")
    rows = _rows(index)
    assert len(rows) == 2
    archived = [r for r in rows if r.get("superseded")]
    # 新档盖旧档：归档层恒等于「上一代活块」，也就是旧课最可能引到的那一代
    assert [r["content"][:4] for r in archived] == ["三版正文"]


def test_backfill_rebuild_does_not_clobber_the_real_archive(index):
    """④ 回填 concept_tags 是同一个 run 内的第二次重建，它不许归档。

    ② 刚写的那一代块没出过任何一门课。按默认口径归档它，会用它盖掉真正被旧课
    引用着的上一代归档（同号新档盖旧档）——归档层就被一代从没上过屏的块顶掉了。
    """
    ingest_domain.write_corpus_index("probe", _sections("上一代正文。" + LONG), [], "L1-L3")
    # 一次完整的接入 run：② 建库（归档上一代）→ ④ 回填词表（不归档）
    ingest_domain.write_corpus_index("probe", _sections("本代正文。" + LONG), [], "L1-L3")
    ingest_domain.write_corpus_index(
        "probe", _sections("本代正文。" + LONG), [{"concept": "巡检"}], "L1-L3", supersede=False
    )

    rows = _rows(index)
    assert len(rows) == 2
    live = [r for r in rows if not r.get("superseded")]
    archived = [r for r in rows if r.get("superseded")]
    assert live[0]["content"][:4] == "本代正文"
    assert archived[0]["content"][:5] == "上一代正文"  # 被引用的那一代还在


# ── 检索默认不返回 ──────────────────────────────────────────────────────────

def test_load_index_hides_superseded_by_default(index):
    index.write_text(
        "\n".join(
            json.dumps(r, ensure_ascii=False)
            for r in (_row("plc#s1"), _row("plc#s1", superseded=True), _row("gone#s9", superseded=True))
        )
        + "\n",
        encoding="utf-8",
    )
    live = rt.load_index(index, index.parent / "docs")
    assert [c.source_id for c in live] == ["plc#s1"]
    assert not any(c.superseded for c in live)
    assert len(rt.load_index(index, index.parent / "docs", include_superseded=True)) == 3


def test_all_archived_index_reports_empty_not_a_markdown_rescan(index):
    """全是归档块的库要如实报「没有可检索素材」，不许掉头扫 docs/ 冒充索引。"""
    docs = index.parent / "docs"
    docs.mkdir()
    (docs / "stray.md").write_text("---\ntitle: 混进来的\n---\n\n" + LONG, encoding="utf-8")
    index.write_text(json.dumps(_row("plc#s1", superseded=True), ensure_ascii=False) + "\n", encoding="utf-8")
    assert rt.load_index(index, docs) == []
    assert rt.get_corpus_retriever("probe") is None


def test_retriever_never_surfaces_an_archived_block(index):
    ingest_domain.write_corpus_index("probe", _sections("旧版讲的是继电器。" + LONG), [], "L1-L3")
    ingest_domain.write_corpus_index(
        "probe", _sections("新版讲的是继电器。" + LONG, "第二节也讲继电器。" + LONG), [], "L1-L3"
    )
    retriever = rt.get_corpus_retriever("probe")
    assert not any(c.superseded for c in retriever.chunks)
    hits = retriever.search("继电器 巡检", top_k=6).retrieved_chunks
    assert hits and not any(c.superseded for c in hits)
    assert all("旧版" not in c.content for c in hits)


# ── 按 id 精确查得到 ────────────────────────────────────────────────────────

def test_lookup_prefers_the_live_block_on_a_collision(index):
    ingest_domain.write_corpus_index("probe", _sections("旧版正文。" + LONG), [], "L1-L3")
    ingest_domain.write_corpus_index("probe", _sections("新版正文。" + LONG), [], "L1-L3")
    got = rt.lookup_source("plc#s1", "probe")
    assert got is not None and got.superseded is False
    assert got.content.startswith("新版正文")


def test_lookup_falls_back_to_the_archive_when_the_id_is_gone(index):
    """这一条就是「已经出的课出处永不断链」的全部兑现方式。"""
    ingest_domain.write_corpus_index("probe", _sections(LONG, "第二节原文。" + LONG), [], "L1-L3")
    ingest_domain.write_corpus_index("probe", _sections(LONG), [], "L1-L3")  # 重切只剩一节
    got = rt.lookup_source("plc#s2", "probe")
    assert got is not None and got.superseded is True
    assert got.content.startswith("第二节原文")


def test_lookup_returns_none_for_a_real_dead_link(index):
    ingest_domain.write_corpus_index("probe", _sections(LONG), [], "L1-L3")
    assert rt.lookup_source("plc#s99", "probe") is None
    assert rt.lookup_source("plc#s1", "no-such-corpus") is None
    assert rt.lookup_source("plc#s1", "../etc") is None  # 语料名照旧卡字符集


# ── 路障 ────────────────────────────────────────────────────────────────────

def test_every_retrieval_read_path_filters_superseded(index, monkeypatch):
    """路障：检索侧的每一条读取路径都不许看见归档块。

    这个库反复吃过「同一份数据两条读取路径只改了一条」的亏，所以这里不查实现、
    只逐条把入口跑一遍：默认 ai 的 TF-IDF、按域 TF-IDF、向量后端、以及建 npz 的
    那条离线路径。四条全都从 `load_index` 取块，漏改一条这里就红。
    """
    default_index = rt.DEFAULT_INDEX_PATH
    default_index.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(
        json.dumps(r, ensure_ascii=False)
        for r in (_row("live#s1"), _row("live#s2"), _row("dead#s1", superseded=True))
    )
    default_index.write_text(body + "\n", encoding="utf-8")
    index.write_text(body + "\n", encoding="utf-8")

    # ① 默认 ai 语料（get_retriever）
    assert [c.source_id for c in rt.get_retriever().chunks] == ["live#s1", "live#s2"]
    # ② 按域语料（get_corpus_retriever）
    assert [c.source_id for c in rt.get_corpus_retriever("probe").chunks] == ["live#s1", "live#s2"]

    # ③ 向量后端。npz 只对活块建，`get_embedding_retriever` 会拿 source_ids 与装载
    #    出来的块逐条比对——归档块要是漏进来，这里直接对不上、悄悄降级 TF-IDF。
    np.savez(
        index.parent / "knowledge_embeddings.npz",
        matrix=np.eye(2, 4, dtype=np.float32),
        source_ids=np.array(["live#s1", "live#s2"]),
    )
    emb_mod.get_embedding_retriever.cache_clear()
    vector = emb_mod.get_embedding_retriever(str(index))
    assert vector is not None, "向量后端装载失败：多半是归档块漏进了 load_index"
    assert [c.source_id for c in vector.chunks] == ["live#s1", "live#s2"]
    assert [c.source_id for c in vector.fallback.chunks] == ["live#s1", "live#s2"]

    # ④ npz 是怎么建出来的：build_embedding_index.py 也必须走同一个 load_index，
    #    它要是自己解析 jsonl，建出来的矩阵就带着归档块，与 ③ 的活块清单对不上。
    builder = (ENGINE / "scripts" / "build_embedding_index.py").read_text(encoding="utf-8")
    assert "load_index(index_path" in builder
    assert "json.loads" not in builder


def test_only_load_index_parses_the_jsonl(index):
    """路障之二：检索层里解析索引行的地方**只能有一处**。

    再加一处就是第二条读取路径，而新加的那处不会记得过滤 superseded。
    """
    assert (ENGINE / "backend" / "rag" / "retriever.py").read_text(encoding="utf-8").count(
        "json.loads("
    ) == 1
    emb_src = (ENGINE / "backend" / "rag" / "embedding_retriever.py").read_text(encoding="utf-8")
    assert "json.loads" not in emb_src and "read_text" not in emb_src


def test_backfill_path_is_wired_to_supersede_false():
    """路障之三：④ 回填必须显式关掉归档。

    这行掉了不会有任何报错——归档层被一代没上过屏的块悄悄顶掉，
    要等某门旧课的出处渲染出错才发现。属于典型的静默回退，只能靠盯源码拦。
    """
    src = (ENGINE / "backend" / "services" / "domain_intake.py").read_text(encoding="utf-8")
    body = src.split("def _backfill_concept_tags(", 1)[1].split("\ndef ", 1)[0]
    assert "supersede=False" in body
    # ② 建库那一次反过来，绝不许关
    chunk_stage = src.split("def _stage_chunk(", 1)[1].split("\ndef ", 1)[0]
    assert "supersede" not in chunk_stage
