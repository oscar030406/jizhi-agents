from __future__ import annotations

import pytest

from backend.agents import knowledge_retrieval_agent as retrieval_module
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.integration import personalize_service
from backend.integration.personalize_service import evidence_retrieve_api
from backend.schemas.learner import LearnerProfile, PretestResult
from backend.schemas.resources import KnowledgeChunk, RetrievalResult
from backend.services.domain_path import build_domain_path


CORPUS = "smart-manufacturing"
AI_CORE = {
    "deep_learning",
    "llm_basics",
    "agent_basics",
    "rag",
    "evaluation",
    "tool_calling",
    "langgraph",
}


class _DisabledGateway:
    def is_enabled(self, _agent: str) -> bool:
        return False


class _EmptyRetriever:
    def search(self, *_args, **_kwargs) -> RetrievalResult:
        return RetrievalResult(
            retrieved_chunks=[],
            source_ids=[],
            evidence_summary="",
            missing_evidence_warning="没有命中",
        )


def _external_diagnosis():
    profile = LearnerProfile(
        id="mfg-learner",
        name="智造学员",
        background="自动化专业",
        programming_level=2,
        python_level=1,
        agent_level=0,
        rag_level=0,
        engineering_level=2,
        learning_goal="ROS2 与 S7-1200 PLC 协同控制",
        time_budget_hours=24,
        learning_preference="实操优先",
        corpus=CORPUS,
    )
    diagnosis = LearnerDiagnosisAgent(gateway=_DisabledGateway()).run(
        profile,
        PretestResult(
            learner_profile_id=profile.id,
            concept_scores={"S7 连接配置": 0.2},
        ),
    )
    return profile, diagnosis


def _path_concepts() -> set[str]:
    path = build_domain_path(CORPUS)
    return {
        concept["id"]
        for stage in path["stages"]
        for concept in stage["concepts"]
    }


def test_empty_external_mastery_is_unmeasured_not_weak(monkeypatch) -> None:
    monkeypatch.setattr(personalize_service, "_bridge_gateway", lambda: _DisabledGateway())

    got = personalize_service.learner_blueprint_api(
        learning_goal="ROS2 与 S7-1200 PLC 协同控制",
        corpus=CORPUS,
        concept_mastery={},
    )
    path_concepts = _path_concepts()

    assert got["mastery_vector"] == {}
    assert got["weak_concepts"] == []
    assert set(got["unmeasured_concepts"]) == path_concepts
    assert got["coverage"] == {
        "corpus": CORPUS,
        "total_concepts": len(path_concepts),
        "measured_concepts": 0,
        "ratio": 0.0,
        "out_of_domain_concepts": [],
    }
    assert "尚无" in got["diagnosis_summary"]
    assert not (set(got["unmeasured_concepts"]) & AI_CORE)


def test_smart_manufacturing_diagnosis_and_blueprint_share_path_concepts(monkeypatch) -> None:
    monkeypatch.setattr(personalize_service, "_bridge_gateway", lambda: _DisabledGateway())

    got = personalize_service.learner_blueprint_api(
        learning_goal="ROS2 与 S7-1200 PLC 协同控制",
        corpus=CORPUS,
        concept_mastery={"S7 连接配置": 0.2},
    )
    path_concepts = _path_concepts()
    blueprint = got["blueprint"]
    required = {skill["concept"] for skill in blueprint["required_skills"]}
    diagnosis_concepts = set(got["weak_concepts"]) | set(got["unmeasured_concepts"])

    assert blueprint["corpus"] == CORPUS
    assert blueprint["goal_mapping_status"] == "mapped"
    assert required
    assert required <= path_concepts
    assert diagnosis_concepts == path_concepts
    assert set(got["weak_concepts"]) == {"S7 连接配置"}
    assert not ((required | diagnosis_concepts) & AI_CORE)


def test_unmapped_external_goal_returns_empty_skills_without_ai_fallback(monkeypatch) -> None:
    monkeypatch.setattr(personalize_service, "_bridge_gateway", lambda: _DisabledGateway())

    got = personalize_service.learner_blueprint_api(
        learning_goal="宋代瓷器烧制工艺",
        corpus=CORPUS,
        concept_mastery={},
    )

    assert got["blueprint"]["goal_mapping_status"] == "unmapped_goal"
    assert got["blueprint"]["required_skills"] == []
    assert got["blueprint"]["skill_gaps"] == []


