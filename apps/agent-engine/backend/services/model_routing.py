from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True)
class ModelRoute:
    agent: str
    tier: str
    provider: str
    model: str
    base_url: str
    api_key_env: str
    purpose: str
    enabled: bool

    def public_dict(self) -> dict[str, str | bool]:
        return {
            "agent": self.agent,
            "tier": self.tier,
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "api_key_env": self.api_key_env,
            "purpose": self.purpose,
            "enabled": self.enabled,
        }


PROVIDER_BASE_URLS = {
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "deepseek": "https://api.deepseek.com",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
    "openai": "https://api.openai.com/v1",
    "siliconflow": "https://api.siliconflow.cn/v1",
}

PROVIDER_KEY_ENV = {
    "dashscope": "DASHSCOPE_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "google": "GEMINI_API_KEY",
    "openai": "OPENAI_API_KEY",
    "siliconflow": "SILICONFLOW_API_KEY",
}

# 默认路由只是兜底；实际模型一律以 .env 显式配置为准（本项目当前用 siliconflow 三档，见 .env.example）。
# deepseek 官方 API 的对话模型真名是 deepseek-chat / deepseek-reasoner。
TIER_DEFAULTS = {
    "fast": ("dashscope", "qwen-flash"),
    "strong": ("deepseek", "deepseek-chat"),
    "judge": ("google", "gemini-2.5-pro"),
    "embedding": ("dashscope", "text-embedding-v4"),
    "rerank": ("dashscope", "gte-rerank-v2"),
}

AGENT_TIERS = {
    "LearnerDiagnosisAgent": ("fast", "画像识别、能力向量、难度分层"),
    "KnowledgeRetrievalAgent": ("embedding", "知识库检索向量化；主链路不调用聊天模型"),
    "ResourceGenerationAgent": ("strong", "生成讲义、实操任务、测试题和引用说明"),
    "ContentAuditAgent": ("judge", "抽样复核内容事实性、引用覆盖和难度适配"),
    "LearningPathPlannerAgent": ("fast", "结构化学习路径规划"),
    "FeedbackDecisionAgent": ("fast", "根据得分和信心做反馈决策"),
    "ConversationTutor": ("fast", "高频对话引导和动作路由"),
    "EvaluationJudge": ("judge", "离线样例评测和答辩前抽检"),
    # 走 strong 而不是 fast 是有依据的：ZPD-SCA（arXiv:2508.14377）Table 4 零样本行里，
    # Qwen 系商用档低于三分类随机基线（Qwen-max 0.3061 / Qwen-plus 0.3152），
    # 而 DeepSeek-V3 到 0.7775——正是我们 strong 档的模型家族。用 fast 标难度是明知故犯。
    "ChunkDifficultyLabeler": ("strong", "教材切片的读者门槛分档，离线一次性标注"),
    # 同理走 strong：前置关系是公开基准里最难的一类判断——K12-KGraph（arXiv:2605.09635）
    # 实测强模型在 Prereq 任务上 EM 也只有 34.8%（F1 58.2）。这张图又卡着整个选点，
    # 一条错边影响所有走这条路径的学习者，省这点钱不划算。
    "PrereqEdgeClassifier": ("strong", "概念前置关系成对分类，接入期一次性造表"),
    "RerankService": ("rerank", "检索结果重排"),
}


def _env_value(env: Mapping[str, str], key: str, default: str) -> str:
    return env.get(key) or os.environ.get(key) or default


def route_for(agent: str, env: Mapping[str, str] | None = None) -> ModelRoute:
    env = env or os.environ
    tier, purpose = AGENT_TIERS.get(agent, ("fast", "通用低成本结构化任务"))
    default_provider, default_model = TIER_DEFAULTS[tier]
    provider = _env_value(env, f"LLM_PROVIDER_{tier.upper()}", default_provider)
    model = _env_value(env, f"LLM_MODEL_{tier.upper()}", default_model)
    base_url = _env_value(env, f"LLM_BASE_URL_{tier.upper()}", PROVIDER_BASE_URLS.get(provider, ""))
    api_key_env = _env_value(env, f"LLM_API_KEY_ENV_{tier.upper()}", PROVIDER_KEY_ENV.get(provider, "LLM_API_KEY"))
    # 2026-08-28 起系统只有真实模型一条生成路径（AGENT_GENERATION_MODE 开关与
    # 确定性兜底引擎一并移除）：路由是否可用只取决于密钥在不在。密钥缺失时
    # 生成/审核环节显式报错，不再静默降级——降级会把"多智能体协同"变成可选项。
    enabled = bool(env.get(api_key_env) or os.environ.get(api_key_env))
    return ModelRoute(
        agent=agent,
        tier=tier,
        provider=provider,
        model=model,
        base_url=base_url,
        api_key_env=api_key_env,
        purpose=purpose,
        enabled=enabled,
    )


def configured_model_plan(env: Mapping[str, str] | None = None) -> list[dict[str, str | bool]]:
    return [route_for(agent, env=env).public_dict() for agent in AGENT_TIERS]
