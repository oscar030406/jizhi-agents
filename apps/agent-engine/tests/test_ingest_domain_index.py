"""接入链的落库那一步。

钉住 2026-08-13 查出来的空档：`ingest_domain.py` 跑完 odoo / iotdb 之后，
知识库里一条它们的 chunk 都没有——就绪度报告齐全，语料却检索不到，
「换个领域生成课程」根本无素材可取。这个用例保证那一步不会再被拿掉。
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import ingest_domain  # noqa: E402
from backend.rag.retriever import get_corpus_retriever  # noqa: E402

SECTIONS = [
    (
        "a/b/guide.md#1 批次追踪",
        "批次追踪用于按批次记录产品流向。启用后可在收货时录入批次号。",
        ["批次追踪"],
    ),
    (
        "a/b/guide.md#2 序列号",
        "序列号为每一件产品分配唯一标识，适用于高价值物料。",
        ["序列号"],
    ),
]
VOCAB = [{"concept": "批次追踪"}, {"concept": "序列号"}, {"concept": "从不出现的概念"}]


def test_writes_retrievable_index(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest_domain, "KB", tmp_path)
    path, n = ingest_domain.write_corpus_index("demo", SECTIONS, VOCAB, "L1-L3")
    assert n == 2
    assert path == tmp_path / "corpora" / "demo" / "knowledge_index.jsonl"

    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    assert len(rows) == 2
    first = rows[0]
    # topic 取章级（叶子父目录），与前置图的概念面同一层
    assert first["topic"] == "a/b"
    # 难度取来源级区间下界，不逐 chunk 标（逐 chunk 自动标难度实测没过验收）
    assert first["difficulty"] == "L1"
    # concept_tags 是机械子串匹配，没出现的概念不许挂上去
    assert first["concept_tags"] == ["批次追踪"]
    assert "从不出现的概念" not in first["concept_tags"]
    assert first["source_id"].endswith("#s1")


def test_source_ids_unique_across_sections(tmp_path, monkeypatch):
    monkeypatch.setattr(ingest_domain, "KB", tmp_path)
    path, _ = ingest_domain.write_corpus_index("demo", SECTIONS, VOCAB, "L2-L3")
    ids = [json.loads(x)["source_id"] for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    assert len(set(ids)) == len(ids), ids


def test_unbuilt_corpus_returns_none_not_default():
    """没建库的域必须返回 None。回退到默认语料等于拿 AI 域的素材去讲工业时序库。"""
    get_corpus_retriever.cache_clear()
    assert get_corpus_retriever("no-such-corpus-xyz") is None
    # 语料名进路径，非法字符要卡死（外部 HTTP 参数是不可信输入）
    assert get_corpus_retriever("../../etc") is None
