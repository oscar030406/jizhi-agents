r"""把 `lecture_body_audit.py` 的口径搬到非 AI 域：换语料重量一遍。

    python scripts/experiments/lecture_body_audit_corpora.py \
        --course <某门课的 json 路径> \
        --corpus odoo --corpus plc-s71200 \
        --json <落点>.json

## 这一份和原脚本什么关系

原脚本（2026-08-13）量的是 `apps/classroom/data/classrooms/` 里的讲义页，
对照带是 `references/` 四本中文教材。两侧都在 AI 域内。

这一份**不改判据、不改阈值**，只换输入：

  · 讲义侧 —— `--course` 指到任意一份课程 JSON（含 workorder 落的课程 dump），
    页面提取、剥摘录、`audit_page()` 全部直接 import 原脚本的函数，一个字没动。
  · 对照侧 —— `--corpus` 读 `data/knowledge_base/corpora/<库>/knowledge_index.jsonl`，
    每条 chunk 的 content 当一份文档，走 `strip_to_prose()` 之后按
    「连续 6 段聚成一节、不足 200 汉字丢弃」切节——与原脚本 `textbook_sections()`
    对四本教材做的完全同一套动作。

## 为什么要换语料量

原实验的两条阈值（段落中位落在 19–41、一节概念数 P95=8）是从四本 AI/Python
中文教材的分位里取的。产品现在开了制造、ERP 这些库，问题就变成：
**这两条带子跨域还成不成立。** 只有把别的域的真实资料按同一套动作量一遍才知道。

概念数那条要留神：术语表 `adaptation-terms.json` 自己写着
「词表是看着这 54 份写的，换主题域要重列重校」，110 个词全是 AI 域的。
拿它去数 ERP 文档的概念，数出来的低不是「概念少」，是**尺子不认识这个域的词**。
所以本脚本对每个语料额外打印术语命中率，让这件事有数可查，别当成结论。
"""

from __future__ import annotations

import argparse
import json
import statistics as st
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent))

from lecture_body_audit import (  # noqa: E402
    CJK,
    EXCERPT,
    audit_page,
    distinct_terms,
    load_terms,
    pct,
    plain,
    textbook_sections,
)
from textbook_prose_ladder import TEXTBOOKS, load_textbook, strip_to_prose  # noqa: E402

_ENGINE = _HERE.parents[2]
CORPORA = _ENGINE / "data" / "knowledge_base" / "corpora"

QUANTILES = [("P10", 0.10), ("P25", 0.25), ("中位", 0.50), ("P75", 0.75), ("P90", 0.90), ("P95", 0.95)]


def load_course(path: Path) -> dict:
    """课程 JSON。workorder 的 dump 是「JSON 字符串里再包一层 JSON」，两种都吃。"""
    d = json.loads(path.read_text(encoding="utf-8"))
    return json.loads(d) if isinstance(d, str) else d


def pages_of(course: dict, terms: list[str]) -> list[dict]:
    """与 `lecture_body_audit.main()` 的页面循环逐行同构，判据不改。"""
    name = (course.get("stage") or {}).get("name", "?")
    out: list[dict] = []
    for s in course.get("scenes", []):
        c = s.get("content") or {}
        if c.get("type") != "slide":
            continue
        raw = "".join(
            el.get("content", "")
            for el in c.get("canvas", {}).get("elements", [])
            if isinstance(el.get("content"), str)
        )
        text = plain(raw)
        excerpt_text = "".join(EXCERPT.findall(text))
        own = EXCERPT.sub("", text)
        if len(CJK.findall(own)) < 100:
            continue
        r = audit_page(own, excerpt_text, terms)
        r["course"] = name
        r["scene"] = s.get("title", "")
        out.append(r)
    return out


def corpus_band(name: str, terms: list[str]) -> dict | None:
    """语料当对照带：与 `textbook_sections()` 同一套切节与计数动作。"""
    index = CORPORA / name / "knowledge_index.jsonl"
    if not index.is_file():
        return None
    per_section_terms: list[int] = []
    per_para: list[int] = []
    chunks = 0
    # 只取活块：这里量的是「这个库现在的正文长什么样」，
    # 归档块是被顶替的上一代，混进来会把段长分布往旧版拉。
    from backend.rag.ingest import read_index_rows

    for row in read_index_rows(index):
        chunks += 1
        prose = strip_to_prose(row.get("content", ""))
        paras = [p for p in prose.split("\n") if len(CJK.findall(p)) >= 10]
        per_para += [len(CJK.findall(p)) for p in paras]
        for i in range(0, len(paras), 6):
            sec = "\n".join(paras[i : i + 6])
            if len(CJK.findall(sec)) < 200:
                continue
            per_section_terms.append(distinct_terms(sec, terms))
    return {"chunks": chunks, "section_terms": per_section_terms, "para_cjk": per_para}


def quant_row(label: str, v: list[int]) -> str:
    if not v:
        return f"  {label:<22} 无样本"
    cells = "  ".join(f"{q} {pct(v, p):.0f}" for q, p in QUANTILES)
    return f"  {label:<22} n={len(v):<7} {cells}"


