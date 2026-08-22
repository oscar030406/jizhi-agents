"""只重建 demo_runs 的 manifest，不碰 run 文件。

为什么单独一个脚本：`build_demo_runs.py` 会先删光目录再重跑全部工作流——
现有 run 是真 LLM 轨迹（重跑要花钱、且换一批数字），只想给 manifest 补
仲裁判决与口径块时不能走它。本脚本从磁盘上已有的 run 文件重推 manifest，
run 内容一个字节不动。

用法：
    python scripts/refresh_demo_manifest.py                    # data/demo_runs
    python scripts/refresh_demo_manifest.py --dir <其他目录>    # 提交包副本等
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.schemas.resources import WorkflowRun  # noqa: E402
from backend.services.demo_run_service import _git_commit, _manifest_item  # noqa: E402


def refresh(directory: Path) -> dict:
    manifest_path = directory / "manifest.json"
    old = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    old_runs = {item["file"]: item for item in old.get("runs", [])}

    runs = []
    for item in old.get("runs", []):
        path = directory / item["file"]
        if not path.exists():
            print(f"  跳过（文件缺失）：{item['file']}")
            continue
        run = WorkflowRun.model_validate_json(path.read_text(encoding="utf-8"))
        runs.append(
            _manifest_item(
                scenario=item["scenario"],
                filename=item["file"],
                run=run,
                parent_scenario=item.get("parent_scenario"),
            )
        )

    from backend.services.demo_run_service import build_demo_runs  # noqa: F401  (确保口径块常量同源)

    # 口径块直接借 demo_run_service 里 build_demo_runs 写的同一份文本——
    # 复制一份出来迟早漂移，这里 import 模块后从函数生成的 manifest 拿不现实
    # （它会重跑工作流），所以退一步：口径块在 service 里是字面量，这里同步维护，
    # check_metrics.py 会校验两处一致。
    metric_semantics = {
        "hallucination_rate": (
            "生成端 claim 级 unsupported 比例（充分性门开启后的口径，判定见 "
            "docs/05-evidence/evaluation_protocol.md §1）。这是门禁的输入不是产品的输出："
            "超过 arbitration 放行线（0.10）的 run 会被拦截转人工，见各 run 的 "
            "arbitration_action 字段。对外幻觉承诺挂交付端（released=true 的子集），"
            "不挂本列裸值。"
        ),
        "factuality_score": "claim 级 supported 加权分，放行线 0.62（ArbitrationAgent 同参）。",
        "released": "True=门禁放行（approve/approve_with_warning）；False=拦截转人工，属门禁活证案例。",
    }

    manifest = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_commit": _git_commit(),
        "generation_mode": old.get("generation_mode", "unknown"),
        "goal": old.get("goal", ""),
        "manifest_refreshed_from_existing_runs": True,
        "metric_semantics": metric_semantics,
        "runs": runs,
        "notes": old.get("notes", ""),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    released = [r["scenario"] for r in runs if r.get("released")]
    blocked = [r["scenario"] for r in runs if r.get("released") is False]
    print(f"  {directory}: {len(runs)} runs，放行 {released}，拦截 {blocked}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", default="data/demo_runs")
    args = parser.parse_args()
    refresh(Path(args.dir))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
