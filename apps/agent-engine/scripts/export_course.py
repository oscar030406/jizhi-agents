r"""课程导出：课程 JSON → Markdown / Word(.docx) / 打印版 HTML（浏览器另存为 PDF）。

为什么不引 pandoc/python-docx：本机没有 pandoc 与 libreoffice，而 .docx 本质是
一个装着 XML 的 zip——用标准库 zipfile 写最小 OOXML 约 120 行，比多一条外部依赖划算，
也让提交包在任何机器上都能重现导出。PDF 不自己排版，交给浏览器打印（原生能力最稳）。

用法：
  python scripts\export_course.py --concept llm_basics --format md,docx,html
  python scripts\export_course.py --all --out dist\exports
  python scripts\export_course.py --selftest
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRICULUM = ROOT / "data" / "curriculum"

CITATION_RE = re.compile(r"\[([a-z]{2}\d{2}s\d{2}#s\d+)\]")


# ---------------------------------------------------------------- 取数

def walk_lessons(course: dict):
    for ch in course.get("chapters") or []:
        for lesson in ch["lessons"]:
            yield ch, lesson
    for lesson in course.get("lessons") or []:
        yield None, lesson


def course_blocks(course: dict, keep_citations: bool = True) -> list[tuple[str, str]]:
    """课程 → [(块类型, 文本)]，供三种格式共用。

    块类型：h1/h2/h3/p/li/quote/meta
    """
    out: list[tuple[str, str]] = []
    add = lambda k, t: out.append((k, t))

    add("h1", course.get("title", ""))
    if course.get("tagline"):
        add("quote", course["tagline"])
    gen = course.get("generated_by") or {}
    add("meta", f"难度 {course.get('difficulty', '')} · "
                f"{sum(1 for _ in walk_lessons(course))} 课时 · 共约 {course.get('minutes_total', 0)} 分钟"
                + (f" · 生成 {gen.get('date', '')}" if gen.get("date") else ""))
    if course.get("textbooks"):
        add("p", "教材与授权：" + "；".join(course["textbooks"]))

    seen_chapter = set()
    for chapter, lesson in walk_lessons(course):
        if chapter and chapter["chapter_id"] not in seen_chapter:
            seen_chapter.add(chapter["chapter_id"])
            add("h2", chapter.get("title", ""))
            if chapter.get("intro"):
                add("quote", chapter["intro"])
        add("h3", lesson["title"])
        if lesson.get("objectives"):
            add("p", "学完这一课，你能：")
            for o in lesson["objectives"]:
                add("li", o)
        for sec in lesson.get("sections") or []:
            add("p", f"【{sec['heading']}】")
            for para in str(sec.get("body_md", "")).split("\n"):
                para = para.strip()
                if not para:
                    continue
                (add("li", para[2:].strip()) if para[:2] in ("- ", "* ") else add("p", para))
        checks = lesson.get("check_understanding") or []
        if checks:
            add("p", "随堂检查题")
            for i, q in enumerate(checks, 1):
                add("p", f"{i}. {q['question']}")
                for oi, opt in enumerate(q.get("options") or []):
                    add("li", f"{chr(65 + oi)}. {opt}")
                ans = chr(65 + int(q.get("answer_index", 0)))
                add("meta", f"参考答案 {ans}｜{q.get('explanation', '')}")
        if lesson.get("key_terms"):
            add("p", "关键术语")
            for t in lesson["key_terms"]:
                add("li", f"{t['term']} —— {t['definition']}")
        audit = lesson.get("audit") or {}
        if audit:
            add("meta", f"审核指纹：引用覆盖率 {audit.get('citation_coverage', 0) * 100:.0f}%"
                        f" · 独立复核 {audit.get('sections_supported', 0)}/{audit.get('sections_total', 0)}"
                        f" · 复核模型 {audit.get('judge_model', '')}")

    for field, label in (("theory_exam", "结业理论卷"), ("final_quiz", "结业测验")):
        qs = course.get(field) or []
        if not qs:
            continue
        add("h2", label)
        for i, q in enumerate(qs, 1):
            add("p", f"{i}. {q['question']}")
            for oi, opt in enumerate(q.get("options") or []):
                add("li", f"{chr(65 + oi)}. {opt}")
            add("meta", f"参考答案 {chr(65 + int(q.get('answer_index', 0)))}｜{q.get('explanation', '')}")

    if not keep_citations:
        out = [(k, CITATION_RE.sub("", t)) for k, t in out]
    return out


# ---------------------------------------------------------------- Markdown

def to_markdown(blocks: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for kind, text in blocks:
        if kind == "h1":
            lines += [f"# {text}", ""]
        elif kind == "h2":
            lines += ["", f"## {text}", ""]
        elif kind == "h3":
            lines += ["", f"### {text}", ""]
        elif kind == "quote":
            lines += [f"> {text}", ""]
        elif kind == "li":
            lines.append(f"- {text}")
        elif kind == "meta":
            lines += [f"*{text}*", ""]
        else:
            lines += [text, ""]
    return "\n".join(lines).rstrip() + "\n"


# ---------------------------------------------------------------- 打印版 HTML（浏览器另存为 PDF）

PRINT_CSS = """
@page { size: A4; margin: 20mm 18mm; }
body { font: 11.5pt/1.75 "Songti SC", "SimSun", Georgia, serif; color: #1c1b19; max-width: 720px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22pt; margin: 0 0 4px; }
h2 { font-size: 15pt; margin: 26px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #eaeaea; page-break-after: avoid; }
h3 { font-size: 13pt; margin: 20px 0 6px; page-break-after: avoid; }
p { margin: 0 0 9px; }
ul { margin: 0 0 10px; padding-left: 22px; }
li { margin: 2px 0; }
blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #eaeaea; color: #555; }
.meta { font-size: 9.5pt; color: #787774; margin: 2px 0 10px; }
.cite { font-size: 8pt; color: #1f6c9f; vertical-align: super; }
.tip { border: 1px solid #eaeaea; background: #fbfbfa; padding: 10px 12px; margin: 14px 0; font-size: 10pt; color: #555; }
@media print { .tip { display: none; } a { text-decoration: none; color: inherit; } }
"""


def to_print_html(blocks: list[tuple[str, str]], title: str) -> str:
    def esc(t: str) -> str:
        t = html.escape(t)
        return CITATION_RE.sub(lambda m: f'<span class="cite">{m.group(1)}</span>', t)

    body: list[str] = ['<div class="tip">按 Ctrl/⌘ + P，目标选「另存为 PDF」即可导出。本提示不会被打印。</div>']
    in_list = False
    for kind, text in blocks:
        if kind == "li":
            if not in_list:
                body.append("<ul>")
                in_list = True
            body.append(f"<li>{esc(text)}</li>")
            continue
        if in_list:
            body.append("</ul>")
            in_list = False
        if kind in ("h1", "h2", "h3"):
            body.append(f"<{kind}>{esc(text)}</{kind}>")
        elif kind == "quote":
            body.append(f"<blockquote>{esc(text)}</blockquote>")
        elif kind == "meta":
            body.append(f'<p class="meta">{esc(text)}</p>')
        else:
            body.append(f"<p>{esc(text)}</p>")
    if in_list:
        body.append("</ul>")
    return (
        f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        f"<title>{html.escape(title)}</title><style>{PRINT_CSS}</style></head>"
        f"<body>{''.join(body)}</body></html>"
    )


# ---------------------------------------------------------------- Word (.docx)：标准库手写最小 OOXML

_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _style(sid: str, name: str, size_half_pt: int, bold: bool, color: str, outline: int | None) -> str:
    ol = f'<w:outlineLvl w:val="{outline}"/>' if outline is not None else ""
    return (
        f'<w:style w:type="paragraph" w:styleId="{sid}"><w:name w:val="{name}"/>'
        f'<w:pPr><w:spacing w:before="180" w:after="90" w:line="330" w:lineRule="auto"/>{ol}</w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="Georgia" w:eastAsia="SimSun" w:hAnsi="Georgia"/>'
        f'<w:sz w:val="{size_half_pt}"/>{"<w:b/>" if bold else ""}'
        f'<w:color w:val="{color}"/></w:rPr></w:style>'
    )


_STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:styles {_W}>"
    + _style("Title", "Title", 44, True, "1C1B19", 0)
    + _style("Heading1", "heading 1", 30, True, "1C1B19", 0)
    + _style("Heading2", "heading 2", 26, True, "1C1B19", 1)
    + _style("Normal", "Normal", 23, False, "1C1B19", None)
    + _style("Meta", "Meta", 19, False, "787774", None)
    + _style("Quote", "Quote", 23, False, "555555", None)
    + "</w:styles>"
)

_KIND_STYLE = {"h1": "Title", "h2": "Heading1", "h3": "Heading2",
               "p": "Normal", "li": "Normal", "meta": "Meta", "quote": "Quote"}


def _xml_escape(t: str) -> str:
    return (t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def to_docx(blocks: list[tuple[str, str]], path: Path) -> None:
    paras: list[str] = []
    for kind, text in blocks:
        style = _KIND_STYLE.get(kind, "Normal")
        indent = '<w:ind w:left="420" w:hanging="180"/>' if kind == "li" else ""
        body = ("• " + text) if kind == "li" else text
        paras.append(
            f'<w:p><w:pPr><w:pStyle w:val="{style}"/>{indent}</w:pPr>'
            f'<w:r><w:t xml:space="preserve">{_xml_escape(body)}</w:t></w:r></w:p>'
        )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document {_W}><w:body>{"".join(paras)}'
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1134" w:right="1021" w:bottom="1134" w:left="1021"/></w:sectPr>'
        "</w:body></w:document>"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _CONTENT_TYPES)
        z.writestr("_rels/.rels", _RELS)
        z.writestr("word/_rels/document.xml.rels", _DOC_RELS)
        z.writestr("word/styles.xml", _STYLES)
        z.writestr("word/document.xml", document)


# ---------------------------------------------------------------- CLI

def export(concept: str, out_dir: Path, formats: list[str], keep_citations: bool) -> list[Path]:
    course = json.loads((CURRICULUM / f"{concept}.json").read_text(encoding="utf-8"))
    blocks = course_blocks(course, keep_citations=keep_citations)
    title = course.get("title", concept)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    if "md" in formats:
        p = out_dir / f"{concept}.md"
        p.write_text(to_markdown(blocks), encoding="utf-8")
        written.append(p)
    if "html" in formats:
        p = out_dir / f"{concept}.print.html"
        p.write_text(to_print_html(blocks, title), encoding="utf-8")
        written.append(p)
    if "docx" in formats:
        p = out_dir / f"{concept}.docx"
        to_docx(blocks, p)
        written.append(p)
    return written


def selftest() -> None:
    course = {
        "title": "测试课", "tagline": "一句话", "difficulty": "L1", "minutes_total": 45,
        "chapters": [{"chapter_id": "ch1", "title": "第一章", "intro": "引子", "lessons": [{
            "lesson_id": "t1-01", "title": "课时一", "objectives": ["目标 A"],
            "sections": [{"heading": "小节", "body_md": "正文 [hl01s01#s1]\n- 要点一\n- 要点二",
                          "source_ids": ["hl01s01#s1"]}],
            "check_understanding": [{"question": "问？", "options": ["甲", "乙"], "answer_index": 1,
                                     "explanation": "因为乙"}],
            "key_terms": [{"term": "术语", "definition": "释义"}],
            "audit": {"citation_coverage": 1.0, "sections_supported": 1, "sections_total": 1,
                      "judge_model": "J", "notes": []},
        }]}],
        "final_quiz": [{"question": "结业问？", "options": ["A项", "B项"], "answer_index": 0,
                        "explanation": "解析"}],
    }
    blocks = course_blocks(course)
    kinds = {k for k, _ in blocks}
    assert {"h1", "h2", "h3", "p", "li", "meta"} <= kinds, kinds

    md = to_markdown(blocks)
    assert "# 测试课" in md and "### 课时一" in md and "- 要点一" in md, md[:200]
    assert "参考答案 B" in md, "答案字母必须按 answer_index 换算"

    doc = to_print_html(blocks, "测试课")
    assert doc.startswith("<!doctype html>") and "</html>" in doc
    assert '<span class="cite">hl01s01#s1</span>' in doc, "引用角标应转成上标"
    assert "<ul>" in doc and doc.count("<ul>") == doc.count("</ul>"), "列表标签必须闭合"

    stripped = course_blocks(course, keep_citations=False)
    assert all("#s" not in t for _, t in stripped), "keep_citations=False 应剥掉角标"

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "t.docx"
        to_docx(blocks, p)
        with zipfile.ZipFile(p) as z:
            names = set(z.namelist())
            assert {"[Content_Types].xml", "_rels/.rels", "word/document.xml",
                    "word/styles.xml", "word/_rels/document.xml.rels"} <= names, names
            xml = z.read("word/document.xml").decode("utf-8")
        import xml.dom.minidom as minidom
        minidom.parseString(xml)  # 结构必须是合法 XML，否则 Word 打不开
        assert "测试课" in xml and "&amp;" not in "测试课"
    # 转义安全
    evil = course_blocks({"title": "A & B <tag>", "chapters": [], "lessons": []})
    x = [t for k, t in evil if k == "h1"][0]
    assert "&" in x
    assert "&amp;" in _xml_escape(x) and "&lt;" in _xml_escape(x)
    print("selftest OK")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--concept", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--format", default="md,docx,html", help="逗号分隔：md / docx / html")
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "exports")
    ap.add_argument("--no-citations", action="store_true", help="剥掉引用角标（对外分享用）")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return
    concepts = ([p.stem for p in sorted(CURRICULUM.glob("*.json")) if p.stem != "catalog"]
                if args.all or not args.concept else [args.concept])
    formats = [f.strip() for f in args.format.split(",") if f.strip()]
    unknown = set(formats) - {"md", "docx", "html"}
    if unknown:
        sys.exit(f"未知格式：{'、'.join(unknown)}（可选 md / docx / html）")
    for concept in concepts:
        files = export(concept, args.out, formats, keep_citations=not args.no_citations)
        print(f"✅ {concept} → " + "、".join(f.name for f in files))
    # 原有 --publish 会把导出件拷进 legacy-platform/web-next/public/exports/。
    # 那个 app 已退役、目录已删，等于往不存在的地方发布，已去掉。
    print(f"输出目录：{args.out}")
    print("PDF：用浏览器打开 *.print.html，Ctrl/⌘+P 选「另存为 PDF」")


if __name__ == "__main__":
    main()
