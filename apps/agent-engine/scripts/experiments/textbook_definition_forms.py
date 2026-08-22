r"""教材是怎么给术语下定义的：把「定义句式」从语料里量出来，不靠自己列。

    python scripts/experiments/textbook_definition_forms.py --json data/eval/textbook_definition_forms.json

## 起因

`apps/classroom/lib/generation/decompression.ts` 的解压覆盖率判据里，
「术语在本文内被定义过没有」是靠一张手列的 11 条句式表判的
（是指/指的是/称为/叫做/定义为/所谓/也就是/即/是一种/是一个）。

2026-08-13 拿 108 份判官评过的探针资源实测这个探测器：
**三档的覆盖率中位数都是 0.000**，最大值 0.667。判官认可其中 85.2% 的适配，
L1 的 rubric 还明写「术语第一次出现必须紧跟一句大白话定义」——
所以不是课里没定义，是**探测器认不出我们和教材实际在用的定义句式**。
按仓库的规矩「产出为 0 先怀疑探测器」，先量再改。

## 做法

在真实中文教材语料里，找每个术语**第一次出现之后 40 字**的窗口
（与 decompression.ts 的 `definedInText` 同一个窗口口径），
把窗口开头的连接片段按频次排出来。频次说话，不是我们说话。

语料与 `textbook_prose_ladder.py` 同源，剥代码/公式/表格后只留散文。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent))

from textbook_prose_ladder import (  # noqa: E402
    TEXTBOOKS,
    OURS_PROBE,
    load_textbook,
    load_probe,
    strip_to_prose,
)

_REPO = _HERE.parents[4]
TERMS_JSON = _REPO / "apps" / "classroom" / "lib" / "generation" / "data" / "adaptation-terms.json"

#: 与 decompression.ts 的 definedInText 同一个窗口长度。改这里要两边一起改。
WINDOW = 40

#: 现行手列表（要被检验的那张）
CURRENT = [
    "是指", "指的是", "称为", "叫做", "定义为", "所谓",
    "也就是", "即", "是一种", "是一个",
]

#: 窗口开头允许出现的连接片段：从窗口头部逐字扫，取到第一个句末标点为止，
#: 再把这一段里的「术语 + 连接词」形态归一。这里只做**最小归一**——
#: 把数字、拉丁串、括号内容抹掉，避免把具体内容当成句式。
_NOISE = re.compile(r"[A-Za-z0-9_./\\-]+|（[^）]{0,40}）|\([^)]{0,40}\)")
_SENT_END = re.compile(r"[。！？；\n]")


def head_fragment(window: str, max_len: int = 12) -> str:
    """窗口开头到第一个句末标点之间的片段，抹掉具体内容只留句式骨架。"""
    cut = _SENT_END.split(window, 1)[0]
    cut = _NOISE.sub("", cut).strip()
    return cut[:max_len]


def scan(docs: list[str], terms: list[str]) -> tuple[Counter, int, int]:
    """→ (片段计数, 命中术语次数, 文档数)。每个术语在每篇里只取首现。"""
    frags: Counter = Counter()
    hits = 0
    for raw in docs:
        text = strip_to_prose(raw)
        for t in terms:
            idx = text.find(t)
            if idx < 0:
                continue
            hits += 1
            window = text[idx + len(t) : idx + len(t) + WINDOW]
            frag = head_fragment(window)
            if frag:
                frags[frag] += 1
    return frags, hits, len(docs)


def leading_patterns(frags: Counter, min_count: int) -> list[tuple[str, int]]:
    """把片段收敛成**开头的连接词**：取片段的前 1-4 字做前缀，按覆盖的片段数排。"""
    prefix: Counter = Counter()
    for frag, n in frags.items():
        for k in (4, 3, 2, 1):
            if len(frag) >= k:
                prefix[frag[:k]] += n
    return [(p, n) for p, n in prefix.most_common() if n >= min_count]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    ap.add_argument("--min-count", type=int, default=20, help="前缀至少覆盖多少次才报")
    ap.add_argument("--top", type=int, default=40)
    args = ap.parse_args()

    terms = json.loads(TERMS_JSON.read_text(encoding="utf-8"))["terms"]
    terms = sorted(set(terms), key=len, reverse=True)

    tb_docs: list[str] = []
    for label, root in TEXTBOOKS:
        if root.is_dir():
            tb_docs += load_textbook(root)
        else:
            print(f"跳过 {label}：路径不存在")
    if not tb_docs:
        print("教材语料一份都没读到")
        return 1

    tb_frags, tb_hits, tb_n = scan(tb_docs, terms)
    our_frags, our_hits, our_n = scan(load_probe(), terms)

    print(f"术语表 {len(terms)} 个词。教材 {tb_n} 篇、术语首现命中 {tb_hits} 次；"
          f"探针资源 {our_n} 篇、命中 {our_hits} 次。窗口 {WINDOW} 字（与 definedInText 同口径）。\n")

    tb_pat = leading_patterns(tb_frags, args.min_count)
    our_pat = leading_patterns(our_frags, max(3, args.min_count // 5))
    our_map = dict(our_pat)

    print(f"【教材里术语后面最常跟着什么】前 {args.top}，覆盖 ≥{args.min_count} 次")
    print(f"{'片段':<8}{'教材次数':>8}{'占命中':>8}{'我们次数':>8}  在现行表里？")
    for p, n in tb_pat[:args.top]:
        in_cur = "✔" if any(c.startswith(p) or p.startswith(c) for c in CURRENT) else ""
        print(f"{p:<8}{n:>8}{n / max(tb_hits, 1):>8.1%}{our_map.get(p, 0):>8}  {in_cur}")

    covered = sum(n for p, n in tb_pat if any(c.startswith(p) or p.startswith(c) for c in CURRENT))
    print(f"\n现行 11 条句式覆盖了教材首现窗口里 {covered}/{tb_hits} = "
          f"{covered / max(tb_hits, 1):.1%} 的情形。")
    print("这就是探测器读出 0.000 的原因：它认的那几条不是教材（和我们）实际在用的写法。")

    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "window": WINDOW,
                    "terms": len(terms),
                    "textbook": {"docs": tb_n, "term_hits": tb_hits,
                                 "patterns": [{"frag": p, "count": n} for p, n in tb_pat]},
                    "ours": {"docs": our_n, "term_hits": our_hits,
                             "patterns": [{"frag": p, "count": n} for p, n in our_pat]},
                    "current_patterns": CURRENT,
                    "current_recall_on_textbook": covered / max(tb_hits, 1),
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
