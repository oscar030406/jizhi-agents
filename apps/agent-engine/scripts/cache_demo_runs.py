"""用真实 LLM 跑几条代表性闭环并缓存结果，作演示离线回放（PLAYBOOK Phase G）。

用法：
    python scripts\\cache_demo_runs.py            # 默认 api 模式，跑 3 条代表性组合
    python scripts\\cache_demo_runs.py --mode env # 按 .env 的模式跑

输出：
    data/demo_runs/<run_id>.json   完整 WorkflowRun（含 trace/debate/engine 标注），随仓库提交
    同时写入 data/runs/ 的运行历史，前端"运行历史"面板可直接回放。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEMO_DIR = ROOT / "data" / "demo_runs"

# 代表性组合：零基础/转型/冲刺三种画像 × 不同目标，覆盖 L1-L3 难度和辩论触发面
SHOWCASES = [
    ("zero_beginner", "完成 RAG 文档问答 Agent"),
    ("python_no_agent", "实现工具调用 Agent 并记录 trace"),
    ("backend_to_agent", "搭建多 Agent 协作的内容审核工作流"),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="缓存真实 LLM 演示 run")
    parser.add_argument("--mode", choices=["env", "deterministic", "api"], default="api")
    args = parser.parse_args()
    if args.mode != "env":
        os.environ["AGENT_GENERATION_MODE"] = args.mode

    from backend.orchestration.workflow import workflow
    from backend.services.data_loader import get_learner_profile
    from backend.services.history_service import record_workflow_run
    from backend.services.model_routing import route_for

    generation_enabled = route_for("ResourceGenerationAgent").enabled
    print(f"mode={os.environ.get('AGENT_GENERATION_MODE')}, generation LLM enabled={generation_enabled}")
    if args.mode == "api" and not generation_enabled:
        print("警告：api 模式但未检测到可用 key，将全部走确定性引擎。")

    DEMO_DIR.mkdir(parents=True, exist_ok=True)
    for profile_id, goal in SHOWCASES:
        profile = get_learner_profile(profile_id)
        run = workflow.run(profile, learning_goal=goal)
        engines = [step.artifacts.get("engine", "?") for step in run.trace]
        out = DEMO_DIR / f"{run.run_id}.json"
        out.write_text(json.dumps(run.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
        record_workflow_run(run)
        print(
            f"cached {profile_id} | {goal}\n"
            f"  run_id={run.run_id} engines={engines}\n"
            f"  factuality={run.audit.factuality_score} hallucination_rate={run.audit.hallucination_rate} "
            f"claims={run.audit.claims_supported}/{run.audit.claims_total} debate_rounds={len(run.debate)}"
        )
    print(f"done -> {DEMO_DIR}")


if __name__ == "__main__":
    main()
