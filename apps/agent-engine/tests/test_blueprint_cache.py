"""学情诊断缓存：命中不重算、只缓存模型参与的结果、并发只算一次、可整体关掉。"""
import threading
import time

import pytest

from backend.services import blueprint_cache as bc


@pytest.fixture()
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("BLUEPRINT_CACHE_DIR", str(tmp_path))
    monkeypatch.delenv("BLUEPRINT_CACHE", raising=False)
    bc._inflight.clear()
    return tmp_path


def test_key_ignores_dict_order(cache_dir):
    a = {"learning_goal": "x", "concept_mastery": {"b": 0.2, "a": 0.9}}
    b = {"concept_mastery": {"a": 0.9, "b": 0.2}, "learning_goal": "x"}
    assert bc.cache_key(a) == bc.cache_key(b)
    assert bc.cache_key(a) != bc.cache_key({**a, "learning_goal": "y"})


def test_hit_skips_compute(cache_dir):
    calls = []

    def compute():
        calls.append(1)
        return {"engine": bc.CACHEABLE_ENGINE, "mastery_vector": {"a": 0.5}}

    req = {"learning_goal": "agent", "corpus": "ai"}
    first = bc.cached_call(req, compute)
    second = bc.cached_call(req, compute)
    assert first == second
    assert calls == [1]
    assert list(cache_dir.glob("*.json"))


def test_deterministic_only_result_is_not_cached(cache_dir):
    calls = []

    def compute():
        calls.append(1)
        return {"engine": "deterministic", "mastery_vector": {}}

    req = {"learning_goal": "agent"}
    bc.cached_call(req, compute)
    bc.cached_call(req, compute)
    assert calls == [1, 1]
    assert not list(cache_dir.glob("*.json"))


def test_disabled_by_env(cache_dir, monkeypatch):
    monkeypatch.setenv("BLUEPRINT_CACHE", "0")
    calls = []

    def compute():
        calls.append(1)
        return {"engine": bc.CACHEABLE_ENGINE}

    bc.cached_call({"g": 1}, compute)
    bc.cached_call({"g": 1}, compute)
    assert calls == [1, 1]


def test_concurrent_identical_requests_compute_once(cache_dir):
    calls = []
    gate = threading.Event()

    def compute():
        calls.append(1)
        gate.wait(2)
        return {"engine": bc.CACHEABLE_ENGINE, "n": 1}

    req = {"learning_goal": "same"}
    results = []
    threads = [threading.Thread(target=lambda: results.append(bc.cached_call(req, compute))) for _ in range(2)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    gate.set()
    for t in threads:
        t.join(5)
    assert calls == [1]
    assert results == [{"engine": bc.CACHEABLE_ENGINE, "n": 1}] * 2


def test_corrupt_file_is_treated_as_miss(cache_dir):
    req = {"learning_goal": "bad"}
    (cache_dir / f"{bc.cache_key(req)}.json").write_text("{not json", encoding="utf-8")
    out = bc.cached_call(req, lambda: {"engine": bc.CACHEABLE_ENGINE, "ok": True})
    assert out == {"engine": bc.CACHEABLE_ENGINE, "ok": True}
