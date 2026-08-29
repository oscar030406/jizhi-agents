"""成本实测：把 LLMGateway telemetry 快照折算成人民币成本。

行动指南 §2.8——"极低边际成本"不许停留在叙事，必须是测量值。
价格常量，以账单为准（硅基流动定价页，单位 ¥/百万 tokens）。
"""
from __future__ import annotations

from pydantic import BaseModel

# (模型前缀, input 价, output 价, 是否估价) —— 前缀匹配。成本是对外数字之一：
# 估价档必须在 CostReport.notes 里标出来（2026-08-28 清查 L8），不许把估的钱
# 报成对过账的钱。账单校正后把对应行的 estimated 翻 False 并注明核对日期。
PRICE_TABLE: list[tuple[str, float, float, bool]] = [
    ("Qwen/", 0.7, 2.8, False),   # Qwen3-30B-A3B-Instruct（fast 档主力，价目页核对）
    ("zai-org/GLM", 4.0, 16.0, True),   # GLM judge 档，估价
    ("deepseek-ai/DeepSeek-V3", 2.0, 8.0, True),  # V3.2 生成器主力（2026-07 起），估价待账单校正
]
# 未匹配到前缀时按主力 Qwen 档估——此时无论哪档都算估价
DEFAULT_PRICE: tuple[float, float, bool] = (0.7, 2.8, True)


class CostReport(BaseModel):
    total_tokens: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    api_calls: int = 0
    estimated_cost_cny: float = 0.0
    duration_ms: int = 0
    notes: str = ""


def _price_for(model: str) -> tuple[float, float, bool]:
    for prefix, price_in, price_out, estimated in PRICE_TABLE:
        if model.startswith(prefix):
            return price_in, price_out, estimated
    return DEFAULT_PRICE


def cost_from_telemetry(snapshot: dict, duration_ms: int = 0, model: str = "") -> CostReport:
    """从 gateway.telemetry_snapshot() 折算成本。

    ponytail: telemetry 是全 agent 聚合，无 per-model 分账，整体按一档价估；
    要精确分账需给 gateway 加 per-route token 计数。
    """
    prompt = int(snapshot.get("prompt_tokens", 0))
    completion = int(snapshot.get("completion_tokens", 0))
    price_in, price_out, estimated = _price_for(model)
    cost = prompt / 1e6 * price_in + completion / 1e6 * price_out
    return CostReport(
        total_tokens=int(snapshot.get("total_tokens", 0)),
        prompt_tokens=prompt,
        completion_tokens=completion,
        api_calls=int(snapshot.get("api_successes", 0)),
        estimated_cost_cny=round(cost, 6),
        duration_ms=duration_ms,
        notes=(
            f"按 ¥{price_in}/M input + ¥{price_out}/M output 折算"
            + ("；该档价目为估价、未经账单校正" if estimated else "；价目已与价目页核对")
            + "，最终以账单为准"
        ),
    )