def selftest() -> int:
    """判据没被搬坏的最小检查：一条待核数字、一节切分门槛。"""
    terms = load_terms()
    r = audit_page("余弦值可能高达 0.85，所以两者相近。", "", terms)
    assert r["claim_numbers"] == 1 and r["ungrounded_numbers"] == 1, r
    r2 = audit_page("余弦值可能高达 0.85。", "参考里写着 0.85 这个数。", terms)
    assert r2["claim_numbers"] == 1 and r2["ungrounded_numbers"] == 0, r2
    assert pct([1, 2, 3, 4, 5], 0.5) == 3
    print("selftest ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", type=Path, action="append", default=[])
    ap.add_argument("--corpus", action="append", default=[])
    ap.add_argument("--json", type=Path)
    ap.add_argument("--per-book", action="store_true", help="四本教材分开出段落分位")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()

    terms = load_terms()
    result: dict = {"terms_in_dict": len(terms), "courses": {}, "corpora": {}}

    for path in args.course:
        if not path.is_file():
            print(f"[缺] 课程文件不在盘上：{path}")
            result["courses"][str(path)] = None
            continue
        course = load_course(path)
        origin = (course.get("stage") or {}).get("origin") or {}
        pages = pages_of(course, terms)
        name = (course.get("stage") or {}).get("name", "?")
        print(f"\n══ 讲义侧：{name}   来源库 {origin.get('corpus', '未标注')}"
              f" / 域 {origin.get('domain', '未标注')}   {len(pages)} 页过了 100 汉字门")
        if not pages:
            result["courses"][str(path)] = {"origin": origin, "pages": []}
            continue
        t = [p["terms"] for p in pages]
        para = [x for p in pages for x in p["para_cjk"]]
        ung = sum(p["ungrounded_numbers"] for p in pages)
        claim = sum(p["claim_numbers"] for p in pages)
        ex = sum(p["examples"] for p in pages)
        exu = sum(p["examples_unlanded"] for p in pages)
        print(f"  一页概念数   中位 {st.median(t):.0f}  P90 {pct(t, .9):.0f}  最大 {max(t)}"
              f"   （逐页 {t}）")
        print(quant_row("段落长度 汉字", para))
        print(f"  段落中位落在 19–41 内的页：{sum(1 for p in pages if p['para_cjk'] and 19 <= st.median(p['para_cjk']) <= 41)}"
              f" / {len(pages)}   逐页中位 {[round(st.median(p['para_cjk'])) if p['para_cjk'] else None for p in pages]}")
        print(f"  无出处数字   {ung} / {claim} 条待核断言无出处"
              f"   样本 {[s for p in pages for s in p['ungrounded_samples']][:6]}")
        print(f"  例子没收尾   {exu} / {ex}")
        result["courses"][str(path)] = {"origin": origin, "pages": pages}

    for name in args.corpus:
        band = corpus_band(name, terms)
        if band is None:
            print(f"\n══ 对照侧：{name}   **本地无此语料**"
                  f"（{CORPORA / name / 'knowledge_index.jsonl'} 不存在），跳过")
            result["corpora"][name] = None
            continue
        hit = sum(1 for x in band["section_terms"] if x > 0)
        n = len(band["section_terms"])
        print(f"\n══ 对照侧：{name}   {band['chunks']} 个 chunk → {n} 节 / {len(band['para_cjk'])} 段")
        print(quant_row("段落长度 汉字", band["para_cjk"]))
        print(quant_row("一节概念数", band["section_terms"]))
        print(f"  术语表命中：{hit} / {n} 节至少命中 1 个词"
              f"（{hit / max(n, 1):.0%}）——命中率低说明尺子不认识这个域的词，不是概念少")
        result["corpora"][name] = {
            "chunks": band["chunks"],
            "sections": n,
            "paragraphs": len(band["para_cjk"]),
            "section_terms_hit_ratio": hit / max(n, 1),
            "para_quantiles": {q: pct(band["para_cjk"], p) for q, p in QUANTILES},
            "section_terms_quantiles": {q: pct(band["section_terms"], p) for q, p in QUANTILES},
        }

    if args.per_book:
        print("\n══ 四本教材各自的段落分位（看这条带子有多依赖挑了哪本书）")
        result["per_book"] = {}
        for label, root in TEXTBOOKS:
            if not root.is_dir():
                print(f"  {label:<22} 目录不在盘上")
                continue
            v: list[int] = []
            for raw in load_textbook(root):
                v += [
                    len(CJK.findall(p))
                    for p in strip_to_prose(raw).split("\n")
                    if len(CJK.findall(p)) >= 10
                ]
            print(quant_row(label, v))
            result["per_book"][label] = {q: pct(v, p) for q, p in QUANTILES}

    tb = textbook_sections(terms)
    print("\n══ 原实验的对照带（references/ 四本中文教材，同一套动作重算）")
    print(quant_row("段落长度 汉字", tb["para_cjk"]))
    print(quant_row("一节概念数", tb["section_terms"]))
    result["textbooks"] = {
        "sections": len(tb["section_terms"]),
        "paragraphs": len(tb["para_cjk"]),
        "para_quantiles": {q: pct(tb["para_cjk"], p) for q, p in QUANTILES},
        "section_terms_quantiles": {q: pct(tb["section_terms"], p) for q, p in QUANTILES},
    }

    if args.json:
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
