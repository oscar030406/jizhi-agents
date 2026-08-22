from fastapi.testclient import TestClient

from backend.main import app
from backend.services.llm_gateway import LLMGateway
from backend.services.model_routing import configured_model_plan, route_for


client = TestClient(app)


def _clear_strong_overrides(monkeypatch):
    # .env 会注入 LLM_PROVIDER_STRONG 等覆盖；测默认路由时先清掉，保证封闭
    for var in ["LLM_PROVIDER_STRONG", "LLM_MODEL_STRONG", "LLM_BASE_URL_STRONG", "LLM_API_KEY_ENV_STRONG"]:
        monkeypatch.delenv(var, raising=False)


def test_model_routes_default_to_deterministic_fallback(monkeypatch):
    _clear_strong_overrides(monkeypatch)
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    route = route_for("ResourceGenerationAgent")
    assert route.provider == "deepseek"
    assert route.model == "deepseek-chat"
    assert route.enabled is False


def test_model_route_enables_when_api_mode_has_key(monkeypatch):
    _clear_strong_overrides(monkeypatch)
    monkeypatch.setenv("AGENT_GENERATION_MODE", "api")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    route = route_for("ResourceGenerationAgent")
    assert route.enabled is True


def test_llm_gateway_blocks_calls_without_enabled_route(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    gateway = LLMGateway()
    assert gateway.is_enabled("ResourceGenerationAgent") is False


def test_configured_model_plan_is_public_safe(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "api")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "secret-value")
    plan = configured_model_plan()
    assert any(item["agent"] == "ResourceGenerationAgent" for item in plan)
    assert all("secret-value" not in str(item) for item in plan)


def test_model_routes_endpoint():
    response = client.get("/api/models/routes")
    assert response.status_code == 200
    data = response.json()
    assert any(item["agent"] == "ResourceGenerationAgent" for item in data)
