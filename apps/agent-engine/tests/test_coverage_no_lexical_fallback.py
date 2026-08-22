"""覆盖判定不吃词法兜底，生成链路仍吃——两把尺子别被后人合并回一把。

背景（2026-08-21 实测）：`EmbeddingKnowledgeRetriever.search` 在语义门筛完不足 2 块时整个查询
改走 TF-IDF，而 TF-IDF 的门是 0.05、比语义门 0.60 松一个数量级。这对生成是对的
（英文关键词查询是稀疏检索的强项，宁可给点素材也别让生成器空手），对**覆盖判定**
却是后门：技能「Agent Harness Engineering」语义 top1 只有 0.153、「自进化 Agent 与
多平台运行时」0.276，两条全靠兜底各拿 6 块判成「已覆盖」，亲读那 6 块全是同一篇
Agent 生产环境博客的开头、总结与 token 经济学段，没有一块讲脚手架或自进化。

所以加了 `allow_lexical_fallback`：默认 True（生成链路一字不改），
`skill_map_api` 传 False。这个文件把两边的行为差异钉死。
"""
from __future__ import annotations

import numpy as np
import pytest

from backend.rag.embedding_retriever import EMB_MIN_SCORE, EmbeddingKnowledgeRetriever
from backend.rag.retriever import TfidfKnowledgeRetriever
from backend.schemas.resources import KnowledgeChunk, RetrievalResult


def _chunk(sid: str, body: str) -> KnowledgeChunk:
    return KnowledgeChunk(
        source_id=sid,
        title=f"标题 {sid}",
        topic="agent_basics",
        difficulty="L2",
        concept_tags=["agent_basics"],
        section="s1",
        url=f"https://example.invalid/{sid}",
        # 正文要过 MIN_CHUNK_CHARS(80)，否则被长度门刷掉、测不到我们想测的那道门
        content=body + "。" + "补足正文长度用的说明文字，确保这一块过得了长度门不被误刷。" * 3,
    )


@pytest.fixture()
def retriever() -> EmbeddingKnowledgeRetriever:
    """两块语料 + 一个受控嵌入函数：查询向量与语料向量的余弦可精确摆布。"""
    chunks = [_chunk("doc-a#s1", "第一块讲的是甲主题"), _chunk("doc-a#s2", "第二块也讲甲主题")]
    # 语料向量都是 e0；查询给 e0 就是余弦 1.0（过门），给 e1 就是 0.0（不过门）
    matrix = np.array([[1.0, 0.0], [1.0, 0.0]], dtype=float)
    fallback = TfidfKnowledgeRetriever(chunks)

    def embed(query: str):
        return np.array([1.0, 0.0]) if "命中" in query else np.array([0.0, 1.0])

    return EmbeddingKnowledgeRetriever(chunks, matrix, fallback, embed_fn=embed)


def test_语义命中时两种模式都给证据(retriever: EmbeddingKnowledgeRetriever) -> None:
    for allow in (True, False):
        r = retriever.search("命中的查询", allow_lexical_fallback=allow)
        assert r.missing_evidence_warning is None, f"allow={allow} 不该报证据不足"
        assert len(r.retrieved_chunks) >= 2


def test_语义不过门时生成链路仍走词法兜底(retriever: EmbeddingKnowledgeRetriever) -> None:
    """默认行为一字不改：兜底该被调用。

    这里验的是**分支走没走到**，不是 TF-IDF 在玩具语料上能打出多少分——两篇文档的
    语料里所有词的 IDF 都退化，余弦恒为 0，拿它的返回值断言等于在测 sklearn 的
    小样本行为，不是测我们的开关。
    """
    called: list[str] = []
    original = retriever.fallback.search
    retriever.fallback.search = lambda q, **kw: called.append(q) or original(q, **kw)  # type: ignore[assignment]

    retriever.search("甲主题", allow_lexical_fallback=True)
    assert called == ["甲主题"], "兜底没被调用，生成链路会退化成空手"

    called.clear()
    retriever.search("甲主题", allow_lexical_fallback=False)
    assert called == [], "覆盖判定不该碰词法兜底"


