from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 赛题实用价值项的三条硬指标（评分标准原文）：
# 幻觉率 <5%、画像-资源难度适配 ≥85%、核心知识点覆盖 ≥90%。
COMPETITION_TARGETS = [
    ("hallucination_rate", "幻觉率", 0.05, "max"),
    ("difficulty_match", "难度适配准确率", 0.85, "min"),
    ("concept_coverage", "知识点覆盖率", 0.90, "min"),
]

GOLD_NOTE = {
    "v1": "自证基线金标（难度与算法同源，循环论证，仅作对照）",
    "v2": "独立规则种子集（已参与校准，待教师盲测复核）",
}

_DEFAULT_GOLD_METADATA = {
    "v1": {
        "evidence_tier": "self_generated_baseline",
        "calibration_exposed": True,
        "human_reviewed": False,
        "holdout": False,
        "scope": "historical circular baseline only",
    },
    "v2": {
        "evidence_tier": "independent_seed_calibration_exposed",
        "calibration_exposed": True,
        "human_reviewed": False,
        "holdout": False,
        "scope": "engineering calibration agreement only",
    },
}


def load_gold_metadata(gold: str) -> dict:
    """Load evidence provenance, defaulting conservatively when metadata is absent."""
    metadata = dict(_DEFAULT_GOLD_METADATA.get(gold, {}))
    path = ROOT / "data" / "eval" / f"gold_{gold}" / "metadata.json"
    if path.exists():
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            metadata.update(loaded)
    metadata.setdefault("gold", gold)
    metadata.setdefault("evidence_tier", "unclassified")
    metadata.setdefault("calibration_exposed", True)
    metadata.setdefault("human_reviewed", False)
    metadata.setdefault("holdout", False)
    metadata.setdefault("scope", "provisional engineering evidence")
    return metadata


def evidence_claimability(
    metadata: dict,
    *,
    generation_mode: str,
    sample_count: int,
    thresholds_met: bool,
) -> dict:
    """Separate a numeric threshold check from whether it is final, claimable evidence."""
    has_human_holdout = (
        bool(metadata.get("human_reviewed"))
        and bool(metadata.get("holdout"))
        and not bool(metadata.get("calibration_exposed"))
    )
    enough_cases = sample_count >= 50
    claimable = thresholds_met and enough_cases and has_human_holdout
    reasons = []
    if not thresholds_met:
        reasons.append("numeric competition thresholds are not all met")
    if not enough_cases:
        reasons.append("fewer than 50 cases were evaluated")
    if not has_human_holdout:
        reasons.append("an independently labeled, unseen human holdout is still required")
    if generation_mode == "deterministic":
        reasons.append("deterministic mode proves reproducibility, not real-LLM teaching quality")
    return {
        "thresholds_met": thresholds_met,
        "sample_requirement_met": enough_cases,
        "claimable_as_final_accuracy": claimable,
        "generation_mode": generation_mode,
        "reason": "; ".join(reasons) if reasons else "final evidence requirements are met",
    }


def evaluate_gold(gold: str, limit: int, write_csv: bool) -> dict:
    from backend.orchestration.workflow import workflow
    from backend.services.data_loader import get_learner_profile, load_e2e_cases
    from backend.services.evaluation_service import evaluate_run

    cases = load_e2e_cases(gold=gold)
    if limit > 0:
        cases = cases[:limit]
    rows = []
    for case in cases:
        profile = get_learner_profile(case.learner_profile_id)
        run = workflow.run(profile, learning_goal=case.learning_goal)
        rows.append(evaluate_run(case, profile, run).model_dump())

    if write_csv:
        out = ROOT / "data" / "eval" / f"eval_results{'' if gold == 'v1' else '_' + gold}.csv"
        with out.open("w", encoding="utf-8", newline="") as file:
            fieldnames = [
                "case_id",
                "concept_coverage",
                "citation_coverage",
                "faithfulness",
                "context_precision",
                "context_concept_recall",
                "difficulty_match",
                "hallucination_rate",
                "hallucination_risk_flag_rate",
                "workflow_success",
                "details",
            ]
            writer = csv.DictWriter(file, fieldnames=fieldnames)
            writer.writeheader()
            for row in rows:
                row = dict(row)
                row["details"] = str(row["details"])
                writer.writerow(row)

    n = len(rows)
    return {
        "gold": gold,
        "n": n,
        "concept_coverage": sum(r["concept_coverage"] for r in rows) / n,
        "citation_coverage": sum(r["citation_coverage"] for r in rows) / n,
        "faithfulness": sum(r["faithfulness"] for r in rows) / n,
        "context_precision": sum(r["context_precision"] for r in rows) / n,
        "context_concept_recall": sum(r["context_concept_recall"] for r in rows) / n,
        "difficulty_match": sum(r["difficulty_match"] for r in rows) / n,
        "hallucination_rate": sum(r["hallucination_rate"] for r in rows) / n,
        "workflow_success": sum(r["workflow_success"] for r in rows) / n,
    }


