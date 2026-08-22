r"""难度定标校准 CLI：5 类预设画像当模拟学生，校准工作流生成的分阶题难度标签。

用法：python scripts\calibrate_difficulty.py [--goal "..."] [--mode deterministic|api]
产物：data/eval/difficulty_calibration.json + 终端摘要。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.orchestration.workflow import AgentTrainingWorkflow  # noqa: E402
from backend.services.data_loader import load_learner_profiles  # noqa: E402
from backend.services.difficulty_calibration import CalibrationItem, calibrate  # noqa: E402
from backend.services.quiz_service import estimate_pretest_from_profile  # noqa: E402
from backend.services.data_loader import load_pretest_questions  # noqa: E402
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--goal", default="学会搭一个带审核的 RAG 问答系统")
    parser.add_argument("--mode", choices=["env", "deterministic", "api"], default="env")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "eval" / "difficulty_calibration.json")
    args = parser.parse_args()
    if args.mode != "env":
        os.environ["AGENT_GENERATION_MODE"] = args.mode

    profiles = load_learner_profiles()
    diagnosis_agent = LearnerDiagnosisAgent()
    pretest = load_pretest_questions()

    # 掌握向量：与生成同源的诊断（数值层确定性，可复算）
    mastery_by_profile = {}
    for p in profiles:
        d = diagnosis_agent.run(p, estimate_pretest_from_profile(p, pretest), learning_goal=args.goal)
        mastery_by_profile[p.name] = d.mastery_vector

    # 题目池：每个画像跑一遍闭环，聚合全部分阶测验题（标签=生成时声明的难度）
    items = []
    for p in profiles:
        run = AgentTrainingWorkflow().run(p, learning_goal=args.goal)
        for qi, q in enumerate(run.resources.graded_quiz):
            items.append(CalibrationItem(
                item_id=f"{p.id}#q{qi}",
                difficulty=q.difficulty,
                concept_tags=list(q.concept_tags),
            ))

    report = calibrate(items, mastery_by_profile)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(report.model_dump_json(indent=2), encoding="utf-8")

    print(f"题目 {len(report.items)} 道 | 档均值 {report.level_mean_prob}")
    print(f"单调性违例 {len(report.monotone_violations)} | 低区分度题 {len(report.low_discrimination_items)}")
    for v in report.monotone_violations:
        print(f"  ⚠ {v.lower_level}({v.lower_mean_prob}) < {v.higher_level}({v.higher_mean_prob}) 逆序")
    print(f"{'PASS' if report.passed else 'FAIL'} → {args.output}")


if __name__ == "__main__":
    main()
