from pathlib import Path

from backend.services.ablation_service import (
    ABLATION_MODES,
    run_ablation_case,
    run_ablation_suite,
    write_ablation_results,
)
from backend.services.data_loader import load_e2e_cases


def test_ablation_modes_are_fixed_nine_levels():
    # 九档矩阵（action_guide_v4 §1.1）：三基线 + 验证机制阶梯 + 完整档
    assert ABLATION_MODES == (
        "direct",
        "cot_single",
        "self_consistency",
        "rag",
        "self_refine",
        "rag_audit",
        "rag_audit_debate",
        "hetero_debate",
        "full_personalized",
    )


def test_each_ablation_mode_executes_only_declared_stage_boundary():
    case = load_e2e_cases(gold="v2")[0]
    results = {mode: run_ablation_case(case, mode) for mode in ABLATION_MODES}

    assert results["direct"].stages == ["direct_generation"]
    assert results["rag"].stages == ["diagnosis", "retrieval", "generation"]
    assert results["rag_audit"].stages == ["diagnosis", "retrieval", "generation", "audit"]
    assert results["rag_audit_debate"].stages == [
        "diagnosis",
        "retrieval",
        "generation",
        "audit_loop",
    ]
    assert results["full_personalized"].stages[-1] == "learning_path"
    assert results["direct"].personalized is False
    assert results["rag_audit_debate"].personalized is False
    assert results["full_personalized"].personalized is True
    assert results["full_personalized"].has_learning_path is True
    assert results["rag_audit_debate"].has_learning_path is False


def test_ablation_metrics_are_bounded_and_traceable():
    case = load_e2e_cases(gold="v2")[0]
    result = run_ablation_case(case, "full_personalized")

    for field in (
        "faithfulness",
        "context_precision",
        "context_concept_recall",
        "concept_coverage",
        "citation_coverage",
        "difficulty_match",
        "hallucination_rate",
        "fallback_rate",
    ):
        assert 0 <= getattr(result.metrics, field) <= 1
    assert result.duration_ms >= 0
    assert result.stages
    assert result.executed_agents


def test_ablation_suite_writes_json_csv_and_markdown(tmp_path: Path):
    case = load_e2e_cases(gold="v2")[0]
    results = run_ablation_suite([case], modes=("direct", "full_personalized"))

    write_ablation_results(results, tmp_path)

    assert (tmp_path / "ablation_results.json").exists()
    assert (tmp_path / "ablation_results.csv").exists()
    assert (tmp_path / "ablation_results.md").exists()
    markdown = (tmp_path / "ablation_results.md").read_text(encoding="utf-8")
    assert "direct" in markdown
    assert "full_personalized" in markdown
