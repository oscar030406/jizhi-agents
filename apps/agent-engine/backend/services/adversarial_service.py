from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from backend.orchestration.workflow import AgentTrainingWorkflow
from backend.schemas.learner import FeedbackInput
from backend.schemas.resources import WorkflowRun
from backend.services.data_loader import DATA_DIR, get_learner_profile


class AdversarialFeedback(BaseModel):
    quiz_score: float = Field(ge=0.0, le=1.0)
    confidence: int = Field(ge=1, le=5)
    free_text: str | None = None
    concept_scores: dict[str, float] = Field(default_factory=dict)


class AdversarialCase(BaseModel):
    case_id: str
    category: str
    kind: Literal["workflow", "feedback", "manual"]
    profile_id: str | None = None
    learning_goal: str | None = None
    feedback: AdversarialFeedback | None = None
    assertions: dict[str, Any] = Field(default_factory=dict)
    manual_required: bool = False
    notes: str = ""

    @model_validator(mode="after")
    def validate_case_shape(self) -> "AdversarialCase":
        if self.kind in {"workflow", "feedback"}:
            if not self.profile_id or not self.learning_goal:
                raise ValueError("profile_id and learning_goal are required for executable cases")
        if self.kind == "feedback" and self.feedback is None:
            raise ValueError("feedback is required for feedback cases")
        if self.kind == "manual" and not self.manual_required:
            raise ValueError("manual cases must set manual_required=true")
        return self


class AdversarialResult(BaseModel):
    case_id: str
    category: str
    status: Literal["PASS", "FAIL", "SKIP"]
    checks: dict[str, bool] = Field(default_factory=dict)
    details: dict[str, Any] = Field(default_factory=dict)
    message: str = ""


def load_adversarial_cases(path: Path | None = None) -> list[AdversarialCase]:
    source = path or DATA_DIR / "eval" / "adversarial_cases.jsonl"
    cases: list[AdversarialCase] = []
    for line_number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            cases.append(AdversarialCase.model_validate_json(line))
        except Exception as exc:
            raise ValueError(f"invalid adversarial case at line {line_number}: {exc}") from exc
    return cases


def run_adversarial_case(
    case: AdversarialCase,
    workflow: AgentTrainingWorkflow | None = None,
) -> AdversarialResult:
    if case.manual_required or case.kind == "manual":
        return AdversarialResult(
            case_id=case.case_id,
            category=case.category,
            status="SKIP",
            message=case.notes or "manual verification required",
        )

    wf = workflow or AgentTrainingWorkflow()
    profile = get_learner_profile(case.profile_id or "")
    parent = wf.run(profile, learning_goal=case.learning_goal)
    run = parent
    if case.kind == "feedback":
        feedback = case.feedback
        assert feedback is not None
        run = wf.run_followup(
            profile,
            parent,
            FeedbackInput(
                learner_profile_id=profile.id,
                quiz_score=feedback.quiz_score,
                confidence=feedback.confidence,
                free_text=feedback.free_text,
                concept_scores=feedback.concept_scores,
            ),
        )

    checks = _evaluate_assertions(case, run, parent)
    status: Literal["PASS", "FAIL"] = "PASS" if all(checks.values()) else "FAIL"
    return AdversarialResult(
        case_id=case.case_id,
        category=case.category,
        status=status,
        checks=checks,
        details={
            "run_id": run.run_id,
            "parent_run_id": run.parent_run_id or "",
            "difficulty": run.diagnosis.recommended_difficulty,
            "sources": run.retrieval.source_ids,
            "hallucination_rate": run.audit.hallucination_rate,
            "decision": run.feedback_decision.decision if run.feedback_decision else "",
            "learner_type": (
                run.diagnosis.personalization_blueprint.learner_type
                if run.diagnosis.personalization_blueprint
                else ""
            ),
        },
        message="all assertions passed" if status == "PASS" else "one or more assertions failed",
    )


def run_adversarial_suite(cases: list[AdversarialCase] | None = None) -> list[AdversarialResult]:
    return [run_adversarial_case(case) for case in (cases or load_adversarial_cases())]


