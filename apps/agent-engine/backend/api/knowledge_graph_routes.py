"""知识宇宙的读端点。

只读、不鉴权：返回的是知识库自己的结构（概念、教材、章节标题、切片标题），
与 practice-scout 的读端点同一条口径——没有学员数据，也没有正文全文。
机构可见性由 classroom 那侧的 `requireCorpusVisible` 把闸，桥不重复判。
"""

from __future__ import annotations

from fastapi import APIRouter

from backend.services.knowledge_graph import knowledge_graph

router = APIRouter(prefix="/api/knowledge-graph", tags=["knowledge-graph"])


@router.get("/{corpus}")
def get_knowledge_graph(corpus: str) -> dict:
    return knowledge_graph(corpus)
