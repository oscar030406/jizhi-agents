# -*- coding: utf-8 -*-
"""语料形态检测：结构信号能不能用，由语料形态决定。

2026-08-23 两轮实测得出的一等结论——不是三条独立局限，是一条规律：

- **教材形态**（单书成册、文件名带序号）：章节序、指路措辞、篇内位置三样都在。
- **文档站形态**（VuePress / rst 转 md）：章节序全灭，措辞信号只够得着一成。

所以下游吃顺序的东西（前置边用章节序当默认、难度冷启动的位置先验）
只在 textbook 形态激活；docsite 形态诚实降级并说明原因。

**这个检测器自己先错过一次**，所以下面盯得比较死：第一版扫正文里的
`## 1. 步骤` 这类标题号，把 iotdb（文档站）判成 textbook 99%——
页内小标题文档站也有，跟文档之间的顺序毫无关系。判据必须看文档身份。
"""
from __future__ import annotations

import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE) not in sys.path:
    sys.path.insert(0, str(ENGINE))
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

from backend.rag.structure_edges import detect_form  # noqa: E402


def _docs(names: list[str], body: str = "# 标题\n正文") -> dict[str, str]:
    return {n: body for n in names}


def test_文件名带序号判教材():
    files = _docs([f"book/pv-ops-{i:02d}.md" for i in range(1, 11)])
    got = detect_form(files)
    assert got["form"] == "textbook"
    assert got["numbered_ratio"] == 1.0


def test_chapter1连写也认():
    # vecdb 的形态：`annoy-chapter1-annoy.md`，数字贴在词后面没有分隔符
    files = _docs([f"annoy-chapter{i}-api.md" for i in range(1, 9)])
    assert detect_form(files)["form"] == "textbook"


def test_中文第N章也认():
    files = _docs([f"第{n}章-定时器.md" for n in "一二三四五六"])
    assert detect_form(files)["form"] == "textbook"


def test_文档站判成docsite():
    # iotdb / odoo 的形态：路径全是语义名，一个序号都没有
    files = _docs(
        [
            "Table/API/Programming-Java-Native-API.md",
            "Table/Basic-Concept/Operate-Metadata.md",
            "content/administration/hosting.md",
            "content/inventory/shipping.md",
        ]
    )
    got = detect_form(files)
    assert got["form"] == "docsite"
    assert got["numbered_ratio"] == 0.0
    assert "没有可用的章节序" in got["why"]


def test_页内小标题号不算数():
    """检测器自己犯过的错：正文里的 `## 1. 步骤` 让 iotdb 判成 textbook 99%。

    页内小标题描述的是**一页之内**的次序，跟这些页谁先谁后毫无关系。
    """
    body = "# 数据写入\n\n## 1. CLI 写入\n正文\n\n## 2. JDBC 写入\n正文\n\n## 3.1 批量\n正文"
    files = _docs(
        [
            "Table/API/write-data.md",
            "Table/API/query-data.md",
            "Table/Basic-Concept/metadata.md",
        ],
        body,
    )
    assert detect_form(files)["form"] == "docsite"


def test_导航文件是反证据而不是正证据(tmp_path):
    """顺序写在导航里，而导航不在我们收进来的正文里——所以它证明的是「拿不到顺序」。"""
    (tmp_path / "SUMMARY.md").write_text("- [a](a.md)\n", encoding="utf-8")
    files = _docs(["docs/alpha.md", "docs/beta.md"])
    got = detect_form(files, tmp_path)
    assert got["form"] == "docsite"
    assert "SUMMARY.md" in got["nav_files"]
    assert "导航" in got["why"]


def test_空语料不猜():
    got = detect_form({})
    assert got["form"] == "unknown"


def test_阈值落在空档里():
    """六份真语料实测：教材 86%-100%，文档站 0%，中间是空的。
    阈值取 0.5 是因为那一段没有样本，不是调出来的。"""
    from backend.rag.structure_edges import _TEXTBOOK_MIN_RATIO

    assert 0.0 < _TEXTBOOK_MIN_RATIO < 0.86


def test_probe带出形态():
    """路障：形态要跟着 probe 出来，否则 ④ 拿不到、就绪度报告里就没有它。"""
    src = (ENGINE / "backend" / "rag" / "structure_edges.py").read_text(encoding="utf-8")
    assert '"structure_form": form' in src
    svc = (ENGINE / "backend" / "services" / "domain_intake.py").read_text(encoding="utf-8")
    assert '"structure_form": structure.get("structure_form")' in svc, "就绪度报告里没写形态"
    assert "文档站形态" in svc, "docsite 没有诚实降级的说明"


# ── 章节序信号：只记不判 ──────────────────────────────────

import ingest_domain as g  # noqa: E402


def test_概念位置取文件名里的序号():
    vocab = [
        {"concept": "向量数据库", "sections": ["chapter1-01-intro.md#1 简介"]},
        {"concept": "混合检索", "sections": ["chapter3-06-hybrid.md#2 混合"]},
    ]
    assert g.concept_positions(vocab) == {"向量数据库": (1, 1), "混合检索": (3, 6)}


def test_没有序号的路径退化成兜底位置():
    """文档站形态的路径没有序号，位置全退化成 (999,)——
    于是 order_agrees 全落成 tie/None，等于没记。**这正是要的降级行为**。"""
    vocab = [{"concept": "A", "sections": ["content/administration/hosting.md#1 x"]}]
    assert g.concept_positions(vocab) == {"A": (999,)}


def test_多次出现取首次():
    vocab = [{"concept": "A", "sections": ["ch5-02.md#1 x", "ch1-03.md#2 y"]}]
    assert g.concept_positions(vocab)["A"] == (1, 3)


def test_章节序是记录不是过滤():
    """路障：`order_agrees` 只记不判。

    实测过才这么定的：rag-adv 11 条边里 5 条违反章节序，vecdb 5 条里 2 条。
    **违反的占四五成**——「章节序当默认、LLM 只复核违反的边」这条杠杆
    在我们的语料上省不下调用，一半的边都要复核。所以先记不判，
    等人工标注出来再决定。谁把它改成过滤条件，这条会拦住。
    """
    src = (ENGINE / "scripts" / "ingest_domain.py").read_text(encoding="utf-8")
    assert '"order_agrees": _agrees(ps, q)' in src
    # 不许出现「按 order_agrees 丢边」的形态
    assert "if _agrees" not in src
    assert 'order_agrees"] ==' not in src
