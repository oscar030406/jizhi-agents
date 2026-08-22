"""成本实测：telemetry→成本折算可手算复核；确定性模式成本必须为 0。"""
from backend.services.compare_service import compare_generate
from backend.services.cost_meter import cost_from_telemetry

GOAL = "学会搭一个带审核的 RAG 问答系统"


def test_cost_from_telemetry_manual_numbers():
    snap = {
        "prompt_tokens": 1_000_000,
        "completion_tokens": 500_000,
        "total_tokens": 1_500_000,
        "api_successes": 7,
    }
    report = cost_from_telemetry(snap, duration_ms=1234, model="Qwen/Qwen3-30B-A3B-Instruct-2507")
    # 1M × ¥0.7 + 0.5M × ¥2.8 = 0.7 + 1.4 = ¥2.1
    assert report.estimated_cost_cny == 2.1
    assert report.prompt_tokens == 1_000_000
    assert report.completion_tokens == 500_000
    assert report.total_tokens == 1_500_000
    assert report.api_calls == 7
    assert report.duration_ms == 1234
    assert "以账单为准" in report.notes


def test_cost_from_telemetry_unknown_model_uses_default():
    snap = {"prompt_tokens": 2_000_000, "completion_tokens": 0}
    report = cost_from_telemetry(snap)
    assert report.estimated_cost_cny == 1.4  # 默认档 ¥0.7/M input


def test_compare_deterministic_cost_is_zero(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    report = compare_generate(GOAL, ["zero_beginner", "backend_to_agent"])
    for entry in report.entries:
        assert entry.cost is not None
        assert entry.cost.estimated_cost_cny == 0
        assert entry.cost.total_tokens == 0
        assert entry.cost.duration_ms >= 0
