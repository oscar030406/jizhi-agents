"""集成层测试（Phase C/P-2）：个性化端点契约 + 模型层桥接 + 鉴权 + 产品层 API + 流式。"""

import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.integration import personalize_api
from backend.integration.personalize_service import (
    DailyPlanRequest,
    GradeReviewRequest,
    ModelConfig,
    PersonalizeFollowupRequest,
    PersonalizeRequest,
    PlanConcept,
    ReviewCardState,
    build_daily_plan_api,
    env_from_model_config,
    grade_review_api,
    list_learning_modes_api,
    run_personalize,
    run_personalize_followup,
    stream_personalize_events,
)


def _client(token: str = "test-internal-token") -> TestClient:
    os.environ["AI_SERVICE_TOKEN"] = token
    app = FastAPI()
    app.include_router(personalize_api.router)
    return TestClient(app)


def test_generate_requires_internal_token():
    client = _client()
    resp = client.post("/internal/v1/personalize/generate", json={"userId": "1", "learningGoal": "完成 RAG 文档问答 Agent"})
    assert resp.status_code == 401


def test_generate_returns_apiresponse_envelope_and_metrics():
    client = _client()
    resp = client.post(
        "/internal/v1/personalize/generate",
        headers={"x-internal-token": "test-internal-token", "x-trace-id": "t-123"},
        json={
            "userId": "42",
            "learningGoal": "完成 RAG 文档问答 Agent",
            "profile": {"background": "会 Python 不懂 Agent", "programming_level": 2, "agent_level": 0, "engineering_level": 2},
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == "SUCCESS"
    assert body["traceId"] == "t-123"
    # WorkflowRun 结构化产物齐全
    data = body["data"]
    assert data["diagnosis"] and data["resources"]["lecture"]["sections"]
    assert data["trace"] and "audit" in data
    # 可观测指标
    obs = body["observability"]
    assert obs["scene"] == "personalize_generate"
    assert obs["engines"] and "hallucinationRate" in obs


def test_env_from_model_config_bridges_all_chat_tiers():
    env = env_from_model_config(ModelConfig(model="deepseek-ai/DeepSeek-V3", baseUrl="https://x/v1", apiKey="sk-x"))
    assert env["AGENT_GENERATION_MODE"] == "api"
    for tier in ("FAST", "STRONG", "JUDGE"):
        assert env[f"LLM_MODEL_{tier}"] == "deepseek-ai/DeepSeek-V3"
        assert env[f"LLM_BASE_URL_{tier}"] == "https://x/v1"
    assert env["PERSONALIZE_API_KEY"] == "sk-x"


def test_env_empty_when_no_valid_config():
    assert env_from_model_config(ModelConfig()) == {}


def test_run_personalize_deterministic_without_config():
    run, metrics = run_personalize(PersonalizeRequest(userId="7", learningGoal="搭建多 Agent 协作的内容审核工作流"), "trace-x")
    assert run["run_id"]
    assert metrics.fallbackUsed is True  # 无 modelConfig → 确定性兜底
    assert metrics.model == "deterministic"


def test_followup_internal_endpoint_generates_child_run():
    client = _client()
    generate_response = client.post(
        "/internal/v1/personalize/generate",
        headers={"x-internal-token": "test-internal-token", "x-trace-id": "parent-trace"},
        json={"userId": "42", "learningGoal": "掌握 Agentic RAG"},
    )
    parent = generate_response.json()["data"]

    response = client.post(
        "/internal/v1/personalize/followup",
        headers={"x-internal-token": "test-internal-token", "x-trace-id": "child-trace"},
        json={
            "userId": "42",
            "profile": {"background": "会 Python，正在学习 Agent"},
            "parentRun": parent,
            "feedback": {
                "learner_profile_id": "user_42",
                "quiz_score": 0.3,
                "confidence": 2,
                "concept_scores": {"rag": 0.2},
                "free_text": "检索链路仍然不清楚",
            },
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["traceId"] == "child-trace"
    assert body["data"]["parent_run_id"] == parent["run_id"]
    assert body["data"]["generation_reason"] == "feedback_followup"
    assert body["data"]["feedback_decision"]["decision"] == "downgrade_explanation"
    assert body["observability"]["scene"] == "personalize_followup"


# ---------------------------------------------------------------- 产品层三件套 API（P-2）

HEADERS = {"x-internal-token": "test-internal-token"}


def test_daily_plan_api_deterministic_and_budgeted():
    request = DailyPlanRequest(
        plan_date="2026-07-09",
        minutes_budget=25,
        review_cards=[
            ReviewCardState(item_id="rag", stability=1.0, difficulty=5.0,
                            last_review="2026-07-06", due="2026-07-09"),
        ],
        next_concepts=[PlanConcept(concept_id="langgraph", title="状态图编排")],
    )
    plan = build_daily_plan_api(request)
    assert plan["plan_date"] == "2026-07-09"
    assert plan["total_minutes"] <= 25
    types = [item["item_type"] for item in plan["items"]]
    assert "review" in types and "new_concept" in types
    assert plan == build_daily_plan_api(request)  # 纯函数可复算


def test_daily_plan_endpoint_contract():
    client = _client()
    resp = client.post(
        "/internal/v1/personalize/daily-plan",
        headers={**HEADERS, "x-trace-id": "plan-1"},
        json={
            "plan_date": "2026-07-09",
            "minutes_budget": 30,
            "review_cards": [],
            "next_concepts": [{"concept_id": "rag", "title": "RAG 检索"}],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["traceId"] == "plan-1"
    assert body["data"]["has_new_concept"] is True
    assert body["data"]["encouragement"]


def test_grade_review_api_first_review_schedules_due():
    result = grade_review_api(
        GradeReviewRequest(card=ReviewCardState(item_id="rag"), rating=3, review_date="2026-07-09")
    )
    card = result["card"]
    assert card["stability"] is not None and card["difficulty"] is not None
    assert card["last_review"] == "2026-07-09"
    assert card["due"] > "2026-07-09"
    assert result["interval_days"] >= 1


def test_review_grade_endpoint_wrong_answer_comes_back_sooner():
    client = _client()

    def grade(rating: int) -> dict:
        resp = client.post(
            "/internal/v1/personalize/review/grade",
            headers=HEADERS,
            json={"card": {"item_id": "x"}, "rating": rating, "review_date": "2026-07-09"},
        )
        assert resp.status_code == 200
        return resp.json()["data"]

    assert grade(1)["interval_days"] <= grade(4)["interval_days"]


def test_learning_modes_api_resolves_situational_answers():
    data = list_learning_modes_api("solo", "visual")
    assert len(data["modes"]) == 4
    assert data["resolved"]["mode_id"] == "deep_diver"
    assert list_learning_modes_api()["resolved"] is None


def test_learning_modes_endpoint_contract():
    client = _client()
    resp = client.get(
        "/internal/v1/personalize/learning-modes",
        headers=HEADERS,
        params={"stuck_style": "social", "approach_style": "hands_on"},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert {m["mode_id"] for m in data["modes"]} == {
        "deep_diver", "code_smith", "study_captain", "sprint_partner",
    }
    assert data["resolved"]["mode_id"] == "sprint_partner"
    assert data["resolved"]["avatar_seed"]


# ---------------------------------------------------------------- 流式（P-2）


def test_stream_personalize_events_order_and_final_run():
    events = list(
        stream_personalize_events(
            PersonalizeRequest(userId="11", learningGoal="完成 RAG 文档问答 Agent"),
            "stream-trace",
        )
    )
    kinds = [e["event"] for e in events]
    assert kinds[0] == "run_started"
    assert kinds[-1] == "final"
    steps = [e for e in events if e["event"] == "agent_step"]
    assert steps, "至少应有一个 agent_step 事件"
    # 事件流里的 trace 增量 = 最终 run 的 trace（不多发、不漏发）
    final = events[-1]["data"]
    assert len(steps) == len(final["run"]["trace"])
    assert [s["data"]["agent"] for s in steps] == [t["agent"] for t in final["run"]["trace"]]
    assert final["metrics"]["scene"] == "personalize_stream"
    assert final["run"]["resources"]["lecture"]["sections"]


def test_generate_stream_endpoint_emits_sse_frames():
    client = _client()
    resp = client.post(
        "/internal/v1/personalize/generate/stream",
        headers={**HEADERS, "x-trace-id": "sse-1"},
        json={"userId": "12", "learningGoal": "掌握 Agentic RAG"},
    )
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    assert resp.headers["x-trace-id"] == "sse-1"
    text = resp.text
    assert "event: run_started" in text
    assert "event: agent_step" in text
    assert "event: final" in text


def test_pretest_endpoint_returns_per_dim_questions_without_answers():
    client = _client()
    resp = client.get(
        "/internal/v1/personalize/pretest",
        headers=HEADERS,
        params={"dims": "agent,rag", "per_dim": 2},
    )
    assert resp.status_code == 200
    questions = resp.json()["data"]["questions"]
    by_dim: dict[str, int] = {}
    for q in questions:
        by_dim[q["dim"]] = by_dim.get(q["dim"], 0) + 1
        assert q["id"] and q["question"] and q["options"]
        assert "answer" not in q and "explanation" not in q  # 出题面不带答案
    assert by_dim == {"agent": 2, "rag": 2}


def test_pretest_grade_applies_divergence_correction_rule():
    from backend.services.data_loader import load_pretest_questions

    client = _client()
    questions = client.get(
        "/internal/v1/personalize/pretest",
        headers=HEADERS,
        params={"dims": "agent,rag", "per_dim": 2},
    ).json()["data"]["questions"]
    # agent 全答对（按题库正确答案作答），rag 全答错（选一个非正确项）
    key = {q.id: q.answer for q in load_pretest_questions()}
    answers = {
        q["id"]: key[q["id"]] if q["dim"] == "agent"
        else next(c for c in "ABCD" if c != key[q["id"]])
        for q in questions
    }
    resp = client.post(
        "/internal/v1/personalize/pretest/grade",
        headers=HEADERS,
        json={"answers": answers, "self_levels": {"agent": 0, "rag": 3, "engineering": 2}},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    # agent：自评 0、测出 4，差 ≥2 → 均值四舍五入 = 2
    assert data["agent"] == {"self": 0, "tested": 4, "corrected": 2, "evidence": "答对2/2"}
    # rag：自评 3、测出 0，差 ≥2 → 均值四舍五入 = 2（1.5 进位）
    assert data["rag"] == {"self": 3, "tested": 0, "corrected": 2, "evidence": "答对0/2"}
    # engineering 没答题 → 不硬猜档位
    assert "engineering" not in data


def test_run_personalize_followup_uses_parent_goal():
    parent, _ = run_personalize(
        PersonalizeRequest(userId="9", learningGoal="完成工具调用与审核闭环"),
        "parent",
    )
    request = PersonalizeFollowupRequest(
        userId="9",
        parentRun=parent,
        feedback={
            "learner_profile_id": "user_9",
            "quiz_score": 0.9,
            "confidence": 5,
        },
    )

    child, metrics = run_personalize_followup(request, "child")

    assert child["learning_goal"] == parent["learning_goal"]
    assert child["parent_run_id"] == parent["run_id"]
    assert metrics.scene == "personalize_followup"


def test_tutor_endpoint_probes_grades_and_404s_unknown_concept():
    client = _client()
    # 首轮：无历史 → 探测提问，决策带 because 链
    resp = client.post(
        "/internal/v1/personalize/tutor",
        headers={**HEADERS, "x-trace-id": "t-tutor"},
        json={"concept": "llm_basics", "history": []},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["traceId"] == "t-tutor"
    data = body["data"]
    assert data["decision"]["type"] == "probe"
    assert data["decision"]["because"]
    question = data["question"]
    assert question["options"] and question["source_ids"]
    assert question["engine"] in ("llm", "deterministic")

    # 第二轮：拿真实 question_id 作答 → 按对错裁决降维/推进/进阶，裁决仍有依据
    resp2 = client.post(
        "/internal/v1/personalize/tutor",
        headers=HEADERS,
        json={"concept": "llm_basics", "history": [{"question_id": question["question_id"], "selected_index": 1}]},
    )
    assert resp2.status_code == 200
    data2 = resp2.json()["data"]
    assert data2["decision"]["type"] in ("simplify", "advance", "challenge", "complete")
    assert data2["decision"]["because"]
    assert data2["asked"] == 1

    # 没建课程语料的概念 → 404（区分「引擎挂了」和「没题库」）
    assert client.post(
        "/internal/v1/personalize/tutor", headers=HEADERS, json={"concept": "nope"}
    ).status_code == 404
