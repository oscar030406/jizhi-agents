"""向量检索器（KR1）——bge-m3 语义检索，TF-IDF 诚实降级。

与 TfidfKnowledgeRetriever 同一 search() 契约（含充分性门/长度门/证据不足告警），
差别只在相关性分数来源：预建向量索引（build_embedding_index.py）+ 查询单次
嵌入调用。查询嵌入失败（网络/无 key）自动降级 TF-IDF 并打日志——检索层
永远给答案，但绝不假装用了没用上的后端。

门阈值标定（2026-08-03 实测，scripts/calibrate_embedding_gate.py）：
命中组 top1 = 0.617-0.741；未命中组 top1 = 0.331-0.582（bge-m3 余弦地板高，
「马拉松训练配速表」也有 0.582——语义嵌入对任何流畅中文都给基础分）。
EMB_MIN_SCORE=0.60 取簇间中点。**间隙只有 0.035，比 TF-IDF 版（0.015 vs 0.106）
更窄**——阈值敏感，换嵌入模型/语料必须重跑标定。量纲与 TF-IDF 的 0.05
完全不同，两套阈值不许混用。

RETRIEVER_BACKEND 环境变量：embedding（默认，索引在则用）| tfidf（强制旧后端，
消融对照用）。
"""

from __future__ import annotations

import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Sequence

import numpy as np
import requests

from backend.rag.retriever import (
    DEFAULT_INDEX_PATH,
    MIN_CHUNK_CHARS,
    MIN_CHUNKS,
    TfidfKnowledgeRetriever,
    _strip_heading_marks,
    load_index,
)
from backend.schemas.resources import KnowledgeChunk, RetrievalResult

logger = logging.getLogger("backend.rag.embedding")

EMB_MIN_SCORE = 0.60
EMB_TAG_BONUS = 0.03  # 余弦量纲下的小加成：只影响排序，不进门禁分
EMBED_MODEL = "BAAI/bge-m3"
EMBED_ENDPOINT = "https://api.siliconflow.cn/v1/embeddings"
EMBED_TIMEOUT = 8


# 硅基流动一律剥代理直连：Clash fake-ip 会把失败 DNS 伪装成成功，
# 走系统代理时嵌入调用的失败形态是「超时」而不是「拒绝」，很难查。
_SESSION = requests.Session()
_SESSION.trust_env = False


def embed_texts(texts: Sequence[str]) -> list[np.ndarray] | None:
    """批量嵌入 → L2 归一化向量表。无 key / 任何失败返回 None（调用方降级，不抛）。

    整批失败就整批 None：半截结果没法和输入对齐，宁可让调用方走保底。
    """
    key = os.environ.get("SILICONFLOW_API_KEY", "")
    if not key or not texts:
        return None
    out: list[np.ndarray] = []
    for start in range(0, len(texts), 16):
        batch = [t[:2000] for t in texts[start : start + 16]]
        try:
            resp = _SESSION.post(
                EMBED_ENDPOINT,
                headers={"Authorization": f"Bearer {key}"},
                json={"model": EMBED_MODEL, "input": batch},
                timeout=EMBED_TIMEOUT,
            )
            if resp.status_code != 200:
                logger.warning("嵌入失败 HTTP %s", resp.status_code)
                return None
            items = sorted(resp.json()["data"], key=lambda d: d["index"])
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("嵌入不可达（%s）", type(exc).__name__)
            return None
        if len(items) != len(batch):
            logger.warning("嵌入返回条数不符（%s vs %s）", len(items), len(batch))
            return None
        for item in items:
            vec = np.array(item["embedding"], dtype=np.float32)
            norm = float(np.linalg.norm(vec))
            out.append(vec / norm if norm > 0 else vec)
    return out


def _embed_query(query: str) -> np.ndarray | None:
    vecs = embed_texts([query])
    if not vecs or not float(np.linalg.norm(vecs[0])):
        logger.warning("查询嵌入不可用，降级 TF-IDF")
        return None
    return vecs[0]


