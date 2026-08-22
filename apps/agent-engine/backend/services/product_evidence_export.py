from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from backend.services.demo_run_service import validate_demo_runs


class ProductEvidenceExportError(ValueError):
    """Raised when source evidence is incomplete or not safe to publish."""


def export_product_evidence(
    engine_root: Path,
    product_root: Path,
    *,
    validate_demo: bool = True,
) -> dict[str, Any]:
    engine_root = engine_root.resolve()
    product_root = product_root.resolve()
    source_eval = engine_root / "data/eval/eval_summary.json"
    source_ablation = engine_root / "data/eval/ablation/ablation_results.json"
    source_demo = engine_root / "data/demo_runs"
    source_manifest = source_demo / "manifest.json"

    required = [source_eval, source_ablation, source_manifest]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise ProductEvidenceExportError(f"missing source evidence: {missing}")

    eval_summary = _load_object(source_eval)
    v2 = eval_summary.get("v2")
    if not isinstance(v2, dict):
        raise ProductEvidenceExportError("eval summary has no v2 result")
    evidence = v2.get("evidence")
    claimability = v2.get("claimability")
    if not isinstance(evidence, dict) or not isinstance(claimability, dict):
        raise ProductEvidenceExportError("v2 evidence provenance is missing")
    if claimability.get("claimable_as_final_accuracy") is not False:
        raise ProductEvidenceExportError(
            "calibration-exposed v2 must not be exported as final accuracy"
        )

    demo_manifest = _load_object(source_manifest)
    runs = demo_manifest.get("runs")
    if not isinstance(runs, list) or len(runs) < 4:
        raise ProductEvidenceExportError("demo manifest must contain at least four runs")
    if demo_manifest.get("generation_mode") != "deterministic":
        raise ProductEvidenceExportError(
            "public offline replay currently accepts deterministic snapshots only"
        )

    if validate_demo:
        validation = validate_demo_runs(source_demo)
        if not validation.get("valid"):
            raise ProductEvidenceExportError(
                f"demo validation failed: {validation.get('errors', [])}"
            )
    else:
        validation = {"valid": True, "skipped": True}

    run_files: list[str] = []
    for item in runs:
        if not isinstance(item, dict) or not isinstance(item.get("file"), str):
            raise ProductEvidenceExportError("demo manifest contains an invalid run item")
        filename = item["file"]
        source = source_demo / filename
        if not source.is_file():
            raise ProductEvidenceExportError(f"demo run file is missing: {filename}")
        run_files.append(filename)

    output_root = product_root / "ai-learn-web/public/personalize-evidence"
    output_demo = output_root / "demo"
    output_demo.mkdir(parents=True, exist_ok=True)

    shutil.copy2(source_eval, output_root / "eval_summary.json")
    shutil.copy2(source_ablation, output_root / "ablation_results.json")
    shutil.copy2(source_manifest, output_demo / "manifest.json")
    for filename in run_files:
        shutil.copy2(source_demo / filename, output_demo / filename)

    public_manifest = {
        "schema_version": 1,
        "source_commit": demo_manifest.get("source_commit"),
        "generation_mode": demo_manifest.get("generation_mode"),
        "generated_at": demo_manifest.get("generated_at"),
        "evidence_tier": evidence.get("evidence_tier"),
        "claimable_as_final_accuracy": claimability.get(
            "claimable_as_final_accuracy", False
        ),
        "claim_limit": evidence.get("claim_limit"),
        "demo_run_count": len(run_files),
        "files": {
            "evaluation": "eval_summary.json",
            "ablation": "ablation_results.json",
            "demo_manifest": "demo/manifest.json",
            "demo_runs": [f"demo/{filename}" for filename in run_files],
        },
        "notes": (
            "Static evidence is exported from validated engine snapshots. "
            "Deterministic replay demonstrates mechanism and reproducibility, "
            "not real-LLM teaching quality."
        ),
    }
    (output_root / "manifest.json").write_text(
        json.dumps(public_manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    return {
        "valid": True,
        "output_root": str(output_root),
        "source_commit": public_manifest["source_commit"],
        "generation_mode": public_manifest["generation_mode"],
        "run_count": len(run_files),
        "validation": validation,
    }


def _load_object(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProductEvidenceExportError(f"invalid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProductEvidenceExportError(f"expected JSON object: {path}")
    return payload
