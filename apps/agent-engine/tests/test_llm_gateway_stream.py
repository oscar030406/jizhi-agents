"""网关的传输层与解析层：SSE 拼装 + LLM 常见非法 JSON 的修补，不发真实请求。"""

import json

from backend.services.llm_gateway import LLMGateway, _collect_stream, _parse_json_object


class RecordingGateway(LLMGateway):
    """把 chat() 换成脚本化应答，用来验重试策略——不发真实请求。"""

    def __init__(self, replies):
        super().__init__(env={"AGENT_GENERATION_MODE": "api", "SILICONFLOW_API_KEY": "test"})
        self._replies = list(replies)
        self.calls = []

    def chat(self, agent, messages, *, temperature=0.2, max_tokens=1200, response_format=None):
        self.calls.append({"messages": list(messages), "max_tokens": max_tokens})
        content, finish = self._replies.pop(0)
        return {
            "choices": [{"message": {"content": content}, "finish_reason": finish}],
            "usage": {},
        }


def test_truncated_reply_retries_with_bigger_budget_and_clean_context():
    """finish_reason=length 是预算不够，不是格式没听懂——重问必须原样重问 + 抬预算。"""
    gateway = RecordingGateway([
        # 截在键名之后、值之前——补括号也救不回来（_close_json 的能力边界）
        ('{"a": 1, "b": {"c": ', "length"),
        ('{"a": 1}', "stop"),
    ])
    assert gateway.structured_chat("ResourceGenerationAgent", "sys", "user", max_tokens=6400) == {"a": 1}
    assert len(gateway.calls) == 2
    # 第二次预算抬了，且上下文没被那份截断稿撑大
    assert gateway.calls[1]["max_tokens"] > gateway.calls[0]["max_tokens"]
    assert len(gateway.calls[1]["messages"]) == 2


def test_malformed_reply_retries_with_json_reminder_and_gives_up_after_three():
    gateway = RecordingGateway([("裸文本", "stop")] * 3)
    assert gateway.structured_chat("ResourceGenerationAgent", "sys", "user") is None
    assert len(gateway.calls) == 3
    # 格式跑偏走的是"把上一版贴回去 + 提醒只出 JSON"这条路
    assert len(gateway.calls[1]["messages"]) == 4


class FakeResponse:
    """只实现 iter_lines(decode_unicode=False)——网关只用这一个口。"""

    def __init__(self, lines: list[bytes]):
        self._lines = lines

    def iter_lines(self, decode_unicode=False):  # noqa: ARG002 - 与 requests 同签名
        return iter(self._lines)


def _sse(payload: dict) -> bytes:
    return b"data: " + json.dumps(payload, ensure_ascii=False).encode("utf-8")


def test_collect_stream_concatenates_deltas_and_keeps_usage():
    response = FakeResponse([
        _sse({"choices": [{"delta": {"content": "前"}}]}),
        b"",
        _sse({"choices": [{"delta": {"reasoning_content": "想了想"}}]}),
        _sse({"choices": [{"delta": {"content": "半段"}, "finish_reason": "stop"}]}),
        _sse({"choices": [], "usage": {"total_tokens": 42}}),
        b"data: [DONE]",
    ])
    result = _collect_stream(response)
    assert result["choices"][0]["message"]["content"] == "前半段"
    assert result["choices"][0]["message"]["reasoning_content"] == "想了想"
    assert result["choices"][0]["finish_reason"] == "stop"
    assert result["usage"]["total_tokens"] == 42


def test_collect_stream_survives_unicode_line_separator_in_content():
    """\\u2028 曾经把 data 行劈成两半（str.splitlines 的 Unicode 行边界）——按 bytes 切就没事。"""
    response = FakeResponse([
        _sse({"choices": [{"delta": {"content": "上 下"}}]}),
        b"data: [DONE]",
    ])
    assert _collect_stream(response)["choices"][0]["message"]["content"] == "上 下"


def test_parse_json_object_repairs_latex_escape():
    # \( 在 JSON 字符串里是非法转义，模型写公式时常出现
    raw = '```json\n{"body": "设 \\(x\\) 为输入"}\n```'
    assert _parse_json_object(raw) == {"body": "设 \\(x\\) 为输入"}


def test_parse_json_object_does_not_mangle_text_when_unrepairable():
    """修补规则只补非法转义。补不动的畸形 JSON 一律返回 None 走重试，绝不猜着改内容。"""
    # 值丢了左引号——正确做法是重试，不是拿正则去猜边界（猜过，会挪动正文里的引号）
    assert _parse_json_object('{"a": 裸文本", "b": 1}') is None


def test_parse_json_object_leaves_valid_json_untouched():
    assert _parse_json_object('{"path": "a\\\\b", "nl": "x\\ny"}') == {"path": "a\\b", "nl": "x\ny"}
