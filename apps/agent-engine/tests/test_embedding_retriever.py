"""向量检索器（KR1）：契约与降级链的行为锁（离线，fake 嵌入不走网络）。"""

import numpy as np

from backend.rag.embedding_retriever import EMB_MIN_SCORE, EmbeddingKnowledgeRetriever
from backend.rag.retriever import TfidfKnowledgeRetriever
from backend.schemas.resources import KnowledgeChunk


def _chunk(sid: str, content: str, tags=None) -> KnowledgeChunk:
    return KnowledgeChunk(
        source_id=sid,
        title=f"标题 {sid}",
        topic="rag",
        difficulty="L1",
        concept_tags=tags or ["rag"],
        section="s",
        url="",
        content=content,
    )


def _build(embed_fn):
    body = "检索增强生成把检索结果拼进上下文，" * 10
    chunks = [
        _chunk("a#s1", body),
        _chunk("b#s1", "注意力机制通过 QKV 加权求和聚焦关键信息。" * 10),
        _chunk("c#s1", "# 裸标题"),  # 长度门应拦下
    ]
    dim = 8
    matrix = np.zeros((3, dim), dtype=np.float32)
    matrix[0, 0] = 1.0
    matrix[1, 1] = 1.0
    matrix[2, 0] = 1.0
    fallback = TfidfKnowledgeRetriever(chunks)
    return EmbeddingKnowledgeRetriever(chunks, matrix, fallback, embed_fn=embed_fn), dim


def test_semantic_hit_passes_gate_and_bare_heading_filtered():
    retriever, dim = _build(lambda q: np.eye(dim, dtype=np.float32)[0])
    result = retriever.search("RAG 检索")
    ids = [c.source_id for c in result.retrieved_chunks]
    assert "a#s1" in ids
    assert "c#s1" not in ids  # 与 a 同向但只有裸标题——长度门拦下


def test_below_gate_yields_insufficient_warning():
    low = np.full(8, 0.1, dtype=np.float32)
    low /= np.linalg.norm(low)
    # 与所有块余弦 ≈0.1*... < EMB_MIN_SCORE
    retriever, _ = _build(lambda q: low)
    result = retriever.search("不相关查询")
    assert result.retrieved_chunks == [] or all(
        c.score is None or c.score < EMB_MIN_SCORE for c in result.retrieved_chunks
    )
    assert result.missing_evidence_warning


def test_embed_failure_falls_back_to_tfidf():
    retriever, _ = _build(lambda q: None)
    result = retriever.search("检索增强生成 上下文")
    # TF-IDF 保底照样能命中 a 块
    assert any(c.source_id == "a#s1" for c in result.retrieved_chunks)


def test_misaligned_matrix_rejected():
    chunks = [_chunk("a#s1", "内容" * 50)]
    try:
        EmbeddingKnowledgeRetriever(
            chunks, np.zeros((3, 4), dtype=np.float32), TfidfKnowledgeRetriever(chunks)
        )
        raise AssertionError("应当抛错")
    except ValueError:
        pass
