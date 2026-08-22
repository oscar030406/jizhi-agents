r"""把 gettext `.po` 译文还原成接入 Agent 能吃的 markdown。

    python scripts/po_to_markdown.py --po <文件.po> --out <目录> [--limit N]

## 为什么需要这一步

接入 Agent 吃 md/txt/rst（`backend/rag/intake.py` 的 `READABLE_SUFFIXES`；rst 是 08-21 加的，
有 rst 原件就直接投原件，`read_body` 会按下划线还原标题层级，不必绕这条 `.po` 的路）。
Odoo 中文文档的形态是 `.po`——原文在 `msgid`、译文在 `msgstr`、来源在 `#:` 注释里。
这是**格式分诊那条边界的第一次真实触发**：不加分支就退回，加分支就得写这个。

## 一个绕不开的坑：标题层级还原不了

调研当初标了风险，实测属实。reStructuredText 的标题**级别由下划线字符**表达：

    数据模型
    ========

而下划线不是可翻译字符串，**不进 `.po`**。所以从 `.po` 只还原得出标题**文本**，
还原不出**层级**。这不是实现偷懒，是格式本身的信息损失。

兜底：用 `#:` 注释里的**源文件路径深度**当结构信号
（`inventory/shipping/setup.rst` = 3 层）。`outline_sections(path_depth=…)` 早就为
这种情况留了回退口——那个参数不是白加的。

## 切分口径

一个源 rst 文件 → 一个 `.md`。同一文件内的条目按 `.po` 里的出现顺序拼接，
**顺序即原文顺序**（gettext 抽取器按源文件行号走）。

只取 `msgstr` 非空的条目：没译文的段落留着只会把英文混进中文语料，
污染术语密度与可读性特征。跳过多少条要报出来，不静默。
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from collections import OrderedDict
from pathlib import Path

#: `#: docs/a/b.rst:12 docs/a/b.rst:34` —— 可能一行多个引用
_REF = re.compile(r"^#:\s*(.+)$")
_MSGID = re.compile(r'^msgid\s+"(.*)"$')
_MSGSTR = re.compile(r'^msgstr\s+"(.*)"$')
_CONT = re.compile(r'^"(.*)"$')

#: 短于此长度的译文多半是 UI 标签（按钮名、字段名），不是教学内容。
MIN_ENTRY_CHARS = 12


def safe_relative(src: str) -> pathlib.PurePosixPath:
    """把 `.po` 里的源路径收敛成**一定落在 --out 之内**的相对路径。

    实测踩过：Odoo 的引用写成 `../../content/applications/...rst`，
    直接 `out / rel` 会顺着 `../..` 爬到 --out 的父目录去——这次在项目根目录
    凭空建了个 `content/`（165 个文件）。转换器能写到 --out 之外是真隐患，
    不是「这次弄脏了目录」那么轻。

    做法：丢掉所有 `..` 与绝对根，只留末端的相对结构。
    """
    parts = [p for p in pathlib.PurePosixPath(src.replace("\\", "/")).parts
             if p not in ("..", ".", "/") and not p.endswith(":")]
    return pathlib.PurePosixPath(*parts) if parts else pathlib.PurePosixPath("unknown.rst")


#: reStructuredText 的行内角色与转义。留着会污染术语密度、可读性、代码占比这几个
#: 机械特征——`:guilabel:` 里的界面词会被当成术语，`\ ` 会被当成代码记号。
#: 实测残渣样本：`在 Odoo 中，商品和服务均设置为\ *产品*\ 。`
_RST_ROLE = re.compile(r":[a-z]+:`([^`]*)`")
#: rst 的行内转义：一个反斜杠 + 可选空白，用来把标记与中文隔开，剥掉即可。
_RST_ESCAPE = re.compile(r"\\\s?")
_RST_EMPH = re.compile(r"\*{1,2}([^*]+)\*{1,2}")
_RST_LINK = re.compile(r"`([^`<]+?)\s*<[^>]+>`_+")
#: 写坏的角色残渣，成对规则匹配不上时的兜底
_RST_BARE_ROLE = re.compile(r":[a-z]{3,}:")


def clean_rst(text: str) -> str:
    """剥掉 rst 行内标记，只留可读中文。**保留内容，去掉记号。**

    一版把这四个 `sub` 的替换串写成了空串，于是角色里的可见文本被一起吃掉：
    `:guilabel:`产品`` 变成空白，整段话少了关键名词，43 万字缩到 24 万。
    **剥标记不等于删内容**——每个 `sub` 都必须把捕获组写回去。
    """
    t = _RST_LINK.sub(r"\1", text)
    # 角色里的可见文本可能带 `-->` 这样的路径分隔，原样留着可读
    t = _RST_ROLE.sub(r"\1", t)
    t = _RST_ESCAPE.sub("", t)
    t = _RST_EMPH.sub(r"\1", t)
    # 兜底：译者把角色写坏时（`:guilabel:产品表单上的\`条形码\`字段`）成对规则匹配不上，
    # 剩个裸的 `:word:` 记号和游离反引号。它们不是内容，扫掉。
    t = _RST_BARE_ROLE.sub("", t).replace("`", "")
    return re.sub(r"\s{2,}", " ", t).strip()


#: 标题超过这个长度就不像标题，是被当成标题的第一段正文。
MAX_TITLE_CHARS = 40


def parse_po(path: Path) -> list[tuple[str, str]]:
    """返回 [(源文件, 译文)]，按 `.po` 里的出现顺序。"""
    entries: list[tuple[str, str]] = []
    refs: list[str] = []
    mode: str | None = None
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf, refs, mode
        if mode == "msgstr":
            text = "".join(buf).replace("\\n", "\n").replace('\\"', '"').strip()
            src = refs[0].split(":")[0] if refs else "unknown.rst"
            text = clean_rst(text)
            if len(text) >= MIN_ENTRY_CHARS:
                entries.append((src, text))
        buf = []
        mode = None

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.rstrip()
        if m := _REF.match(line):
            flush()
            refs = m.group(1).split()
            continue
        if m := _MSGID.match(line):
            flush()
            mode = "msgid"
            buf = [m.group(1)]
            continue
        if m := _MSGSTR.match(line):
            if mode == "msgid":
                buf = []
            mode = "msgstr"
            buf = [m.group(1)]
            continue
        if (m := _CONT.match(line)) and mode:
            buf.append(m.group(1))
            continue
        if not line:
            flush()
    flush()
    return entries


#: 小节层级还原：**试过，实测不行，别再试同一条路。**
#:
#: 背景：rst 的小节标题靠下划线（`====`）标记，下划线不进 .po，所以一页十个小节
#: 会被压成一个大平铺——切块拿不到层级，抽知识点拿不到结构信号。2026-08-16 查清
#: 这是 odoo 金标退化成 `fedex`/`labels`/`../setup_configuration` 的上游成因之一。
#:
#: 试过的判据：「短条目 + 不以句末标点收尾 + 下一条 ≥80 字 → 判为小节标题」。
#: 实测（inventory_and_mrp.po，166 篇）：只有 21% 的文件加出标题，且样例是
#: `### (310[0-5])(d{6})`（条码正则）、`### 0120611628936004 3000000050 10LOT0002`
#: （条码数据）——把代码与数据行提成了标题，比不做更糟。已撤回。
#:
#: 正解方向（调研，`docs/05-evidence/kb-architecture-decision-20260816.md`）：
#: Schema-Guided Hierarchical Information Extraction / AnnoIndex 那一路，
#: 先定 schema 再抽结构，4-6 天且无开源仓库。纯长度启发式救不了这件事。


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--po", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=0, help="只导前 N 个源文件，试跑用")
    ap.add_argument(
        "--license-from",
        type=Path,
        help="把源仓库的 LICENSE 复制进产物目录。**转换产物必须带着来源与许可走**——"
        "不带的话接入 Agent 查出来是 UNKNOWN，而它并不是真的许可不明，"
        "是我们在转换这一步把证据弄丢了。",
    )
    args = ap.parse_args()

    if not args.po.is_file():
        print(f"找不到 {args.po}")
        return 1

    entries = parse_po(args.po)
    by_file: OrderedDict[str, list[str]] = OrderedDict()
    for src, text in entries:
        by_file.setdefault(src, []).append(text)

    files = list(by_file.items())
    if args.limit:
        files = files[: args.limit]

    args.out.mkdir(parents=True, exist_ok=True)
    total_chars = 0
    for src, texts in files:
        rel = Path(str(safe_relative(src)))
        # 目录结构照搬源 rst 的路径——路径深度是我们唯一还原得出的结构信号
        target = args.out / rel.with_suffix(".md")
        # 防路径穿越：算完还要确认它真的在 --out 之内，规则写错了也不许写出去
        if not str(target.resolve()).startswith(str(args.out.resolve())):
            print(f"  跳过越界路径：{src}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        # 首条**通常**是该页标题，但不总是——短才像标题，长的是正文第一段。
        # 误把整段正文当 H1，切块时标题路径就成了一整段话（实测见过：
        # 「# 在 Odoo 中，商品和服务均设置为产品。设置新产品时……」）。
        # 那会让概念抽取的候选池里塞满句子，正是 IoTDB 那次翻车的同款根因。
        head_is_title = bool(texts) and len(texts[0]) <= MAX_TITLE_CHARS
        title = texts[0] if head_is_title else rel.stem.replace("_", " ")
        body = "\n\n".join(texts[1:] if head_is_title else texts)
        doc = f"# {title}\n\n{body}\n"
        target.write_text(doc, encoding="utf-8")
        total_chars += len(doc)

    if args.license_from:
        # 传目录（「源仓库」的字面意思）也认——原来只认 `is_file()`，传仓库目录时
        # 整段**静默跳过**：没有 LICENSE、没有 README、没有一句警告，产物看着正常，
        # 直到接入 Agent 查出 UNKNOWN 才发现证据在这一步丢了。odoo 库的许可记录
        # 就是这么变成 UNKNOWN 的（2026-08-16 查清）。静默跳过才是这里真正的缺陷。
        license_file = args.license_from
        if license_file.is_dir():
            license_file = next(
                (
                    c
                    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md")
                    for c in [license_file / name]
                    if c.is_file()
                ),
                None,
            )
        if license_file is None or not license_file.is_file():
            print(
                f"许可原件取不到：--license-from={args.license_from} "
                "既不是文件、目录下也没有 LICENSE/LICENSE.md/LICENSE.txt/COPYING/COPYING.md。\n"
                "转换产物必须带着许可走，这里不静默放过——要么给对路径，要么去掉这个参数并接受产物是 UNKNOWN。"
            )
            return 2
        (args.out / "LICENSE").write_text(
            license_file.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8"
        )
        (args.out / "README.md").write_text(
            "# 转换产物：来源与许可\n\n"
            f"- 源文件：`{args.po}`\n"
            f"- 许可原件：`{license_file}`（已复制为本目录的 LICENSE）\n"
            "- 转换脚本：`apps/agent-engine/scripts/po_to_markdown.py`\n\n"
            "本目录是**转换产物不是真源**。改内容一律回源仓库重跑转换，不要直接编辑这里。\n"
            "标题层级还原不出（rst 的下划线不进 .po），结构信号只有文件路径深度。\n",
            encoding="utf-8",
        )
        print(f"许可与来源已随产物落盘：{args.out / 'LICENSE'}")

    print(f"源 rst 文件 {len(by_file)} 个，导出 {len(files)} 个")
    print(f"条目 {len(entries)} 条（已跳过短于 {MIN_ENTRY_CHARS} 字的 UI 标签类）")
    print(f"中文正文 {total_chars:,} 字符 → {args.out}")
    print("⚠ 标题层级还原不出（rst 的下划线不进 .po），结构信号只有文件路径深度")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
