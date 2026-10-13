"""按请求生效的执行上限（调度实验用，默认不生效）。

调用方（课堂端）给模型调用设的超时是它自己的：它放弃等待并不会让引擎停下来。
线上 2026-09-23 的日志里就有一次 practice-guide 在引擎跑满 228.1 秒，而路由那边
170 秒就已经断开。队列实验要的是「上限真的把服务器释放出来」，所以上限得在引擎侧生效。

用法：请求带 `x-sched-deadline-ms` 头，本模块把截止时刻放进 contextvar，
模型网关在每次调用前按剩余时间压超时、剩余为 0 就不再重试。
不带这个头时 `remaining_seconds()` 返回 None，所有调用路径与改造前一致。

contextvar 会随 Starlette 的 `run_in_threadpool` 复制进工作线程，
所以同步 handler 也能读到。
"""

from __future__ import annotations

import time
from contextvars import ContextVar

_DEADLINE: ContextVar[float | None] = ContextVar("sched_call_deadline", default=None)

HEADER = "x-sched-deadline-ms"


def set_deadline_ms(budget_ms: float | None) -> None:
    """从现在起 budget_ms 毫秒后到期；None = 不设上限。"""
    _DEADLINE.set(None if budget_ms is None else time.monotonic() + budget_ms / 1000.0)


def deadline_from_header(value: str | None) -> None:
    if not value:
        _DEADLINE.set(None)
        return
    try:
        budget = float(value)
    except (TypeError, ValueError):
        _DEADLINE.set(None)
        return
    set_deadline_ms(budget if budget > 0 else None)


def remaining_seconds() -> float | None:
    """还剩多少秒；没设上限返回 None，已经超了返回 0.0。"""
    deadline = _DEADLINE.get()
    if deadline is None:
        return None
    return max(0.0, deadline - time.monotonic())


def expired() -> bool:
    remaining = remaining_seconds()
    return remaining is not None and remaining <= 0.0
