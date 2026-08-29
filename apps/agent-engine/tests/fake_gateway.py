# -*- coding: utf-8 -*-
"""测试用假网关：喂罐头 JSON 给真实 LLM 代码路径，不发任何请求。

2026-08-28 移除确定性兜底引擎后，回归测试的封闭性由它保证：
- conftest 会剥掉所有模型密钥（无路由可用），再把模块级网关单例换成 StubGateway；
- StubGateway 只对生成智能体放行，罐头输出从用户提示词里的证据块提取真实
  source_id 拼出来——满足证据不变量，走的是与生产完全相同的解析与护栏代码。
审核/判官在测试里保持路由关闭：审核的确定性断言核验是量具本体，本来就不调模型。
"""

from __future__ import annotations

import re


def extract_source_ids(user_prompt: str) -> list[str]:
    """从提示词证据块里抠出真实 source_id（形如「[sid] 标题（难度）：…」的行首标记）。"""
    return re.findall(r"^\[([^\]\n]+)\]", user_prompt, flags=re.M)


def extract_evidence(user_prompt: str) -> list[tuple[str, str]]:
    """抠出 (source_id, 证据原文) 对。罐头正文必须摘抄证据原文——
    否则确定性断言核验会如实判它 100% 无据（08-29 实测），量具没错，
    是编造的正文在造幻觉。"""
    return re.findall(r"^\[([^\]\n]+)\] ([^\n]+)$", user_prompt, flags=re.M)


def is_course_generation_prompt(system: str) -> bool:
    """只有课程生成/修订的 system 提示词吃罐头；其他调用（示例起草、关键词、
    实操侦察……）返回 None 走调用方失败路径——罐头不该假装会答一切。"""
    return "graded_quiz" in system or "practice_task" in system


def generation_payload(source_ids: list[str], seed_text: str = "") -> dict:
    sid = source_ids[0] if source_ids else "unknown#s0"
    evidence = extract_evidence(seed_text) if seed_text else []
    def body_from(idx: int, fallback: str) -> tuple[str, str]:
        if len(evidence) > idx:
            esid, etext = evidence[idx]
            # 摘掉「标题（难度）：」前缀，保留正文供断言核验命中
            text = etext.split("：", 1)[-1]
            return esid, text[:400]
        return sid, fallback
    # 标题掺入提示词指纹：不同画像的提示词不同（蓝图/难度档嵌在里面），
    # 罐头输出因此可区分——个性化结构类断言测的就是"输入不同则产物不同"。
    import hashlib
    tag = hashlib.md5(seed_text.encode("utf-8")).hexdigest()[:6] if seed_text else "000000"
    # 蓝图敏感：支架档位真的写进了提示词，罐头按它换标题措辞——
    # 结构个性化断言由此测到「蓝图 → 提示词 → 产物」整条注入链是通的。
    if '"scaffold_level":"full"' in seed_text or '"scaffold_level": "full"' in seed_text:
        style = "类比与分步"
    elif '"scaffold_level":"minimal"' in seed_text or '"scaffold_level": "minimal"' in seed_text:
        style = "接口契约与失败模式"
    else:
        style = "讲解"
    # 测验解析与实操场景同样摘抄证据原文：编造的说明句会被断言核验如实判无据，
    # 把对抗用例的幻觉率顶破阈值（08-29 实测 0.5）。
    exp_sid, exp_text = body_from(0, "证据门控要求生成前检索、生成后核验。")
    quiz_item = {
        "question": "证据门控的作用是什么？",
        "options": {"A": "提高创意", "B": "让输出可追溯", "C": "隐藏中间状态", "D": "降低成本"},
        "answer": "B",
        "explanation": exp_text[:200],
        "concept_tags": ["rag"],
        "source_ids": [exp_sid],
    }
    return {
        "lecture": {
            "title": "测试罐头讲义",
            "sections": [
                (lambda p: {"heading": f"概念一 证据门控（{style}）· {tag}", "body": p[1], "source_ids": [p[0]]})(body_from(0, "生成内容必须能追溯到证据来源。")),
                (lambda p: {"heading": f"概念二 协同闭环（{style}）· {tag}", "body": p[1], "source_ids": [p[0]]})(body_from(1, "生成后经审核与仲裁方可放行。")),
            ],
        },
        "practice_task": {
            "title": "构建证据约束问答",
            "scenario": (lambda p: p[1][:200])(body_from(1, "基于给定文档构建问答应用。")),
            "steps": ["定义输出格式", "接入检索", "增加审核", f"按{style}风格自查一遍"],
            "deliverable": "可运行 API",
            "acceptance_checks": ["每个结论有引用", f"{style}检查点逐项通过"],
            "source_ids": [sid],
        },
        "graded_quiz": [dict(quiz_item) for _ in range(4)],
    }


class StubGateway:
    """默认只放行生成智能体；其余 agent 一律 disabled（与旧回归口径一致）。"""

    enabled_agents = {"ResourceGenerationAgent"}

    def __init__(self):
        self.calls: list[str] = []

    def is_enabled(self, agent: str) -> bool:
        return agent in self.enabled_agents

    def route_for(self, agent: str):
        from backend.services.model_routing import route_for

        return route_for(agent)

    def structured_chat(self, agent: str, system: str, user: str, **kwargs):
        self.calls.append(agent)
        if agent not in self.enabled_agents:
            raise AssertionError(f"disabled agent {agent} must not call the gateway in tests")
        return generation_payload(extract_source_ids(user), seed_text=user)

    def chat(self, agent: str, messages, **kwargs):  # pragma: no cover - 保守兜住
        raise AssertionError("tests must use structured_chat stubs")
