"""学情诊断结果的盘上缓存。

诊断本体是确定性规则，毫秒级；慢的是 fast 档模型做的「摘要与风险补充」
（线上实测单次 5～7 秒，报告页并发打两次）。同一份画像、同一个目标、同一份掌握度，
模型那句摘要没有理由每次重算——缓存键就是这三样的规范化 JSON。

只缓存 `engine == "llm+deterministic"` 的结果：模型路由不可用时退回的纯规则结果
不落盘，否则模型恢复后还一直回放降级版摘要。

并发去重：两条相同请求同时到达（报告页就是这么打的）只算一次，第二条等第一条落盘。

目录：`data/blueprint_cache/`，与 `knowledge_base/graph_cache` 同一套「数据目录里的派生物」
口径。`BLUEPRINT_CACHE_DIR` 可改位置，`BLUEPRINT_CACHE=0` 整体关掉（测试与排障用）。
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path
from typing import Any, Callable

from backend.services.concept_graph import KB_DIR

CACHEABLE_ENGINE = "llm+deterministic"

_inflight: dict[str, threading.Lock] = {}
_inflight_guard = threading.Lock()


def cache_dir() -> Path:
    override = os.environ.get("BLUEPRINT_CACHE_DIR", "").strip()
    return Path(override) if override else KB_DIR.parent / "blueprint_cache"


def enabled() -> bool:
    return os.environ.get("BLUEPRINT_CACHE", "1").strip() not in {"0", "false", "no", "off"}


def cache_key(request: dict[str, Any]) -> str:
    """请求参数的规范化哈希。字典按键排序、掌握度按概念排序，键顺序不影响命中。"""
    canonical = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _path(key: str) -> Path:
    return cache_dir() / f"{key}.json"


def read(key: str) -> dict[str, Any] | None:
    path = _path(key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    result = payload.get("result") if isinstance(payload, dict) else None
    return result if isinstance(result, dict) else None


def write(key: str, request: dict[str, Any], result: dict[str, Any]) -> bool:
    """只落盘可缓存的结果；写失败（只读盘）不影响主流程。"""
    if result.get("engine") != CACHEABLE_ENGINE:
        return False
    try:
        directory = cache_dir()
        directory.mkdir(parents=True, exist_ok=True)
        tmp = _path(key).with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps({"request": request, "result": result}, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(_path(key))
        return True
    except OSError:
        return False


def cached_call(request: dict[str, Any], compute: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """命中直接回；未命中算一次并落盘。相同键的并发调用串行，只算一次。"""
    if not enabled():
        return compute()
    key = cache_key(request)
    hit = read(key)
    if hit is not None:
        return hit
    with _inflight_guard:
        lock = _inflight.setdefault(key, threading.Lock())
    with lock:
        hit = read(key)
        if hit is not None:
            return hit
        result = compute()
        write(key, request, result)
        return result
