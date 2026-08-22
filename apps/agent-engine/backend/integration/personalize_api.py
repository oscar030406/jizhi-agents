"""个性化能力的 ai-service 内部路由（PLAYBOOK Phase C）。

镜像 ai_learn 约定：x-internal-token 鉴权 + ApiResponse 信封 + observability。
vendor 进 ai_learn 时，把 ApiResponse/verify_internal_token 换成 ai_learn 的
`app.schemas.common.ApiResponse` 与 `app.api.dependencies.verify_internal_token` 即可，
其余业务（personalize_service）原样复用。
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Generic, Iterator, Optional, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.integration.personalize_service import (
    CompareRequest,
    DailyPlanRequest,
    GradeReviewRequest,
    PersonalizeFollowupRequest,
    PersonalizeRequest,
    build_daily_plan_api,
    grade_review_api,
    list_learning_modes_api,
    run_compare,
    run_personalize,
    run_personalize_followup,
    stream_personalize_events,
)

logger = logging.getLogger("ai_service.personalize")
T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    """与 ai_learn app/schemas/common.py 同构的统一信封。"""

    code: str = "SUCCESS"
    message: str = "操作成功"
    data: Optional[T] = None
    traceId: str = "ai-service-trace"
    observability: Optional[dict[str, Any]] = None


def verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("AI_SERVICE_TOKEN", "")
    if not expected or x_internal_token != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="内部服务鉴权失败")


def _trace_id(x_trace_id: str | None) -> str:
    return x_trace_id.strip() if x_trace_id and x_trace_id.strip() else uuid.uuid4().hex


router = APIRouter(prefix="/internal/v1/personalize", tags=["personalize"])


@router.post("/generate", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def generate(request: PersonalizeRequest, x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """运行多智能体个性化闭环，返回结构化产物 + 可观测指标。失败降级由 Java 端兜底。"""
    trace_id = _trace_id(x_trace_id)
    try:
        run_dict, metrics = run_personalize(request, trace_id)
    except Exception as exc:  # noqa: BLE001 - 内部接口失败交由 Java 本地兜底
        logger.warning("个性化生成失败：traceId=%s err=%s", trace_id, exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="个性化生成暂不可用") from exc
    return ApiResponse(data=run_dict, traceId=trace_id, observability=metrics.model_dump(mode="json"))


@router.post("/followup", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def followup(
    request: PersonalizeFollowupRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse:
    """根据父运行和学习反馈执行一次新的完整多智能体闭环。"""
    trace_id = _trace_id(x_trace_id)
    try:
        run_dict, metrics = run_personalize_followup(request, trace_id)
    except Exception as exc:  # noqa: BLE001 - 内部接口失败交由业务后端记录
        logger.warning("个性化反馈二次生成失败：traceId=%s err=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化反馈生成暂不可用",
        ) from exc
    return ApiResponse(
        data=run_dict,
        traceId=trace_id,
        observability=metrics.model_dump(mode="json"),
    )


def _encode_sse(events: Iterator[dict[str, Any]]) -> Iterator[str]:
    """dict 事件 → SSE 帧。失败时发 error 事件后正常收尾（客户端不必处理半截流）。"""
    try:
        for event in events:
            payload = json.dumps(event["data"], ensure_ascii=False)
            yield f"event: {event['event']}\ndata: {payload}\n\n"
    except Exception as exc:  # noqa: BLE001 - 流中途失败以事件形式告知客户端
        logger.warning("个性化流式生成中断：err=%s", exc)
        yield f"event: error\ndata: {json.dumps({'message': '个性化流式生成中断'}, ensure_ascii=False)}\n\n"


@router.post("/generate/stream", dependencies=[Depends(verify_internal_token)])
def generate_stream(
    request: PersonalizeRequest,
    x_trace_id: str | None = Header(default=None),
) -> StreamingResponse:
    """流式运行多智能体闭环：run_started → agent_step* → final（Agent 协同剧场数据源）。"""
    trace_id = _trace_id(x_trace_id)
    return StreamingResponse(
        _encode_sse(stream_personalize_events(request, trace_id)),
        media_type="text/event-stream",
        headers={"X-Trace-Id": trace_id},
    )


@router.post("/compare", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def compare(request: CompareRequest, x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """同题异人对比：同一学习目标 × 2-4 画像各跑一遍完整闭环，返回并排快照 + 逐处差异归因。"""
    trace_id = _trace_id(x_trace_id)
    try:
        report = run_compare(request, trace_id)
    except Exception as exc:  # noqa: BLE001 - 内部接口失败交由调用方兜底
        logger.warning("对比生成失败：traceId=%s err=%s", trace_id, exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="对比生成暂不可用") from exc
    return ApiResponse(data=report, traceId=trace_id)


@router.post("/daily-plan", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def daily_plan(request: DailyPlanRequest, x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """组合今日计划（FSRS 到期复习 + 新知识点 + 挑战题），纯函数可复算。"""
    return ApiResponse(data=build_daily_plan_api(request), traceId=_trace_id(x_trace_id))


@router.post("/review/grade", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def review_grade(request: GradeReviewRequest, x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """FSRS 复习评分：更新卡片记忆状态并排定下次到期日。"""
    return ApiResponse(data=grade_review_api(request), traceId=_trace_id(x_trace_id))


@router.get("/learning-modes", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def learning_modes(
    stuck_style: str = "",
    approach_style: str = "",
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse:
    """学习模式清单；带两道情景题答案时同时返回判定结果。"""
    return ApiResponse(
        data=list_learning_modes_api(stuck_style, approach_style),
        traceId=_trace_id(x_trace_id),
    )


# ── 课堂桥接四端点（2026-08-01 反向补漂移）─────────────────────────────
# 这四条先长在 vendored 副本（legacy-platform/ai-service/app/api/personalize.py），
# classroom 的四个桥全指着它们，引擎本体却一直没有——README 教人起 apps/agent-engine，
# 起完 /blueprint 等全 404，课堂静默降级成裸生成。违反的正是 §8.12「vendored 不是
# 第二套实现」，只是方向反了：副本长出了本体没有的路由。契约照抄副本，勿再各改各的。


@router.post("/profile-intake", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def profile_intake(payload: dict[str, Any], x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """一句话自述 → 画像种子（确定性关键词抽取，逐条附命中证据）。

    **这条路由 2026-08-13 才补上，此前抽取器只被画像弹窗用过。** 实测暴露的洞：
    在生成框里写「我完全不懂技术，也没写过代码」，画像纹丝不动（programming_level 仍是 1、
    偏好仍是「可运行示例与分步练习」），课照旧给代码。抽取规则本来就认得「没写过代码」→
    programming 0，只是从来没人拿需求文本去问它。

    2A 适配率探针测不出这个洞——探针是直接把画像塞进去的，不走自述这条路。
    """
    from backend.integration.personalize_service import profile_intake_api

    text = str(payload.get("text") or "")
    return ApiResponse(data=profile_intake_api(text), traceId=_trace_id(x_trace_id))


@router.post("/blueprint", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def blueprint(payload: dict[str, Any], x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """学情诊断：画像 → 掌握度/薄弱概念/推荐难度/资源配比计划（确定性，毫秒级）。"""
    from backend.integration.personalize_service import learner_blueprint_api

    allowed = {
        "learning_goal", "background", "programming_level", "python_level",
        "agent_level", "rag_level", "engineering_level",
        "learning_preference", "time_budget_hours",
    }
    kwargs = {k: v for k, v in payload.items() if k in allowed}
    kwargs.setdefault("learning_goal", "")
    return ApiResponse(data=learner_blueprint_api(**kwargs), traceId=_trace_id(x_trace_id))


@router.post("/tutor", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def tutor(payload: dict[str, Any], x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """动态追问导学单轮：系统主动提问定位盲区，按答题实况裁决降维/推进/进阶（赛题第五(4)款②）。"""
    from pydantic import ValidationError

    from backend.integration.personalize_service import TutorTurnRequest, run_tutor_turn

    trace_id = _trace_id(x_trace_id)
    try:
        request = TutorTurnRequest.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)) from exc
    try:
        data = run_tutor_turn(request, trace_id)
    except KeyError as exc:
        # 概念没有策展课程语料 → 404，调用方据此区分「引擎挂了」和「该主题没题库」
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - 内部接口失败交由调用方兜底
        logger.warning("导学执行失败：traceId=%s err=%s", trace_id, exc)
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="导学执行暂不可用") from exc
    return ApiResponse(data=data, traceId=trace_id)


@router.post("/quiz-decision", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def quiz_decision(payload: dict[str, Any], x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """反馈决策：答题正确率 → 降维解释/补充练习/进阶挑战/保持路线。"""
    from backend.integration.personalize_service import quiz_decision_api

    allowed = {"quiz_score", "current_difficulty", "confidence", "concept_scores", "free_text", "learner_rating"}
    kwargs = {k: v for k, v in payload.items() if k in allowed}
    kwargs.setdefault("quiz_score", 0.0)
    return ApiResponse(data=quiz_decision_api(**kwargs), traceId=_trace_id(x_trace_id))


@router.get("/evidence", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def evidence(
    query: str,
    top_k: int = 6,
    corpus: str = "default",
    mastery: str = "",
    max_difficulty: str = "",
    max_code_lines: int = 0,
    beginner_code_form: bool = False,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse:
    """受控知识库检索：课堂生成前取证据块；未建库领域返回空 chunks 并说明原因。

    mastery 为可选掌握度 JSON（概念 id 或场景标题 → 0-1 分），给了走 outer-fringe
    选段（跳过已会、按前置图排序，跳过项带理由返回）。
    max_difficulty 为可选难度上限（L1-L4）：超档 chunk 跳过并带理由——摘录难度
    必须匹配学习者姿态档，否则姿态指令压不住摘录（2A 纯净测 beginner 44.4% 病根）。
    max_code_lines 为可选代码形态上限（>0 生效）：最长代码块超过 N 行的 chunk 同样
    跳过带理由——难度档管不住代码长度，L1 档语料里照样有 21 行的生产级 class。
    beginner_code_form=true 时再加一道**结构**闸：含 import / def / class / 装饰器的
    chunk 跳过。判据来自外部教材而非自拟——《Python 编程：从入门到实践》配套源码
    1-6 章 129 个文件里这三种结构出现率都是 0%，全书才 57%/31%/25%。
    长度管不住结构：3 行的 `from x import y` + `def f():` 比 5 行 print 序列难得多。
    """
    from backend.integration.personalize_service import evidence_retrieve_api

    return ApiResponse(
        data=evidence_retrieve_api(
            query, top_k, corpus, mastery, max_difficulty, max_code_lines, beginner_code_form
        ),
        traceId=_trace_id(x_trace_id),
    )


@router.get("/skill-map", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def skill_map(x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """岗位技能地图：技能清单 + 知识库覆盖 + 市场事实 + 语料库建设状态。"""
    from backend.integration.personalize_service import skill_map_api

    return ApiResponse(data=skill_map_api(), traceId=_trace_id(x_trace_id))


@router.get("/pretest", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def pretest(
    dims: str = "programming,python,agent,rag,engineering",
    per_dim: int = 2,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse:
    """前测出题：各维度 per_dim 道题（id/题干/选项，不含答案）。"""
    from backend.integration.personalize_service import pretest_questions_api

    return ApiResponse(data=pretest_questions_api(dims, per_dim), traceId=_trace_id(x_trace_id))


@router.post("/pretest/grade", response_model=ApiResponse, dependencies=[Depends(verify_internal_token)])
def pretest_grade(payload: dict[str, Any], x_trace_id: str | None = Header(default=None)) -> ApiResponse:
    """前测判分 + 档位校正：自评当先验，规则见 personalize_service.PRETEST_DIVERGENCE_GAP。"""
    from backend.integration.personalize_service import pretest_grade_api

    answers = {str(k): str(v) for k, v in (payload.get("answers") or {}).items()}
    self_levels = {str(k): int(v) for k, v in (payload.get("self_levels") or {}).items()}
    return ApiResponse(data=pretest_grade_api(answers, self_levels), traceId=_trace_id(x_trace_id))
