r"""讲义正文体检：一页塞几个概念、数字有没有出处、例子有没有讲完。

    python scripts/experiments/lecture_body_audit.py --json data/eval/lecture_body_audit.json

## 起因

2026-08-13 亲手读了一页生成的讲义（RAG 检索质量评估与优化 · 召回机制详解），
读出三处毛病，但「读出来」不算数据，所以把 165 页全量量一遍。

那一页的原文（节选）：

> 假设查询"如何融资"，文档标题为"资金筹集指南"。稀疏检索（如 BM25）基于词频和
> 逆文档频率计算相关性得分，使用平滑处理避免零分情况。而稠密向量中，两者夹角
> 余弦值可能高达 0.85。

三处：①一页里 7 个概念平铺；②例子起了头被无关定义打断，读者没看到 0.85 怎么来的；
③「可能高达 0.85」——这个数没有出处。

PLAYBOOK §2 记的老病是「讲了是什么、没讲为什么」。**那个诊断已经不成立**：
实测因果词 5.14/千字，教材才 2.10。真正超标的是「导致」2.82 对教材 0.26（11 倍），
那是断言口气不是解释。所以要换判据重新量。

## 量什么（全部机械可判，零 LLM）

1. **每页不同术语数**——一页塞几个概念。对照组是真实教材按节切开之后的同一指标。
2. **无出处数字**——自撰区里出现的数字，在**本页的教材摘录里找不到**、也不在代码块里。
   这是最硬的一条：产品招牌是「带出处」，一个凭空的 0.85 就是反例。
3. **例子有没有走完**——「假设/例如/比如/举例」引入之后 N 字内有没有落到具体结果
   （数字或"因此/所以/得到"）。起了头不收尾的例子只会让读者更糊涂。
4. **段落长度分布**——与教材对照。

判据不在这里定，这一份只出数。定阈值要等看到教材的对照带。
"""

from __future__ import annotations

import argparse
import json
import re
import statistics as st
import sys
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent))

from textbook_prose_ladder import TEXTBOOKS, load_textbook, strip_to_prose  # noqa: E402

_REPO = _HERE.parents[4]
CLASSROOMS = _REPO / "apps" / "classroom" / "data" / "classrooms"
TERMS_JSON = _REPO / "apps" / "classroom" / "lib" / "generation" / "data" / "adaptation-terms.json"

