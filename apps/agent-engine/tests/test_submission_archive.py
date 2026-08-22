from pathlib import Path

from scripts.build_submission_archive import _is_safe


def test_legacy_data_archive_is_excluded_from_submission():
    assert _is_safe(Path("data/archive/legacy_agentguide_demo_runs/run.json")) is False
    assert _is_safe(Path("ai-service/data/archive/legacy/run.json")) is False


def test_current_evidence_and_archive_documentation_remain_included():
    assert _is_safe(Path("data/demo_runs/manifest.json")) is True
    assert _is_safe(Path("docs/archive_policy.md")) is True
