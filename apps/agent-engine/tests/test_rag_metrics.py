from backend.schemas.resources import ClaimVerdict, KnowledgeChunk
from backend.services.evaluation_service import (
    context_concept_recall,
    context_precision,
    faithfulness,
)


def test_faithfulness_uses_supported_claim_ratio():
    verdicts = [
        ClaimVerdict(claim="a", verdict="supported", support_score=0.9),
        ClaimVerdict(claim="b", verdict="supported", support_score=0.8),
        ClaimVerdict(claim="c", verdict="unsupported", support_score=0.1),
    ]

    assert faithfulness(verdicts) == 2 / 3


def test_faithfulness_is_one_when_no_fact_claims_exist():
    assert faithfulness([]) == 1.0


def test_context_precision_rewards_early_relevant_sources():
    ranked_source_ids = ["s1", "s2", "s3", "s4"]

    early = context_precision(ranked_source_ids, {"s1", "s3"})
    late = context_precision(ranked_source_ids, {"s2", "s4"})

    assert round(early, 3) == 0.833
    assert round(late, 3) == 0.5
    assert early > late


def test_context_precision_is_one_when_no_relevant_sources_are_required():
    assert context_precision(["s1", "s2"], set()) == 1.0


def test_context_concept_recall_uses_retrieved_chunk_tags():
    chunks = [
        KnowledgeChunk(
            source_id="s1",
            title="one",
            topic="agent",
            difficulty="L1",
            concept_tags=["agent_basics", "tool_calling"],
            section="1",
            content="content",
        ),
        KnowledgeChunk(
            source_id="s2",
            title="two",
            topic="rag",
            difficulty="L2",
            concept_tags=["rag"],
            section="2",
            content="content",
        ),
    ]

    assert context_concept_recall(["agent_basics", "rag", "evaluation"], chunks) == 2 / 3
    assert context_concept_recall([], chunks) == 1.0
