r"""把 Sphinx 的 `.rst` 原件 + gettext `.po` 译文合成接入 Agent 能吃的中文 markdown。

    python scripts/rst_to_markdown.py --rst-root <仓库>/content --po-dir <仓库>/locale/zh_CN/LC_MESSAGES \
        --out <目录> --sub applications --sub administration --license-from <仓库>

## 为什么要有它（`po_to_markdown.py` 差在哪）

`po_to_markdown.py` 只读 `.po`。rst 的**标题级别由下划线字符表达**（`====` / `----`），
下划线不是可翻译字符串、不进 `.po`，所以那条路上一页十个小节会被压成一段大平铺：

    # setup configuration          ← 文件名当标题
    在 Odoo 中，配送方式可以直接在…   ← 十个小节的正文首尾相连

2026-08-16 查清这是 odoo 金标退化成 `fedex` / `labels` / `../setup_configuration`
的上游成因：`derive_kc_gold.title_of()` 取不到中文标题就退回英文锚点，
而 `../setup_configuration` 是 `.. toctree::` 的导航条目、`fedex` 是 `:guilabel:` 里的界面词。

**rst 原件里这三件事都是语法层可判的**，不需要任何分类器：

| 现象 | rst 里的来源 | 本脚本的处置 |
|---|---|---|
| 标题层级 | 标题下划线（rst 规范：同一字符 = 同一级，按首次出现定级） | 转成 `#` / `##` / `###` |
| `../setup_configuration` | `.. toctree::` 的条目 | 整条指令丢弃，不产出正文 |
| `fedex` / `labels` | `:guilabel:` / `:menuselection:` 行内角色 | 只剥记号、文字留在所在句子里，永远不会单独成段成标题 |

## 中文从哪来

rst 原件是英文，译文在 `.po` 的 `msgstr`。gettext 的翻译单元与 rst 的块一一对应，
`msgid` 就是**空格拼接后的原文块**（gettext 只是按 79 列重排了显示）。
所以按 msgid 精确查表即可，不做模糊匹配。

**查不到的块回落英文并计数**——回落率进报告，不静默。结构正确的中英混排严格优于
无结构的纯中文，但这个比例要如实报。

## 边界

- 只处理 rst 的确定语法（标题下划线、指令、行内角色、列表、表格边框）。
  **这不是启发式**：下划线定级是 reStructuredText 规范里写死的规则，
  不是「短且无句末标点就当标题」那种猜（那条 2026-08-16 实测 21% 命中，已撤回）。
- 代码块 / 字面块不进产物：它们不翻译，留着只会把英文塞进中文语料抬高回落率分母。
- 表格按行拆成短句，不还原表格结构——下游是检索切块，不是渲染。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from po_to_markdown import clean_rst  # noqa: E402  剥行内角色的口径只留一份

# --------------------------------------------------------------------------
# .po 查表
# --------------------------------------------------------------------------

_MSGID = re.compile(r'^msgid\s+"(.*)"$')
_MSGSTR = re.compile(r'^msgstr\s+"(.*)"$')
_CONT = re.compile(r'^"(.*)"$')


def _unescape(raw: str) -> str:
    return raw.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")


def load_catalog(po_dir: Path) -> dict[str, str]:
    """msgid → msgstr。跨 `.po` 文件合并，同一 msgid 后来者不覆盖先到者。

    `#~` 开头的是 gettext 标记的**过时条目**（原文已改），跳过——用它们填当前 rst
    会拿到与原文对不上的旧译文。
    """
    catalog: dict[str, str] = {}
    for po in sorted(po_dir.glob("*.po")):
        mode: str | None = None
        buf: list[str] = []
        msgid = ""
        for raw in po.read_text(encoding="utf-8").splitlines():
            line = raw.rstrip()
            if line.startswith("#~"):
                mode = None
                buf = []
                continue
            if m := _MSGID.match(line):
                mode, buf = "msgid", [m.group(1)]
                continue
            if m := _MSGSTR.match(line):
                if mode == "msgid":
                    msgid = _unescape("".join(buf))
                mode, buf = "msgstr", [m.group(1)]
                continue
            if (m := _CONT.match(line)) and mode:
                buf.append(m.group(1))
                continue
            if mode == "msgstr":
                text = _unescape("".join(buf)).strip()
                if msgid and text:
                    catalog.setdefault(msgid, text)
                mode, buf, msgid = None, [], ""
        if mode == "msgstr":
            text = _unescape("".join(buf)).strip()
            if msgid and text:
                catalog.setdefault(msgid, text)
    return catalog


# --------------------------------------------------------------------------
# rst 解析
# --------------------------------------------------------------------------

#: reStructuredText 规范里可以当标题装饰的标点。级别由「首次出现顺序」决定，
#: 不由字符本身决定——同一篇里 `=` 先出现就是 H1，`-` 次之就是 H2。
_ADORNMENT = set("""!"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~""")

