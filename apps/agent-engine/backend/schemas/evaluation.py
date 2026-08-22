from typing import Dict, List

from pydantic import BaseModel, Field


class E2ECase(BaseModel):
    id: str
    learner_profile_id: str
    learning_goal: str
    expected_concepts: List[str]
    expected_difficulty: str
    must_include: List[str]
    must_not_include: List[str]


class EvaluationMetrics(BaseModel):
    case_id: str
    concept_coverage: float = Field(ge=0.0, le=1.0)
    citation_coverage: float = Field(ge=0.0, le=1.0)
    faithfulness: float = Field(default=1.0, ge=0.0, le=1.0)
    context_precision: float = Field(default=1.0, ge=0.0, le=1.0)
    context_concept_recall: float = Field(default=1.0, ge=0.0, le=1.0)
    difficulty_match: float = Field(ge=0.0, le=1.0)
    hallucination_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    hallucination_risk_flag_rate: float = Field(ge=0.0, le=1.0)
    workflow_success: float = Field(ge=0.0, le=1.0)
    details: Dict[str, str]

