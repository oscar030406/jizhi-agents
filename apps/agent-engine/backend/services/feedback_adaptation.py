from __future__ import annotations

from backend.schemas.learner import DiagnosisResult, FeedbackInput, LearnerProfile
from backend.schemas.resources import FeedbackAdaptation, FeedbackDecision, WorkflowRun
from backend.services.personalization_service import build_personalization_blueprint

WEAK_MASTERY_THRESHOLD = 0.65
MAX_FOCUS_CONCEPTS = 3


def adapt_feedback(
    profile: LearnerProfile,
    parent_run: WorkflowRun,
    feedback: FeedbackInput,
    decision: FeedbackDecision,
) -> FeedbackAdaptation:
    """根据可复算规则更新掌握度，并生成下一轮检索与生成约束。"""
    old_mastery = dict(parent_run.diagnosis.mastery_vector)
    focus_concepts = _focus_concepts(parent_run, feedback)
    updated_mastery = dict(old_mastery)

    if feedback.concept_scores:
        for concept in focus_concepts:
            old_value = old_mastery.get(concept, 0.0)
            score = feedback.concept_scores.get(concept, feedback.quiz_score)
            updated_mastery[concept] = _round_score(old_value * 0.7 + score * 0.3)
    else:
        delta = _feedback_delta(feedback)
        for concept in focus_concepts:
            updated_mastery[concept] = _round_score(old_mastery.get(concept, 0.0) + delta)

    mastery_change = {
        concept: round(updated_mastery.get(concept, 0.0) - old_mastery.get(concept, 0.0), 3)
        for concept in focus_concepts
    }
    weak_concepts = [
        concept
        for concept, score in sorted(updated_mastery.items(), key=lambda item: (item[1], item[0]))
        if score < WEAK_MASTERY_THRESHOLD
    ]
    if not weak_concepts and updated_mastery:
        weak_concepts = [min(updated_mastery, key=updated_mastery.get)]

    risks = list(parent_run.diagnosis.learning_risks)
    if decision.decision == "downgrade_explanation":
        risks = list(dict.fromkeys(risks + ["本轮反馈显示基础概念仍需降维解释。"]))
    elif decision.decision == "advance_challenge":
        risks = [risk for risk in risks if "基础" not in risk]

    blueprint = build_personalization_blueprint(
        profile,
        parent_run.learning_goal,
        updated_mastery,
    )
    diagnosis = DiagnosisResult(
        mastery_vector=updated_mastery,
        weak_concepts=weak_concepts[:5],
        recommended_difficulty=decision.updated_difficulty,
        learning_risks=risks,
        diagnosis_summary=(
            f"基于父运行 {parent_run.run_id} 的反馈更新掌握度；"
            f"本轮动作是 {decision.decision}，聚焦 {', '.join(focus_concepts)}。"
        ),
        personalization_blueprint=blueprint,
    )
    generation_instruction = _generation_instruction(decision)
    focus_text = "、".join(focus_concepts)
    retrieval_query = (
        f"{parent_run.learning_goal}；聚焦概念：{focus_text}；"
        f"本轮要求：{generation_instruction}"
    )
    return FeedbackAdaptation(
        diagnosis=diagnosis,
        mastery_change=mastery_change,
        focus_concepts=focus_concepts,
        retrieval_query=retrieval_query,
        generation_instruction=generation_instruction,
    )


def _focus_concepts(parent_run: WorkflowRun, feedback: FeedbackInput) -> list[str]:
    if feedback.concept_scores:
        return list(feedback.concept_scores)[:MAX_FOCUS_CONCEPTS]
    if parent_run.diagnosis.weak_concepts:
        return parent_run.diagnosis.weak_concepts[:MAX_FOCUS_CONCEPTS]
    mastery = parent_run.diagnosis.mastery_vector
    return [concept for concept, _ in sorted(mastery.items(), key=lambda item: (item[1], item[0]))[:2]]


def _feedback_delta(feedback: FeedbackInput) -> float:
    quiz_signal = feedback.quiz_score - 0.5
    confidence_signal = (feedback.confidence - 3) / 10
    return max(-0.18, min(0.18, quiz_signal * 0.3 + confidence_signal))


def _generation_instruction(decision: FeedbackDecision) -> str:
    instructions = {
        "downgrade_explanation": "使用基础解释、类比、分步示例和低门槛聚焦练习",
        "add_practice": "保持当前难度，增加带提示的引导练习与明确验收检查",
        "advance_challenge": "提供综合挑战、工程约束、异常场景和可复算评测",
        "keep_route": "保持当前路线，根据更新后的薄弱概念重排资源和路径",
    }
    return instructions.get(decision.decision, decision.next_action)


def _round_score(value: float) -> float:
    return round(max(0.0, min(1.0, value)), 3)