_DIRECTIVE = re.compile(r"^(\s*)\.\.\s+([a-zA-Z0-9_:-]+)::\s*(.*)$")
_COMMENT = re.compile(r"^(\s*)\.\.(\s|$)")
_FIELD = re.compile(r"^\s*:[a-zA-Z0-9_-]+:(\s|$)")
_BULLET = re.compile(r"^(\s*)([-*+]|\#\.|\d+\.)\s+(.*)$")
_TABLE_BORDER = re.compile(r"^\s*[+|][-=+|\s]*$")

#: 正文里没有教学内容的指令：整条（含缩进体）丢弃。
#: `toctree` 是导航、`image`/`figure` 是媒体（图链进课文会变死链，见 ingest_domain.strip_media）、
#: 其余是站点装配件。
_DROP_DIRECTIVES = {
    "toctree", "image", "figure", "graphviz", "cards", "card", "embedded_video",
    "github_link", "only", "raw", "code-block", "code", "literalinclude", "highlight",
    "rst-class", "container", "youtube", "index", "meta", "csv-table", "list-table",
    "autodoc-field", "autodoc-placeholder", "h_code", "tabs", "group-tab", "tab",
}

#: 提示框类：装饰是指令，**内容是正文**，要递归进去。
_KEEP_DIRECTIVES = {
    "note", "tip", "warning", "important", "caution", "danger", "attention",
    "seealso", "example", "spoiler", "admonition", "exercise", "hint", "deprecated",
    "versionadded", "versionchanged", "topic", "sidebar",
}


def _is_adornment(line: str) -> bool:
    s = line.strip()
    return len(s) >= 2 and len(set(s)) == 1 and s[0] in _ADORNMENT


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip())


def _take_block(lines: list[str], i: int) -> tuple[list[str], int]:
    """吃掉第 i 行（指令头）之后所有更深缩进的行，返回（去缩进的体, 下一行号）。"""
    base = _indent(lines[i])
    j = i + 1
    body: list[str] = []
    while j < len(lines):
        if not lines[j].strip():
            body.append("")
            j += 1
            continue
        if _indent(lines[j]) <= base:
            break
        body.append(lines[j])
        j += 1
    while body and not body[-1].strip():
        body.pop()
    pad = min((_indent(b) for b in body if b.strip()), default=0)
    return [b[pad:] if b.strip() else "" for b in body], j


def parse_rst(text: str) -> list[tuple[str, int, str]]:
    """-> [(kind, level, 原文)]，kind ∈ {heading, para}。level 只对 heading 有意义。

    级别按 rst 规范定：装饰字符（含有无上划线）**首次出现的顺序**就是级别顺序。
    """
    order: list[tuple[str, bool]] = []

    def walk(lines: list[str], out: list[tuple[str, int, str]]) -> None:
        i = 0
        while i < len(lines):
            line = lines[i]
            if not line.strip():
                i += 1
                continue

            # 带上划线的标题：装饰 / 标题 / 同款装饰
            if (
                _is_adornment(line)
                and i + 2 < len(lines)
                and lines[i + 1].strip()
                and _is_adornment(lines[i + 2])
                and line.strip()[0] == lines[i + 2].strip()[0]
            ):
                key = (line.strip()[0], True)
                if key not in order:
                    order.append(key)
                out.append(("heading", order.index(key) + 1, lines[i + 1].strip()))
                i += 3
                continue

            m = _DIRECTIVE.match(line)
            if m:
                name = m.group(2).lower()
                body, nxt = _take_block(lines, i)
                if name in _KEEP_DIRECTIVES:
                    head = m.group(3).strip()
                    inner = ([head] + [""] + body) if head else body
                    walk([b for b in inner if not _FIELD.match(b)], out)
                i = nxt
                continue

            # 注释 / 超链接目标 `.. _foo:`：整条丢
            if _COMMENT.match(line):
                _, i = _take_block(lines, i)
                continue

            # 文档级字段 `:show-content:`
            if _FIELD.match(line):
                i += 1
                continue

            if _TABLE_BORDER.match(line):
                i += 1
                continue

            # 表格行：拆成单元格短句
            if line.lstrip().startswith("|") and line.rstrip().endswith("|"):
                for cell in line.strip().strip("|").split("|"):
                    if cell.strip():
                        out.append(("para", 0, cell.strip()))
                i += 1
                continue

            b = _BULLET.match(line)
            if b:
                base = len(b.group(1)) + len(b.group(2)) + 1
                item = [b.group(3)]
                i += 1
                while i < len(lines) and lines[i].strip() and _indent(lines[i]) >= base:
                    item.append(lines[i].strip())
                    i += 1
                out.append(("para", 0, " ".join(x for x in item if x)))
                continue

            # 普通段落：攒到空行。**先收本行再看下一行**——下一行是够长的装饰线时，
            # 刚收的这行才是标题。顺序反了就会把标题行整个跳过、把装饰线当正文
            # （实测症状：一篇 22 个块里 3 条 `=============` 当段落上屏，小节标题全丢）。
            para: list[str] = []
            while i < len(lines) and lines[i].strip():
                if _DIRECTIVE.match(lines[i]) or _COMMENT.match(lines[i]) or _BULLET.match(lines[i]):
                    break
                para.append(lines[i].strip())
                i += 1
                if (
                    i < len(lines)
                    and _is_adornment(lines[i])
                    and len(lines[i].strip()) >= len(para[-1])
                ):
                    break
            if para:
                joined = " ".join(para)
                if i < len(lines) and _is_adornment(lines[i]):  # 本段最后一行其实是标题
                    key = (lines[i].strip()[0], False)
                    if key not in order:
                        order.append(key)
                    out.append(("heading", order.index(key) + 1, para[-1]))
                    if len(para) > 1:
                        out.insert(-1, ("para", 0, " ".join(para[:-1])))
                    i += 1
                    continue
                out.append(("para", 0, joined))
                # `::` 结尾 = 后面跟字面块，整块跳过（代码不翻译）
                if joined.endswith("::"):
                    while i < len(lines) and not lines[i].strip():
                        i += 1
                    if i < len(lines) and _indent(lines[i]) > 0:
                        _, i = _take_block(lines, i - 1) if i else ([], i)
                continue
            i += 1

    out: list[tuple[str, int, str]] = []
    walk(text.replace("\t", "    ").splitlines(), out)
    return out


