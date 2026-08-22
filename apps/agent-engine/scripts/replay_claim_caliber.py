"""口径复算：拿归档的 run 产物，用当前代码重新抽取+打分，对比存档里的旧数值。

零 API 调用。用途是在花钱重跑真实评测之前，先量清楚每一条口径改动把数字挪了多少、
朝哪个方向挪——改完就跑等于拿钱赌，赌输了没有第二次。

用法：
    python scripts/replay_claim_caliber.py                 # 扫 data/runs + data/demo_runs
    python scripts/replay_claim_caliber.py --limit 50
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.claims import audited_char_ratio, claim_statistics, extract_claims, verify_claims  # noqa: E402
from backend.schemas.resources import KnowledgeChunk, LearningResources  # noqa: E402

SCAN_DIRS = ["data/runs", "data/demo_runs", "data/eval"]


def iter_runs(limit: int):
    seen = 0
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(data, dict):
                continue
            if "resources" not in data or "retrieval" not in data:
                continue
            yield path, data
            seen += 1
            if limit and seen >= limit:
                return


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    old_rates, new_low, new_high, coverage, deltas = [], [], [], [], []
    old_counts, new_counts = [], []
    skipped = 0

    for path, data in iter_runs(args.limit):
        try:
            resources = LearningResources.model_validate(data["resources"])
            chunks = [KnowledgeChunk.model_validate(c) for c in data["retrieval"]["retrieved_chunks"]]
        except Exception:  # noqa: BLE001 - 归档格式跨版本，读不动就跳过
            skipped += 1
            continue
        archived = (data.get("audit") or {}).get("hallucination_rate")
        if archived is None:
            skipped += 1
            continue
        stats = claim_statistics(verify_claims(extract_claims(resources), chunks))
        old_rates.append(float(archived))
        new_low.append(stats["hallucination_rate"])
        new_high.append(stats["hallucination_rate_upper"])
        coverage.append(audited_char_ratio(resources))
        deltas.append(stats["hallucination_rate"] - float(archived))
        old_counts.append((data.get("audit") or {}).get("claims_total") or 0)
        new_counts.append(stats["claims_total"])

    n = len(old_rates)
    if not n:
        print(f"没找到可复算的归档 run（跳过 {skipped} 个）")
        return
    print(f"复算 {n} 个 run（跳过 {skipped} 个格式不兼容的）\n")
    print(f"  旧口径 幻觉率均值      : {statistics.mean(old_rates):.4f}")
    print(f"  新口径 严格下界均值    : {statistics.mean(new_low):.4f}")
    print(f"  新口径 宽口径上界均值  : {statistics.mean(new_high):.4f}")
    print(f"  逐 run 差值 中位/均值  : {statistics.median(deltas):+.4f} / {statistics.mean(deltas):+.4f}")
    print(f"  断言数 旧/新 均值      : {statistics.mean(old_counts):.1f} / {statistics.mean(new_counts):.1f}")
    print(f"  被审正文占比 均值      : {statistics.mean(coverage):.3f}")
    worse = sum(1 for d in deltas if d > 0.01)
    better = sum(1 for d in deltas if d < -0.01)
    print(f"  变高 {worse} 个 / 变低 {better} 个 / 基本不变 {n - worse - better} 个")


if __name__ == "__main__":
    main()
