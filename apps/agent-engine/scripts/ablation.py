from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.ablation_service import (  # noqa: E402
    ABLATION_MODES,
    run_ablation_suite,
    summarize_ablation,
    write_ablation_results,
)
from backend.services.data_loader import load_e2e_cases  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="五档消融：direct→RAG→审核→辩论→完整个性化")
    parser.add_argument("--gold", choices=["v1", "v2"], default="v2")
    parser.add_argument("--limit", type=int, default=0, help="只运行前 N 条，0=全部")
    parser.add_argument(
        "--mode",
        choices=["env", "deterministic", "api"],
        default="deterministic",
        help="LLM 运行模式；api 需要显式配置真实密钥",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "eval" / "ablation",
    )
    parser.add_argument(
        "--only",
        default="",
        help="只跑指定档位，逗号分隔（如 direct 或 rag,rag_audit）；默认全部九档",
    )
    parser.add_argument(
        "--offset",
        type=int,
        default=0,
        help="跳过前 N 个用例（与 --limit 组合做分片并发）",
    )
    args = parser.parse_args()

    if args.mode != "env":
        os.environ["AGENT_GENERATION_MODE"] = args.mode
    cases = load_e2e_cases(gold=args.gold)
    if args.offset > 0:
        cases = cases[args.offset:]
    if args.limit > 0:
        cases = cases[: args.limit]
    selected = tuple(m.strip() for m in args.only.split(",") if m.strip()) or ABLATION_MODES
    unknown = [m for m in selected if m not in ABLATION_MODES]
    if unknown:
        raise SystemExit(f"--only 含未知档位：{unknown}（可选：{list(ABLATION_MODES)}）")
    results = run_ablation_suite(cases, modes=selected)
    write_ablation_results(results, args.output_dir)
    summary = summarize_ablation(results)

    print(f"gold={args.gold} cases={len(cases)} mode={os.environ.get('AGENT_GENERATION_MODE', 'deterministic')}")
    for ablation_mode in selected:
        item = summary[ablation_mode]
        print(
            f"{ablation_mode:20} n={item['n']:>3} "
            f"faith={item['faithfulness']:.3f} "
            f"ctxP={item['context_precision']:.3f} "
            f"ctxR={item['context_concept_recall']:.3f} "
            f"difficulty={item['difficulty_match']:.3f} "
            f"hallucination={item['hallucination_rate']:.3f} "
            f"fallback={item['fallback_rate']:.3f} "
            f"ms={item['duration_ms']:.1f}"
        )
    print(f"results: {args.output_dir}")


if __name__ == "__main__":
    main()