def test_retrieval_uses_blueprint_corpus_instead_of_default_ai(monkeypatch) -> None:
    _, diagnosis = _external_diagnosis()
    requested: list[str] = []

    def get_retriever(corpus: str):
        requested.append(corpus)
        return _EmptyRetriever()

    monkeypatch.setattr(retrieval_module, "get_corpus_retriever", get_retriever)

    KnowledgeRetrievalAgent().run("ROS2 与 S7-1200 PLC 协同控制", diagnosis)

    assert requested == [CORPUS]


def test_retrieval_rejects_missing_domain_blueprint(monkeypatch) -> None:
    _, diagnosis = _external_diagnosis()
    unresolved = diagnosis.model_copy(update={"personalization_blueprint": None})
    monkeypatch.setattr(
        retrieval_module,
        "get_corpus_retriever",
        lambda _corpus: pytest.fail("未裁决蓝图不应开始检索"),
    )

    with pytest.raises(RuntimeError, match="尚未映射"):
        KnowledgeRetrievalAgent().run("ROS2 与 S7-1200 PLC 协同控制", unresolved)


def test_generation_prompt_keeps_ai_axes_only_for_main_corpus() -> None:
    from fake_gateway import extract_source_ids, generation_payload

    class CaptureGateway:
        def __init__(self) -> None:
            self.user = ""

        def is_enabled(self, _agent: str) -> bool:
            return True

        def structured_chat(self, _agent, _system, user, **_kwargs):
            self.user = user
            return generation_payload(extract_source_ids(user), seed_text=user)

    def retrieval(concept: str) -> RetrievalResult:
        chunk = KnowledgeChunk(
            source_id=f"test#{concept}",
            title=concept,
            topic="测试",
            difficulty="L2",
            concept_tags=[concept],
            section="1",
            content=f"{concept} 的教学证据。",
        )
        return RetrievalResult(
            retrieved_chunks=[chunk],
            source_ids=[chunk.source_id],
            evidence_summary="测试证据",
        )

    from backend.services.data_loader import get_learner_profile
    from backend.services.quiz_service import estimate_pretest_from_profile

    main_profile = get_learner_profile("python_no_agent")
    main_diagnosis = LearnerDiagnosisAgent(gateway=_DisabledGateway()).run(
        main_profile,
        estimate_pretest_from_profile(main_profile, []),
        main_profile.learning_goal,
    )
    main_gateway = CaptureGateway()
    ResourceGenerationAgent(gateway=main_gateway).run(
        main_profile,
        main_profile.learning_goal,
        main_diagnosis,
        retrieval(main_diagnosis.personalization_blueprint.required_skills[0].concept),
    )
    assert "编程 " in main_gateway.user and "Agent " in main_gateway.user and "RAG " in main_gateway.user

    external_profile, external_diagnosis = _external_diagnosis()
    external_gateway = CaptureGateway()
    ResourceGenerationAgent(gateway=external_gateway).run(
        external_profile,
        external_profile.learning_goal,
        external_diagnosis,
        retrieval(external_diagnosis.personalization_blueprint.required_skills[0].concept),
    )
    prompt = external_gateway.user
    assert "领域：smart-manufacturing" in prompt
    assert "领域掌握度" in prompt and "测量覆盖" in prompt and "个性化蓝图" in prompt
    assert "编程 " not in prompt and "Agent " not in prompt and "RAG " not in prompt


def test_external_fringe_skips_mastered_concepts_with_its_own_graph(monkeypatch) -> None:
    chunks = [
        KnowledgeChunk(
            source_id="mfg#s7",
            title="S7 已掌握",
            topic="制造",
            difficulty="L2",
            concept_tags=["S7 连接配置"],
            section="1",
            content="S7 内容",
        ),
        KnowledgeChunk(
            source_id="mfg#ros",
            title="ROS2 待学习",
            topic="制造",
            difficulty="L2",
            concept_tags=["ROS2通信机制"],
            section="2",
            content="ROS2 内容",
        ),
    ]

    class _Retriever:
        def search(self, *_args, **_kwargs) -> RetrievalResult:
            return RetrievalResult(
                retrieved_chunks=chunks,
                source_ids=[chunk.source_id for chunk in chunks],
                evidence_summary="",
            )

    from backend.rag import retriever

    monkeypatch.setattr(retriever, "get_corpus_retriever", lambda _corpus: _Retriever())
    got = evidence_retrieve_api(
        "ROS2 与 S7-1200 PLC 协同控制",
        corpus=CORPUS,
        mastery='{"S7 连接配置": 0.95, "ROS2通信机制": 0.2}',
    )

    assert [chunk["source_id"] for chunk in got["chunks"]] == ["mfg#ros"]
    assert [chunk["source_id"] for chunk in got["skipped"]] == ["mfg#s7"]
