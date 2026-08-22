r"""结构化前置信号探针：不问模型，只看语料里已经写着的东西。

    python scripts/structural_prereq_probe.py --intake data/knowledge_base/odoo_intake --corpus <目录>

## 为什么试这条

代码图谱（call / import / inherit）抽得出来，是因为那些边**在源码里是显式的**——
AST 里就写着，不需要判断。我们前三轮一直在让 LLM **判断**「A 是不是 B 的前置」，
三个语料全判 none，且是高置信度判错（`批次与序列号追踪` vs `批次追踪` 判 none、conf 0.9）。

而语料里其实有不需要判断的信号：

1. **显式交叉引用**——Odoo 文档里 168 条 `<../../path/to/page>`，等价于 import
2. **术语定义不对称**——B 的定义段里提到了 A，而 A 的定义段没提 B，则 A 先于 B。
   方向明确、纯机械。Pal et al.（arXiv:2011.10337）用的正是术语提及信号，
   章节顺序只是它上面的过滤器——我们把主次搞反了。

**这个脚本零 LLM 调用。** 它先回答一个事实问题：这些信号在我们的语料上能产出多少条边。
产出量太低就说明此路不通，不必再往下修；够多就该把它做成前置图的第一来源，
把 LLM 降级成**复核**而不是**判定**。
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

#: 定义句标记，与 `lib/generation/decompression.ts` 同口径——两处改要一起改。
DEFINITION_MARKERS = ("是指", "指的是", "称为", "叫做", "定义为", "所谓", "是一种", "是一个", "或")

_XREF = re.compile(r"<((?:\.\./)+[^>]+)>")


def load_corpus(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)).replace("\\", "/"): p.read_text(encoding="utf-8", errors="replace")
        for p in root.rglob("*.md")
    }


def defining_section(concept: str, corpus: dict[str, str]) -> str | None:
    """概念在哪一篇里被**定义**。取第一篇「概念名后 40 字内出现定义标记」的。"""
    for path, text in corpus.items():
        idx = text.find(concept)
        while idx >= 0:
            window = text[idx + len(concept) : idx + len(concept) + 40]
            if any(m in window for m in DEFINITION_MARKERS):
                return path
            idx = text.find(concept, idx + 1)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--intake", required=True, type=Path)
    ap.add_argument("--corpus", required=True, type=Path)
    args = ap.parse_args()

    report = json.loads((args.intake / "readiness.json").read_text(encoding="utf-8"))
    concepts = [c["concept"] for c in report["concepts"]]
    corpus = load_corpus(args.corpus)
    print(f"概念 {len(concepts)} 个，文档 {len(corpus)} 篇")

    # --- 信号一：显式交叉引用 ---
    xrefs = sum(len(_XREF.findall(t)) for t in corpus.values())
    print(f"\n[信号一] 显式交叉引用 {xrefs} 条")

    # --- 信号二：定义位置 ---
    defined_in = {c: defining_section(c, corpus) for c in concepts}
    with_def = {c: p for c, p in defined_in.items() if p}
    print(f"[信号二] 找得到定义段的概念 {len(with_def)}/{len(concepts)}")
    for c, p in list(with_def.items())[:5]:
        print(f"    {c} ← {p.split('/')[-1]}")

    # --- 边：B 的定义段提到 A，而 A 的定义段没提 B ---
    edges: list[tuple[str, str, str]] = []
    for b, pb in with_def.items():
        text_b = corpus[pb]
        for a, pa in with_def.items():
            if a == b or a in b or b in a:
                continue  # 同名包含关系另算，别混进来
            if a in text_b and b not in corpus[pa]:
                edges.append((a, b, f"「{a}」出现在「{b}」的定义段 {pb.split('/')[-1]}，反向不成立"))

    print(f"\n[结构边] {len(edges)} 条（B 的定义段提到 A，且 A 的定义段没提 B）")
    for a, b, why in edges[:15]:
        print(f"    {a} → {b}")
    if len(edges) > 15:
        print(f"    …另有 {len(edges) - 15} 条")

    # 与 LLM 那一版对照
    llm_edges = len((report.get("prereq_graph") or {}).get("clauses") or {})
    print(f"\n对照：LLM 成对判定产出 {llm_edges} 条（{report.get('prereq_meta', {}).get('pairs', '?')} 对全判过）")
    print("本脚本零 LLM 调用。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