# --------------------------------------------------------------------------
# 合成
# --------------------------------------------------------------------------

#: 只剩记号、剥完没有可读内容的块（`|` 替换、纯符号）不产出。
_MEANINGFUL = re.compile(r"[0-9A-Za-z一-鿿]")

#: `:doc:` 是**跨页引用**，等价于 import——`structure_edges.probe()` 靠它出章级前置边。
#: 但它的尖括号里是链接目标不是给人读的字，原样留着就成了现役 odoo 语料里遍地的
#: 「电子商务 </applications/websites/ecommerce/shipping>购物车」。
#: 处置：转成标准 markdown 链接 `[显示文字](目标)`——`page_refs()` 认这种写法
#: （IoTDB 那份语料就是这个形态），读起来也是正常的文档链接。
#: 不做这一步的实测代价：交叉引用 978 条 → 9 条，结构候选边 142 → 1，
#: 章级前置图整层塌掉（本单第一次转换就是这么翻的车）。
_DOC_ROLE_T = re.compile(r":doc:`([^`<]*?)\s*<([^`>]*)>`")
_DOC_ROLE_B = re.compile(r":doc:`([^`<>]+)`")
#: `:ref:` 指的是**标签**不是路径，解析不出页面，目标段直接摘掉只留显示文字。
_REF_ROLE_T = re.compile(r":([a-z]+):`([^`<]*?)\s*<[^`>]*>`")
#: `:icon:`oi-arrow-right`` 是字体图标类名，渲染出来是个图标、不是词。留着就成了
#: 「点击oi-arrow-right 获取费率按钮」。
_ICON_ROLE = re.compile(r":icon:`[^`]*`\s*")


def _resolve_doc(base: str, target: str) -> str:
    """`:doc:` 目标 → 相对 rst 根的规范路径（无扩展名）。绝对目标以 `/` 开头。"""
    if target.startswith("/"):
        return target.lstrip("/")
    parts = base.split("/") if base else []
    for seg in target.split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg not in ("", "."):
            parts.append(seg)
    return "/".join(parts)


def _strip_link_targets(text: str, titles: dict[str, str], base: str) -> str:
    """把行内角色收拾成可读文字，`:doc:` 保留成 markdown 链接。

    `:doc:`../setup_configuration``（不带显示文字）在 Sphinx 里渲染成**目标页的标题**。
    照抄路径就是 odoo 金标里那条 `../setup_configuration` 的来路，所以这里按目标页
    的中文标题填显示文字，查不到才退回路径末段。
    """

    def _bare(m: re.Match[str]) -> str:
        target = m.group(1)
        label = titles.get(_resolve_doc(base, target)) or target.rstrip("/").split("/")[-1].replace("_", " ")
        return f"[{label}]({target})"

    text = _DOC_ROLE_T.sub(lambda m: f"[{m.group(1)}]({m.group(2)})", text)
    text = _DOC_ROLE_B.sub(_bare, text)
    return _ICON_ROLE.sub("", _REF_ROLE_T.sub(r":\1:`\2`", text))


