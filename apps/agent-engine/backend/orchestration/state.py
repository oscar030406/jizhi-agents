from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from backend.schemas.learner import DiagnosisResult, LearnerProfile, PretestResult
from backend.schemas.resources import AgentTraceStep, AuditResult, LearningPath, LearningResources, RetrievalResult


class WorkflowState(BaseModel):
    run_id: str
    learner_profile: LearnerProfile
    learning_goal: str
    pretest_result: PretestResult
    diagnosis: Optional[DiagnosisResult] = None
    retrieval: Optional[RetrievalResult] = None
    resources: Optional[LearningResources] = None
    audit: Optional[AuditResult] = None
    learning_path: Optional[LearningPath] = None
    trace: list[AgentTraceStep] = Field(default_factory=list)

    def add_trace(self, step: AgentTraceStep) -> None:
        self.trace.append(step)