def print_targets(avg: dict) -> bool:
    all_pass = True
    for field, label, target, direction in COMPETITION_TARGETS:
        value = avg[field]
        ok = value < target if direction == "max" else value >= target
        all_pass = all_pass and ok
        comparator = "<" if direction == "max" else ">="
        print(f"  {label} ({field}): {value:.3f} {comparator} {target} -> {'PASS' if ok else 'FAIL'}")
    print(f"  numeric threshold check: {'PASS' if all_pass else 'FAIL'}")
    return all_pass


def main() -> None:
    parser = argparse.ArgumentParser(description="端到端评测：输出赛题三项指标与达标判定")
    parser.add_argument("--limit", type=int, default=0, help="只评测前 N 个用例（0=全部）")
    parser.add_argument("--mode", choices=["env", "deterministic", "api"], default="env",
                        help="引擎模式：env=按 .env/环境变量，deterministic/api=强制覆盖")
    parser.add_argument("--gold", choices=["v1", "v2", "both"], default="both",
                        help="v1=自证基线；v2=独立金标(破循环)；both=两者对比(默认)")
    args = parser.parse_args()
    if args.mode != "env":
        os.environ["AGENT_GENERATION_MODE"] = args.mode

    from backend.services.model_routing import route_for

    print(f"generation mode: {os.environ.get('AGENT_GENERATION_MODE', 'deterministic')}"
          f" (ResourceGenerationAgent LLM enabled: {route_for('ResourceGenerationAgent').enabled})")
    if args.limit > 0:
        print(f"[subset run: first {args.limit} cases; full run needed for competition numbers]")

    golds = ["v1", "v2"] if args.gold == "both" else [args.gold]
    results = {}
    for gold in golds:
        print(f"\n===== gold={gold} —— {GOLD_NOTE[gold]} =====")
        avg = evaluate_gold(gold, args.limit, write_csv=True)
        results[gold] = avg
        print(f"evaluated {avg['n']} cases (competition requires >=50)")
        for key in [
            "concept_coverage",
            "citation_coverage",
            "faithfulness",
            "context_precision",
            "context_concept_recall",
            "difficulty_match",
            "hallucination_rate",
            "workflow_success",
        ]:
            print(f"  {key}: {avg[key]:.3f}")
        print("-- competition numeric thresholds --")
        thresholds_met = print_targets(avg)
        metadata = load_gold_metadata(gold)
        claimability = evidence_claimability(
            metadata,
            generation_mode=os.environ.get("AGENT_GENERATION_MODE", "deterministic"),
            sample_count=avg["n"],
            thresholds_met=thresholds_met,
        )
        avg["evidence"] = metadata
        avg["claimability"] = claimability
        print(f"-- evidence tier: {metadata['evidence_tier']} --")
        print(f"  final accuracy claimable: {claimability['claimable_as_final_accuracy']}")
        print(f"  reason: {claimability['reason']}")

    _write_summary(results)

    if "v1" in results and "v2" in results:
        print("\n===== 破循环论证对照（difficulty_match）=====")
        print(f"  v1 自证金标: {results['v1']['difficulty_match']:.3f}（诊断算法给自己判卷，无参考价值）")
        print(f"  v2 独立规则种子集: {results['v2']['difficulty_match']:.3f}（校准集一致率）")
        print("  说明：v2 的标签逻辑与诊断实现来源不同，但该集合已经参与规则校准，"
              "因此只能作为暂定工程一致率；最终难度适配准确率必须来自冻结算法后的教师盲测 holdout。")


def _write_summary(results: dict[str, dict]) -> None:
    output_dir = ROOT / "data" / "eval"
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "eval_summary.json"
    json_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    metrics = [
        "concept_coverage",
        "citation_coverage",
        "faithfulness",
        "context_precision",
        "context_concept_recall",
        "difficulty_match",
        "hallucination_rate",
        "workflow_success",
    ]
    lines = [
        "# Deterministic Evaluation Summary",
        "",
        "`context_concept_recall` measures expected concept tags covered by retrieved chunks; "
        "it is not reference-context recall requiring human reference contexts.",
        "",
        "A numeric threshold pass is not automatically final evidence. v2 is an independent-rule seed set "
        "that has already been used for calibration; a frozen-algorithm teacher-labeled holdout is still required.",
        "",
        "| Gold | Evidence tier | Final claimable | N | " + " | ".join(metrics) + " |",
        "| --- | --- | ---: | ---: | " + " | ".join(["---:"] * len(metrics)) + " |",
    ]
    for gold, values in results.items():
        evidence = values.get("evidence", {})
        claimability = values.get("claimability", {})
        lines.append(
            f"| {gold} | {evidence.get('evidence_tier', 'unclassified')} | "
            f"{claimability.get('claimable_as_final_accuracy', False)} | {values['n']} | "
            + " | ".join(f"{values[metric]:.3f}" for metric in metrics)
            + " |"
        )
    (output_dir / "eval_summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
