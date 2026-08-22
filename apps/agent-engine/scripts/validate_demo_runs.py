from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.demo_run_service import validate_demo_runs  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="校验离线演示运行 manifest、schema 和父子关系")
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=ROOT / "data" / "demo_runs",
    )
    args = parser.parse_args()
    report = validate_demo_runs(args.input_dir)
    print(report)
    if not report["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
