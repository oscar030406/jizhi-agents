from types import SimpleNamespace

import pytest

from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.api import routes
from backend.orchestration.workflow import AgentTrainingWorkflow
from backend.schemas.learner import FeedbackInput, LearnerProfile, PretestResult
from backend.schemas.resources import FeedbackDecision, WorkflowRun
from backend.services.data_loader import get_learner_profile
from backend.services.feedback_adaptation import _feedback_delta, adapt_feedback


class _DisabledGateway:
    def is_enabled(self, _agent: str) -> bool:
        return False


def test_feedback_decision_changes_difficulty_by_at_most_one_level():
    workflow = AgentTrainingWorkflow()

    low = workflow.decide_feedback(
        FeedbackInput(
            learner_profile_id="backend_to_agent",
            quiz_score=0.2,
            confidence=1,
        ),
        current_difficulty="L4",
    )
    high = workflow.decide_feedback(
        FeedbackInput(
            learner_profile_id="zero_beginner",
            quiz_score=0.95,
            confidence=5,
        ),
        current_difficulty="L1",
    )

    assert low.updated_difficulty == "L3"
    assert high.updated_difficulty == "L2"


def test_workflow_run_new_feedback_fields_keep_old_json_compatible():
    profile = get_learner_profile("zero_beginner")
    original = AgentTrainingWorkflow().run(profile)
    old_payload = original.model_dump(mode="json")
    old_payload.pop("parent_run_id", None)
    old_payload.pop("feedback_decision", None)
    old_payload.pop("mastery_change", None)
    old_payload.pop("generation_reason", None)

    restored = WorkflowRun.model_validate(old_payload)

    assert restored.parent_run_id is None
    assert restored.feedback_decision is None
    assert restored.mastery_change == {}
    assert restored.generation_reason == "initial"


def test_followup_creates_new_run_and_recomputes_resources_from_feedback():
    workflow = AgentTrainingWorkflow()
    profile = get_learner_profile("backend_to_agent")
    parent = workflow.run(profile, learning_goal="掌握 Agentic RAG 工程闭环")
    feedback = FeedbackInput(
        learner_profile_id=profile.id,
        quiz_score=0.25,
        confidence=2,
        free_text="检索和审核仍然混淆",
        concept_scores={"rag": 0.2, "guardrails": 0.3},
    )

    followup = workflow.run_followup(profile, parent, feedback)

    assert followup.run_id != parent.run_id
    assert followup.parent_run_id == parent.run_id
    assert followup.generation_reason == "feedback_followup"
    assert followup.feedback_decision is not None
    assert followup.feedback_decision.decision == "downgrade_explanation"
    assert followup.trace[0].agent == "FeedbackDecisionAgent"
    assert followup.mastery_change
    assert followup.resources != parent.resources
    assert followup.learning_path
    assert followup.audit


def test_followup_rejects_same_account_after_switching_corpus():
    workflow = AgentTrainingWorkflow()
    profile = get_learner_profile("backend_to_agent")
    parent = workflow.run(profile, learning_goal="掌握 Agentic RAG 工程闭环")
    switched = profile.model_copy(update={"corpus": "smart-manufacturing"})
    feedback = FeedbackInput(
        learner_profile_id=profile.id,
        quiz_score=0.6,
    )

    with pytest.raises(ValueError, match="corpus does not match"):
        workflow.run_followup(switched, parent, feedback)


def test_followup_api_loads_parent_and_records_child(monkeypatch):
    workflow = AgentTrainingWorkflow()
    profile = get_learner_profile("zero_beginner")
    parent = workflow.run(profile, learning_goal="理解 Agent 基础")
    recorded = []
    monkeypatch.setattr(routes, "load_run_detail", lambda run_id: parent if run_id == parent.run_id else None)
    monkeypatch.setattr(routes, "record_workflow_run", recorded.append)

    child = routes.followup_workflow(
        routes.WorkflowFollowupRequest(
            parent_run_id=parent.run_id,
            feedback=FeedbackInput(
                learner_profile_id=profile.id,
                quiz_score=0.6,
                confidence=3,
            ),
        )
    )

    assert child.parent_run_id == parent.run_id
    assert recorded == [child]


