from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.adversarial_service import (  # noqa: E402
    load_adversarial_cases,
    run_adversarial_suite,
    write_adversarial_results,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="运行结构化对抗用例并输出可复算结果")
    parser.add_argument("--limit", type=int, default=0, help="只运行前 N 条，0=全部")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "eval",
        help="结果目录",
    )
    args = parser.parse_args()

    cases = load_adversarial_cases()
    if args.limit > 0:
        cases = cases[: args.limit]
    results = run_adversarial_suite(cases)
    write_adversarial_results(results, args.output_dir)

    counts = {status: sum(result.status == status for result in results) for status in ("PASS", "FAIL", "SKIP")}
    for result in results:
        failed = [name for name, ok in result.checks.items() if not ok]
        suffix = f" failed={','.join(failed)}" if failed else ""
        print(f"{result.status:4} {result.case_id} [{result.category}]{suffix}")
    print(f"summary: PASS={counts['PASS']} FAIL={counts['FAIL']} SKIP={counts['SKIP']}")
    if counts["FAIL"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