TAG = re.compile(r"<[^>]+>")
MONO_P = re.compile(r"<p[^>]*monospace[^>]*>.*?</p>", re.S)
EXCERPT = re.compile(r"📖[\s\S]*?——\s*摘自《[^《》]*》\s*\[[^\]]+\]")
ENT = [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&")]

#: 正文里的数字。带小数点或百分号的才算——「三个组件」这种量词不是待核数字。
#: 纯整数不收：页码、序号、列表编号会淹没信号。
NUM = re.compile(r"\d+\.\d+%?|\d+%|\d+\s*(?:倍|万|亿|ms|MB|GB|KB|tokens?|维)")

#: ⚠️ 第一版把所有数字都当「待核事实」，量出 98% 无出处——那是探测器太粗：
#: 「把温度设成 2.0」「学习率取 0.1」是**示例参数**，本来就不需要出处。
#: 真正要抓的是对世界的**声称**：「余弦值可能高达 0.85」「延迟提升约 40%」。
#: 判据改成：数字前 20 字内出现模糊限定或效果动词，才算一条待核断言。
HEDGE = re.compile(
    r"可能|大约|约|高达|接近|通常|一般|往往|普遍|典型|平均|"
    r"提升|下降|降低|提高|增加|减少|加快|变慢|多出|少于|超过"
)
HEDGE_WINDOW = 20

#: 例子的引入语
EXAMPLE_LEAD = re.compile(r"假设|例如|比如|举例|设想|以.{2,12}为例")
#: 例子收尾的标志：落到具体结果
EXAMPLE_LAND = re.compile(r"\d|因此|所以|得到|结果是|就会|则会")

CJK = re.compile(r"[一-鿿]")


def plain(html: str) -> str:
    t = MONO_P.sub("", html)
    t = re.sub(r"<br\s*/?>", "\n", t)
    t = re.sub(r"</(p|div|li|h[1-6])>", "\n", t)
    t = TAG.sub("", t)
    for a, b in ENT:
        t = t.replace(a, b)
    return t


def load_terms() -> list[str]:
    terms = json.loads(TERMS_JSON.read_text(encoding="utf-8"))["terms"]
    return sorted(set(terms), key=len, reverse=True)


def distinct_terms(text: str, terms: list[str]) -> int:
    """长词优先掩码，避免「注意力」在「注意力机制」里重复计数。"""
    mask = bytearray(len(text))
    n = 0
    for t in terms:
        i = text.find(t)
        while i >= 0:
            if not any(mask[i : i + len(t)]):
                for k in range(i, i + len(t)):
                    mask[k] = 1
                n += 1
                break
            i = text.find(t, i + 1)
    return n


def audit_page(own: str, excerpt_text: str, terms: list[str]) -> dict:
    nums = [m.group(0) for m in NUM.finditer(own)]
    # 待核断言：数字前 HEDGE_WINDOW 字内有模糊限定或效果动词
    claims = [
        m.group(0)
        for m in NUM.finditer(own)
        if HEDGE.search(own[max(0, m.start() - HEDGE_WINDOW) : m.start()])
    ]
    # 出处：这一页的摘录里出现过同一个数字串就算有据
    ungrounded = [x for x in claims if x not in excerpt_text]
    leads = list(EXAMPLE_LEAD.finditer(own))
    unlanded = 0
    for m in leads:
        window = own[m.end() : m.end() + 120]
        if not EXAMPLE_LAND.search(window):
            unlanded += 1
    paras = [p for p in own.split("\n") if len(CJK.findall(p)) >= 10]
    return {
        "terms": distinct_terms(own, terms),
        "cjk": len(CJK.findall(own)),
        "numbers": len(nums),
        "claim_numbers": len(claims),
        "ungrounded_numbers": len(ungrounded),
        "ungrounded_samples": ungrounded[:4],
        "examples": len(leads),
        "examples_unlanded": unlanded,
        "paragraphs": len(paras),
        "para_cjk": [len(CJK.findall(p)) for p in paras],
    }


def textbook_sections(terms: list[str]) -> dict:
    """教材按 markdown 二级标题切节，量同样两个指标当对照带。"""
    per_section_terms: list[int] = []
    per_para: list[int] = []
    for _, root in TEXTBOOKS:
        if not root.is_dir():
            continue
        for raw in load_textbook(root):
            prose = strip_to_prose(raw)
            # 原始 markdown 的 ## 已被 strip 掉，改按空行段落聚成「节」：连续 6 段算一节，
            # 与我们一页讲义的体量（中位 6 段）对齐，不然节太长没有可比性。
            paras = [p for p in prose.split("\n") if len(CJK.findall(p)) >= 10]
            per_para += [len(CJK.findall(p)) for p in paras]
            for i in range(0, len(paras), 6):
                chunk = "\n".join(paras[i : i + 6])
                if len(CJK.findall(chunk)) < 200:
                    continue
                per_section_terms.append(distinct_terms(chunk, terms))
    return {"section_terms": per_section_terms, "para_cjk": per_para}


def pct(v: list[float], q: float) -> float:
    if not v:
        return 0.0
    s = sorted(v)
    return float(s[min(len(s) - 1, int(round(q * (len(s) - 1))))])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    terms = load_terms()
    pages: list[dict] = []
    worst: list[tuple] = []

    for f in sorted(CLASSROOMS.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        name = (d.get("stage") or {}).get("name", "?")
        for s in d.get("scenes", []):
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
            pages.append(r)
            if r["ungrounded_numbers"]:
                worst.append((r["ungrounded_numbers"], name, r["scene"], r["ungrounded_samples"]))

    tb = textbook_sections(terms)

    t_ours = [p["terms"] for p in pages]
    print(f"讲义页 {len(pages)} 页（剥掉摘录与代码后的自撰区）\n")
    print("【一页塞几个概念】不同术语数")
    print(f"  我们     中位 {st.median(t_ours):.0f}  P75 {pct(t_ours,.75):.0f}  P90 {pct(t_ours,.9):.0f}  最大 {max(t_ours)}")
    print(f"  教材同体量节  中位 {st.median(tb['section_terms']):.0f}  "
          f"P75 {pct(tb['section_terms'],.75):.0f}  P90 {pct(tb['section_terms'],.9):.0f}  "
          f"最大 {max(tb['section_terms'])}   （n={len(tb['section_terms'])} 节）")

    all_para = [x for p in pages for x in p["para_cjk"]]
    print("\n【段落长度】汉字")
    print(f"  我们     中位 {st.median(all_para):.0f}  P90 {pct(all_para,.9):.0f}")
    print(f"  教材     中位 {st.median(tb['para_cjk']):.0f}  P90 {pct(tb['para_cjk'],.9):.0f}")

    ung = sum(p["ungrounded_numbers"] for p in pages)
    num = sum(p["claim_numbers"] for p in pages)
    allnum = sum(p["numbers"] for p in pages)
    pages_with = sum(1 for p in pages if p["ungrounded_numbers"])
    print("\n【无出处数字】自撰区里出现、但本页摘录里查不到的数")
    print(f"  {ung} / {num} 个数字无出处 = {ung / max(num,1):.0%}，"
          f"涉及 {pages_with} / {len(pages)} 页（{pages_with / len(pages):.0%}）")

    ex = sum(p["examples"] for p in pages)
    exu = sum(p["examples_unlanded"] for p in pages)
    print("\n【例子有没有走完】「假设/例如/比如」之后 120 字内落没落到具体结果")
    print(f"  {exu} / {ex} 个例子没收尾 = {exu / max(ex,1):.0%}")

    print("\n【无出处数字最多的 8 页】")
    for n, course, scene, samples in sorted(worst, reverse=True)[:8]:
        print(f"  {n:>2} 个  {course[:18]:<20}{scene[:16]:<18}{'、'.join(samples)}")

    if args.json:
        args.json.write_text(
            json.dumps(
                {"pages": pages, "textbook": {k: v[:2000] for k, v in tb.items()}},
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
