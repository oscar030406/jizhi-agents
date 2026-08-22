r"""多 seed 多分片消融合并分析（评测协议 §三：均值±标准差 + 净化口径双表）。

用法：
  python scripts\merge_ablation_seeds.py --roots data\eval\full_s1 data\eval\full_s2 ...
  （每个 root 下有 shard_*/ablation_results.csv；root 名即 seed 标签）
产物：--output（默认 data/eval/ablation_merged.md）+ 同名 .csv 长表。
"""
from __future__ import annotations

import argparse
import csv
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.ablation_service import ABLATION_MODES  # noqa: E402

METRICS = ["faithfulness", "hallucination_rate", "citation_coverage",
           "difficulty_match", "fallback_rate", "debate_rounds", "duration_ms"]


def load_rows(roots: list[Path]) -> list[dict]:
    rows = []
    for root in roots:
        paths = sorted(root.glob("shard_*/ablation_results.csv")) or [root / "ablation_results.csv"]
        for csv_path in paths:
            if not csv_path.is_file():
                continue
            with open(csv_path, encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    r["seed"] = root.name
                    rows.append(r)
    return rows


def summarize(rows: list[dict], purified: bool) -> dict[str, dict[str, tuple[float, float, int]]]:
    """mode -> metric -> (mean, std, n)。净化口径剔除生成端降级行（fallback_rate>0）。"""
    by_mode = defaultdict(list)
    for r in rows:
        if purified and float(r.get("fallback_rate", 0)) > 0:
            continue
        by_mode[r["mode"]].append(r)
    out = {}
    for mode, rs in by_mode.items():
        out[mode] = {}
        for m in METRICS:
            vals = [float(r[m]) for r in rs if r.get(m) not in (None, "")]
            if vals:
                out[mode][m] = (st.mean(vals), st.stdev(vals) if len(vals) > 1 else 0.0, len(vals))
    return out


def render(summary: dict, title: str) -> list[str]:
    lines = [f"### {title}", "", "| Mode | n | faith | halluc | cite | fallback | 时长s |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for mode in ABLATION_MODES:
        s = summary.get(mode)
        if not s:
            continue
        f_m, f_s, n = s["faithfulness"]
        h_m, h_s, _ = s["hallucination_rate"]
        c_m, _, _ = s.get("citation_coverage", (0, 0, 0))
        fb_m, _, _ = s.get("fallback_rate", (0, 0, 0))
        d_m, _, _ = s.get("duration_ms", (0, 0, 0))
        lines.append(
            f"| {mode} | {n} | {f_m:.3f}±{f_s:.3f} | {h_m:.3f}±{h_s:.3f} | "
            f"{c_m:.3f} | {fb_m:.3f} | {d_m / 1000:.0f} |")
    lines.append("")
    return lines


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roots", nargs="+", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "eval" / "ablation_merged.md")
    args = parser.parse_args()

    rows = load_rows([r if r.is_absolute() else ROOT / r for r in args.roots])
    if not rows:
        raise SystemExit("没有找到任何 shard_*/ablation_results.csv")
    seeds = sorted({r["seed"] for r in rows})
    cases = sorted({r["case_id"] for r in rows})

    lines = [
        "# 九档消融合并结果",
        "",
        f"seeds={seeds} · cases={len(cases)} · rows={len(rows)}（口径见 evaluation_protocol.md §三）",
        "",
    ]
    lines += render(summarize(rows, purified=False), "原始口径（含降级行）")
    lines += render(summarize(rows, purified=True), "净化口径（剔除生成端降级行）")

    args.output.write_text("\n".join(lines), encoding="utf-8")
    with open(args.output.with_suffix(".csv"), "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("\n".join(lines[:20]))
    print(f"→ {args.output}")


if __name__ == "__main__":
    main()
