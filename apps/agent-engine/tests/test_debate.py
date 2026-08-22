from backend.agents.arbitration_agent import ArbitrationAgent
from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.orchestration.workflow import workflow
from backend.schemas.resources import AuditResult, DebateRound
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile


def test_revision_answers_auditor_objections():
    profile = get_learner_profile("backend_to_agent")
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    retrieval = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    generation = ResourceGenerationAgent()
    audit_agent = ContentAuditAgent()

    resources = generation.run(profile, profile.learning_goal, diagnosis, retrieval)
    for section in resources.lecture.sections:
        section.source_ids = []
    first_audit = audit_agent.run(resources, diagnosis, retrieval)
    assert first_audit.revision_required

    revised, action, note = generation.revise(resources, first_audit, retrieval, diagnosis)
    assert action
    assert note
    second_audit = audit_agent.run(revised, diagnosis, retrieval)
    assert second_audit.citation_coverage >= first_audit.citation_coverage
    assert second_audit.factuality_score >= first_audit.factuality_score


def test_arbitration_publishes_above_floor():
    audit = AuditResult(
        factuality_score=0.7,
        citation_coverage=0.8,
        difficulty_match=1.0,
        concept_coverage=0.8,
        revision_required=True,
        hallucination_rate=0.04,
    )
    decision = ArbitrationAgent().run(audit, [DebateRound(round_index=1)])
    assert decision.action == "publish_with_warnings"


def test_arbitration_blocks_below_floor():
    audit = AuditResult(
        factuality_score=0.4,
        citation_coverage=0.2,
        difficulty_match=1.0,
        concept_coverage=0.3,
        revision_required=True,
        hallucination_rate=0.5,
    )
    decision = ArbitrationAgent().run(audit, [])
    assert decision.action == "block_pending_human_review"
    assert "人工审核" in decision.rationale


def test_workflow_exposes_debate_and_engine_labels():
    profile = get_learner_profile("competition_sprint")
    run = workflow.run(profile)
    assert isinstance(run.debate, list)
    assert run.audit.claims_total > 0
    assert run.resources.evidence_plan is not None
    for step in run.trace:
        assert step.artifacts.get("engine")
    if run.audit.revision_required:
        assert run.arbitration is not None
    # 若发生辩论，回合应携带审核质疑清单供可视化
    for round_record in run.debate:
        assert isinstance(round_record.auditor_challenges, list)
