from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from fastapi.responses import StreamingResponse

from app.api.dependencies import verify_internal_token
from app.config.log_config import configure_logger
from app.personalize.engine_bridge import (
    AgentEngineUnavailable,
    build_daily_plan,
    grade_review,
    evidence_retrieve,
    excerpt_relevance,
    learner_blueprint,
    list_learning_modes,
    pretest_grade,
    pretest_questions,
    profile_appeal_challenge,
    profile_appeal_grade,
    profile_intake,
    quiz_decision,
    run_compare,
    run_personalize,
    run_personalize_followup,
    run_tutor,
    skill_map,
    stream_personalize,
    verify_content,
)
from app.personalize.schemas import (
    CompareRequest,
    DailyPlanRequest,
    GradeReviewRequest,
    PersonalizeFollowupRequest,
    PersonalizeGenerateRequest,
    TutorRequest,
)
from app.schemas.common import ApiResponse

router = APIRouter(prefix="/internal/v1/personalize", tags=["personalize"])
logger = configure_logger("ai_service.personalize")


@router.post(
    "/generate",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def generate_personalized_learning(
    request: PersonalizeGenerateRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """运行多智能体个性化学习闭环。"""
    trace_id = _resolve_trace_id(x_trace_id)
    try:
        data, metrics = run_personalize(request, trace_id)
    except AgentEngineUnavailable as exc:
        logger.error("个性化 agent 引擎不可用：traceId=%s reason=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化学习引擎暂不可用",
        ) from exc
    except Exception as exc:
        logger.exception("个性化 agent 引擎执行失败：traceId=%s error=%s", trace_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化学习生成失败",
        ) from exc
    return ApiResponse(data=data, traceId=trace_id, observability=metrics)


@router.post(
    "/followup",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def generate_personalized_followup(
    request: PersonalizeFollowupRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """根据父运行与结构化反馈执行一次新的完整多智能体闭环。"""
    trace_id = _resolve_trace_id(x_trace_id)
    try:
        data, metrics = run_personalize_followup(request, trace_id)
    except AgentEngineUnavailable as exc:
        logger.error("反馈二次生成引擎不可用：traceId=%s reason=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化学习引擎暂不可用",
        ) from exc
    except Exception as exc:
        logger.exception("反馈二次生成失败：traceId=%s error=%s", trace_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化反馈生成失败",
        ) from exc
    return ApiResponse(data=data, traceId=trace_id, observability=metrics)


@router.post(
    "/compare",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def compare_personalized_generation(
    request: CompareRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """同题异人对比生成：同一目标 × N 画像并排资源 + 逐处差异归因（适配能力演示）。"""
    trace_id = _resolve_trace_id(x_trace_id)
    try:
        data = run_compare(request, trace_id)
    except AgentEngineUnavailable as exc:
        logger.error("对比生成引擎不可用：traceId=%s reason=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="对比生成引擎暂不可用",
        ) from exc
    except Exception as exc:
        logger.exception("对比生成失败：traceId=%s error=%s", trace_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="对比生成失败",
        ) from exc
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/tutor",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def tutor_turn_endpoint(
    request: TutorRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """动态追问导学单轮：系统主动提问定位盲区，按答题实况裁决降维/推进/进阶。"""
    trace_id = _resolve_trace_id(x_trace_id)
    try:
        data = run_tutor(request, trace_id)
    except AgentEngineUnavailable as exc:
        logger.error("导学引擎不可用：traceId=%s reason=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="导学引擎暂不可用",
        ) from exc
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("导学执行失败：traceId=%s error=%s", trace_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="导学执行失败",
        ) from exc
    return ApiResponse(data=data, traceId=trace_id)


@router.post("/generate/stream", dependencies=[Depends(verify_internal_token)])
def generate_personalized_stream(
    request: PersonalizeGenerateRequest,
    x_trace_id: str | None = Header(default=None),
) -> StreamingResponse:
    """流式运行多智能体闭环：run_started → agent_step* → final（Agent 协同剧场数据源）。"""
    trace_id = _resolve_trace_id(x_trace_id)
    try:
        events = stream_personalize(request, trace_id)
    except AgentEngineUnavailable as exc:
        logger.error("个性化流式引擎不可用：traceId=%s reason=%s", trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化学习引擎暂不可用",
        ) from exc
    return StreamingResponse(
        events,
        media_type="text/event-stream",
        headers={"X-Trace-Id": trace_id},
    )


@router.post(
    "/daily-plan",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def build_personalized_daily_plan(
    request: DailyPlanRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """组合今日计划（FSRS 到期复习 + 新知识点 + 挑战题），纯函数可复算。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("每日计划", trace_id, lambda: build_daily_plan(request))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/review/grade",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def grade_review_card(
    request: GradeReviewRequest,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """FSRS 复习评分：更新卡片记忆状态并排定下次到期日。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("复习评分", trace_id, lambda: grade_review(request))
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/learning-modes",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_learning_modes(
    stuck_style: str = "",
    approach_style: str = "",
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """学习模式清单；带两道情景题答案时同时返回判定结果。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("学习模式", trace_id, lambda: list_learning_modes(stuck_style, approach_style))
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/profile-intake",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_profile_intake(
    text: str = "",
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """一句话自述 → 画像种子（确定性抽取，附命中证据；无 LLM 依赖）。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("画像抽取", trace_id, lambda: profile_intake(text))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/blueprint",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_blueprint(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """学情诊断 Agent：画像 → 掌握度/薄弱概念/推荐难度/资源配比计划（确定性，毫秒级）。

    供外部课堂系统（OpenMAIC 接地改造）在生成前调用。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    allowed = {
        "learning_goal", "background", "programming_level", "python_level",
        "agent_level", "rag_level", "engineering_level",
        "learning_preference", "time_budget_hours",
        # corpus 决定学情诊断用哪个域的概念集。漏在白名单外时调用方传了也被
        # 静默丢掉，诊断永远走主域——AI 概念补进制造课（#6）。
        #
        # **这份白名单在 backend/integration/personalize_api.py 里还有一份**，
        # 生产入口是 app.main:app 走的是这里。两处必须同改，
        # tests/test_diagnosis_domain_concepts.py 有一条测试钉住它们一致。
        "corpus",
    }
    kwargs = {k: v for k, v in payload.items() if k in allowed}
    kwargs.setdefault("learning_goal", "")
    data = _call_engine("学情诊断", trace_id, lambda: learner_blueprint(**kwargs))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/quiz-decision",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_quiz_decision(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """反馈决策 Agent：答题正确率 → 降维解释/补充练习/进阶挑战/保持路线。

    供外部课堂系统在测验交卷后调用，闭合"分析-生成-校验-决策"的决策环。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    allowed = {"quiz_score", "current_difficulty", "confidence", "concept_scores", "free_text", "learner_rating"}
    kwargs = {k: v for k, v in payload.items() if k in allowed}
    kwargs.setdefault("quiz_score", 0.0)
    data = _call_engine("反馈决策", trace_id, lambda: quiz_decision(**kwargs))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/verify-content",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_verify_content(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """可执行验证（KR2）：交付前机械验算内容里的代码块与数值等式。

    零 LLM：代码隔离子进程真跑（passed/failed/unverifiable 三态），
    数值等式 AST 白名单复核。供课堂在场景生成后调用，结果进车间面板。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    code_blocks = payload.get("code_blocks") or []
    texts = payload.get("texts") or []
    if not isinstance(code_blocks, list) or not isinstance(texts, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="code_blocks/texts 必须是数组")
    data = _call_engine(
        "可执行验证",
        trace_id,
        lambda: verify_content([str(c) for c in code_blocks], [str(t) for t in texts]),
    )
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/evidence",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_evidence(
    query: str,
    top_k: int = 6,
    corpus: str = "default",
    mastery: str = "",
    max_difficulty: str = "",
    max_code_lines: int = 0,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """受控知识库检索：外部课堂系统（OpenMAIC 接地改造）取证据块。

    corpus = 培训领域（default/ai 走现有 AI 语料）；未建库的领域返回空 chunks 并说明原因。
    mastery = 可选掌握度 JSON（概念 id 或场景标题 → 0-1），触发 outer-fringe 选段
    （跳过已会概念的块并带理由回传）。
    max_difficulty = 可选摘录难度上限（L1-L4）：超档块跳过带理由，摘录难度匹配姿态档。
    max_code_lines = 可选摘录代码形态上限（>0 生效）：最长代码块超 N 行的块跳过带理由。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine(
        "证据检索", trace_id,
        lambda: evidence_retrieve(query, top_k, corpus, mastery, max_difficulty, max_code_lines),
    )
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/excerpt-relevance",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_excerpt_relevance(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """摘录咬合打分（只读、零 LLM）：讲义前文 × 教材引文的 bge-m3 余弦矩阵。

    课堂在注入摘录前调用：模型挑的那条引文与它自己写的前一段不咬合时，
    换一条咬合的候选，全不合格才不贴。阈值随响应回传（单一真源，客户端不许自己写死）。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    contexts = payload.get("contexts") or []
    source_ids = payload.get("source_ids") or []
    if not isinstance(contexts, list) or not isinstance(source_ids, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="contexts/source_ids 必须是数组"
        )
    # 上限是防滥用不是业务约束：一节课的占位符是个位数，候选块 top_k ≤ 12
    if len(contexts) > 64 or len(source_ids) > 64:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="contexts/source_ids 最多 64 条"
        )
    data = _call_engine(
        "摘录咬合打分",
        trace_id,
        lambda: excerpt_relevance(
            [str(c) for c in contexts],
            [str(s) for s in source_ids],
            str(payload.get("corpus") or "default"),
        ),
    )
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/skill-map",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_skill_map(
    domain: str = "",
    corpus: str = "",
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """岗位技能地图：岗位技能清单 + 知识库覆盖 + 市场事实 + 各领域语料库建设状态。

    `domain`（`corpus` 是同义别名）指明问的是哪个域。不传 = 主域 ai。未登记岗位要求的域
    返回空 jobs + reason——两个 main 各挂一份路由，漏一个就有一条路仍在给主域岗位。
    """
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("岗位技能地图", trace_id, lambda: skill_map(domain or corpus or "ai"))
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/profile-appeal",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_profile_appeal(
    dimension: str,
    claimed_level: int = 1,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """画像申诉出题：negotiated OLM——「这个我其实会」先过验证题。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine(
        "画像申诉出题", trace_id, lambda: profile_appeal_challenge(dimension, claimed_level))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/profile-appeal",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_profile_appeal(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """画像申诉判分：全对才改档，because 链逐题留证。"""
    trace_id = _resolve_trace_id(x_trace_id)
    dimension = str(payload.get("dimension", ""))
    claimed_level = int(payload.get("claimed_level", 1))
    answers = {str(k): str(v) for k, v in (payload.get("answers") or {}).items()}
    data = _call_engine(
        "画像申诉判分", trace_id,
        lambda: profile_appeal_grade(dimension, claimed_level, answers))
    return ApiResponse(data=data, traceId=trace_id)


@router.get(
    "/pretest",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_pretest(
    dims: str = "agent,rag,engineering",
    per_dim: int = 2,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """前测出题：各维度 per_dim 道题（id/题干/选项，不含答案）。"""
    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("前测出题", trace_id, lambda: pretest_questions(dims, per_dim))
    return ApiResponse(data=data, traceId=trace_id)


@router.post(
    "/pretest/grade",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def post_pretest_grade(
    payload: dict[str, Any],
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """前测判分 + 档位校正：自评当先验，规则见引擎 PRETEST_DIVERGENCE_GAP 常量。"""
    trace_id = _resolve_trace_id(x_trace_id)
    answers = {str(k): str(v) for k, v in (payload.get("answers") or {}).items()}
    self_levels = {str(k): int(v) for k, v in (payload.get("self_levels") or {}).items()}
    data = _call_engine("前测判分", trace_id, lambda: pretest_grade(answers, self_levels))
    return ApiResponse(data=data, traceId=trace_id)


def _call_engine(scene: str, trace_id: str, invoke) -> dict[str, Any]:
    """产品层轻接口的统一错误封装（与 generate/followup 的降级语义一致）。"""
    try:
        return invoke()
    except AgentEngineUnavailable as exc:
        logger.error("%s引擎不可用：traceId=%s reason=%s", scene, trace_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="个性化学习引擎暂不可用",
        ) from exc
    except Exception as exc:
        logger.exception("%s执行失败：traceId=%s error=%s", scene, trace_id, type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{scene}生成失败",
        ) from exc


def _resolve_trace_id(trace_id: str | None) -> str:
    if trace_id and trace_id.strip():
        return trace_id.strip()
    return uuid.uuid4().hex


@router.get(
    "/domain-path/{corpus}",
    response_model=ApiResponse[dict[str, Any]],
    dependencies=[Depends(verify_internal_token)],
)
def get_domain_path(
    corpus: str,
    x_trace_id: str | None = Header(default=None),
) -> ApiResponse[dict[str, Any]]:
    """域级学习路径：该库的概念按前置图拓扑深度分阶。

    直接吃 `backend.services.domain_path`，不走 engine_bridge——这条是纯读盘、
    不碰模型也不碰 personalize_service 的编排，没有可降级的东西要桥接。
    没跑过接入流水线的库返回 source="none" + reason，不回退到 AI 域那份手工路径。
    """
    from backend.services.domain_path import build_domain_path

    trace_id = _resolve_trace_id(x_trace_id)
    data = _call_engine("域级学习路径", trace_id, lambda: build_domain_path(corpus))
    return ApiResponse(data=data, traceId=trace_id)
