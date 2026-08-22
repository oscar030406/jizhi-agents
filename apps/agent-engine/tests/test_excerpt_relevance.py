"""摘录咬合打分端点的行为锁（离线，不走网络）。

阈值本身的出处是 scripts/calibrate_excerpt_relevance.py（91 条判官三档标注）；
这里只锁契约：打分对不对、打不出分时是不是**如实返回空**而不是伪造低分。
后者是关键——课堂侧靠「空 scores」判断放行，一旦这里返回 0.0 冒充分数，
线上就会把全部摘录判成不咬合，重演 08-10 摘录归零。
"""

import numpy as np
import pytest

from backend.integration import personalize_service as svc
from backend.schemas.resources import KnowledgeChunk


def _chunk(sid: str) -> KnowledgeChunk:
    return KnowledgeChunk(
        source_id=sid, title=f"标题 {sid}", topic="rag", difficulty="L1",
        concept_tags=["rag"], section="s", url="", content="正文" * 60,
    )


class _FakeRetriever:
    def __init__(self, sids, matrix):
        self.chunks = [_chunk(s) for s in sids]
        self.matrix = matrix


@pytest.fixture
def patched(monkeypatch):
    """三维正交基：ctx 与 a#s1 同向（余弦 1），与 b#s1 正交（0）。"""
    eye = np.eye(3, dtype=np.float32)
    retriever = _FakeRetriever(["a#s1", "b#s1"], eye[:2])

    def install(embed_result):
        monkeypatch.setattr(
            "backend.rag.retriever.get_corpus_retriever", lambda corpus: retriever
        )
        monkeypatch.setattr("backend.rag.embedding_retriever.embed_texts", lambda t: embed_result)

    return install, eye


def test_scores_align_with_source_id_order(patched):
    install, eye = patched
    install([eye[0]])
    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1", "b#s1"])
    assert out["threshold"] == svc.EXCERPT_MIN_RELEVANCE
    assert out["scores"] == [[pytest.approx(1.0), pytest.approx(0.0)]]


def test_unknown_source_id_scores_none_not_zero(patched):
    """索引里没有的块打不出分——必须是 null，不能是 0.0（0.0 会被判成不咬合）。"""
    install, eye = patched
    install([eye[0]])
    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1", "不存在#s9"])
    assert out["scores"] == [[pytest.approx(1.0), None]]


def test_embed_unavailable_returns_empty_scores(patched):
    install, _ = patched
    install(None)
    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1"])
    assert out["scores"] == []
    assert "嵌入" in out["reason"]


def test_corpus_without_vector_index_returns_empty_scores(monkeypatch):
    class _NoMatrix:
        chunks: list = []

    monkeypatch.setattr("backend.rag.retriever.get_corpus_retriever", lambda corpus: _NoMatrix())
    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1"], corpus="manufacturing")
    assert out["scores"] == []
    assert "manufacturing" in out["reason"]


def test_empty_input_is_not_an_error(patched):
    install, eye = patched
    install([eye[0]])
    assert svc.excerpt_relevance_api([], ["a#s1"])["scores"] == []
    assert svc.excerpt_relevance_api(["前文"], [])["scores"] == []


def test_context_is_windowed_to_calibration_width(patched, monkeypatch):
    """打分窗口必须与校准时判官看到的一致（末 160 字），否则阈值换了量纲。"""
    install, eye = patched
    seen: list[str] = []

    monkeypatch.setattr(
        "backend.rag.retriever.get_corpus_retriever",
        lambda corpus: _FakeRetriever(["a#s1"], eye[:1]),
    )

    def fake_embed(texts):
        seen.extend(texts)
        return [eye[0]]

    monkeypatch.setattr("backend.rag.embedding_retriever.embed_texts", fake_embed)
    svc.excerpt_relevance_api(["头" * 300 + "尾巴"], ["a#s1"])
    assert len(seen[0]) == svc.EXCERPT_CTX_WINDOW
    assert seen[0].endswith("尾巴")


def test_tfidf_backed_corpus_returns_reason_not_crash(monkeypatch):
    """新领域语料走 TF-IDF，`.matrix` 是稀疏 TF-IDF 矩阵——不许拿它当嵌入矩阵算。

    2026-08-14 实测发现的真 bug：守卫原来只判 `matrix is None`，而
    TfidfKnowledgeRetriever **也有** `.matrix`（实测 iotdb 是 csr_matrix
    (3202, 477516)、odoo 是 (307, 307659)），于是守卫放行，
    下面拿 bge-m3 的 1024 维向量去点乘，直接抛
    `ValueError: matmul: dimension mismatch`，而那段没有 try/except。

    触发条件恰好是**换领域**：只有主语料 ai 建了 `knowledge_embeddings.npz`。
    全账 `docs/05-evidence/domain-generalization-boundary-20260814.md`。
    """
    from scipy.sparse import csr_matrix

    retriever = _FakeRetriever(["a#s1"], csr_matrix(np.ones((1, 5000), dtype=np.float32)))
    monkeypatch.setattr("backend.rag.retriever.get_corpus_retriever", lambda corpus: retriever)
    monkeypatch.setattr(
        "backend.rag.embedding_retriever.embed_texts", lambda t: [np.ones(1024, dtype=np.float32)]
    )

    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1"], corpus="iotdb")
    assert out["scores"] == []
    assert "iotdb" in out["reason"]


def test_dimension_mismatch_is_refused_not_computed(monkeypatch):
    """换了嵌入模型而索引没重建：维度对不上就放行，不算一个无意义的余弦。"""
    retriever = _FakeRetriever(["a#s1"], np.ones((1, 768), dtype=np.float32))
    monkeypatch.setattr("backend.rag.retriever.get_corpus_retriever", lambda corpus: retriever)
    monkeypatch.setattr(
        "backend.rag.embedding_retriever.embed_texts", lambda t: [np.ones(1024, dtype=np.float32)]
    )

    out = svc.excerpt_relevance_api(["讲义前文"], ["a#s1"])
    assert out["scores"] == []
    assert "768" in out["reason"] and "1024" in out["reason"]
