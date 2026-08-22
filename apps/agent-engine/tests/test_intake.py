"""接入前三步：分诊、结构元数据、许可识别。

钉住的是三件容易悄悄坏掉的事：退回清单不许静默丢文件、切块行为不许被改动、
CC BY-NC-SA 不许被误判成 CC BY-SA（两者正文高度重叠，判据顺序错了就会串）。
"""

from backend.rag.ingest import split_into_sections
from backend.rag.intake import (
    UNKNOWN_LICENSE,
    detect_license,
    normalize_rst_dir,
    outline_sections,
    read_body,
    triage,
)

CC_BY_NC_SA = "Attribution-NonCommercial-ShareAlike 4.0 International\nhttps://creativecommons.org/licenses/by-nc-sa/4.0/"
CC_BY_SA = "Attribution-ShareAlike 4.0 International\nhttps://creativecommons.org/licenses/by-sa/4.0/"


def _write(root, rel, text):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def test_triage_keeps_markdown_and_explains_every_rejection(tmp_path):
    _write(tmp_path, "docs/chapter1/intro.md", "# 引言\n\n" + "正文内容。" * 80)
    _write(tmp_path, "docs/chapter1/notes.txt", "纯文本笔记。" * 60)
    _write(tmp_path, "docs/chapter1/diagram.png", "not really an image")
    _write(tmp_path, "docs/chapter1/placeholder.md", "TODO")
    _write(tmp_path, "docs/chapter1/小结.md", "# 小结\n\n" + "重复正文。" * 80)

    manifest = triage(tmp_path)
    accepted = {f.relative for f in manifest.accepted}
    assert accepted == {"docs/chapter1/intro.md", "docs/chapter1/notes.txt"}

    # 每个被退回的文件都要带理由——静默丢文件是这一层最容易犯的错
    rejected = dict(manifest.rejected)
    assert len(rejected) == 3
    assert all(reason for reason in rejected.values())
    assert ".png" in rejected["docs/chapter1/diagram.png"]
    assert "占位" in rejected["docs/chapter1/placeholder.md"]
    assert "小结" in rejected["docs/chapter1/小结.md"]


def test_triage_records_path_depth_for_structure_fallback(tmp_path):
    _write(tmp_path, "a/b/c/deep.md", "# 深\n\n" + "内容。" * 80)
    manifest = triage(tmp_path)
    assert manifest.accepted[0].path_depth == 4
    assert manifest.accepted_chars > 0


def test_outline_does_not_change_chunking(tmp_path):
    """结构元数据是旁挂的。切法一旦被改，现有 1704 个 chunk 和三个指标全要重算。"""
    body = "# 文档标题\n\n" + "\n\n".join(f"## 第 {i} 节\n\n" + "内容。" * 60 for i in range(1, 5))
    assert [m.text for m in outline_sections(body)] == split_into_sections(body)


def test_outline_builds_heading_path():
    """切开的段挂到它自己的 H2 上，路径是 文档标题 → 小节标题。"""
    body = "# 量化\n\n" + "导语。" * 400 + "\n\n## 为什么要量化\n\n" + "正文。" * 400
    metas = outline_sections(body)
    assert len(metas) > 1, "语料够长时应当切开，否则这个用例测不到东西"
    tail = metas[-1]
    assert tail.heading_path == ["量化", "为什么要量化"]
    assert tail.depth == 2


def test_merged_section_is_anchored_to_its_first_heading():
    """短文档会被合并成一段，此时按文档口径取**第一个**标题作为归属。"""
    body = "# 量化\n\n导语。\n\n## 为什么要量化\n\n" + "正文。" * 100
    metas = outline_sections(body)
    assert len(metas) == 1
    assert metas[0].heading_path == ["量化"]


def test_outline_falls_back_to_path_depth_without_headings():
    """`.po` 转出来的文本还原不了标题层级——那条路上只有文件路径深度可用。"""
    metas = outline_sections("没有任何标题的一段正文。" * 40, path_depth=3)
    assert metas[0].heading_path == []
    assert metas[0].depth == 3


