from pathlib import Path

from backend.services.submission_service import verify_submission


def test_submission_verifier_reports_missing_required_files(tmp_path: Path):
    report = verify_submission(tmp_path)

    assert report["valid"] is False
    assert report["missing"]
    assert any("README.md" in item for item in report["missing"])


def test_submission_verifier_accepts_minimal_complete_fixture(tmp_path: Path):
    required_files = [
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
        # 2026-08 仓库整理把这几份挪到了仓库级 docs/，校验器改成按候选组解析
        # （REQUIRED_REPO_FILES）。夹具用组里的首选路径造文件。
        "docs/06-defense/README.md",
        "docs/archive/demo_script.md",
        "docs/archive/2026-07-defense-paused/human_tasks.md",
        "docs/06-defense/deployment.md",
        "docs/05-evidence/test_inventory.md",
    ]
    for relative in required_files:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("placeholder", encoding="utf-8")
    (tmp_path / "data/eval/adversarial_cases.jsonl").write_text(
        "\n".join('{"case_id":"case-%02d"}' % index for index in range(20)) + "\n",
        encoding="utf-8",
    )
    (tmp_path / "data/eval/adversarial_results.json").write_text("[]", encoding="utf-8")
    modes = ["direct", "rag", "rag_audit", "rag_audit_debate", "full_personalized"]
    (tmp_path / "data/eval/ablation/ablation_results.json").write_text(
        __import__("json").dumps([{"mode": mode} for mode in modes]),
        encoding="utf-8",
    )
    (tmp_path / "data/eval/difficulty_robustness_results.json").write_text(
        '{"evidence_scope":"engineering_robustness_only","summary":{"total":18,"passed":18,"failed":0},"results":[]}',
        encoding="utf-8",
    )
    (tmp_path / "data/eval/eval_summary.json").write_text(
        '{"v2":{"n":50,"evidence":{"evidence_tier":"independent_seed_calibration_exposed"},"claimability":{"claimable_as_final_accuracy":false}}}',
        encoding="utf-8",
    )

    report = verify_submission(tmp_path, validate_demo=False)

    assert report["valid"] is True
    assert report["missing"] == []
    assert report["checks"]["difficulty_robustness_fail_count"] == 0
    assert report["checks"]["v2_final_accuracy_claimable"] is False
