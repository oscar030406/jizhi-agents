from __future__ import annotations

from backend.schemas.resources import WorkflowRun


def build_report_summary(run: WorkflowRun) -> dict:
    return {
        "run_id": run.run_id,
        "learner_profile_id": run.learner_profile_id,
        "recommended_difficulty": run.diagnosis.recommended_difficulty,
        "weak_concepts": run.diagnosis.weak_concepts,
        # 时间预算够不够，跟难度、薄弱概念同级出现在摘要里：说不做到的话要出现在
        # 汇报口径里才算数，藏在完整 run 里等人翻不算（设计稿 §5.4）。
        "feasibility": run.diagnosis.feasibility.model_dump() if run.diagnosis.feasibility else None,
        "audit": {
            "factuality_score": run.audit.factuality_score,
            "citation_coverage": run.audit.citation_coverage,
            "difficulty_match": run.audit.difficulty_match,
            "concept_coverage": run.audit.concept_coverage,
            "revision_required": run.audit.revision_required,
            "flags": run.audit.hallucination_risk_flags,
        },
        "source_count": len(run.retrieval.source_ids),
        "path_stage_count": len(run.learning_path.learning_path),
    }

