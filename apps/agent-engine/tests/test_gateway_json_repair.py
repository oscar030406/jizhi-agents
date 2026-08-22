"""网关 JSON 解析容错：模型漏右括号（finish_reason=stop）时确定性补全。"""
from backend.services.llm_gateway import _close_json, _parse_json_object


def test_parse_valid_object():
    assert _parse_json_object('{"a": 1}') == {"a": 1}


def test_parse_fenced_block():
    assert _parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}


def test_repair_missing_closing_brace():
    # 真实事故形态（2026-07-20 消融试点）：对象结尾停在数组的 "] 上
    broken = '{"diagnosis_summary": "总结", "extra_risks": ["风险一", "风险二"]'
    assert _parse_json_object(broken) == {"diagnosis_summary": "总结", "extra_risks": ["风险一", "风险二"]}


def test_repair_unclosed_string_and_braces():
    assert _parse_json_object('{"a": {"b": ["c"') == {"a": {"b": ["c"]}}


def test_close_json_ignores_braces_inside_strings():
    assert _close_json('{"a": "b{[\\"x"') == '{"a": "b{[\\"x"}'


def test_fence_embedded_in_prose():
    # 真实事故形态：解释性正文 + ```json 围栏（围栏不在开头）
    content = '好的，以下是生成结果：\n```json\n{"a": [1, 2]}\n```\n希望有帮助。'
    assert _parse_json_object(content) == {"a": [1, 2]}


def test_bare_array_still_rejected():
    assert _parse_json_object('["not", "an", "object"]') is None


def test_garbage_rejected():
    assert _parse_json_object("完全不是 JSON") is None
