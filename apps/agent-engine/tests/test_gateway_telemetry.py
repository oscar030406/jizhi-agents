from backend.services.llm_gateway import MAX_STRUCTURED_ATTEMPTS, LLMGateway


def test_gateway_telemetry_counts_parse_failures_and_retries(monkeypatch):
    gateway = LLMGateway(env={})
    monkeypatch.setattr(gateway, "is_enabled", lambda agent: True)
    monkeypatch.setattr(
        gateway,
        "chat",
        lambda *args, **kwargs: {
            "choices": [{"message": {"content": "not-json"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14},
        },
    )

    result = gateway.structured_chat("ResourceGenerationAgent", "system", "user")
    snapshot = gateway.telemetry_snapshot()

    assert result is None
    assert snapshot["attempts"] == MAX_STRUCTURED_ATTEMPTS
    assert snapshot["api_successes"] == MAX_STRUCTURED_ATTEMPTS
    assert snapshot["parse_failures"] == MAX_STRUCTURED_ATTEMPTS
    assert snapshot["json_successes"] == 0
    assert snapshot["prompt_tokens"] == 10 * MAX_STRUCTURED_ATTEMPTS
    assert snapshot["completion_tokens"] == 4 * MAX_STRUCTURED_ATTEMPTS
    assert snapshot["total_tokens"] == 14 * MAX_STRUCTURED_ATTEMPTS


def test_gateway_telemetry_counts_json_success(monkeypatch):
    gateway = LLMGateway(env={})
    monkeypatch.setattr(gateway, "is_enabled", lambda agent: True)
    monkeypatch.setattr(
        gateway,
        "chat",
        lambda *args, **kwargs: {
            "choices": [{"message": {"content": '{"ok": true}'}}],
            "usage": {"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
        },
    )

    assert gateway.structured_chat("LearnerDiagnosisAgent", "system", "user") == {"ok": True}
    snapshot = gateway.telemetry_snapshot()

    assert snapshot["attempts"] == 1
    assert snapshot["json_successes"] == 1
    assert snapshot["request_failures"] == 0
    gateway.reset_telemetry()
    assert gateway.telemetry_snapshot()["attempts"] == 0


def test_gateway_telemetry_counts_request_failures(monkeypatch):
    gateway = LLMGateway(env={})
    monkeypatch.setattr(gateway, "is_enabled", lambda agent: True)

    def fail(*args, **kwargs):
        raise TimeoutError("timeout")

    monkeypatch.setattr(gateway, "chat", fail)

    assert gateway.structured_chat("ContentAuditAgent", "system", "user") is None
    snapshot = gateway.telemetry_snapshot()
    assert snapshot["attempts"] == MAX_STRUCTURED_ATTEMPTS
    assert snapshot["request_failures"] == MAX_STRUCTURED_ATTEMPTS
    assert snapshot["api_successes"] == 0
