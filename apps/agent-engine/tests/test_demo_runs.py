from pathlib import Path

from backend.services.demo_run_service import build_demo_runs, validate_demo_runs


def test_build_demo_runs_creates_four_verified_scenarios(tmp_path: Path):
    manifest = build_demo_runs(tmp_path, generation_mode="deterministic")

    assert manifest["generation_mode"] == "deterministic"
    assert len(manifest["runs"]) == 4
    scenarios = {item["scenario"] for item in manifest["runs"]}
    assert scenarios == {
        "beginner_initial",
        "engineer_initial",
        "low_score_followup",
        "high_score_followup",
    }
    assert (tmp_path / "manifest.json").exists()
    for item in manifest["runs"]:
        assert (tmp_path / item["file"]).exists()
        assert item["engines"]
        assert item["factuality_score"] >= 0


def test_validate_demo_runs_checks_parent_links_and_schema(tmp_path: Path):
    build_demo_runs(tmp_path, generation_mode="deterministic")

    report = validate_demo_runs(tmp_path)

    assert report["valid"] is True
    assert report["run_count"] == 4
    assert report["followup_count"] == 2
    assert report["errors"] == []


def test_validate_demo_runs_fails_when_manifest_file_is_missing(tmp_path: Path):
    build_demo_runs(tmp_path, generation_mode="deterministic")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.unlink()

    report = validate_demo_runs(tmp_path)

    assert report["valid"] is False
    assert report["errors"]
