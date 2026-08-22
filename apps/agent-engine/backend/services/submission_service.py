from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.services.demo_run_service import validate_demo_runs

REQUIRED_FILES = (
    "README.md",
    "PLAYBOOK.md",
    "AGENTS.md",
    "requirements.txt",
    "backend/main.py",
    "data/knowledge_base/sources_manifest.csv",
    "data/knowledge_base/ATTRIBUTION.md",
    "data/eval/eval_summary.json",
    "data/eval/eval_summary.md",
    "data/eval/adversarial_cases.jsonl",
    "data/eval/adversarial_results.json",
    "data/eval/adversarial_results.md",
    "data/eval/difficulty_robustness_cases.jsonl",
    "data/eval/difficulty_robustness_results.json",
    "data/eval/difficulty_robustness_results.md",
    "data/eval/gold_v2/metadata.json",
    "data/eval/ablation/ablation_results.json",
    "data/eval/ablation/ablation_results.csv",
    "data/eval/ablation/ablation_results.md",
    "data/demo_runs/manifest.json",
)

#: 相对**仓库根**（不是引擎目录）解析的那几份。
#:
#: 2026-08 那次仓库整理把交付文档从 `apps/agent-engine/docs/` 挪到了仓库级 `docs/`，
#: 这张清单没跟着改，于是校验器一直在原地找、一直报 missing——2026-08-13 才被
#: `verify_all.py` 暴露出来（平时没人单跑 verify_submission）。
#: 每项给一组候选路径，命中任一即算齐；写成组是因为 deployment 同时存在
#: 现行版与归档版，只认现行那份。
REQUIRED_REPO_FILES: tuple[tuple[str, ...], ...] = (
    ("docs/06-defense/deployment.md",),
    ("docs/05-evidence/test_inventory.md",),
    ("docs/archive/demo_script.md",),
    ("docs/archive/2026-07-defense-paused/human_tasks.md",),
    # 原名 submission_manifest.md。仓库整理后这份清单是 docs/06-defense/README.md，
    # 开头就是「提交材料真源」+ 提交形式↔真源对照表，内容对得上，只是改了名。
    ("docs/06-defense/README.md", "docs/submission_manifest.md"),
)


def verify_submission(root: Path, *, validate_demo: bool = True) -> dict[str, Any]:
    root = root.resolve()
    missing = [relative for relative in REQUIRED_FILES if not (root / relative).is_file()]
    # 仓库根 = 引擎目录往上两层（apps/agent-engine → apps → 仓库）。
    # 单测把 root 指向 tmp_path，那里没有 apps/ 层级，所以候选组也允许在 root 下命中。
    repo = root.parents[1]
    for candidates in REQUIRED_REPO_FILES:
        if any((repo / c).is_file() or (root / c).is_file() for c in candidates):
            continue
        missing.append(candidates[0])
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, Any] = {}

    adversarial_path = root / "data/eval/adversarial_cases.jsonl"
    if adversarial_path.is_file():
        case_count = sum(1 for line in adversarial_path.read_text(encoding="utf-8").splitlines() if line.strip())
        checks["adversarial_case_count"] = case_count
        if case_count < 20:
            errors.append(f"adversarial case count below 20: {case_count}")

    adversarial_results_path = root / "data/eval/adversarial_results.json"
    if adversarial_results_path.is_file():
        try:
            results = json.loads(adversarial_results_path.read_text(encoding="utf-8"))
            fail_count = sum(item.get("status") == "FAIL" for item in results)
            skip_count = sum(item.get("status") == "SKIP" for item in results)
            checks["adversarial_fail_count"] = fail_count
            checks["adversarial_skip_count"] = skip_count
            if fail_count:
                errors.append(f"adversarial results contain {fail_count} FAIL cases")
            if skip_count:
                warnings.append(f"adversarial results contain {skip_count} manual SKIP cases")
        except Exception as exc:
            errors.append(f"adversarial_results.json invalid: {exc}")

    robustness_path = root / "data/eval/difficulty_robustness_results.json"
    if robustness_path.is_file():
        try:
            payload = json.loads(robustness_path.read_text(encoding="utf-8"))
            summary = payload.get("summary", {})
            total = int(summary.get("total", 0))
            fail_count = int(summary.get("failed", 0))
            checks["difficulty_robustness_case_count"] = total
            checks["difficulty_robustness_fail_count"] = fail_count
            checks["difficulty_robustness_evidence_scope"] = payload.get("evidence_scope")
            if total < 16:
                errors.append(f"difficulty robustness case count below 16: {total}")
            if fail_count:
                errors.append(f"difficulty robustness results contain {fail_count} FAIL cases")
            if payload.get("evidence_scope") != "engineering_robustness_only":
                errors.append("difficulty robustness evidence scope must be engineering_robustness_only")
        except Exception as exc:
            errors.append(f"difficulty_robustness_results.json invalid: {exc}")

    ablation_path = root / "data/eval/ablation/ablation_results.json"
    if ablation_path.is_file():
        try:
            results = json.loads(ablation_path.read_text(encoding="utf-8"))
            modes = {item.get("mode") for item in results}
            checks["ablation_modes"] = sorted(mode for mode in modes if mode)
            required_modes = {
                "direct",
                "rag",
                "rag_audit",
                "rag_audit_debate",
                "full_personalized",
            }
            if not required_modes <= modes:
                errors.append(f"ablation modes incomplete: {sorted(modes)}")
        except Exception as exc:
            errors.append(f"ablation_results.json invalid: {exc}")

    eval_summary_path = root / "data/eval/eval_summary.json"
    if eval_summary_path.is_file():
        try:
            summary = json.loads(eval_summary_path.read_text(encoding="utf-8"))
            checks["eval_golds"] = sorted(summary)
            if "v2" not in summary:
                errors.append("independent gold v2 missing from eval summary")
            else:
                v2 = summary["v2"]
                if v2.get("n", 0) < 50:
                    warnings.append("independent gold v2 has fewer than 50 evaluated cases")
                evidence_tier = v2.get("evidence", {}).get("evidence_tier", "unclassified")
                final_claimable = bool(
                    v2.get("claimability", {}).get("claimable_as_final_accuracy", False)
                )
                checks["v2_evidence_tier"] = evidence_tier
                checks["v2_final_accuracy_claimable"] = final_claimable
                if "calibration_exposed" in evidence_tier and final_claimable:
                    errors.append("calibration-exposed v2 must not be marked as final claimable accuracy")
                if not final_claimable:
                    warnings.append("teacher-labeled unseen holdout is still required for final difficulty accuracy")
        except Exception as exc:
            errors.append(f"eval_summary.json invalid: {exc}")

    if validate_demo and (root / "data/demo_runs/manifest.json").is_file():
        demo_report = validate_demo_runs(root / "data/demo_runs")
        checks["demo"] = demo_report
        if not demo_report["valid"]:
            errors.extend(f"demo: {message}" for message in demo_report["errors"])

    if (root / ".env").exists():
        warnings.append("local .env exists; ensure it is excluded from the submission archive")
    if (root / "server.log").exists() or (root / "server.err.log").exists():
        warnings.append("local server logs exist; exclude them from the final archive")

    return {
        "valid": not missing and not errors,
        "root": str(root),
        "missing": missing,
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
    }
