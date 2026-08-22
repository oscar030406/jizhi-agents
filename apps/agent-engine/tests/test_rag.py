from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.rag.ingest import load_markdown_chunks
from backend.rag.retriever import DEFAULT_DOC_DIR, get_retriever
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile


def test_sample_knowledge_base_has_required_size():
    chunks = load_markdown_chunks(DEFAULT_DOC_DIR)
    assert len(chunks) >= 20


def test_retriever_returns_sources_for_rag_query():
    result = get_retriever().search("RAG evidence source_id citations", concept_tags=["rag"], top_k=5)
    assert result.retrieved_chunks
    assert result.source_ids
    assert any("rag" in chunk.concept_tags for chunk in result.retrieved_chunks)


def test_retrieved_chunks_include_metadata():
    result = get_retriever().search("tool calling", concept_tags=["tool_calling"], top_k=3)
    chunk = result.retrieved_chunks[0]
    assert chunk.source_id
    assert chunk.title
    assert chunk.difficulty.startswith("L")


def test_retrieval_agent_diversifies_evidence_for_required_skills():
    profile = get_learner_profile("backend_to_agent")
    goal = "搭建可评测并可部署的 Agentic RAG 工作流"
    pretest = estimate_pretest_from_profile(profile, load_pretest_questions())
    diagnosis = LearnerDiagnosisAgent().run(profile, pretest, learning_goal=goal)

    result = KnowledgeRetrievalAgent().run(goal, diagnosis)

    required = {
        skill.concept
        for skill in diagnosis.personalization_blueprint.required_skills
    }
    covered = {
        tag
        for chunk in result.retrieved_chunks
        for tag in chunk.concept_tags
    }
    assert required <= covered
    assert len(result.retrieved_chunks) <= 12
    assert len(result.source_ids) == len(set(result.source_ids))

