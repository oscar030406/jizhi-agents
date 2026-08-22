from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile


def test_diagnosis_agent_outputs_weak_concepts():
    profile = get_learner_profile("zero_beginner")
    result = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    assert result.weak_concepts
    assert result.recommended_difficulty == "L1"


def test_retrieval_agent_uses_diagnosis_concepts():
    profile = get_learner_profile("python_no_agent")
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    result = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    assert len(result.retrieved_chunks) >= 3


def test_generation_agent_creates_three_resource_types():
    profile = get_learner_profile("backend_to_agent")
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    retrieval = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    resources = ResourceGenerationAgent().run(profile, profile.learning_goal, diagnosis, retrieval)
    assert resources.lecture.sections
    assert resources.practice_task.steps
    assert resources.graded_quiz
    assert all(section.source_ids for section in resources.lecture.sections)
    assert resources.practice_task.source_ids
    assert all(item.source_ids for item in resources.graded_quiz)


def test_audit_agent_scores_generated_resources():
    profile = get_learner_profile("backend_to_agent")
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    retrieval = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    resources = ResourceGenerationAgent().run(profile, profile.learning_goal, diagnosis, retrieval)
    audit = ContentAuditAgent().run(resources, diagnosis, retrieval)
    assert 0 <= audit.factuality_score <= 1
    assert 0 <= audit.citation_coverage <= 1
