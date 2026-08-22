from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from threading import Lock
from typing import Any, Mapping

import requests

from backend.services.model_routing import ModelRoute, route_for

logger = logging.getLogger(__name__)

JSON_ONLY_REMINDER = "你上一次的输出不是合法 JSON。这次只输出一个 JSON 对象，不要任何解释、markdown 代码块或多余文本。"

# 三次机会：一次原样、两次补救。两次的时候实测不够——生成智能体第一次撞 token
# 上限被截断、第二次吐了个畸形 JSON，就整条降级成确定性兜底了。
MAX_STRUCTURED_ATTEMPTS = 3
# 抬预算的天花板，防止一路翻倍到把上下文窗口吃光
MAX_STRUCTURED_TOKENS = 16000


class LLMGateway:
    """Small OpenAI-compatible gateway with deterministic fallback by default."""

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self.env = env or os.environ
        self._telemetry_lock = Lock()
        self._telemetry = self._empty_telemetry()

    @staticmethod
    def _empty_telemetry() -> dict[str, int]:
        return {
            "disabled_calls": 0,
            "attempts": 0,
            "api_successes": 0,
            "request_failures": 0,
            "parse_failures": 0,
            "json_successes": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

    def reset_telemetry(self) -> None:
        with self._telemetry_lock:
            self._telemetry = self._empty_telemetry()

    def telemetry_snapshot(self) -> dict[str, int]:
        with self._telemetry_lock:
            return dict(self._telemetry)

    def _increment(self, **values: int) -> None:
        with self._telemetry_lock:
            for key, value in values.items():
                self._telemetry[key] = self._telemetry.get(key, 0) + int(value)

    def route_for(self, agent: str) -> ModelRoute:
        return route_for(agent, env=self.env)

    def is_enabled(self, agent: str) -> bool:
        return self.route_for(agent).enabled

    def chat(
        self,
        agent: str,
        messages: list[dict[str, str]],
        *,
        temperature: float = 0.2,
        max_tokens: int = 1200,
        response_format: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        route = self.route_for(agent)
        if not route.enabled:
            raise RuntimeError(f"LLM route is not enabled for {agent}; using deterministic fallback.")
        api_key = self.env.get(route.api_key_env) or os.environ.get(route.api_key_env)
        payload: dict[str, Any] = {
            "model": route.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            payload["response_format"] = response_format
        # 判官档关思考：核对「这句话证据里有没有」是清单活，不需要长推理，而思考
        # 会把 max_tokens 吃光——实测 Qwen3.6-35B 判官首次调用 finish_reason=length
        # 且正文 0 字符，白白多花一次重试。与产品链 08-03 的判官口径一致。
        # LLM_JUDGE_THINKING=1 可恢复（做口径对照时用）。
        if route.tier == "judge" and self.env.get("LLM_JUDGE_THINKING", "") != "1":
            payload["enable_thinking"] = False
        # 默认流式：慢模型（DeepSeek-V3.2 实测约 20 tok/s）一次 2400 tokens 的非流式
        # 应答要 95-115s，整包等待很容易撞穿读超时；流式下超时只约束"两块之间"的停顿。
        # LLM_STREAM=0 可退回非流式（对照/排障用）。
        stream = self.env.get("LLM_STREAM", "1") != "0"
        if stream:
            payload["stream"] = True
            payload["stream_options"] = {"include_usage": True}
        # 国内 API（硅基流动/百炼/DeepSeek）需直连；默认不走系统代理，
        # 确需代理（如 Gemini）时设 LLM_TRUST_ENV=1。
        session = requests.Session()
        session.trust_env = self.env.get("LLM_TRUST_ENV", "") == "1"
        response = session.post(
            f"{route.base_url.rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=(
                float(self.env.get("LLM_CONNECT_TIMEOUT_SECONDS", "15")),
                float(self.env.get("LLM_TIMEOUT_SECONDS", "30")),
            ),
            stream=stream,
        )
        response.raise_for_status()
        if not stream:
            return response.json()
        return _collect_stream(response)

    def structured_chat(
        self,
        agent: str,
        system: str,
        user: str,
        *,
        temperature: float = 0.2,
        max_tokens: int = 2400,
    ) -> dict[str, Any] | None:
        """Call the routed model and parse a single JSON object from the reply.

        Returns None on any failure (route disabled, network error, unparsable
        output after the retries) so callers can fall back to the deterministic
        engine without special-casing error types.
        """
        if not self.is_enabled(agent):
            self._increment(disabled_calls=1)
            return None
        base_messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        messages = list(base_messages)
        budget = max_tokens
        for attempt in range(MAX_STRUCTURED_ATTEMPTS):
            self._increment(attempts=1)
            try:
                raw = self.chat(agent, messages, temperature=temperature, max_tokens=budget)
                usage = raw.get("usage") or {}
                self._increment(
                    api_successes=1,
                    prompt_tokens=int(usage.get("prompt_tokens") or 0),
                    completion_tokens=int(usage.get("completion_tokens") or 0),
                    total_tokens=int(usage.get("total_tokens") or 0),
                )
                content = raw["choices"][0]["message"]["content"]
                parsed = _parse_json_object(content)
                if parsed is not None:
                    self._increment(json_successes=1)
                    return parsed
                self._increment(parse_failures=1)
                finish = raw["choices"][0].get("finish_reason")
                logger.warning(
                    "structured_chat parse failure for %s (attempt %s): finish_reason=%s, %s chars, tail=%r",
                    agent, attempt + 1, finish, len(content), content[-80:],
                )
                # 尸检开关：LLM_PARSE_DUMP_DIR 设了就把解析失败的全文落盘
                dump_dir = self.env.get("LLM_PARSE_DUMP_DIR") or os.environ.get("LLM_PARSE_DUMP_DIR")
                if dump_dir:
                    try:
                        path = Path(dump_dir)
                        path.mkdir(parents=True, exist_ok=True)
                        (path / f"{agent}-a{attempt + 1}-{int(time.time() * 1000)}.txt").write_text(
                            content, encoding="utf-8")
                    except OSError:
                        pass
                if finish == "length":
                    # 截断不是"没听懂 JSON 格式"，是预算不够。把 1 万多字符的截断稿
                    # 塞回上下文再问一遍，只会让下一次更快撞顶（实测：生成智能体
                    # 连撞两次后整条降级成确定性兜底，把真实 LLM 口径污染了）。
                    # 正确做法＝原样重问 + 抬预算。
                    budget = min(int(budget * 1.5), MAX_STRUCTURED_TOKENS)
                    messages = list(base_messages)
                    continue
                messages.append({"role": "assistant", "content": content})
                messages.append({"role": "user", "content": JSON_ONLY_REMINDER})
            except Exception as exc:  # noqa: BLE001 - fallback path must never raise
                self._increment(request_failures=1)
                # 网络瞬断/超时也重试一次，第二次仍失败才降级
                logger.warning("structured_chat failed for %s (attempt %s): %s", agent, attempt + 1, exc)
        logger.warning("structured_chat gave up for %s after retry", agent)
        return None


def _collect_stream(response: requests.Response) -> dict[str, Any]:
    """把 SSE 分块拼回非流式同构的响应，调用方与遥测都不用改。

    必须按 bytes 切行：requests 的 iter_lines(decode_unicode=True) 走 str.splitlines()，
    会在 \\u2028 等 Unicode 行边界上把一条 data 行劈成两半，JSON 直接解析失败。
    """
    content: list[str] = []
    reasoning: list[str] = []
    finish_reason: str | None = None
    usage: dict[str, Any] = {}
    for raw_line in response.iter_lines(decode_unicode=False):
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            logger.warning("stream chunk is not valid JSON, skipped: %r", data[:120])
            continue
        if chunk.get("usage"):
            usage = chunk["usage"]
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            if delta.get("content"):
                content.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            if choice.get("finish_reason"):
                finish_reason = choice["finish_reason"]
    return {
        "choices": [
            {
                "message": {
                    "content": "".join(content),
                    "reasoning_content": "".join(reasoning),
                },
                "finish_reason": finish_reason,
            }
        ],
        "usage": usage,
    }


def _close_json(text: str) -> str:
    """给未闭合的 JSON 补右括号/引号（模型常在长输出末尾漏 `}`，finish_reason 仍是 stop）。"""
    stack: list[str] = []
    in_str = escaped = False
    for ch in text:
        if escaped:
            escaped = False
            continue
        if in_str:
            if ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]" and stack:
            stack.pop()
    if in_str:
        text += '"'
    return text + "".join("}" if ch == "{" else "]" for ch in reversed(stack))


def _parse_json_object(content: str) -> dict[str, Any] | None:
    text = content.strip()
    if text.startswith("```"):
        first_newline = text.find("\n")
        text = text[first_newline + 1 :] if first_newline != -1 else text
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    start = text.find("{")
    if start == -1:
        return None
    end = text.rfind("}")
    candidates = []
    # 围栏块可能夹在解释性正文中间（不在开头）——先抽围栏内容
    fenced = re.findall(r"```(?:json)?\s*\n(.*?)```", text, flags=re.DOTALL)
    candidates.extend(block.strip() for block in fenced if block.strip().startswith("{"))
    if end > start:
        candidates.append(text[start : end + 1])
    candidates.append(_close_json(text[start:].rstrip()))
    for cand in list(candidates):
        # 唯一的修补候选：非法转义。正文里的 LaTeX（\(、\[、\alpha）在 JSON 串里
        # 是非法转义序列，模型很爱写，而补成 \\ 只影响本来就解析不动的输入。
        #
        # 刻意不修的两类（试过，撤了）：尾逗号 `,\s*[}\]]` 与"丢了左引号的值"，
        # 两个规则都会在字符串正文里误伤——实测后者把一段正常文本里的引号
        # 挪了位（tmp/parsedump 那份样本）。这是评测口径的产物，宁可让它解析
        # 失败走重试，也不要静默改坏内容。
        repaired = re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", cand)
        if repaired != cand:
            candidates.append(repaired)
    for cand in candidates:
        try:
            parsed = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


llm_gateway = LLMGateway()
