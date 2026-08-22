r"""复用已抽好的词表，只重跑前置判定。

    python scripts/rerun_prereq_from_vocab.py --intake data/knowledge_base/odoo_intake

## 为什么单开一个脚本

抽词表是 150 次调用，前置判定是 O(n²) 次。**改证据构造要重跑一遍不划算**，
而词表本身没问题——Odoo 那批抽出来的是「库存调整 / 先进先出 / 质量控制点 / 批次追踪」，
是真的业务知识面。废的是喂给分类器的证据。

复用词表、只重跑前置，就是「一次只动一个变量」在实验层面的落地：
词表不变，证据变了，边数变没变一目了然。

产出直接覆盖原 `readiness.json` 的 `prereq_graph` 与 `prereq_meta`，
并把上一版的边数记进 `_previous` 供对照——**不许静默替换**。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from backend.services.llm_gateway import LLMGateway  # noqa: E402
from ingest_domain import build_prereq, concept_evidence  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--intake", required=True, type=Path, help="接入产物目录（含 readiness.json）")
    args = ap.parse_args()

    report_path = args.intake / "readiness.json"
    if not report_path.is_file():
        print(f"找不到 {report_path}")
        return 1
    report = json.loads(report_path.read_text(encoding="utf-8"))
    vocab = report.get("concepts") or []
    if len(vocab) < 2:
        print(f"词表只有 {len(vocab)} 个概念，前置图无从谈起")
        return 1

    os.environ["AGENT_GENERATION_MODE"] = "api"
    gateway = LLMGateway()
    route = gateway.route_for("PrereqEdgeClassifier")
    if not route.enabled:
        print(f"路由未启用：{route.provider}/{route.model}")
        return 1
    print(f"模型 {route.provider}/{route.model}；复用词表 {len(vocab)} 个概念")

    names = [v["concept"] for v in vocab]
    evidence = {v["concept"]: concept_evidence(v) for v in vocab}
    print("证据样例（第一个概念）：")
    for line in evidence[names[0]].splitlines()[:4]:
        print(f"  {line[:90]}")

    graph, meta = build_prereq(gateway, names, evidence)

    before = len((report.get("prereq_graph") or {}).get("clauses") or {})
    after = len(graph["clauses"])
    report["_previous"] = report.get("_previous", [])
    report["_previous"].append(
        {
            "prereq_edges": before,
            "note": "上一版的前置边数，留档对照。证据构造改过一次：小节标题在转换语料上"
            "退化成英文文件名，改成只保留含中文的标题、并把正文证据句给足。",
        }
    )
    report["prereq_graph"] = graph
    report["prereq_meta"] = {k: v for k, v in meta.items() if k != "audit"}
    report["readiness"]["gate2_graph_connected"] = after > 0
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    (args.intake / "prereq_audit.json").write_text(
        json.dumps(meta["audit"], ensure_ascii=False, indent=1), encoding="utf-8"
    )

    errors = sum(1 for x in meta["audit"] if x.get("relation") == "error")
    print(f"\n前置边：{before} → {after}（{meta['pairs']} 对，{errors} 次调用失败）")
    print(f"去环 {len(meta['cycles_removed'])}，传递约简 {len(meta['transitive_removed'])}")
    for q, clauses in list(graph["clauses"].items())[:12]:
        print(f"  {'、'.join(clauses[0]['all'])} → {q}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
