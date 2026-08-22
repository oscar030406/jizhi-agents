from scripts.run_real_llm_eval import _fallback_status, _summarize


def _row(**overrides):
    row = {
        "success": True,
        "fallback_used": False,
        "fallback_step_rate": 0.0,
        "audit_triggered": False,
        "debate_rounds": 0,
        "blocked": False,
        "duration_ms": 100,
        "faithfulness": 0.9,
        "context_precision": 1.0,
        "context_concept_recall": 1.0,
        "hallucination_rate": 0.0,
        "concept_coverage": 1.0,
        "difficulty_match": 1.0,
        "gateway_attempts": 3,
        "gateway_request_failures": 0,
        "gateway_parse_failures": 0,
        "gateway_total_tokens": 100,
    }
    row.update(overrides)
    return row


def test_deterministic_by_design_steps_are_not_counted_as_fallback():
    fallback_used, fallback_rate, fallback_agents = _fallback_status(
        [
            {"agent": "LearnerDiagnosisAgent", "engine": "llm+deterministic"},
            {"agent": "KnowledgeRetrievalAgent", "engine": "deterministic"},
            {"agent": "ResourceGenerationAgent", "engine": "llm"},
            {"agent": "ContentAuditAgent", "engine": "llm+deterministic"},
            {"agent": "LearningPathPlannerAgent", "engine": "deterministic"},
        ]
    )

    assert fallback_used is False
    assert fallback_rate == 0.0
    assert fallback_agents == []


def test_expected_llm_agent_deterministic_engine_is_fallback():
    fallback_used, fallback_rate, fallback_agents = _fallback_status(
        [
            {"agent": "LearnerDiagnosisAgent", "engine": "llm+deterministic"},
            {"agent": "ResourceGenerationAgent", "engine": "deterministic"},
            {"agent": "ContentAuditAgent", "engine": "llm+deterministic"},
        ]
    )

    assert fallback_used is True
    assert fallback_rate == 1 / 3
    assert fallback_agents == ["ResourceGenerationAgent"]


def test_real_llm_summary_rejects_smoke_sample_for_external_claims():
    summary = _summarize([_row()], {}, routes_incomplete=False)

    assert summary["invalid_for_claims"] is True
    assert any("fewer than 60 runs" in reason for reason in summary["claimability_reasons"])


def test_real_llm_summary_rejects_infra_fallback_but_not_guardrail_reject():
    """口径 v2：护栏拒收（模型答了但违反证据不变量）是护栏在干活，不该判成
    「这轮不可对外声称」；只有调用/解析真挂了才算。旧版把两者压成一个布尔量，
    实测那一轮 5 条 fallback 全是护栏拒收，却被写成 8.3% 的用例 API 挂了。"""
    rows = [_row() for _ in range(60)]
    rows[0] = _row(fallback_used=True, fallback_step_rate=0.4,
                   reject_reason="guardrail_evidence_invariant")
    summary = _summarize(rows, {}, routes_incomplete=False)
    assert summary["guardrail_reject_rate"] > 0
    assert summary["invalid_for_claims"] is False

    rows[1] = _row(fallback_used=True, fallback_step_rate=0.4,
                   reject_reason="llm_call_or_parse_failed")
    summary = _summarize(rows, {}, routes_incomplete=False)
    assert summary["infra_fallback_rate"] > 0
    assert summary["invalid_for_claims"] is True


def test_real_llm_summary_accepts_clean_sixty_run_evaluation():
    summary = _summarize([_row() for _ in range(60)], {}, routes_incomplete=False)

    assert summary["invalid_for_claims"] is False
    assert summary["claimability_reasons"] == []
    # 技术上干净仍然不等于可当最终成绩——证据等级是另一条信号
    assert summary["requires_human_holdout"] is True