def convert(
    rst: Path, catalog: dict[str, str], titles: dict[str, str] | None = None, base: str = ""
) -> tuple[str, int, int]:
    """-> (markdown 正文, 翻译命中块数, 回落英文块数)"""
    blocks = parse_rst(rst.read_text(encoding="utf-8", errors="replace"))
    titles = titles or {}
    lines: list[str] = []
    hit = miss = 0
    for kind, level, raw in blocks:
        zh = catalog.get(raw)
        if zh is None:
            zh = catalog.get(raw.rstrip("."))
        if zh is not None:
            hit += 1
        else:
            miss += 1
            zh = raw
        text = clean_rst(_strip_link_targets(zh, titles, base))
        if not text or not _MEANINGFUL.search(text):
            continue
        lines.append(("#" * min(level, 6) + " " + text) if kind == "heading" else text)
    return "\n\n".join(lines) + "\n", hit, miss


def page_titles(files: list[Path], root: Path, catalog: dict[str, str]) -> dict[str, str]:
    """规范路径（无扩展名）→ 该页的中文标题。给 `:doc:` 的显示文字用。"""
    out: dict[str, str] = {}
    for path in files:
        for kind, _lvl, raw in parse_rst(path.read_text(encoding="utf-8", errors="replace")):
            if kind == "heading":
                out[path.relative_to(root).with_suffix("").as_posix()] = clean_rst(
                    catalog.get(raw, raw)
                )
                break
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rst-root", required=True, type=Path, help="仓库的 content/ 目录")
    ap.add_argument("--po-dir", required=True, type=Path, help="locale/<语言>/LC_MESSAGES")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--sub", action="append", default=[], help="只转 content 下的这些子树，可重复")
    ap.add_argument("--license-from", type=Path, help="源仓库目录或 LICENSE 文件")
    ap.add_argument("--limit", type=int, default=0, help="只转前 N 篇，试跑用")
    args = ap.parse_args()

    if not args.rst_root.is_dir():
        print(f"找不到 {args.rst_root}")
        return 1
    catalog = load_catalog(args.po_dir)
    print(f"[译文] {len(catalog):,} 条 msgid → msgstr（来自 {args.po_dir}）")

    roots = [args.rst_root / s for s in args.sub] if args.sub else [args.rst_root]
    files = sorted(p for root in roots for p in root.rglob("*.rst"))
    if args.limit:
        files = files[: args.limit]
    print(f"[原件] {len(files)} 篇 rst")
    titles = page_titles(files, args.rst_root, catalog)
    print(f"[页名] {len(titles)} 篇取到标题，供 :doc: 交叉引用当显示文字")

    args.out.mkdir(parents=True, exist_ok=True)
    written = chars = hit = miss = 0
    empty: list[str] = []
    for path in files:
        rel = path.relative_to(args.rst_root)
        body, h, m = convert(path, catalog, titles, rel.parent.as_posix().strip("."))
        hit += h
        miss += m
        if len(body.strip()) < 2:
            empty.append(rel.as_posix())
            continue
        target = (args.out / "content" / rel).with_suffix(".md")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        written += 1
        chars += len(body)

    if args.license_from:
        src = args.license_from
        if src.is_dir():
            src = next(
                (c for n in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING") for c in [src / n] if c.is_file()),
                None,
            )
        if src is None or not src.is_file():
            print(f"许可原件取不到：--license-from={args.license_from}")
            return 2
        (args.out / "LICENSE").write_text(src.read_text(encoding="utf-8", errors="ignore"), encoding="utf-8")
        (args.out / "README.md").write_text(
            "# 转换产物：来源与许可\n\n"
            f"- 源 rst：`{args.rst_root}`\n"
            f"- 译文：`{args.po_dir}`\n"
            f"- 许可原件：`{src}`（已复制为本目录的 LICENSE）\n"
            "- 转换脚本：`apps/agent-engine/scripts/rst_to_markdown.py`\n\n"
            "本目录是**转换产物不是真源**。改内容一律回源仓库重跑转换，不要直接编辑这里。\n"
            f"标题层级来自 rst 下划线；译文按 msgid 精确查表，未命中的块回落英文"
            f"（本次回落 {miss}/{hit + miss} 块）。\n",
            encoding="utf-8",
        )
        print(f"许可与来源已随产物落盘：{args.out / 'LICENSE'}")

    total = hit + miss
    print(f"[产出] {written} 篇 md，{chars:,} 字符 → {args.out}")
    print(f"[译文命中] {hit}/{total} = {hit / total:.1%}；回落英文 {miss}/{total} = {miss / total:.1%}")
    if empty:
        print(f"[空文件] {len(empty)} 篇转出来是空的（纯 toctree 索引页常见），未落盘")
        for e in empty[:5]:
            print(f"  {e}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
