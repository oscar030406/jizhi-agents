from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from backend.orchestration.workflow import workflow
from backend.rag.retriever import get_retriever
from backend.schemas.learner import FeedbackInput, LearnerProfile, PretestAnswer
from backend.schemas.resources import FeedbackDecision, RetrievalResult, RunHistoryItem, WorkflowRun
from backend.services.data_loader import get_learner_profile, load_learner_profiles, load_pretest_questions
from backend.services.history_service import load_run_detail, load_run_history, record_workflow_run
from backend.services.model_routing import configured_model_plan
from backend.services.quiz_service import score_pretest, select_pretest_questions
from backend.services.report_service import build_report_summary


router = APIRouter(prefix="/api")
ROOT = Path(__file__).resolve().parents[2]
EVAL_RESULTS_PATH = ROOT / "data" / "eval" / "eval_results_v2.csv"
EVAL_SUMMARY_PATH = ROOT / "data" / "eval" / "eval_summary.json"


class WorkflowRequest(BaseModel):
    learner_profile_id: str
    learning_goal: Optional[str] = None
    answers: List[PretestAnswer] = Field(default_factory=list)


class WorkflowFollowupRequest(BaseModel):
    parent_run_id: str
    feedback: FeedbackInput
    profile: Optional[LearnerProfile] = None


class SearchRequest(BaseModel):
    query: str
    concept_tags: List[str] = Field(default_factory=list)
    top_k: int = Field(default=6, ge=1, le=12)


class CustomProfileRequest(BaseModel):
    profile: LearnerProfile
    answers: List[PretestAnswer] = Field(default_factory=list)


class ConversationTurnRequest(BaseModel):
    message: str
    learner_profile_id: Optional[str] = None
    has_workflow_run: bool = False


class ConversationTurnResponse(BaseModel):
    assistant_message: str
    suggested_action: str
    artifact_targets: List[str]
    missing_fields: List[str] = Field(default_factory=list)
    quick_replies: List[str] = Field(default_factory=list)


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "system": "agent_training_system"}


@router.get("/profiles", response_model=List[LearnerProfile])
def profiles() -> List[LearnerProfile]:
    return load_learner_profiles()


@router.get("/quiz/pretest")
def pretest(learning_goal: str = "Agent 应用开发", limit: int = 10) -> dict:
    questions = select_pretest_questions(load_pretest_questions(), learning_goal, limit=limit)
    return {"questions": [question.model_dump() for question in questions]}


@router.get("/models/routes")
def model_routes() -> list[dict[str, str | bool]]:
    return configured_model_plan()


@router.post("/retrieval/search", response_model=RetrievalResult)
def search(request: SearchRequest) -> RetrievalResult:
    return get_retriever().search(request.query, concept_tags=request.concept_tags, top_k=request.top_k)