def _evaluate_assertions(
    case: AdversarialCase,
    run: WorkflowRun,
    parent: WorkflowRun,
) -> dict[str, bool]:
    assertions = case.assertions
    checks: dict[str, bool] = {}
    combined_text = _combined_run_text(run)

    if "workflow_success" in assertions:
        checks["workflow_success"] = bool(run.trace and run.resources.graded_quiz and run.learning_path.learning_path)
    if "min_sources" in assertions:
        checks["min_sources"] = len(run.retrieval.source_ids) >= int(assertions["min_sources"])
    if "max_hallucination_rate" in assertions:
        checks["max_hallucination_rate"] = run.audit.hallucination_rate <= float(
            assertions["max_hallucination_rate"]
        )
    if "banned_substrings" in assertions:
        checks["banned_substrings"] = all(
            str(term).lower() not in combined_text
            for term in assertions["banned_substrings"]
        )
    if "required_substrings" in assertions:
        checks["required_substrings"] = all(
            str(term).lower() in combined_text
            for term in assertions["required_substrings"]
        )
    if "expected_learner_type" in assertions:
        blueprint = run.diagnosis.personalization_blueprint
        checks["expected_learner_type"] = bool(
            blueprint and blueprint.learner_type == assertions["expected_learner_type"]
        )
    if assertions.get("sources_must_be_retrieved"):
        retrieved = set(run.retrieval.source_ids)
        checks["sources_must_be_retrieved"] = set(run.resources.used_sources) <= retrieved
    if "max_estimated_hours" in assertions:
        checks["max_estimated_hours"] = run.learning_path.estimated_time <= int(
            assertions["max_estimated_hours"]
        )
    if "min_difficulty" in assertions:
        checks["min_difficulty"] = _difficulty_level(run.diagnosis.recommended_difficulty) >= int(
            str(assertions["min_difficulty"]).replace("L", "")
        )
    if "max_difficulty" in assertions:
        checks["max_difficulty"] = _difficulty_level(run.diagnosis.recommended_difficulty) <= int(
            str(assertions["max_difficulty"]).replace("L", "")
        )
    if "expected_decision" in assertions:
        checks["expected_decision"] = bool(
            run.feedback_decision
            and run.feedback_decision.decision == assertions["expected_decision"]
        )
    if "max_difficulty_delta" in assertions:
        delta = abs(
            _difficulty_level(run.diagnosis.recommended_difficulty)
            - _difficulty_level(parent.diagnosis.recommended_difficulty)
        )
        checks["max_difficulty_delta"] = delta <= int(assertions["max_difficulty_delta"])
    if assertions.get("requires_parent_link"):
        checks["requires_parent_link"] = run.parent_run_id == parent.run_id
    if assertions.get("requires_mastery_change"):
        checks["requires_mastery_change"] = bool(run.mastery_change)
    if assertions.get("requires_blueprint"):
        checks["requires_blueprint"] = run.diagnosis.personalization_blueprint is not None
    if assertions.get("requires_claim_audit"):
        checks["requires_claim_audit"] = run.audit.claims_total >= run.audit.claims_supported
    if assertions.get("trace_engines_declared"):
        checks["trace_engines_declared"] = all(
            bool(step.artifacts.get("engine")) for step in run.trace
        )
    if not checks:
        checks["executable"] = True
    return checks


def _combined_run_text(run: WorkflowRun) -> str:
    parts = [run.learning_goal]
    parts.extend(section.heading for section in run.resources.lecture.sections)
    parts.extend(section.body for section in run.resources.lecture.sections)
    parts.extend(run.resources.practice_task.steps)
    parts.extend(run.resources.practice_task.acceptance_checks)
    parts.extend(item.question for item in run.resources.graded_quiz)
    parts.extend(item.explanation for item in run.resources.graded_quiz)
    return " ".join(parts).lower()


def _difficulty_level(value: str) -> int:
    try:
        return int(value[1:])
    except (TypeError, ValueError, IndexError):
        return 0


def write_adversarial_results(results: list[AdversarialResult], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = [result.model_dump(mode="json") for result in results]
    (output_dir / "adversarial_results.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [
        "# Adversarial Evaluation",
        "",
        "| Case | Category | Status | Failed checks |",
        "| --- | --- | --- | --- |",
    ]
    for result in results:
        failed = ", ".join(name for name, ok in result.checks.items() if not ok) or "-"
        lines.append(f"| {result.case_id} | {result.category} | {result.status} | {failed} |")
    (output_dir / "adversarial_results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
