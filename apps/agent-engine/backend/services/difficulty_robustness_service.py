from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, Sequence

from pydantic import BaseModel

from backend.services.concept_difficulty import goal_difficulty_level

_LEVELS = ["L1", "L2", "L3", "L4"]


class DifficultyRobustnessCase(BaseModel):
    id: str
    kind: Literal["absolute", "relation"]
    goal: str | None = None
    expected_difficulty: Literal["L1", "L2", "L3", "L4"] | None = None
    base_goal: str | None = None
    variant_goal: str | None = None
    relation: Literal["same", "not_lower", "not_higher", "higher", "lower"] | None = None
    rationale: str


class DifficultyRobustnessResult(BaseModel):
    case_id: str
    kind: Literal["absolute", "relation"]
    passed: bool
    observed: str | None = None
    expected_difficulty: str | None = None
    base_observed: str | None = None
    variant_observed: str | None = None
    relation: str | None = None
    rationale: str
    evidence_scope: str = "engineering_robustness_only"


def load_cases(path: Path) -> list[DifficultyRobustnessCase]:
    cases = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            cases.append(DifficultyRobustnessCase.model_validate_json(line))
        except Exception as exc:
            raise ValueError(f"invalid difficulty robustness case at line {line_number}: {exc}") from exc
    return cases


def evaluate_case(case: DifficultyRobustnessCase) -> DifficultyRobustnessResult:
    if case.kind == "absolute":
        if not case.goal or not case.expected_difficulty:
            raise ValueError(f"absolute case {case.id} requires goal and expected_difficulty")
        observed = goal_difficulty_level(case.goal)
        return DifficultyRobustnessResult(
            case_id=case.id,
            kind=case.kind,
            passed=observed == case.expected_difficulty,
            observed=observed,
            expected_difficulty=case.expected_difficulty,
            rationale=case.rationale,
        )

    if not case.base_goal or not case.variant_goal or not case.relation:
        raise ValueError(f"relation case {case.id} requires base_goal, variant_goal and relation")
    base_observed = goal_difficulty_level(case.base_goal)
    variant_observed = goal_difficulty_level(case.variant_goal)
    base_index = _LEVELS.index(base_observed)
    variant_index = _LEVELS.index(variant_observed)
    passed = {
        "same": variant_index == base_index,
        "not_lower": variant_index >= base_index,
        "not_higher": variant_index <= base_index,
        "higher": variant_index > base_index,
        "lower": variant_index < base_index,
    }[case.relation]
    return DifficultyRobustnessResult(
        case_id=case.id,
        kind=case.kind,
        passed=passed,
        base_observed=base_observed,
        variant_observed=variant_observed,
        relation=case.relation,
        rationale=case.rationale,
    )


def run_suite(cases: Sequence[DifficultyRobustnessCase]) -> list[DifficultyRobustnessResult]:
    return [evaluate_case(case) for case in cases]


def write_results(results: Sequence[DifficultyRobustnessResult], output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "evidence_scope": "engineering_robustness_only",
        "claim_limit": (
            "These cases test semantic rewrite and monotonicity robustness of deterministic rules. "
            "They are not a teacher-labeled holdout and must not be reported as final accuracy."
        ),
        "summary": {
            "total": len(results),
            "passed": sum(result.passed for result in results),
            "failed": sum(not result.passed for result in results),
        },
        "results": [result.model_dump(mode="json") for result in results],
    }
    (output_dir / "difficulty_robustness_results.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [
        "# Difficulty Semantic Robustness",
        "",
        "Evidence scope: `engineering_robustness_only`. This is not a teacher-labeled holdout.",
        "",
        f"PASS={payload['summary']['passed']} FAIL={payload['summary']['failed']} TOTAL={payload['summary']['total']}",
        "",
        "| Case | Kind | Result | Observed | Relation |",
        "| --- | --- | --- | --- | --- |",
    ]
    for result in results:
        observed = result.observed or f"{result.base_observed}→{result.variant_observed}"
        lines.append(
            f"| {result.case_id} | {result.kind} | {'PASS' if result.passed else 'FAIL'} | "
            f"{observed} | {result.relation or '-'} |"
        )
    (output_dir / "difficulty_robustness_results.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )
