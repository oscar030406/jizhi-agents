from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.submission_service import verify_submission  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="检查挑战杯提交物是否齐全且可复算")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--skip-demo-validation", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    args = parser.parse_args()

    report = verify_submission(
        args.root,
        validate_demo=not args.skip_demo_validation,
    )
    if args.json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"valid: {report['valid']}")
        print(f"root: {report['root']}")
        if report["missing"]:
            print("missing:")
            for item in report["missing"]:
                print(f"  - {item}")
        if report["errors"]:
            print("errors:")
            for item in report["errors"]:
                print(f"  - {item}")
        if report["warnings"]:
            print("warnings:")
            for item in report["warnings"]:
                print(f"  - {item}")
        print("checks:")
        print(json.dumps(report["checks"], ensure_ascii=False, indent=2))
    if not report["valid"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
