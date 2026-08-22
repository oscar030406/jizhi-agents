"""造课工坊事件总线自检：no-op 安全、事件流、插话收发、落盘。"""
from __future__ import annotations

import json
import threading

from backend.services import course_studio as cs


def test_publish_is_noop_without_job():
    # CLI 直跑 build_curriculum / pytest 时没有任务在跑，埋点必须零副作用
    assert cs.current_job() is None
    cs.publish("lesson_start", "planner", lesson_id="x")  # 不抛即过
    assert cs.take_feedback("x") == []


def test_job_events_subscribe_and_log(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "RUNS_DIR", tmp_path)
    job = cs.StudioJob("demo")
    job.emit("lesson_start", "planner", lesson_id="l1")
    job.emit("judge_rejected", "judge", lesson_id="l1", notes=["无依据"])

    # 订阅：先补发历史，哨兵事件收尾
    got = []

    def _consume():
        for e in job.subscribe():
            got.append(e)

    t = threading.Thread(target=_consume, daemon=True)
    t.start()
    job.emit("course_done", "planner", lessons=1)
    t.join(timeout=5)
    assert [e["kind"] for e in got] == ["lesson_start", "judge_rejected", "course_done"]
    assert got[0]["agent"] == "策展台"  # 人格名在引擎侧统一映射
    assert got[1]["agent"] == "审核官"

    # 落盘：一行一事件，可回放
    lines = job.log_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    assert json.loads(lines[1])["notes"] == ["无依据"]


def test_feedback_inbox(tmp_path, monkeypatch):
    monkeypatch.setattr(cs, "RUNS_DIR", tmp_path)
    job = cs.StudioJob("demo")
    job.add_feedback("这节太深了", "l2")
    job.add_feedback("整体口语一点")  # 全局
    job.add_feedback("   ")  # 空白丢弃
    # l2 取走自己的 + 全局；再取为空（一次性消费）
    assert job.take_feedback("l2") == ["这节太深了", "整体口语一点"]
    assert job.take_feedback("l2") == []
    # 插话本身也是事件（观看者能看到自己的话进了流水线）
    kinds = [e["kind"] for e in job.events]
    assert kinds.count("feedback_received") == 2
