r"""同题异人对比生成 CLI：杀手演示的引擎侧入口。

用法：
  python scripts\compare_profiles.py --goal "学会搭一个带审核的 RAG 问答系统" ^
    --profiles zero_beginner,python_no_agent,backend_to_agent
  加 --mode api 走真实 LLM（演示口径）；默认跟随环境（回归用 deterministic）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.compare_service import compare_generate  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goal", required=True)
    parser.add_argument("--profiles", required=True, help="画像 id，逗号分隔，≥2 个")
    parser.add_argument("--mode", choices=["env", "deterministic", "api"], default="env")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "eval" / "compare" / "latest.json")
    args = parser.parse_args()

    if args.mode != "env":
        if args.mode == "deterministic":
            raise SystemExit(
                "确定性引擎已于 2026-08-28 移除（运行时统一为真实模型单路径）。"
                "deterministic 口径仅供历史复算：请检出当日之前的 git 版本运行。")

    report = compare_generate(args.goal, [p.strip() for p in args.profiles.split(",") if p.strip()])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report.model_dump_json(indent=2), encoding="utf-8")

    print(f"目标：{report.learning_goal}")
    for entry in report.entries:
        p, r = entry.profile, entry.resources
        engines = sorted(set(r.engines.values()))
        print(f"\n◆ {p.name}（难度 {p.recommended_difficulty}，engine={'/'.join(engines)}）")
        print(f"  讲义 {r.section_count} 节：{'；'.join(r.section_headings[:4])}…")
        print(f"  实操 {r.task_difficulty}·{r.task_steps} 步 | 测验 {r.quiz_count} 题")
    print(f"\n差异归因 {len(report.differences)} 处：")
    for d in report.differences:
        print(f"  [{d.dimension}] {d.observation}")
        for b in d.because[:3]:
            print(f"      ← {b}")
    fi = report.fact_invariance
    if fi:
        print(f"\n事实不变量检查：{'PASS' if fi.passed else 'FAIL'}"
              f"（claims={fi.checked_claims}，越界引用={len(fi.out_of_scope_citations)}，"
              f"疑似冲突={len(fi.suspected_conflicts)}）")
    print(f"\nJSON：{args.output}")


if __name__ == "__main__":
    main()
