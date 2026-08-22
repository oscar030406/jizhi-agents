"""语料库对外可见性：扫盘发现 + 质量闸，不用写死的名单。

背景：这里曾是一个硬编码元组 `DOMAIN_CORPORA`，为了挡住接入流水线的先期小样
（冷链 4 块、光伏 12 块）被抬成「已建设领域」。但那把「管理者上传新库后自动注册」
一起堵死了——按名单走，传进来一个真库不改代码就永远不出现，而「上传完剩下都是
系统的事」正是本项目对泛化的定义。

换成数据判据后，这个文件钉住三件容易退化回去的事：
  ① 门限有推导，不是拍的；
  ② 没过闸的库**如实标出原因**，不静默消失；
  ③ 「过闸可用」与「跨大类泛化域」是两件事，别让前者自动升格成后者。
"""
from __future__ import annotations

import pytest

from backend.integration.personalize_service import (
    CROSS_DOMAIN_CORPORA,
    MIN_CORPUS_CHUNKS,
    _corpus_gate,
)


def test_门限够铺满一门课() -> None:
    """80 这个数的依据：中位 10 屏×6 块=60，最长 13 屏=78。低于 78 就撑不满最长的课。"""
    assert MIN_CORPUS_CHUNKS >= 78


def test_真库过闸() -> None:
    gate = _corpus_gate("iotdb", chunks=3202, retrievable=True)
    assert gate["passed"], gate["reasons"]


def test_先期小样被挡且说得出原因() -> None:
    """挡下来不算完——管理者要看见「为什么」和「差多少」，否则会以为系统把库吞了。"""
    gate = _corpus_gate("pv-ops", chunks=12, retrievable=True)
    assert not gate["passed"]
    assert gate["chunks"] == 12
    assert gate["floor"] == MIN_CORPUS_CHUNKS
    joined = "; ".join(gate["reasons"])
    assert "12" in joined and str(MIN_CORPUS_CHUNKS) in joined, f"原因里要有具体数字：{joined}"


def test_索引缺失单独成因() -> None:
    """块数够但检索器起不来，也要拦——两条原因分别可见，不是笼统一句「不可用」。"""
    gate = _corpus_gate("somelib", chunks=500, retrievable=False)
    assert not gate["passed"]
    assert any("索引" in r for r in gate["reasons"])


def test_三条取与不取或() -> None:
    """能检索 ≠ 有素材。只满足一条不许放行——取或的话 4 块的库也能过。"""
    assert not _corpus_gate("tiny", chunks=4, retrievable=True)["passed"]
    assert not _corpus_gate("big-but-broken", chunks=9999, retrievable=False)["passed"]


def test_跨大类泛化域是另一套判据() -> None:
    """vecdb / rag-adv 块数够、能当知识库用，但它们是 AI 大类内部的扩展语料。

    拿它们证明「换个库就换个领域」等于自己跟自己比。这个集合是人的判断，
    不能从块数推出来——所以它是独立的一张表，不是闸的副产品。
    """
    assert _corpus_gate("vecdb", chunks=807, retrievable=True)["passed"]
    assert "vecdb" not in CROSS_DOMAIN_CORPORA
    assert "rag-adv" not in CROSS_DOMAIN_CORPORA
    assert {"iotdb", "odoo"} <= CROSS_DOMAIN_CORPORA


@pytest.mark.parametrize("name", ["ai"])
def test_主库不适用词表闸(name: str) -> None:
    """主库不是接入链建的，没有 intake 记录，词表闸对它无从谈起，不该因此被拦。"""
    assert _corpus_gate(name, chunks=1704, retrievable=True)["passed"]