def test_high_score_followup_increases_focus_mastery_and_advances_one_level():
    workflow = AgentTrainingWorkflow()
    profile = get_learner_profile("zero_beginner")
    parent = workflow.run(profile, learning_goal="理解 Agent 基础与工具调用")
    focus = parent.diagnosis.weak_concepts[0]
    old_mastery = parent.diagnosis.mastery_vector[focus]
    feedback = FeedbackInput(
        learner_profile_id=profile.id,
        quiz_score=0.95,
        confidence=5,
        concept_scores={focus: 0.95},
    )

    followup = workflow.run_followup(profile, parent, feedback)

    old_level = int(parent.diagnosis.recommended_difficulty[1])
    new_level = int(followup.diagnosis.recommended_difficulty[1])
    assert new_level - old_level in {0, 1}
    assert followup.diagnosis.mastery_vector[focus] > old_mastery
    assert followup.mastery_change[focus] > 0


def test_external_followup_rejects_out_of_domain_concept_scores():
    profile = LearnerProfile(
        id="mfg-followup",
        name="智造学员",
        background="自动化专业",
        programming_level=2,
        python_level=1,
        agent_level=0,
        rag_level=0,
        engineering_level=2,
        learning_goal="ROS2 与 S7-1200 PLC 协同控制",
        time_budget_hours=24,
        learning_preference="实操",
        corpus="smart-manufacturing",
    )
    diagnosis = LearnerDiagnosisAgent(gateway=_DisabledGateway()).run(
        profile,
        PretestResult(
            learner_profile_id=profile.id,
            concept_scores={"S7 连接配置": 0.2},
        ),
    )
    parent = SimpleNamespace(
        run_id="parent",
        learning_goal=profile.learning_goal,
        diagnosis=diagnosis,
    )
    feedback = FeedbackInput(
        learner_profile_id=profile.id,
        quiz_score=0.4,
        concept_scores={"rag": 0.1},
    )
    decision = FeedbackDecision(
        feedback_type="quiz",
        decision="keep_route",
        updated_difficulty="L1",
        next_action="保持路线",
        explanation="测试",
    )

    with pytest.raises(ValueError, match="不属于当前领域"):
        adapt_feedback(profile, parent, feedback, decision)


def test_feedback_coverage_keeps_all_blueprint_required_skills_unmeasured():
    profile = LearnerProfile(
        id="mfg-coverage",
        name="智造学员",
        background="自动化专业",
        programming_level=2,
        python_level=1,
        agent_level=0,
        rag_level=0,
        engineering_level=2,
        learning_goal="ROS2 与 S7-1200 PLC 协同控制",
        time_budget_hours=24,
        learning_preference="实操",
        corpus="smart-manufacturing",
    )
    diagnosis = LearnerDiagnosisAgent(gateway=_DisabledGateway()).run(
        profile,
        PretestResult(learner_profile_id=profile.id, concept_scores={}),
    )
    assert diagnosis.personalization_blueprint is not None
    required = {
        skill.concept for skill in diagnosis.personalization_blueprint.required_skills
    }
    assert required
    diagnosis = diagnosis.model_copy(
        update={"mastery_vector": {}, "weak_concepts": [], "unmeasured_concepts": []}
    )
    parent = SimpleNamespace(
        run_id="parent-coverage",
        learning_goal=profile.learning_goal,
        diagnosis=diagnosis,
    )
    feedback = FeedbackInput(learner_profile_id=profile.id, quiz_score=0.5)
    decision = FeedbackDecision(
        feedback_type="quiz",
        decision="keep_route",
        updated_difficulty="L1",
        next_action="保持路线",
        explanation="测试",
    )

    adapted = adapt_feedback(profile, parent, feedback, decision)

    assert set(adapted.diagnosis.unmeasured_concepts) == required
    assert adapted.diagnosis.coverage.total_concepts == len(required)
    assert adapted.diagnosis.coverage.measured_concepts == 0


def test_feedback_without_confidence_has_neutral_confidence_signal():
    feedback = FeedbackInput(learner_profile_id="x", quiz_score=0.5)

    assert _feedback_delta(feedback) == 0.0
