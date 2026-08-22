"""`scripts/rst_to_markdown.py` 的守门测试。

这份转换器存在的全部理由是**还原 rst 的标题层级**——2026-08-16 查清 odoo 金标退化成
`fedex` / `labels` / `../setup_configuration` 的上游成因就是 `.po` 里没有下划线。
所以断言集中在三件事上，每一件都对应一个已经真实翻过的车：

1. 标题下划线定级（`====` 先出现即 H1，`----` 次之即 H2）。
   翻过的车：判定顺序写反，标题行被整个跳过、`=============` 当正文上屏。
2. `.. toctree::` 不产出正文条目。翻过的车：`labels.md` 整篇正文只有一行
   `../setup_configuration/third_party_shipper`。
3. `:doc:` 交叉引用转成 markdown 链接。翻过的车：目标段一刀切摘掉之后
   `structure_edges.probe()` 的交叉引用从 2707 条掉到 9 条，章级前置图整层塌掉。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from rst_to_markdown import convert, parse_rst  # noqa: E402

SAMPLE = """\
:show-content:

================
Delivery methods
================

In Odoo, *delivery methods* make it possible to calculate shipping costs.

Configuration
=============

Then, remove the :guilabel:`Apps` filter and click :guilabel:`Install`.

.. image:: setup_configuration/delivery-product.png
   :alt: Show delivery order on the sales order line.

Delivery order
--------------

See :doc:`third-party carrier <setup_configuration/third_party_shipper>` for details.

.. toctree::
   :titlesonly:

   setup_configuration/labels
   setup_configuration/fedex
"""


def _blocks(text: str) -> list[tuple[str, int, str]]:
    return parse_rst(text)


def test_heading_levels_follow_adornment_order() -> None:
    heads = [(lvl, txt) for kind, lvl, txt in _blocks(SAMPLE) if kind == "heading"]
    assert heads == [
        (1, "Delivery methods"),
        (2, "Configuration"),
        (3, "Delivery order"),
    ]


def test_adornment_lines_never_become_body() -> None:
    bodies = [txt for kind, _lvl, txt in _blocks(SAMPLE) if kind == "para"]
    assert not any(set(b.strip()) <= {"=", "-"} for b in bodies), bodies


def test_toctree_entries_are_not_body() -> None:
    """`../setup_configuration` 那条金标就是从 toctree 条目变成「知识点」的。"""
    text = "\n".join(txt for _k, _l, txt in _blocks(SAMPLE))
    assert "setup_configuration/labels" not in text
    assert "setup_configuration/fedex" not in text


def test_image_directive_dropped() -> None:
    text = "\n".join(txt for _k, _l, txt in _blocks(SAMPLE))
    assert "delivery-product.png" not in text
    assert "Show delivery order" not in text


def test_guilabel_text_stays_inline(tmp_path: Path) -> None:
    """界面词只剥记号、不删字：它留在句子里，就永远不会单独成一个知识点。"""
    src = tmp_path / "a.rst"
    src.write_text(SAMPLE, encoding="utf-8")
    body, _hit, _miss = convert(src, {})
    assert "remove the Apps filter and click Install" in body
    assert ":guilabel:" not in body


def test_doc_role_becomes_markdown_link(tmp_path: Path) -> None:
    """`structure_edges.page_refs()` 只认 `[文字](路径)` 与 `<../路径>` 两种写法。"""
    src = tmp_path / "a.rst"
    src.write_text(SAMPLE, encoding="utf-8")
    body, _hit, _miss = convert(src, {})
    assert "[third-party carrier](setup_configuration/third_party_shipper)" in body


def test_translation_fills_from_catalog(tmp_path: Path) -> None:
    src = tmp_path / "a.rst"
    src.write_text(SAMPLE, encoding="utf-8")
    catalog = {"Delivery methods": "配送方式", "Configuration": "配置"}
    body, hit, miss = convert(src, catalog)
    assert body.startswith("# 配送方式")
    assert "## 配置" in body
    # 查不到的块回落英文并计数——回落率是要进报告的数字，不能静默
    assert hit == 2 and miss > 0
