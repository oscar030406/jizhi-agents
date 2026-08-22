from __future__ import annotations

from collections import defaultdict
from typing import Iterable, List

from backend.schemas.learner import LearnerProfile, PretestAnswer, PretestQuestion, PretestResult


def select_pretest_questions(questions: List[PretestQuestion], learning_goal: str, limit: int = 10) -> List[PretestQuestion]:
    goal_lower = learning_goal.lower()
    scored = []
    for question in questions:
        joined_tags = " ".join(question.concept_tags).lower()
        score = sum(1 for token in goal_lower.split() if token in joined_tags or token in question.question.lower())
        scored.append((score, question))
    scored.sort(key=lambda item: (item[0], item[1].difficulty), reverse=True)
    selected = [question for _, question in scored[:limit]]
    return selected or questions[:limit]


def score_pretest(profile_id: str, questions: Iterable[PretestQuestion], answers: Iterable[PretestAnswer]) -> PretestResult:
    question_by_id = {question.id: question for question in questions}
    answer_by_id = {answer.question_id: answer.selected for answer in answers}
    total = 0
    correct = 0
    concept_totals: dict[str, int] = defaultdict(int)
    concept_correct: dict[str, int] = defaultdict(int)
    for qid, question in question_by_id.items():
        if qid not in answer_by_id:
            continue
        total += 1
        is_correct = answer_by_id[qid] == question.answer
        correct += int(is_correct)
        for concept in question.concept_tags:
            concept_totals[concept] += 1
            concept_correct[concept] += int(is_correct)
    score = correct / total if total else 0.0
    concept_scores = {
        concept: round(concept_correct[concept] / count, 3)
        for concept, count in concept_totals.items()
        if count
    }
    return PretestResult(learner_profile_id=profile_id, answers=list(answers), score=round(score, 3), concept_scores=concept_scores)


def estimate_pretest_from_profile(profile: LearnerProfile, questions: List[PretestQuestion]) -> PretestResult:
    concept_scores = {
        "agent_basics": profile.agent_level / 4,
        "rag": profile.rag_level / 4,
        "tool_calling": max(profile.agent_level, profile.python_level) / 4,
        "langgraph": min(profile.agent_level, profile.engineering_level) / 4,
        "evaluation": min(profile.engineering_level, profile.rag_level + 1) / 4,
        "deployment": profile.engineering_level / 4,
    }
    avg = sum(concept_scores.values()) / len(concept_scores)
    return PretestResult(
        learner_profile_id=profile.id,
        answers=[],
        score=round(avg, 3),
        concept_scores={key: round(value, 3) for key, value in concept_scores.items()},
    )

