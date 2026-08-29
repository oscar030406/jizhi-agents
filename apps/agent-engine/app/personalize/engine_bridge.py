from __future__ import annotations

import importlib
import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Any, Iterator

from app.config.log_config import configure_logger
from app.config.settings import BASE_DIR, settings
from app.personalize.schemas import (
    CompareRequest,
    DailyPlanRequest,
    GradeReviewRequest,
    PersonalizeFollowupRequest,
    PersonalizeGenerateRequest,
    TutorRequest,
)

logger = configure_logger("ai_service.personalize.bridge")


class AgentEngineUnavailable(RuntimeError):
    """Vendored agent 引擎无法加载。"""


VENDORED_ENGINE_ROOT = BASE_DIR
VENDORED_ENGINE_ENTRY = (
    VENDORED_ENGINE_ROOT
    / "backend"
    / "integration"
    / "personalize_service.py"
)


@lru_cache(maxsize=1)
def _load_personalize_module() -> ModuleType:
    if not VENDORED_ENGINE_ENTRY.is_file():
        raise AgentEngineUnavailable(
            f"未找到 vendored agent 引擎入口：{VENDORED_ENGINE_ENTRY}"
        )

    root_text = str(VENDORED_ENGINE_ROOT)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)

    try:
        module = importlib.import_module(
            "backend.integration.personalize_service"
        )
    except Exception as exc:
        raise AgentEngineUnavailable(
            f"vendored agent 引擎导入失败：{type(exc).__name__}"
        ) from exc

    module_file = Path(getattr(module, "__file__", "")).resolve()
    expected_file = VENDORED_ENGINE_ENTRY.resolve()
    if module_file != expected_file:
        raise AgentEngineUnavailable(
            f"加载到了非 vendored backend 包：{module_file}"
        )

    return module


