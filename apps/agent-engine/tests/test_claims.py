from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.rag.claims import claim_statistics, extract_claims, verify_claims
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile


def _build_run_parts(profile_id: str = "python_no_agent"):
    profile = get_learner_profile(profile_id)
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    retrieval = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    resources = ResourceGenerationAgent().run(profile, profile.learning_goal, diagnosis, retrieval)
    return profile, diagnosis, retrieval, resources


def test_extract_claims_carry_source_ids():
    _, _, _, resources = _build_run_parts()
    claims = extract_claims(resources)
    assert claims
    assert all(source_ids for _, source_ids in claims)


def test_fabricated_citation_is_unsupported():
    _, _, retrieval, _ = _build_run_parts()
    verdicts = verify_claims([("量子计算可以彻底消除大模型幻觉", ["kb999"])], retrieval.retrieved_chunks)
    assert verdicts[0].verdict == "unsupported"
    stats = claim_statistics(verdicts)
    assert stats["hallucination_rate"] == 1.0


def test_evidence_quoting_claim_is_supported():
    _, _, retrieval, _ = _build_run_parts()
    chunk = retrieval.retrieved_chunks[0]
    verdicts = verify_claims([(chunk.content, [chunk.source_id])], retrieval.retrieved_chunks)
    assert verdicts[0].verdict == "supported"


def test_audit_reports_claim_level_metrics():
    _, diagnosis, retrieval, resources = _build_run_parts()
    audit = ContentAuditAgent().run(resources, diagnosis, retrieval)
    assert audit.claims_total > 0
    assert 0.0 <= audit.hallucination_rate <= 1.0
    assert len(audit.claim_verdicts) == audit.claims_total


def test_generation_populates_evidence_plan():
    _, _, retrieval, resources = _build_run_parts()
    plan = resources.evidence_plan
    assert plan is not None
    assert plan.planned_source_ids
    assert all(sid in set(retrieval.source_ids) for sid in plan.planned_source_ids)
    assert plan.constraint_restatement


def test_audit_emits_challenges_and_should_continue():
    _, diagnosis, retrieval, resources = _build_run_parts()
    for section in resources.lecture.sections:
        section.source_ids = []
    resources.practice_task.source_ids = []
    for item in resources.graded_quiz:
        item.source_ids = []
    audit = ContentAuditAgent().run(resources, diagnosis, retrieval)
    assert audit.should_continue == audit.revision_required
    assert audit.revision_required
    assert audit.challenges  # 无据声明应被列成质疑清单


def test_audit_flags_stripped_citations():
    _, diagnosis, retrieval, resources = _build_run_parts()
    for section in resources.lecture.sections:
        section.source_ids = []
    resources.practice_task.source_ids = []
    for item in resources.graded_quiz:
        item.source_ids = []
    audit = ContentAuditAgent().run(resources, diagnosis, retrieval)
    assert audit.revision_required
    assert "low_citation_coverage" in audit.hallucination_risk_flags
    assert audit.hallucination_rate > 0.05
