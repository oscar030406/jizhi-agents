r"""前置复核器的尺子自检：拿**已知成立**的边喂给它，看它认不认。

    python scripts/experiments/prereq_reviewer_sanity.py

## 为什么要这一步

结构信号在 Odoo 上提出 30 条候选边（对照：节级 LLM 盲判 153 对出 0 条），
但复核器把 30 条全否了——21 条判 none 且置信度 0.7-0.9，9 条调用失败。

两种解释，处置完全相反：

- **尺子有问题**：复核器对任何前置关系都倾向判 none。那就该换判据/换模型。
- **语料确实没有前置结构**：产品操作手册的章之间是并列工作流（仓储作业 / 包装类型 /
  补货规则），不是学习先后。那 Odoo 上出不来边就是**正确结论**，该如实写进限制。

分辨办法：把我们自己领域里**已经在用**的前置边（`data/knowledge_base/prereq_graph.json`，
人工与模型共同确认过、正在给学习者选点用）喂给同一个复核器。它若连这些都判 none，
问题在尺子；它若认这些、只否 Odoo 的，那 Odoo 那 30 条被否就是有信息量的判断。

先怀疑验证工具，再怀疑产品。
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from backend.services.llm_gateway import LLMGateway  # noqa: E402

GRAPH = ROOT / "data" / "knowledge_base" / "prereq_graph.json"
INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
OUT = ROOT / "data" / "eval" / "prereq_reviewer_sanity.json"
TITLE_CAP = 12


def topic_titles() -> dict[str, list[str]]:
    """按 topic 收标题——与 build_prereq_graph 的证据形态同源，不另造一份。"""
    # 只取活块，与 build_prereq_graph 同一口径——尺子自检和被检的那条链
    # 必须看到同一份素材，否则自检本身就不作数。
    from backend.rag.ingest import read_index_rows

    titles: dict[str, list[str]] = {}
    for row in read_index_rows(INDEX):
        t = row.get("topic")
        if not t:
            continue
        title = row.get("title", "")
        if title and title not in titles.setdefault(t, []):
            titles[t].append(title)
    return titles


def evidence(topic: str, titles: dict[str, list[str]]) -> str:
    ts = titles.get(topic, [])[:TITLE_CAP]
    lines = [f"概念：{topic}（语料中 {len(titles.get(topic, []))} 节提及）"]
    if ts:
        lines.append("覆盖的教材小节：" + "；".join(ts))
    return "\n".join(lines)


def main() -> int:
    from build_prereq_graph import classify_pair

    graph = json.loads(GRAPH.read_text(encoding="utf-8"))
    titles = topic_titles()
    # 这份图按域分层：{"ai": {items, clauses, ...}, "embodied": {...}}。
    # 一版直接找顶层 clauses，取到 0 条边还打印了「尺子基本可用」——空集不构成任何证据。
    pairs: list[tuple[str, str]] = []
    for domain, sub in graph.items():
        if not isinstance(sub, dict):
            continue
        for target, clauses in (sub.get("clauses") or {}).items():
            for clause in clauses:
                for prereq in clause.get("all", []):
                    pairs.append((prereq, target))
    print(f"已在用的前置边 {len(pairs)} 条（源 {GRAPH.name}，含 {list(graph)} 两域）")
    if not pairs:
        print("取到 0 条边——自检无从做起，先查 prereq_graph.json 的形状")
        return 1

    os.environ["AGENT_GENERATION_MODE"] = "api"
    gateway = LLMGateway()
    rows = []
    for i, (a, b) in enumerate(pairs, 1):
        got = classify_pair(gateway, a, b, evidence(a, titles), evidence(b, titles))
        rows.append({"prereq": a, "target": b, "review": got,
                     "agrees": bool(got and got.get("relation") == "a_before_b")})
        rel = (got or {}).get("relation", "CALL_FAIL")
        print(f"  {i:>2}. {a} → {b}   {rel} conf={(got or {}).get('confidence')}")

    counts = Counter((r["review"] or {}).get("relation", "CALL_FAIL") for r in rows)
    agree = sum(r["agrees"] for r in rows)
    print(f"\n关系分布：{dict(counts)}")
    print(f"复核器认同率：{agree}/{len(rows)} = {agree / max(len(rows), 1):.0%}")
    print("\n判读：")
    if agree >= len(rows) * 0.6:
        print("  复核器认得出我们自己领域的前置边 -> 尺子基本可用，"
              "Odoo 上 0/30 是对那份语料的判断，不是尺子失灵。")
    else:
        print("  复核器连已在用的边都不认 -> 问题在尺子（判据或模型），"
              "不能用它的否定去下「该语料没有前置结构」的结论。")
    OUT.write_text(json.dumps({"pairs": len(rows), "agree": agree,
                               "relations": dict(counts), "rows": rows},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"落盘 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
