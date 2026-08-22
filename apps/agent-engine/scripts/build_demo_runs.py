from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.demo_run_service import build_demo_runs, validate_demo_runs  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="生成并校验离线演示 WorkflowRun")
    parser.add_argument("--mode", choices=["deterministic", "api", "env"], default="deterministic")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "demo_runs",
    )
    args = parser.parse_args()

    manifest = build_demo_runs(args.output_dir, generation_mode=args.mode)
    report = validate_demo_runs(args.output_dir)
    print(
        f"built {len(manifest['runs'])} demo runs mode={manifest['generation_mode']} "
        f"source_commit={manifest['source_commit']}"
    )
    print(
        f"validation valid={report['valid']} runs={report['run_count']} "
        f"followups={report['followup_count']} errors={report['errors']}"
    )
    if not report["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