def test_语义不过门时覆盖判定判未覆盖(retriever: EmbeddingKnowledgeRetriever) -> None:
    """关掉兜底后必须如实报证据不足，不许拿词面重叠冒充覆盖。"""
    r = retriever.search("甲主题", allow_lexical_fallback=False)
    assert r.missing_evidence_warning is not None
    assert str(EMB_MIN_SCORE) in r.missing_evidence_warning, "告警要写清是哪道门没过"


def test_查询嵌入不可用时覆盖判定不退而求其次() -> None:
    """嵌入调用挂了（余额/网络）不能悄悄降级成词法然后照报覆盖——那会虚报。"""
    chunks = [_chunk("doc-b#s1", "乙主题内容"), _chunk("doc-b#s2", "乙主题续")]
    matrix = np.array([[1.0, 0.0], [1.0, 0.0]], dtype=float)
    r = EmbeddingKnowledgeRetriever(chunks, matrix, TfidfKnowledgeRetriever(chunks), embed_fn=lambda q: None)

    called: list[str] = []
    r.fallback.search = lambda q, **kw: called.append(q) or RetrievalResult(  # type: ignore[assignment]
        retrieved_chunks=list(chunks), source_ids=[c.source_id for c in chunks],
        evidence_summary="", missing_evidence_warning=None,
    )
    assert r.search("乙主题", allow_lexical_fallback=True).retrieved_chunks, "生成侧该有兜底"
    assert called == ["乙主题"]

    called.clear()
    judged = r.search("乙主题", allow_lexical_fallback=False)
    assert called == [], "嵌入不可用时，覆盖判定也不许偷偷走词法"
    assert judged.missing_evidence_warning is not None
    assert judged.retrieved_chunks == []


# ── 复合技能名拆项（诊断用，不改判覆盖）────────────────────────────────────

from backend.integration.personalize_service import split_skill_name  # noqa: E402


def test_并列词拆项() -> None:
    assert split_skill_name("ReAct、CoT 与工具增强推理设计模式") == [
        "ReAct", "CoT", "工具增强推理设计模式",
    ]
    assert split_skill_name("自进化 Agent 与多平台运行时") == ["自进化 Agent", "多平台运行时"]


def test_三字母缩写不能被长度规则丢掉() -> None:
    """第一版用「纯长度 ≥4」筛碎片，把 CoT 和 MCP 丢了——正是要救的那两个子主题。"""
    assert "CoT" in split_skill_name("ReAct、CoT 与工具增强推理设计模式")
    assert "MCP" in split_skill_name("MCP 与 A2A 协议原理与工程实践")


def test_括号内不拆() -> None:
    """括号里是同一主题的变体枚举，拆成 MHA / GQA 只会变成噪声查询。"""
    name = "Transformer 注意力机制及其升级变体（MHA/GQA/MQA）"
    assert split_skill_name(name) == [name]
    assert split_skill_name("模型量化（PTQ/QAT/混合精度）") == ["模型量化（PTQ/QAT/混合精度）"]


def test_及其是承接不是并列() -> None:
    """拆「及其」会切出「其升级变体」这种没有主语的碎片。"""
    assert split_skill_name("RLHF 及其变种（PPO/DPO）对齐训练") == [
        "RLHF 及其变种（PPO/DPO）对齐训练",
    ]


def test_纯中文碎片被丢掉() -> None:
    """「超参」脱离上下文没有检索意义；丢完只剩一项就回退成整名单查。"""
    assert split_skill_name("LoRA 微调原理与超参") == ["LoRA 微调原理与超参"]
    assert split_skill_name("记忆写入、检索、更新与遗忘机制") == ["记忆写入", "遗忘机制"]


def test_无并列词原样返回() -> None:
    assert split_skill_name("大模型幻觉成因") == ["大模型幻觉成因"]
