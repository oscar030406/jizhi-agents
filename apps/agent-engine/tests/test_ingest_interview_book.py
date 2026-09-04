"""ingest_interview_book.clean_body 的回归闸。

坏了会怎样：切块器（backend/rag/ingest.split_into_sections）只按 markdown 的 H2/H3 切，
HTML 小标题没被还原的话整篇退化成按段落硬切的窗口，一块横跨几个主题，
语义门检索被稀释——现象是 skill-map 的 Harness / 自进化两项技能悄悄掉回未覆盖，
而脚本本身照样 exit 0。
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location(
    "ingest_interview_book",
    Path(__file__).resolve().parents[1] / "scripts" / "ingest_interview_book.py",
)
_MOD = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_MOD)
clean_body = _MOD.clean_body

RAW = """# 目录

## 第一章 总览

[1. 什么是 Harness？](#q-001)

---

<h1 id="q-001">1. 什么是 Harness？</h1>

正文一。

<h2 id="q-002">面试问题：Harness 和 Benchmark 有什么区别？</h2>

正文二。![图](imgs/a.png)
"""


def test_clean_body_drops_toc_and_restores_markdown_headings() -> None:
    body = clean_body(RAW)
    assert "#q-001" not in body and "## 第一章 总览" not in body, "目录没被去掉"
    assert body.startswith("## 1. 什么是 Harness？"), body[:60]
    assert "### Harness 和 Benchmark 有什么区别？" in body, "H2 没还原或「面试问题：」壳没脱"
    assert "<h1" not in body and "<h2" not in body
    assert "![图]" not in body
    assert "正文一。" in body and "正文二。" in body, "正文被误删"


if __name__ == "__main__":
    test_clean_body_drops_toc_and_restores_markdown_headings()
    print("ok")
