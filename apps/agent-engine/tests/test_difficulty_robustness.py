from pathlib import Path

from backend.services.difficulty_robustness_service import (
    DifficultyRobustnessCase,
    evaluate_case,
    load_cases,
    run_suite,
)

ROOT = Path(__file__).resolve().parents[1]


def test_absolute_case_reports_observed_level():
    case = DifficultyRobustnessCase(
        id="abs-1",
        kind="absolute",
        goal="将现有学习助手封装成一个 HTTP 接口",
        expected_difficulty="L2",
        rationale="单组件按步封装，不是端到端生产工程",
    )

    result = evaluate_case(case)

    assert result.passed is True
    assert result.observed == "L2"
    assert result.evidence_scope == "engineering_robustness_only"


def test_relation_case_checks_monotonicity():
    case = DifficultyRobustnessCase(
        id="rel-1",
        kind="relation",
        base_goal="完成 RAG 文档问答 Agent",
        variant_goal="端到端交付带审核、监控和部署的 RAG 问答系统",
        relation="not_lower",
        rationale="增加审核、监控和部署后任务难度不应降低",
    )

    result = evaluate_case(case)

    assert result.passed is True
    assert result.base_observed == "L2"
    assert result.variant_observed == "L4"


def test_relation_case_can_require_strict_decrease():
    case = DifficultyRobustnessCase(
        id="rel-strict",
        kind="relation",
        base_goal="完整交付一个包含检索、审核、监控和上线部署的生产系统",
        variant_goal="移除审核和部署，只做基础文档问答",
        relation="lower",
        rationale="移除生产组合约束后应严格降档",
    )

    result = evaluate_case(case)

    assert result.passed is True
    assert result.base_observed == "L4"
    assert result.variant_observed == "L2"


def test_committed_robustness_suite_is_large_and_passes():
    cases = load_cases(ROOT / "data" / "eval" / "difficulty_robustness_cases.jsonl")
    results = run_suite(cases)

    assert len(cases) >= 16
    assert all(result.passed for result in results)
    assert {case.kind for case in cases} == {"absolute", "relation"}