@router.post("/workflow/run", response_model=WorkflowRun)
def run_workflow(request: WorkflowRequest) -> WorkflowRun:
    try:
        profile = get_learner_profile(request.learner_profile_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    questions = select_pretest_questions(load_pretest_questions(), request.learning_goal or profile.learning_goal, limit=10)
    pretest_result = None
    if request.answers:
        pretest_result = score_pretest(profile.id, questions, request.answers)
    run = workflow.run(profile, learning_goal=request.learning_goal, pretest_result=pretest_result)
    record_workflow_run(run)
    return run


@router.post("/workflow/run-custom", response_model=WorkflowRun)
def run_custom_workflow(request: CustomProfileRequest) -> WorkflowRun:
    questions = select_pretest_questions(load_pretest_questions(), request.profile.learning_goal, limit=10)
    pretest_result = score_pretest(request.profile.id, questions, request.answers) if request.answers else None
    run = workflow.run(request.profile, learning_goal=request.profile.learning_goal, pretest_result=pretest_result)
    record_workflow_run(run)
    return run


@router.post("/feedback", response_model=FeedbackDecision)
def feedback(request: FeedbackInput, current_difficulty: str = "L2") -> FeedbackDecision:
    return workflow.decide_feedback(request, current_difficulty=current_difficulty)


@router.post("/workflow/followup", response_model=WorkflowRun)
def followup_workflow(request: WorkflowFollowupRequest) -> WorkflowRun:
    parent = load_run_detail(request.parent_run_id)
    if parent is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {request.parent_run_id}")
    try:
        profile = request.profile or get_learner_profile(parent.learner_profile_id)
        run = workflow.run_followup(profile, parent, request.feedback)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    record_workflow_run(run)
    return run


@router.post("/report/summary")
def report_summary(request: WorkflowRequest) -> dict:
    run = run_workflow(request)
    return build_report_summary(run)


@router.get("/evaluation/summary")
def evaluation_summary() -> dict:
    path = EVAL_RESULTS_PATH
    if not path.exists():
        return {"status": "missing", "message": "Run scripts/run_eval.py first.", "averages": {}}
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as file:
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
    evidence: dict[str, Any] = {}
    claimability: dict[str, Any] = {}
    if EVAL_SUMMARY_PATH.exists():
        try:
            summary = json.loads(EVAL_SUMMARY_PATH.read_text(encoding="utf-8"))
            v2 = summary.get("v2", {}) if isinstance(summary, dict) else {}
            evidence = v2.get("evidence", {}) if isinstance(v2, dict) else {}
            claimability = v2.get("claimability", {}) if isinstance(v2, dict) else {}
        except (OSError, json.JSONDecodeError):
            evidence = {"evidence_tier": "unclassified"}
            claimability = {
                "claimable_as_final_accuracy": False,
                "reason": "evaluation provenance metadata is unavailable",
            }
    return {
        "status": "ok",
        "case_count": len(rows),
        "averages": averages,
        "evidence": evidence,
        "claimability": claimability,
        "sample_cases": rows[:5],
        "cases": rows,
    }


@router.get("/evaluation/export")
def evaluation_export() -> Response:
    path = EVAL_RESULTS_PATH
    if not path.exists():
        raise HTTPException(status_code=404, detail="Run scripts/run_eval.py first.")
    return Response(
        content=path.read_text(encoding="utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="eval_results_v2.csv"'},
    )


@router.get("/history/runs", response_model=List[RunHistoryItem])
def history_runs(limit: int = 20) -> List[RunHistoryItem]:
    return load_run_history(limit=max(1, min(limit, 100)))


@router.get("/history/runs/{run_id}", response_model=WorkflowRun)
def history_run_detail(run_id: str) -> WorkflowRun:
    run = load_run_detail(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return run


@router.post("/conversation/turn", response_model=ConversationTurnResponse)
def conversation_turn(request: ConversationTurnRequest) -> ConversationTurnResponse:
    text = request.message.lower()
    if any(keyword in text for keyword in ["评测", "评价", "eval", "指标", "测试报告"]):
        return ConversationTurnResponse(
            assistant_message="我会打开评测摘要。评委关心的是概念覆盖、引用覆盖、难度适配和流程成功率。",
            suggested_action="show_evaluation",
            artifact_targets=["evaluation_metrics", "eval_results_v2.csv"],
            quick_replies=["运行完整闭环", "查看 Agent trace", "提交反馈"],
        )
    if any(keyword in text for keyword in ["反馈", "分数", "不会", "卡住", "太难", "信心"]):
        return ConversationTurnResponse(
            assistant_message="这是反馈迭代场景。请给出测验得分、信心等级和卡点，我会调用反馈决策 Agent。",
            suggested_action="collect_feedback",
            artifact_targets=["feedback_decision", "updated_difficulty", "next_action"],
            missing_fields=["quiz_score", "confidence"],
            quick_replies=["得分偏低，需要降维解释", "得分中等，需要继续练习", "得分较高，给我进阶挑战"],
        )
    if any(keyword in text for keyword in ["开始", "运行", "诊断", "生成", "闭环", "学习路径"]):
        missing = [] if request.learner_profile_id else ["learner_profile_id"]
        return ConversationTurnResponse(
            assistant_message="我会按画像运行完整多 Agent 闭环，并返回诊断、证据、资源、审核和路径。",
            suggested_action="run_workflow" if not missing else "collect_profile",
            artifact_targets=["diagnosis", "retrieval", "resources", "audit", "learning_path", "trace"],
            missing_fields=missing,
            quick_replies=["使用当前画像运行", "先换一个画像", "运行后显示审核指标"],
        )
    if request.has_workflow_run:
        return ConversationTurnResponse(
            assistant_message="当前已有一次结构化运行结果。你可以继续查看证据、审核、路径，或提交反馈进入下一轮。",
            suggested_action="summarize_current_run",
            artifact_targets=["workflow_run"],
            quick_replies=["查看证据来源", "查看审核结果", "提交反馈"],
        )
    return ConversationTurnResponse(
        assistant_message="先确定学习目标、基础、时间预算和偏好。选择一个预设画像后，我可以运行完整闭环。",
        suggested_action="collect_profile",
        artifact_targets=["learner_profile"],
        missing_fields=["learner_profile_id", "learning_goal"],
        quick_replies=["我是零基础", "我会 Python 但不了解 Agent", "我要竞赛冲刺"],
    )


# ---------------------------------------------------------------- 造课工坊（可观测·可插话）
from fastapi.responses import StreamingResponse  # noqa: E402

from backend.services import course_studio  # noqa: E402


class StudioStartRequest(BaseModel):
    concept: str
    generator_model: str = ""


class StudioFeedbackRequest(BaseModel):
    note: str
    lesson_id: str = "*"  # 缺省=全局插话，下一个进入生成的课时吸收


@router.post("/studio/start")
def studio_start(request: StudioStartRequest) -> dict[str, Any]:
    """启动一次造课直播。同一时间只允许一个任务在跑（生产烧真实额度）。"""
    try:
        job = course_studio.start_job(request.concept, request.generator_model)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"job_id": job.job_id, "concept": job.concept, "log": job.log_path.name}


@router.get("/studio/{job_id}/events")
def studio_events(job_id: str) -> StreamingResponse:
    """SSE：先补发历史事件再跟直播；course_done/course_failed 后正常收尾。"""
    job = course_studio.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="没有这个造课任务")

    def _stream():
        for event in job.subscribe():
            yield f"event: {event['kind']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})


@router.post("/studio/{job_id}/feedback")
def studio_feedback(job_id: str, request: StudioFeedbackRequest) -> dict[str, Any]:
    """观看者插话。注入下一个生成回合的指令，产物仍要过引用门禁+判官——参与但不免检。"""
    job = course_studio.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="没有这个造课任务")
    if job.status != "running":
        raise HTTPException(status_code=409, detail="任务已结束，插话无处生效")
    job.add_feedback(request.note, request.lesson_id or "*")
    return {"accepted": True, "lesson_id": request.lesson_id or "*"}


@router.get("/studio/{job_id}/status")
def studio_status(job_id: str) -> dict[str, Any]:
    job = course_studio.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="没有这个造课任务")
    return {"job_id": job.job_id, "concept": job.concept, "status": job.status,
            "error": job.error, "events": len(job.events)}


@router.get("/studio/current")
def studio_current() -> dict[str, Any]:
    """当前在跑的造课任务（无则 job_id=null）——前端进页面先问这个，能接上正在直播的场。"""
    job = course_studio.current_job()
    if job is None:
        return {"job_id": None}
    return {"job_id": job.job_id, "concept": job.concept, "status": job.status, "events": len(job.events)}
