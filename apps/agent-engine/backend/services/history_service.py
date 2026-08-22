from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from backend.schemas.resources import RunHistoryItem, WorkflowRun


ROOT = Path(__file__).resolve().parents[2]
RUN_DIR = ROOT / "data" / "runs"
INDEX_PATH = RUN_DIR / "run_history.jsonl"


def record_workflow_run(run: WorkflowRun) -> RunHistoryItem:
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    item = RunHistoryItem(
        run_id=run.run_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        learner_profile_id=run.learner_profile_id,
        learning_goal=run.learning_goal,
        recommended_difficulty=run.diagnosis.recommended_difficulty,
        weak_concept_count=len(run.diagnosis.weak_concepts),
        source_count=len(run.retrieval.source_ids),
        factuality_score=run.audit.factuality_score,
        citation_coverage=run.audit.citation_coverage,
        concept_coverage=run.audit.concept_coverage,
        revision_required=run.audit.revision_required,
        trace_count=len(run.trace),
        debate_rounds=len(run.debate),
        hallucination_rate=run.audit.hallucination_rate,
        parent_run_id=run.parent_run_id,
        generation_reason=run.generation_reason,
    )
    detail_path = RUN_DIR / f"{run.run_id}.json"
    detail_path.write_text(json.dumps(run.model_dump(mode="json"), ensure_ascii=False, indent=2), encoding="utf-8")
    with INDEX_PATH.open("a", encoding="utf-8") as file:
        file.write(json.dumps(item.model_dump(mode="json"), ensure_ascii=False) + "\n")
    return item


def load_run_history(limit: int = 20) -> list[RunHistoryItem]:
    if not INDEX_PATH.exists():
        return []
    items: list[RunHistoryItem] = []
    with INDEX_PATH.open("r", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                items.append(RunHistoryItem(**json.loads(line)))
    return list(reversed(items))[:limit]


def load_run_detail(run_id: str) -> WorkflowRun | None:
    detail_path = RUN_DIR / f"{run_id}.json"
    if not detail_path.exists():
        return None
    return WorkflowRun(**json.loads(detail_path.read_text(encoding="utf-8")))
