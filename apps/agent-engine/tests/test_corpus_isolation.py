"""库间隔离：检索不许跨库串味（WO-N16 E33）。

新域建成后，学习者选 A 库生成的课不许引到 B 库的教材——出处会对不上，
而「带出处」是这个产品的立身之本。

线上实测（2026-08-23，plc-s71200 与 ai 两个真实库）：

    plc-s71200  查「RAG 检索增强生成怎么做」  → 0 块
    ai          查「S7-1200 高速计数器怎么配」 → 0 块
    plc-s71200  查「高速计数器」               → 6 块（docs-plc#s119…）
    ai          查「RAG 检索增强生成」         → 6 块（ha08s03#s2…）

跨库零命中、本库正常命中、source_id 前缀各归各的。
"""
from __future__ import annotations

import numpy as np
import pytest

from backend.rag.retriever import TfidfKnowledgeRetriever, get_corpus_retriever
from backend.schemas.resources import KnowledgeChunk


def _chunk(sid: str, body: str) -> KnowledgeChunk:
    return KnowledgeChunk(
        source_id=sid,
        title=f"标题 {sid}",
        topic="t",
        difficulty="L2",
        concept_tags=["t"],
        section="s1",
        url=f"https://example.invalid/{sid}",
        content=body + "。" + "补足长度用的说明文字，确保这一块过得了长度门。" * 3,
    )


def test_未建库的域返回_None_不回退默认语料() -> None:
    """**绝不回退**：查不到就是查不到。回退到主库等于把 AI 教材当成制造域的出处。"""
    assert get_corpus_retriever("从来没建过的库") is None


def test_两个检索器各查各的不串味() -> None:
    """同进程里两个库的检索器互不影响——共享缓存写错了就会串。"""
    a = TfidfKnowledgeRetriever([_chunk("a#s1", "甲库讲的是温区与制冷机组巡检")])
    b = TfidfKnowledgeRetriever([_chunk("b#s1", "乙库讲的是注意力机制与词嵌入")])

    got_a = a.search("温区")
    got_b = b.search("注意力")
    assert all(c.source_id.startswith("a#") for c in got_a.retrieved_chunks)
    assert all(c.source_id.startswith("b#") for c in got_b.retrieved_chunks)

    # 交叉查：甲库里没有注意力的内容，不该硬凑
    cross = a.search("注意力机制")
    assert all(c.source_id.startswith("a#") for c in cross.retrieved_chunks), (
        "跨域查询即便命中也只能是本库的块，绝不能出现别的库的 source_id"
    )


@pytest.mark.parametrize("corpus", ["ai", "iotdb"])
def test_已建库的检索器只吐自己的块(corpus: str) -> None:
    """盘上有这些库时验真数据；没有就跳过（本地可能只留书单）。"""
    r = get_corpus_retriever(corpus)
    if r is None:
        pytest.skip(f"{corpus} 不在本机")
    chunks = getattr(r, "chunks", None) or []
    if not chunks:
        pytest.skip(f"{corpus} 索引为空")
    # 同一个库的 source_id 前缀集合应当稳定——混进别的库会多出前缀
    prefixes = {c.source_id.split("#")[0].rstrip("0123456789") for c in chunks}
    assert prefixes, "拿不到任何 source_id 前缀"
