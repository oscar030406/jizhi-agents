from backend.orchestration.workflow import workflow
from backend.services.data_loader import get_learner_profile, load_e2e_cases
from backend.services.evaluation_service import evaluate_run
from scripts.run_eval import evidence_claimability, load_gold_metadata


def test_e2e_cases_have_required_size():
    assert len(load_e2e_cases()) >= 20


def test_evaluation_metrics_are_bounded():
    case = load_e2e_cases()[0]
    profile = get_learner_profile(case.learner_profile_id)
    run = workflow.run(profile, learning_goal=case.learning_goal)
    metrics = evaluate_run(case, profile, run)
    assert 0 <= metrics.concept_coverage <= 1
    assert 0 <= metrics.citation_coverage <= 1
    assert 0 <= metrics.workflow_success <= 1


def test_v2_metadata_is_provisional_and_calibration_exposed():
    metadata = load_gold_metadata("v2")

    assert metadata["evidence_tier"] == "independent_seed_calibration_exposed"
    assert metadata["calibration_exposed"] is True
    assert metadata["human_reviewed"] is False


def test_calibration_exposed_gold_cannot_be_claimed_as_final_accuracy():
    status = evidence_claimability(
        load_gold_metadata("v2"),
        generation_mode="deterministic",
        sample_count=60,
        thresholds_met=True,
    )

    assert status["thresholds_met"] is True
    assert status["claimable_as_final_accuracy"] is False
    assert "human holdout" in status["reason"]


def test_feedback_decision_endpoint_logic():
    decision = workflow.decide_feedback(
        feedback={
            "learner_profile_id": "zero_beginner",
            "quiz_score": 0.3,
            "confidence": 2,
            "free_text": "too hard",
        },
        current_difficulty="L2",
    )
    assert decision.decision == "downgrade_explanation"

