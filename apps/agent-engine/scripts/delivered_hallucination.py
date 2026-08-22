"""交付端幻觉率清算：门禁放行子集 vs 生成端全集。

口径（evaluation_protocol.md 第 1 节）：对外 "<5%" 承诺挂交付端——
仲裁 block_pending_human_review 的 run 不交付，不进交付端分母。
本脚本只做既有 eval_results CSV 的切分统计，不发起任何模型调用。

用法：
    python scripts/delivered_hallucination.py data/eval/eval_results_v2.csv [更多csv]
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path


def analyze(path: Path) -> dict:
    rows = list(csv.DictReader(path.open(encoding="utf-8")))
    if not rows:
        raise SystemExit(f"{path}: 空文件")
    # 两种产物都吃：run_eval 的 details 里带仲裁动作；run_real_llm_eval 直接有 blocked 列。
    if "hallucination_rate" not in rows[0]:
        raise SystemExit(f"{path}: 缺 hallucination_rate 列，不是评测产物")
    if "blocked" in rows[0]:
        def is_blocked(r: dict) -> bool:
            return str(r["blocked"]).strip().lower() in {"true", "1"}
    elif "details" in rows[0]:
        def is_blocked(r: dict) -> bool:
            return "block_pending_human_review" in r["details"]
    else:
        raise SystemExit(f"{path}: 既没有 details 也没有 blocked 列，判不了交付端")

    blocked = [r for r in rows if is_blocked(r)]
    delivered = [r for r in rows if not is_blocked(r)]

    def mean(rs: list[dict]) -> float:
        return sum(float(r["hallucination_rate"]) for r in rs) / max(1, len(rs))

    return {
        "file": str(path),
        "n_total": len(rows),
        "n_blocked": len(blocked),
        "n_delivered": len(delivered),
        "generation_end_hallucination": round(mean(rows), 4),
        "delivered_end_hallucination": round(mean(delivered), 4),
        "blocked_end_hallucination": round(mean(blocked), 4) if blocked else None,
    }


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]] or [Path("data/eval/eval_results_v2.csv")]
    for p in paths:
        r = analyze(p)
        print(f"\n== {r['file']}")
        print(f"  总数 {r['n_total']}，仲裁拦截 {r['n_blocked']}，交付 {r['n_delivered']}")
        print(f"  生成端幻觉率（全集）：{r['generation_end_hallucination']:.3f}")
        print(f"  交付端幻觉率（放行子集）：{r['delivered_end_hallucination']:.3f}")
        if r["blocked_end_hallucination"] is not None:
            print(f"  被拦子集幻觉率（对照）：{r['blocked_end_hallucination']:.3f}")


if __name__ == "__main__":
    main()
