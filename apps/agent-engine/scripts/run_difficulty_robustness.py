from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.difficulty_robustness_service import load_cases, run_suite, write_results


def main() -> None:
    parser = argparse.ArgumentParser(
        description="验证难度规则对同义改写和任务约束增减的工程鲁棒性"
    )
    parser.add_argument("--cases", type=Path, default=ROOT / "data/eval/difficulty_robustness_cases.jsonl")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "data/eval")
    args = parser.parse_args()

    cases = load_cases(args.cases)
    results = run_suite(cases)
    write_results(results, args.output_dir)

    failed = [result for result in results if not result.passed]
    for result in results:
        observed = result.observed or f"{result.base_observed}->{result.variant_observed}"
        print(f"{'PASS' if result.passed else 'FAIL'} {result.case_id} {observed}")
    print(f"summary: PASS={len(results) - len(failed)} FAIL={len(failed)} TOTAL={len(results)}")
    print("scope: engineering_robustness_only; not a teacher-labeled holdout")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