class EmbeddingKnowledgeRetriever:
    """向量主检索 + TF-IDF 保底。矩阵行序与 chunks 严格对齐（构建脚本保证）。"""

    def __init__(
        self,
        chunks: Sequence[KnowledgeChunk],
        matrix: np.ndarray,
        fallback: TfidfKnowledgeRetriever,
        embed_fn=_embed_query,
    ):
        if len(chunks) != matrix.shape[0]:
            raise ValueError(f"索引错位：{len(chunks)} 块 vs 矩阵 {matrix.shape[0]} 行")
        self.chunks = list(chunks)
        self.matrix = matrix
        self.fallback = fallback
        self._embed = embed_fn

    def search(
        self,
        query: str,
        concept_tags: Sequence[str] | None = None,
        top_k: int = 6,
        allow_lexical_fallback: bool = True,
    ) -> RetrievalResult:
        """`allow_lexical_fallback=False` 时只认语义门，语义空手就如实返回证据不足。

        为什么要这个开关：兜底对**生成**是对的（英文关键词查询是稀疏检索的强项，
        宁可给点素材也别让生成器空手），但拿它当**覆盖判定**就是虚报——2026-08-21 实测，
        「Agent Harness Engineering」语义 top1 只有 0.153、「自进化 Agent 与多平台运行时」
        0.276，两条都过不了 0.60，落到词法 0.05 后各拿到 6 块判成「已覆盖」，
        而亲读那 6 块全是一篇 Agent 生产环境博客的开头/总结/token 经济学段，
        没有一块讲脚手架或自进化。有素材可生成 ≠ 该技能被教材覆盖，两件事得用两把尺。
        """
        qvec = self._embed(query)
        if qvec is None:
            if not allow_lexical_fallback:
                return RetrievalResult(
                    retrieved_chunks=[], source_ids=[], evidence_summary="",
                    missing_evidence_warning="查询嵌入不可用，且本次判定不允许词法兜底。",
                )
            return self.fallback.search(query, concept_tags=concept_tags, top_k=top_k)

        concept_tags = concept_tags or []
        tag_set = {t.lower() for t in concept_tags}
        cosines = self.matrix @ qvec  # 双方已归一化，点积=余弦
        ranked = []
        for i, chunk in enumerate(self.chunks):
            bonus = EMB_TAG_BONUS * len(tag_set.intersection({t.lower() for t in chunk.concept_tags}))
            ranked.append((float(cosines[i]) + bonus, float(cosines[i]), chunk))
        ranked.sort(key=lambda x: x[0], reverse=True)

        # 与 TF-IDF 版同款三道门：门禁只看原始余弦；先过滤再取 top_k
        eligible = [
            (rank_score, chunk)
            for rank_score, cosine, chunk in ranked
            if cosine >= EMB_MIN_SCORE and len(_strip_heading_marks(chunk.content)) >= MIN_CHUNK_CHARS
        ]
        selected = [
            chunk.model_copy(update={"score": round(rank_score, 4)})
            for rank_score, chunk in eligible[:top_k]
        ]
        # dense+sparse 互补：语义门空手时落 TF-IDF 再试。英文关键词式查询
        # （"RAG evidence source_id citations"）在 bge 中文语料余弦上过不了 0.60 门，
        # 却正是稀疏检索的强项——两后端各管一类查询，空手率只降不升。
        # TF-IDF 有自己的充分性门，兜底不等于放水。
        if len(selected) < MIN_CHUNKS:
            if not allow_lexical_fallback:
                return RetrievalResult(
                    retrieved_chunks=selected,
                    source_ids=[c.source_id for c in selected],
                    evidence_summary="",
                    missing_evidence_warning=(
                        f"语义证据不足：过滤后仅 {len(selected)} 块过 {EMB_MIN_SCORE} 门"
                        f"（阈值 {MIN_CHUNKS}），本次不允许词法兜底。"
                    ),
                )
            return self.fallback.search(query, concept_tags=concept_tags, top_k=top_k)
        warning = None
        return RetrievalResult(
            retrieved_chunks=selected,
            source_ids=[c.source_id for c in selected],
            evidence_summary="; ".join(f"{c.title}({c.source_id})" for c in selected[:4]),
            missing_evidence_warning=warning,
        )


def load_embedding_matrix(npz_path: Path) -> tuple[np.ndarray, list[str]] | None:
    if not npz_path.exists():
        return None
    try:
        data = np.load(npz_path, allow_pickle=False)
        return data["matrix"], [str(s) for s in data["source_ids"]]
    except Exception:  # 损坏索引视同不存在，别让检索层崩
        logger.warning("向量索引损坏：%s", npz_path)
        return None


@lru_cache(maxsize=8)
def get_embedding_retriever(index_path_str: str) -> EmbeddingKnowledgeRetriever | None:
    """按索引路径构建；npz 缺失/错位返回 None（调用方回落 TF-IDF）。"""
    index_path = Path(index_path_str)
    npz = index_path.parent / "knowledge_embeddings.npz"
    loaded = load_embedding_matrix(npz)
    if loaded is None:
        return None
    matrix, source_ids = loaded
    chunks = load_index(index_path, index_path.parent / "docs")
    if [c.source_id for c in chunks] != source_ids:
        logger.warning("向量索引与语料不同步（%s）：请重跑 build_embedding_index.py", npz)
        return None
    try:
        fallback = TfidfKnowledgeRetriever(chunks)
    except ValueError:
        return None
    return EmbeddingKnowledgeRetriever(chunks, matrix, fallback)


def backend_choice() -> str:
    return os.environ.get("RETRIEVER_BACKEND", "embedding").strip().lower()


def maybe_embedding_retriever(index_path: Path = DEFAULT_INDEX_PATH):
    """工厂：embedding 后端可用则用之，否则 None（调用方保持旧行为）。"""
    if backend_choice() != "embedding":
        return None
    return get_embedding_retriever(str(index_path))
