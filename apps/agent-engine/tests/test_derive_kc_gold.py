"""机械金标抽取的用例。

钉住四条实测踩过的坑：
1. ``` 围栏里的 `# 注释` 不是标题（hello-agents 8.3 节有 6 行 python 注释以 # 开头）
2. 教学活动类标题不是知识成分（人工金标已用同样理由删过条目）
3. 转换语料的首个标题常是英文锚点，取标题要优先含中文的那个
4. 整页没有中文标题时（Odoo 的 `# bpost`），必须补一句正文，
   否则判官拿到的是没有语义的 slug
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from derive_kc_gold import (  # noqa: E402
    chapter_of,
    derive,
    headings,
    lead_sentence,
    read_front_matter,
    title_of,
)


def test_headings_skip_fenced_code():
    text = "# 8.1 真标题\n```python\n# 创建具有RAG能力的Agent\n```\n### 8.1.1 子节\n"
    got = [h[2] for h in headings(text, numbered_only=True)]
    assert got == ["真标题", "子节"], got


def test_only_numbered_headings_count():
    text = "## 概述\n### 2.1 有编号\n#### 小结\n"
    assert [h[2] for h in headings(text, numbered_only=True)] == ["有编号"]


def test_title_prefers_cjk_heading():
    text = "# bpost\n\n## 中文标题\n正文\n"
    assert title_of(Path("bpost.md"), text) == "中文标题"


def test_title_falls_back_to_english_when_no_cjk():
    assert title_of(Path("bpost.md"), "# bpost\n正文没有标题\n") == "bpost"


def test_lead_sentence_skips_headings_and_fences():
    text = "# bpost\n```\n中文注释在代码里不算。\n```\n在 Odoo 中设置 Bpost 送货连接器，以便管理货运。\n"
    assert lead_sentence(text).startswith("在 Odoo 中设置 Bpost")


def test_lead_sentence_empty_when_no_cjk():
    assert lead_sentence("# x\nonly english here.\n") == ""


def test_chapter_from_author_title_not_our_topic_tag():
    """章取作者排的「第 N 章」，不取我们入库时打的 topic 标签——后者是我方产物，
    拿它当金标分母就把权威挪回了我们这边。"""
    meta = read_front_matter("---\nsource_id: ha08s03\ntitle: 第8章 8.3 RAG系统\ntopic: rag\n---\n")
    assert chapter_of(meta, Path("ha08s03.md")) == "ha08-第8章"
    # 没有「第 N 章」时退回 source_id 去掉节号
    assert chapter_of({"source_id": "ha12s04"}, Path("x.md")) == "ha12"


def test_derive_file_tree_adds_description_only_for_slug_names(tmp_path):
    root = tmp_path / "corpus"
    (root / "ch").mkdir(parents=True)
    (root / "ch" / "slug.md").write_text(
        "# bpost\n\n在 Odoo 中设置送货连接器，以便直接管理货运。\n", encoding="utf-8"
    )
    (root / "ch" / "zh.md").write_text("# 库存调整\n\n正文若干。\n", encoding="utf-8")
    topics = derive(root)
    kcs = {k["name"]: k for k in topics["ch"]}
    assert "description" in kcs["bpost"]           # 英文锚点要补正文
    assert "description" not in kcs["库存调整"]      # 中文名不必补


def test_derive_flat_corpus_filters_activities(tmp_path):
    root = tmp_path / "flat"
    root.mkdir()
    (root / "ha08s03.md").write_text(
        "---\nsource_id: ha08s03\ntitle: 第8章 8.3 RAG系统\n---\n"
        "# 8.3 RAG系统\n### 8.3.1 RAG的基础知识\n### 8.3.2 快速体验：30秒上手\n",
        encoding="utf-8",
    )
    topics = derive(root)
    names = [k["name"] for v in topics.values() for k in v]
    assert "RAG的基础知识" in names
    assert not any("快速体验" in n for n in names)   # 教学活动不是知识成分
