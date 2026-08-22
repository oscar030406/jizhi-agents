from backend.orchestration.workflow import AgentTrainingWorkflow
from backend.schemas.learner import DiagnosisResult
from backend.schemas.resources import (
    AuditResult,
    ClaimVerdict,
    LearningResources,
)
from backend.services.data_loader import get_learner_profile
from backend.services.personalization_service import build_personalization_blueprint
from backend.services.claim_dispute_service import build_claim_disputes


def test_same_goal_maps_to_same_required_skills_but_different_gaps():
    goal = "搭建可评测的 Agentic RAG 工作流"
    beginner = get_learner_profile("zero_beginner")
    senior = get_learner_profile("backend_to_agent")
    beginner_run = AgentTrainingWorkflow().run(beginner, learning_goal=goal)
    senior_run = AgentTrainingWorkflow().run(senior, learning_goal=goal)

    beginner_blueprint = beginner_run.diagnosis.personalization_blueprint
    senior_blueprint = senior_run.diagnosis.personalization_blueprint

    assert beginner_blueprint is not None
    assert senior_blueprint is not None
    assert [item.concept for item in beginner_blueprint.required_skills] == [
        item.concept for item in senior_blueprint.required_skills
    ]
    assert beginner_blueprint.learner_type == "guided_beginner"
    assert senior_blueprint.learner_type in {"practice_builder", "systems_engineer"}
    assert sum(item.gap for item in beginner_blueprint.skill_gaps) > sum(
        item.gap for item in senior_blueprint.skill_gaps
    )


def test_resource_mix_varies_by_base_axis_and_preference_axis():
    goal = "搭建可评测的 Agentic RAG 工作流"
    beginner = get_learner_profile("zero_beginner")
    senior = get_learner_profile("backend_to_agent")
    beginner_mix = AgentTrainingWorkflow().run(
        beginner, learning_goal=goal).diagnosis.personalization_blueprint.resource_mix
    senior_mix = AgentTrainingWorkflow().run(
        senior, learning_goal=goal).diagnosis.personalization_blueprint.resource_mix

    assert beginner_mix is not None and senior_mix is not None
    # 基础轴：低基础完整支架，高基础删冗余
    assert beginner_mix.scaffold_level == "full"
    assert senior_mix.scaffold_level in {"faded", "minimal"}
    assert beginner_mix.section_length_band != senior_mix.section_length_band
    # 底线配额：可视化与代码人人 >= 1，偏好只加码不清零
    for mix in (beginner_mix, senior_mix):
        assert mix.visual_widget_count >= 1
        assert mix.diagram_count >= 1
        assert mix.code_example_count >= 1
        assert mix.rationale  # because 链非空：每项配比可指回画像维度
    # 背景轴：后端转型者的类比域取自本行
    assert "后端" in senior_mix.analogy_domain


def test_resource_mix_preference_changes_ratio_only():
    from backend.services.personalization_service import _resource_mix

    base = get_learner_profile("zero_beginner")
    visual = base.model_copy(update={"learning_preference": "图解与结构图优先、原理先行"})
    coder = base.model_copy(update={"learning_preference": "可运行代码示例优先、实操任务驱动"})
    visual_mix = _resource_mix(visual, "guided_beginner")
    coder_mix = _resource_mix(coder, "guided_beginner")

    # 偏好轴只调配比：visual 偏好教具/图示更多，code 偏好代码例更多
    assert visual_mix.visual_widget_count > coder_mix.visual_widget_count
    assert coder_mix.code_example_count > visual_mix.code_example_count
    # 偏好不改基础轴产物（支架/篇幅/难度带一致）
    assert visual_mix.scaffold_level == coder_mix.scaffold_level
    assert visual_mix.section_length_band == coder_mix.section_length_band
    assert visual_mix.quiz_difficulty_band == coder_mix.quiz_difficulty_band


def test_old_diagnosis_json_remains_compatible_without_blueprint():
    payload = {
        "mastery_vector": {"rag": 0.2},
        "weak_concepts": ["rag"],
        "recommended_difficulty": "L1",
        "learning_risks": [],
        "diagnosis_summary": "old",
    }

    diagnosis = DiagnosisResult.model_validate(payload)

    assert diagnosis.personalization_blueprint is None


