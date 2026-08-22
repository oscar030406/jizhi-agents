r"""把造出来的前置图与人工策展的 `concept_graph.json` 对照。

## 为什么要对照，以及对照的边界

一版跑出来 55 对里 52 对答「无关」，只留 3 条边——比人工策展的 13 条少一个数量级。
**不对照就不知道自己在哪一侧翻车**：是模型太保守，还是人工那份太激进。

但要说清参照物是什么：`concept_graph.json` 的 `prerequisites` 是**早期会话按领域判断人工
策展**的（文件 `_meta` 自述「由 hello-agents 章节顺序 + 领域判断人工策展」），
**不是专家标注、不是金标**。跟难度标签那次是同一类东西。所以这里报的是**一致率**，
不是准确率——两份都可能错，一致只说明两条独立路径指向同一个结论。

这也是没有真值时唯一站得住的做法：收敛效度。领域公认「前置关系没有客观基准真值」
（Vuong, Nixon & Towle EDM 2011 用 20,577 名学生跑出来的图，与专家表正例一致率只有 14%）。

## 口径

只在**两份都有的概念**上比（人工那份只覆盖 AI 域 10 个概念，具身域一个都没有）。
比的是有向边集合：
- 都有 = 一致
- 只有人工有 = 模型漏了（recall 缺口）
- 只有模型有 = 模型多判（precision 缺口，也可能是人工漏了）

    python scripts/compare_prereq_graph.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KB = ROOT / "data" / "knowledge_base"
BUILT = KB / "prereq_graph.json"
CURATED = KB / "concept_graph.json"


def curated_edges() -> tuple[set[tuple[str, str]], set[str]]:
    data = json.loads(CURATED.read_text(encoding="utf-8"))
    concepts = {k for k in data if not k.startswith("_")}
    edges = {
        (p, q)
        for q in concepts
        for p in (data[q].get("prerequisites") or [])
        if p in concepts
    }
    return edges, concepts


def built_edges(domain: str) -> tuple[set[tuple[str, str]], set[str]]:
    data = json.loads(BUILT.read_text(encoding="utf-8"))
    d = data.get(domain) or {}
    items = set(d.get("items") or [])
    edges = {
        (p, q)
        for q, clauses in (d.get("clauses") or {}).items()
        for c in clauses
        for p in c.get("all", [])
    }
    return edges, items


def main() -> int:
    if not BUILT.exists():
        print(f"还没造图：{BUILT}")
        return 1
    cur, cur_c = curated_edges()
    got, got_c = built_edges("ai")
    shared = cur_c & got_c
    print(f"人工策展概念 {len(cur_c)}，造出概念 {len(got_c)}，共有 {len(shared)}")
    only_built = sorted(got_c - cur_c)
    if only_built:
        print(f"  ⚠ 人工那份缺的概念：{'、'.join(only_built)}（语料里有，concept_graph 没收）")

    # 只在共有概念上比，否则「人工没这个概念」会被算成模型多判
    c = {e for e in cur if e[0] in shared and e[1] in shared}
    g = {e for e in got if e[0] in shared and e[1] in shared}
    both, miss, extra = c & g, c - g, g - c

    print(f"\n共有概念上的有向边：人工 {len(c)} 条，造出 {len(g)} 条")
    print(f"  一致        {len(both)} 条")
    print(f"  人工有模型无 {len(miss)} 条")
    print(f"  模型有人工无 {len(extra)} 条")
    if c:
        print(f"  对人工那份的召回 {len(both)}/{len(c)} = {len(both) / len(c):.1%}")
    if g:
        print(f"  模型边落在人工集合内的比例 {len(both)}/{len(g)} = {len(both) / len(g):.1%}")

    for label, s in (("一致", both), ("人工有模型无", miss), ("模型有人工无", extra)):
        if s:
            print(f"\n【{label}】")
            for p, q in sorted(s):
                print(f"  {p} → {q}")

    print(
        "\n口径提醒：`concept_graph.json` 是早期会话人工策展的，**不是金标**。"
        "\n上面是一致率不是准确率——两份都可能错。领域内公认前置关系没有客观基准真值"
        "\n（Vuong EDM 2011 的大样本图与专家表正例一致率仅 14%）。"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