def run_personalize(
    request: PersonalizeGenerateRequest,
    trace_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """调用 vendored 多智能体首次生成引擎。"""
    module = _load_personalize_module()
    engine_request = module.PersonalizeRequest.model_validate(
        request.model_dump(mode="python")
    )
    data, metrics = module.run_personalize(engine_request, trace_id)
    return data, metrics.model_dump(mode="json")


def run_personalize_followup(
    request: PersonalizeFollowupRequest,
    trace_id: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """调用 vendored 多智能体反馈二次生成引擎。"""
    module = _load_personalize_module()
    engine_request = module.PersonalizeFollowupRequest.model_validate(
        request.model_dump(mode="python")
    )
    data, metrics = module.run_personalize_followup(engine_request, trace_id)
    return data, metrics.model_dump(mode="json")


def stream_personalize(
    request: PersonalizeGenerateRequest,
    trace_id: str,
) -> Iterator[str]:
    """流式运行多智能体闭环，产出 SSE 帧：run_started → agent_step* → final。

    引擎层产出传输无关的 dict 事件，本层编码为 SSE；中途失败发 error 事件后正常收尾，
    客户端不必处理半截流。
    """
    module = _load_personalize_module()
    engine_request = module.PersonalizeRequest.model_validate(
        request.model_dump(mode="python")
    )
    try:
        for event in module.stream_personalize_events(engine_request, trace_id):
            payload = json.dumps(event["data"], ensure_ascii=False)
            yield f"event: {event['event']}\ndata: {payload}\n\n"
    except Exception as exc:  # noqa: BLE001 - 流中途失败以事件形式告知客户端
        logger.warning("个性化流式生成中断：traceId=%s err=%s", trace_id, exc)
        yield (
            "event: error\ndata: "
            + json.dumps({"message": "个性化流式生成中断"}, ensure_ascii=False)
            + "\n\n"
        )


def run_compare(request: CompareRequest, trace_id: str) -> dict[str, Any]:
    """调用 vendored 同题异人对比生成：N 画像并排 + 逐处差异归因。"""
    module = _load_personalize_module()
    engine_request = module.CompareRequest.model_validate(request.model_dump(mode="python"))
    return module.run_compare(engine_request, trace_id)


def run_tutor(request: TutorRequest, trace_id: str) -> dict[str, Any]:
    """调用 vendored 动态追问导学：单轮探测/降维/推进/进阶，决策逐条有据。"""
    module = _load_personalize_module()
    engine_request = module.TutorTurnRequest.model_validate(request.model_dump(mode="python"))
    return module.run_tutor_turn(engine_request, trace_id)


def build_daily_plan(request: DailyPlanRequest) -> dict[str, Any]:
    """调用 vendored 每日计划组合器（FSRS 到期复习 + 新知识点 + 挑战题）。"""
    module = _load_personalize_module()
    engine_request = module.DailyPlanRequest.model_validate(request.model_dump(mode="python"))
    return module.build_daily_plan_api(engine_request)


def grade_review(request: GradeReviewRequest) -> dict[str, Any]:
    """调用 vendored FSRS 复习评分：更新卡片记忆状态并排定下次到期日。"""
    module = _load_personalize_module()
    engine_request = module.GradeReviewRequest.model_validate(request.model_dump(mode="python"))
    return module.grade_review_api(engine_request)


def list_learning_modes(stuck_style: str = "", approach_style: str = "") -> dict[str, Any]:
    """调用 vendored 学习模式判定（两道情景题 → 4 型学习人格）。"""
    module = _load_personalize_module()
    return module.list_learning_modes_api(stuck_style, approach_style)


def profile_intake(text: str) -> dict[str, Any]:
    """调用 vendored 自述抽取（确定性关键词规则 → 画像种子+命中证据）。"""
    module = _load_personalize_module()
    return module.profile_intake_api(text)


def verify_content(code_blocks: list[str], texts: list[str]) -> dict[str, Any]:
    """调用 vendored 可执行验证（KR2）：代码沙箱真跑 + 数值等式复核，零 LLM。"""
    module = _load_personalize_module()
    return module.verify_content_bridge_api(code_blocks, texts)


def profile_appeal_challenge(dimension: str, claimed_level: int) -> dict[str, Any]:
    """调用 vendored 画像申诉出题（negotiated OLM：验证题全对才改档）。"""
    module = _load_personalize_module()
    return module.profile_appeal_challenge_api(dimension, claimed_level)


def profile_appeal_grade(dimension: str, claimed_level: int,
                         answers: dict[str, str]) -> dict[str, Any]:
    """调用 vendored 画像申诉判分。"""
    module = _load_personalize_module()
    return module.profile_appeal_grade_api(dimension, claimed_level, answers)


def evidence_retrieve(
    query: str, top_k: int = 6, corpus: str = "default", mastery: str = "",
    max_difficulty: str = "", max_code_lines: int = 0,
) -> dict[str, Any]:
    """调用 vendored 受控知识库检索（外部课堂系统证据接地用）。

    corpus 选领域语料库；该领域未建库时引擎返回空 chunks + 说明，不回退别的领域。
    max_difficulty（L1-L4）为摘录难度上限：超档块跳过带理由，摘录难度须匹配学习者姿态档。
    max_code_lines（>0 生效）为摘录代码形态上限：最长代码块超 N 行的块同样跳过带理由。
    """
    module = _load_personalize_module()
    return module.evidence_retrieve_api(
        query, top_k, corpus, mastery, max_difficulty, max_code_lines
    )


def excerpt_relevance(
    contexts: list[str], source_ids: list[str], corpus: str = "default",
) -> dict[str, Any]:
    """调用 vendored 摘录咬合打分（讲义前文 × 教材引文的 bge-m3 余弦矩阵，零 LLM）。"""
    module = _load_personalize_module()
    return module.excerpt_relevance_api(contexts, source_ids, corpus)


def skill_map() -> dict[str, Any]:
    """调用 vendored 岗位技能地图（岗位/技能覆盖/市场事实/各领域语料库状态）。"""
    module = _load_personalize_module()
    return module.skill_map_api()


def learner_blueprint(**kwargs: Any) -> dict[str, Any]:
    """调用 vendored 学情诊断+个性化蓝图（外部课堂系统的诊断 Agent）。"""
    module = _load_personalize_module()
    return module.learner_blueprint_api(**kwargs)


def quiz_decision(**kwargs: Any) -> dict[str, Any]:
    """调用 vendored 反馈决策 Agent（答题正确率 → 降维/补练/进阶/保持）。"""
    module = _load_personalize_module()
    return module.quiz_decision_api(**kwargs)


def pretest_questions(dims: str, per_dim: int) -> dict[str, Any]:
    """调用 vendored 前测出题（各维度 per_dim 道，不含答案）。"""
    module = _load_personalize_module()
    return module.pretest_questions_api(dims, per_dim)


def pretest_grade(answers: dict[str, str], self_levels: dict[str, int]) -> dict[str, Any]:
    """调用 vendored 前测判分 + 档位校正（自评当先验）。"""
    module = _load_personalize_module()
    return module.pretest_grade_api(answers, self_levels)