# ── .rst ──────────────────────────────────────────────────────────────────
#
# 加 `.rst` 的全部风险在「加了后缀但结构认不出」：rst 的标题层级写在下划线里，
# 一个 `#` 都没有，认不出就是一段大平铺。K1 那次 odoo 走 `.po` 已经这么翻过一次车
# （金标退化成 fedex / labels，11 屏错误判定，作品设计实现方案 §7.2）。
# 下面三条钉的就是「层级真的还原出来了」，不是「文件收进来了」。

_LONG = "时间序列按时间顺序记录观测值，写入几乎总是追加，查询几乎总是按时间范围扫描。" * 12

RST_PAGE = f"""====================
时序数据库入门
====================

{_LONG}

写入路径
====================

{_LONG}

攒批的取舍
--------------------

{_LONG}
"""


def test_triage_accepts_rst(tmp_path):
    _write(tmp_path, "docs/guide.rst", RST_PAGE)
    manifest = triage(tmp_path)
    assert [f.relative for f in manifest.accepted] == ["docs/guide.rst"]


def test_unsupported_formats_are_still_returned_with_a_reason(tmp_path):
    """加了 rst 不等于通吃。收不了的照旧退回并写明理由——可控失败优于静默出乱码。"""
    _write(tmp_path, "docs/guide.rst", RST_PAGE)
    _write(tmp_path, "docs/messages.po", 'msgid "a"\nmsgstr "甲"\n' * 40)
    _write(tmp_path, "docs/handbook.pdf", "%PDF-1.7 " + "x" * 400)
    _write(tmp_path, "docs/notes.docx", "PK" + "x" * 400)

    rejected = dict(triage(tmp_path).rejected)
    assert set(rejected) == {"docs/messages.po", "docs/handbook.pdf", "docs/notes.docx"}
    assert all(reason for reason in rejected.values())
    assert ".po" in rejected["docs/messages.po"]


def test_rst_heading_levels_are_recovered(tmp_path):
    """下划线定级：`====` 先出现即 H1，`----` 次之即 H2；上下划线那种再单算一级。"""
    body = read_body(_write(tmp_path, "guide.rst", RST_PAGE))
    heads = [ln for ln in body.splitlines() if ln.startswith("#")]
    assert heads == ["# 时序数据库入门", "## 写入路径", "### 攒批的取舍"]


def test_rst_structure_reaches_the_chunker(tmp_path):
    """还原出的层级要真的走进切块那一路，否则等于白转。"""
    metas = outline_sections(read_body(_write(tmp_path, "guide.rst", RST_PAGE)), path_depth=1)
    assert len(metas) > 1, "语料够长时应当切开，否则这个用例测不到东西"
    paths = [m.heading_path for m in metas]
    assert all(p and p[0] == "时序数据库入门" for p in paths), paths
    assert ["时序数据库入门", "写入路径"] in paths
    assert ["时序数据库入门", "攒批的取舍"] in paths
    # depth 来自标题路径长度，不再回落到文件路径深度——这一格是结构信号的下游输入
    assert max(m.depth for m in metas) == 2


def test_normalize_rst_dir_leaves_only_markdown(tmp_path):
    """下游三处（金标派生、结构信号、⑤ 的开跑前判断）只 rglob `*.md`，所以后缀必须换。"""
    _write(tmp_path, "docs/guide.rst", RST_PAGE)
    assert normalize_rst_dir(tmp_path) == [("docs/guide.rst", "docs/guide.md")]
    assert not list(tmp_path.rglob("*.rst")), "原件留着会被 triage 再收一遍，索引里出现两份"
    assert (tmp_path / "docs" / "guide.md").read_text(encoding="utf-8").startswith("# 时序数据库入门")


