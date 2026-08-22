from fastapi.testclient import TestClient

from backend.main import app
from backend.orchestration.workflow import workflow
from backend.services.data_loader import get_learner_profile


client = TestClient(app)


def test_workflow_runs_complete_trace():
    profile = get_learner_profile("competition_sprint")
    run = workflow.run(profile)
    assert run.diagnosis
    assert run.retrieval.source_ids
    assert run.resources.graded_quiz
    assert run.learning_path.learning_path
    assert len(run.trace) >= 5


def test_health_api():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_workflow_api_returns_resources():
    response = client.post("/api/workflow/run", json={"learner_profile_id": "python_no_agent"})
    assert response.status_code == 200
    data = response.json()
    assert data["resources"]["lecture"]["sections"]
    assert data["trace"]
    assert data["resources"]["lecture"]["sections"][0]["source_ids"]


def test_conversation_turn_maps_to_structured_action():
    response = client.post(
        "/api/conversation/turn",
        json={"message": "开始运行完整闭环", "learner_profile_id": "python_no_agent"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["suggested_action"] == "run_workflow"
    assert "audit" in data["artifact_targets"]


def test_evaluation_summary_endpoint():
    response = client.get("/api/evaluation/summary")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    # Public/API summaries use v2 but must expose that it is calibration-exposed, not final accuracy.
    assert data["averages"]["difficulty_match"] == 1.0
    assert data["evidence"]["evidence_tier"] == "independent_seed_calibration_exposed"
    assert data["claimability"]["claimable_as_final_accuracy"] is False


def test_workflow_run_is_recorded_in_history():
    run_response = client.post("/api/workflow/run", json={"learner_profile_id": "backend_to_agent"})
    assert run_response.status_code == 200
    run_id = run_response.json()["run_id"]

    history_response = client.get("/api/history/runs")
    assert history_response.status_code == 200
    history = history_response.json()
    assert any(item["run_id"] == run_id for item in history)

    detail_response = client.get(f"/api/history/runs/{run_id}")
    assert detail_response.status_code == 200
    assert detail_response.json()["run_id"] == run_id


def test_evaluation_export_returns_csv():
    response = client.get("/api/evaluation/export")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "eval_results_v2.csv" in response.headers["content-disposition"]
    assert "case_id" in response.text
