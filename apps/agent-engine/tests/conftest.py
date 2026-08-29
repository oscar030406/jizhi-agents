from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 测试必须封闭：无论 .env 或外部 shell 怎么配，单测不许发真实模型请求。
# 2026-08-28 移除确定性兜底引擎后，封闭性改由两件事保证：
# 1) 剥掉全部模型密钥——路由一律 disabled，谁偷偷调真模型谁当场炸；
# 2) 模块级网关单例替换为 StubGateway（tests/fake_gateway.py）——生成智能体
#    经真实解析与护栏代码消化罐头 JSON，回归覆盖的是生产同一条路径。
# 注意用空串**预占位**而不是 pop：backend 首次 import 时 load_dotenv_once 会以
# setdefault 语义把 .env 灌回环境——pop 掉的键会被灌回真实密钥，整个套件
# 就开始发真实模型请求（08-29 实测：全量跑 15 分钟无输出，全在排队烧钱）。
# SILICONFLOW_API_KEY 例外：检索的查询嵌入历来在测试里真调（确定性输出、分钱级
# 成本），test_excerpt_code_cap / test_rag 的断言按向量排序校准；聊天路径由下面的
# 类级罐头兜死，这把 key 逃不出嵌入接口。
for _key in ("DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY",
             "GOOGLE_API_KEY", "LLM_API_KEY", "PERSONALIZE_API_KEY"):
    os.environ[_key] = ""

import pytest  # noqa: E402


# 这些模块测的就是真实网关/路由内部机制（重试、遥测、禁用拦截），不吃罐头
_REAL_GATEWAY_MODULES = {"test_gateway_telemetry", "test_llm_gateway_stream", "test_model_routing"}


@pytest.fixture(autouse=True)
def _stub_llm_gateway(request, monkeypatch):
    """给 LLMGateway **类**打补丁：生成智能体吃罐头 JSON，其余 agent 保持禁用。

    打类而不是打模块单例：test_workflow 这类模块在 import 期就实例化了
    workflow/agent，晚到的单例替换够不着它们（08-29 实测 29 败全是这个洞）。
    测试里自己 new 的 FakeGateway 是另一个类，不受影响。
    """
    if request.node.module.__name__ in _REAL_GATEWAY_MODULES:
        yield None
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from fake_gateway import (StubGateway, extract_source_ids, generation_payload,
                              is_course_generation_prompt)

    from backend.services.llm_gateway import LLMGateway

    stub_state = StubGateway()

    def fake_is_enabled(self, agent):
        return agent in StubGateway.enabled_agents

    def fake_structured_chat(self, agent, system, user, **kwargs):
        stub_state.calls.append(agent)
        if agent not in StubGateway.enabled_agents:
            raise AssertionError(f"disabled agent {agent} must not call the gateway in tests")
        if not is_course_generation_prompt(system):
            return None  # 非造课调用：让调用方走自己的失败/回退路径
        return generation_payload(extract_source_ids(user), seed_text=user)

    def fake_chat(self, agent, messages, **kwargs):  # pragma: no cover
        raise AssertionError("tests must use structured_chat stubs")

    monkeypatch.setattr(LLMGateway, "is_enabled", fake_is_enabled)
    monkeypatch.setattr(LLMGateway, "structured_chat", fake_structured_chat)
    monkeypatch.setattr(LLMGateway, "chat", fake_chat)
    yield stub_state

