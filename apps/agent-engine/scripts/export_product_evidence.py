from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.product_evidence_export import export_product_evidence


def main() -> None:
    parser = argparse.ArgumentParser(
        description="将经过校验的评测、消融与离线运行快照导出到 ai_learn 前端 public 目录"
    )
    parser.add_argument("--engine-root", type=Path, default=ROOT)
    parser.add_argument("--product-root", type=Path, default=ROOT.parent / "legacy-platform")
    parser.add_argument(
        "--skip-demo-validation",
        action="store_true",
        help="仅供隔离测试夹具使用；正式导出不得跳过 demo schema 校验",
    )
    args = parser.parse_args()

    report = export_product_evidence(
        args.engine_root,
        args.product_root,
        validate_demo=not args.skip_demo_validation,
    )
    print(f"valid: {report['valid']}")
    print(f"output: {report['output_root']}")
    print(f"source_commit: {report['source_commit']}")
    print(f"generation_mode: {report['generation_mode']}")
    print(f"demo_runs: {report['run_count']}")


if __name__ == "__main__":
    main()
