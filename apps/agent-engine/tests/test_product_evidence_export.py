import json
from pathlib import Path

from backend.services.product_evidence_export import export_product_evidence


def test_export_product_evidence_copies_validated_snapshots(tmp_path: Path):
    engine_root = tmp_path / "engine"
    product_root = tmp_path / "product"
    (engine_root / "data/eval/ablation").mkdir(parents=True)
    (engine_root / "data/demo_runs").mkdir(parents=True)

    eval_summary = {
        "v2": {
            "n": 60,
            "difficulty_match": 1.0,
            "evidence": {"evidence_tier": "independent_seed_calibration_exposed"},
            "claimability": {"claimable_as_final_accuracy": False},
        }
    }
    (engine_root / "data/eval/eval_summary.json").write_text(
        json.dumps(eval_summary), encoding="utf-8"
    )
    (engine_root / "data/eval/ablation/ablation_results.json").write_text(
        json.dumps([{"mode": "direct"}, {"mode": "full_personalized"}]),
        encoding="utf-8",
    )
    run_files = []
    for index in range(1, 5):
        name = f"0{index}-run.json"
        run_files.append(name)
        (engine_root / "data/demo_runs" / name).write_text(
            json.dumps({"run_id": f"run-{index}"}), encoding="utf-8"
        )
    manifest = {
        "schema_version": 1,
        "source_commit": "abc123",
        "generation_mode": "deterministic",
        "runs": [
            {"scenario": f"scenario-{index}", "file": name}
            for index, name in enumerate(run_files, start=1)
        ],
    }
    (engine_root / "data/demo_runs/manifest.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )

    report = export_product_evidence(
        engine_root,
        product_root,
        validate_demo=False,
    )

    output = product_root / "ai-learn-web/public/personalize-evidence"
    assert report["valid"] is True
    assert (output / "eval_summary.json").is_file()
    assert (output / "ablation_results.json").is_file()
    assert (output / "demo/manifest.json").is_file()
    assert all((output / "demo" / name).is_file() for name in run_files)
    public_manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
    assert public_manifest["source_commit"] == "abc123"
    assert public_manifest["generation_mode"] == "deterministic"
    assert public_manifest["claimable_as_final_accuracy"] is False