def test_license_from_license_file(tmp_path):
    _write(tmp_path, "LICENSE", CC_BY_NC_SA)
    info = detect_license(tmp_path)
    assert info.spdx == "CC-BY-NC-SA-4.0"
    assert info.unknown is False
    assert "LICENSE" in info.evidence


def test_nc_variant_is_not_mistaken_for_sa(tmp_path):
    """BY-NC-SA 的正文含 ShareAlike 特征串。判据顺序错了会串成 BY-SA。"""
    _write(tmp_path, "LICENSE", CC_BY_NC_SA)
    assert detect_license(tmp_path).spdx == "CC-BY-NC-SA-4.0"
    other = tmp_path / "other"
    _write(other, "LICENSE", CC_BY_SA)
    assert detect_license(other).spdx == "CC-BY-SA-4.0"


def test_license_from_readme_section(tmp_path):
    """llm-deploy 就是这种：仓库没有 LICENSE 文件，许可写在 README 的 LICENSE 节。"""
    _write(
        tmp_path,
        "README.md",
        "# 项目\n\n介绍若干。\n\n## LICENSE\n\n本项目采用 " + CC_BY_NC_SA + "\n\n## 致谢\n\n略。",
    )
    info = detect_license(tmp_path)
    assert info.spdx == "CC-BY-NC-SA-4.0"
    assert "README.md" in info.evidence


def test_unknown_license_is_recorded_not_blocking(tmp_path):
    """判不出来只进待确认项，不拦接入——非商用场景下拦是过重。"""
    _write(tmp_path, "README.md", "# 项目\n\n没有任何许可声明。")
    info = detect_license(tmp_path)
    assert info.spdx == UNKNOWN_LICENSE
    assert info.unknown is True
    # 证据要写清查了哪些位置，便于人工补
    assert "README.md" in info.evidence
    # 但**不许写绝对路径**：这一串会透传到接入页上屏，绝对路径等于把跑机器的用户名印给评委看
    assert str(tmp_path) not in info.evidence


def test_license_walks_up_to_the_repo_root(tmp_path):
    """人指的通常是内容子目录，LICENSE 躺在仓库根。

    实测踩过：指 `iotdb-docs/src/zh/UserGuide/Master`，Apache-2.0 的 LICENSE 在仓库根，
    只查投进来那一层会把许可明确的仓库判成 UNKNOWN。
    """
    # 深度照抄踩过的真实结构：iotdb-docs/src/zh/UserGuide/Master，距根 4 层。
    # 上限一度被收到 4，正好在探到根之前停住——这个用例就是为了钉死那次回归。
    _write(tmp_path, "LICENSE", "Apache License\nVersion 2.0")
    deep = tmp_path / "src" / "zh" / "UserGuide" / "Master"
    deep.mkdir(parents=True)
    info = detect_license(deep)
    assert info.spdx == "Apache-2.0"
    # 路径要落在 evidence 里——来自上层目录时人一眼能看出不是本目录的许可。
    # 写法是**相对语料根**（`../../../../LICENSE`），不是绝对路径：判据会上屏。
    assert info.evidence.startswith("../../../../LICENSE")
    assert str(tmp_path) not in info.evidence


def test_license_walk_stops_at_repo_root(tmp_path):
    """`.git` 是仓库边界，到此为止——再往上是别人的东西，不许认领。"""
    _write(tmp_path, "LICENSE", "MIT License")
    repo = tmp_path / "vendor" / "somerepo"
    (repo / ".git").mkdir(parents=True)
    content = repo / "docs"
    content.mkdir()
    assert detect_license(content).spdx == UNKNOWN_LICENSE


def test_license_walk_up_is_bounded(tmp_path):
    """向上找有上限——无上限会一路走到用户主目录认领不相干的许可。"""
    _write(tmp_path, "LICENSE", "MIT License")
    deep = tmp_path / "a" / "b" / "c" / "d" / "e" / "f"
    deep.mkdir(parents=True)
    assert detect_license(deep).spdx == UNKNOWN_LICENSE