def test_resource_structure_changes_by_learner_type_for_same_goal():
    workflow = AgentTrainingWorkflow()
    goal = "搭建可评测的 Agentic RAG 工作流"
    beginner = workflow.run(get_learner_profile("zero_beginner"), learning_goal=goal)
    senior = workflow.run(get_learner_profile("backend_to_agent"), learning_goal=goal)

    beginner_headings = [section.heading for section in beginner.resources.lecture.sections]
    senior_headings = [section.heading for section in senior.resources.lecture.sections]

    assert beginner.resources.personalization_blueprint is not None
    assert senior.resources.personalization_blueprint is not None
    assert beginner_headings != senior_headings
    assert any("类比" in heading or "分步" in heading for heading in beginner_headings)
    assert any("契约" in heading or "失败模式" in heading for heading in senior_headings)
    assert beginner.resources.practice_task.steps != senior.resources.practice_task.steps
    assert beginner.resources.practice_task.acceptance_checks != senior.resources.practice_task.acceptance_checks


def test_build_claim_disputes_only_from_real_disputed_claims():
    before = _resources_with_body("Agent 一定能够完全消除幻觉。")
    after = _resources_with_body("在给定证据覆盖范围内，审核流程可以降低幻觉风险。")
    objection = AuditResult(
        factuality_score=0.4,
        citation_coverage=0.5,
        difficulty_match=1.0,
        concept_coverage=1.0,
        hallucination_risk_flags=["unsupported_claim"],
        revision_required=True,
        claims_total=1,
        claims_supported=0,
        hallucination_rate=1.0,
        claim_verdicts=[
            ClaimVerdict(
                claim="Agent 一定能够完全消除幻觉。",
                source_ids=["ha01#s1"],
                verdict="unsupported",
                support_score=0.1,
            )
        ],
        challenges=["绝对化结论缺少证据"],
        should_continue=True,
    )
    re_audit = objection.model_copy(
        update={
            "factuality_score": 0.9,
            "revision_required": False,
            "claims_supported": 1,
            "hallucination_rate": 0.0,
            "claim_verdicts": [
                ClaimVerdict(
                    claim="在给定证据覆盖范围内，审核流程可以降低幻觉风险。",
                    source_ids=["ha01#s1"],
                    verdict="supported",
                    support_score=0.9,
                    matched_source_id="ha01#s1",
                )
            ],
            "should_continue": False,
        }
    )

    disputes, revision_diff = build_claim_disputes(before, after, objection, re_audit)

    assert len(disputes) == 1
    dispute = disputes[0]
    assert dispute.claim == "Agent 一定能够完全消除幻觉。"
    assert dispute.cited_evidence == ["ha01#s1"]
    assert dispute.revised_claim == "在给定证据覆盖范围内，审核流程可以降低幻觉风险。"
    assert dispute.judge_decision == "supported"
    assert dispute.confidence == 0.9
    assert "完全消除" in revision_diff
    assert "降低幻觉风险" in revision_diff


def test_no_disputed_claims_produce_no_claim_disputes():
    resources = _resources_with_body("有证据支持的陈述。")
    audit = AuditResult(
        factuality_score=1.0,
        citation_coverage=1.0,
        difficulty_match=1.0,
        concept_coverage=1.0,
        revision_required=False,
        claims_total=1,
        claims_supported=1,
        hallucination_rate=0.0,
        claim_verdicts=[
            ClaimVerdict(
                claim="有证据支持的陈述。",
                source_ids=["ha01#s1"],
                verdict="supported",
                support_score=1.0,
            )
        ],
    )

    disputes, revision_diff = build_claim_disputes(resources, resources, audit, audit)

    assert disputes == []
    assert revision_diff == ""


def _resources_with_body(body: str) -> LearningResources:
    return LearningResources.model_validate(
        {
            "lecture": {
                "title": "test",
                "sections": [{"heading": "claim", "body": body, "source_ids": ["ha01#s1"]}],
            },
            "practice_task": {
                "title": "task",
                "scenario": "scenario",
                "steps": ["step"],
                "deliverable": "deliverable",
                "acceptance_checks": ["check"],
                "difficulty": "L2",
                "source_ids": ["ha01#s1"],
            },
            "graded_quiz": [],
            "used_sources": ["ha01#s1"],
            "target_concepts": ["rag"],
        }
    )
