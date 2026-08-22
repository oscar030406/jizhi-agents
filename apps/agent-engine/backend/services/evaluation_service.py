from __future__ import annotations

from backend.schemas.evaluation import E2ECase, EvaluationMetrics
from backend.schemas.learner import LearnerProfile
from backend.schemas.resources import ClaimVerdict, KnowledgeChunk, WorkflowRun


def faithfulness(verdicts: list[ClaimVerdict]) -> float:
    """RAGAS-style faithfulness: supported factual claims / factual claims."""
    if not verdicts:
        return 1.0
    supported = sum(1 for verdict in verdicts if verdict.verdict == "supported")
    return supported / len(verdicts)


def context_precision(ranked_source_ids: list[str], relevant_source_ids: set[str]) -> float:
    """Average precision over ranked retrieved sources using actually cited/matched sources as relevance."""
    if not relevant_source_ids:
        return 1.0
    hits = 0
    precision_sum = 0.0
    for index, source_id in enumerate(ranked_source_ids, start=1):
        if source_id in relevant_source_ids:
            hits += 1
            precision_sum += hits / index
    return precision_sum / max(1, len(relevant_source_ids))


def context_concept_recall(expected_concepts: list[str], chunks: list[KnowledgeChunk]) -> float:
    """Expected concepts covered by retrieved context tags; not a reference-context recall metric."""
    expected = {concept.lower() for concept in expected_concepts}
    if not expected:
        return 1.0
    covered = {
        tag.lower()
        for chunk in chunks
        for tag in chunk.concept_tags
    }
    return len(expected & covered) / len(expected)


def evaluate_run(case: E2ECase, profile: LearnerProfile, run: WorkflowRun) -> EvaluationMetrics:
    target = {concept.lower() for concept in case.expected_concepts}
    actual = {concept.lower() for concept in run.resources.target_concepts}
    concept_coverage = len(target.intersection(actual)) / max(1, len(target))

    citation_coverage = run.audit.citation_coverage
    claim_faithfulness = faithfulness(run.audit.claim_verdicts)
    relevant_sources = set(run.resources.used_sources)
    relevant_sources.update(
        verdict.matched_source_id
        for verdict in run.audit.claim_verdicts
        if verdict.matched_source_id
    )
    ranked_sources = [chunk.source_id for chunk in run.retrieval.retrieved_chunks]
    ranked_context_precision = context_precision(ranked_sources, relevant_sources)
    concept_recall = context_concept_recall(case.expected_concepts, run.retrieval.retrieved_chunks)
    difficulty_match = 1.0 if run.diagnosis.recommended_difficulty == case.expected_difficulty else 0.0
    flags = run.audit.hallucination_risk_flags
    hallucination_risk_flag_rate = 1.0 if flags else 0.0
    hallucination_rate = run.audit.hallucination_rate

    combined_text = " ".join(
        [section.heading for section in run.resources.lecture.sections]
        + [section.body for section in run.resources.lecture.sections]
        + [run.resources.practice_task.scenario, run.resources.practice_task.deliverable]
        + [item.question for item in run.resources.graded_quiz]
        + [item.explanation for item in run.resources.graded_quiz]
    ).lower()
    must_include_ok = all(term.lower() in combined_text for term in case.must_include)
    must_not_include_ok = all(term.lower() not in combined_text for term in case.must_not_include)
    blocked = run.arbitration is not None and run.arbitration.action == "block_pending_human_review"
    workflow_success = 1.0 if run.trace and run.resources.graded_quiz and run.learning_path.learning_path else 0.0
    if not must_include_ok or not must_not_include_ok or blocked:
        workflow_success = 0.0

    return EvaluationMetrics(
        case_id=case.id,
        concept_coverage=round(concept_coverage, 3),
        citation_coverage=round(citation_coverage, 3),
        faithfulness=round(claim_faithfulness, 3),
        context_precision=round(ranked_context_precision, 3),
        context_concept_recall=round(concept_recall, 3),
        difficulty_match=round(difficulty_match, 3),
        hallucination_rate=round(hallucination_rate, 3),
        hallucination_risk_flag_rate=round(hallucination_risk_flag_rate, 3),
        workflow_success=round(workflow_success, 3),
        details={
            "profile": profile.id,
            "difficulty": run.diagnosis.recommended_difficulty,
            "flags": ",".join(flags),
            "claims": f"{run.audit.claims_supported}/{run.audit.claims_total}",
            "debate_rounds": str(len(run.debate)),
            "arbitration": run.arbitration.action if run.arbitration else "",
            "must_include_ok": str(must_include_ok),
            "must_not_include_ok": str(must_not_include_ok),
        },
    )
