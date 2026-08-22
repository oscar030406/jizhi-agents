from __future__ import annotations

import csv
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.orchestration.workflow import workflow
from backend.services.data_loader import load_learner_profiles
from backend.services.model_routing import configured_model_plan


PUBLIC_DIR = ROOT / "public"
FRONTEND_DIR = ROOT / "frontend"
# Static demo must use the independent-rule v2 baseline, not the self-referential v1 baseline.
EVAL_CSV = ROOT / "data" / "eval" / "eval_results_v2.csv"


def load_evaluation_summary() -> dict:
    if not EVAL_CSV.exists():
        return {"status": "missing", "message": "Run scripts/run_eval.py first.", "averages": {}}
    rows = []
    with EVAL_CSV.open("r", encoding="utf-8", newline="") as file:
        reader = csv.DictReader(file)
        for row in reader:
            rows.append(row)
    numeric_fields = [
        "concept_coverage",
        "citation_coverage",
        "difficulty_match",
        "hallucination_rate",
        "hallucination_risk_flag_rate",
        "workflow_success",
    ]
    averages = {}
    for field in numeric_fields:
        values = [float(row[field]) for row in rows if row.get(field) not in (None, "")]
        averages[field] = round(sum(values) / len(values), 3) if values else 0.0
    return {"status": "ok", "case_count": len(rows), "averages": averages, "sample_cases": rows[:5], "cases": rows}


def history_item(run: dict) -> dict:
    return {
        "run_id": run["run_id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "learner_profile_id": run["learner_profile_id"],
        "learning_goal": run["learning_goal"],
        "recommended_difficulty": run["diagnosis"]["recommended_difficulty"],
        "weak_concept_count": len(run["diagnosis"]["weak_concepts"]),
        "source_count": len(run["retrieval"]["source_ids"]),
        "factuality_score": run["audit"]["factuality_score"],
        "citation_coverage": run["audit"]["citation_coverage"],
        "concept_coverage": run["audit"]["concept_coverage"],
        "revision_required": run["audit"]["revision_required"],
        "trace_count": len(run["trace"]),
        "debate_rounds": len(run.get("debate", [])),
        "hallucination_rate": run["audit"].get("hallucination_rate", 0.0),
    }


def build_payload() -> dict:
    profiles = load_learner_profiles()
    runs = {}
    for profile in profiles:
        run = workflow.run(profile).model_dump(mode="json")
        runs[profile.id] = run
    default_profile_id = "competition_sprint" if "competition_sprint" in runs else profiles[0].id
    return {
        "profiles": [profile.model_dump(mode="json") for profile in profiles],
        "runs": runs,
        "default_profile_id": default_profile_id,
        "history": [history_item(run) for run in runs.values()],
        "evaluation_summary": load_evaluation_summary(),
        "model_routes": configured_model_plan(),
    }


def export_static_site() -> Path:
    if PUBLIC_DIR.exists():
        shutil.rmtree(PUBLIC_DIR)
    (PUBLIC_DIR / "assets").mkdir(parents=True)
    (PUBLIC_DIR / "data").mkdir(parents=True)
    shutil.copy2(FRONTEND_DIR / "index.html", PUBLIC_DIR / "index.html")
    shutil.copytree(FRONTEND_DIR / "assets", PUBLIC_DIR / "assets", dirs_exist_ok=True)
    if EVAL_CSV.exists():
        shutil.copy2(EVAL_CSV, PUBLIC_DIR / "data" / "eval_results.csv")
    (PUBLIC_DIR / ".nojekyll").write_text("", encoding="utf-8")
    payload = build_payload()
    static_js = "window.STATIC_DEMO_DATA = " + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"
    (PUBLIC_DIR / "assets" / "static-data.js").write_text(static_js, encoding="utf-8")
    return PUBLIC_DIR


if __name__ == "__main__":
    output = export_static_site()
    print(f"Exported static site to {output}")
