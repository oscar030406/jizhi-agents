"""造课工坊：把 build_curriculum 的生产过程变成可观测、可参与的直播。

三件事，一个文件（都很小，拆开反而难读）：
  1. 事件总线：build_curriculum 埋点 publish()，无任务在跑时是 no-op——
     CLI 直跑脚本、pytest 全程零感知。
  2. 任务：一次造课=一个 StudioJob，事件同时进内存（SSE 订阅）与
     data/studio_runs/<ts>_<concept>.jsonl（回放轨 + 赛题"协同决策中间数据"）。
  3. 插话收件箱：观看者对某课时提意见 → 注入该课时下一个生成回合的指令。
     **插话走与判官同一条门禁通道**：生成器参照插话改稿后，仍要过引用门禁 +
     独立判官——人的意见能改方向，不能塞进无据内容。这是与 MAIC 课堂互动的
     本质区别（他们的互动直接生成上屏）。

并发纪律：同一时间只允许一个任务在跑（生产烧真金白银，不做并行竞速）。
"""
from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterator

ROOT = Path(__file__).resolve().parents[2]
RUNS_DIR = ROOT / "data" / "studio_runs"

# 事件里的 agent 字段用人格名——前端不再自己映射，单一真源在引擎侧
AGENTS = {
    "retrieval": "检索员",
    "generator": "生成者",
    "judge": "审核官",
    "verifier": "机验官",
    "planner": "策展台",   # 大纲/流程性事件
    "human": "共建者",     # 观看者插话
}


class StudioJob:
    def __init__(self, concept: str, generator_model: str = "") -> None:
        self.job_id = uuid.uuid4().hex[:12]
        self.concept = concept
        self.generator_model = generator_model
        self.status = "running"  # running | done | failed
        self.error = ""
        self.events: list[dict[str, Any]] = []
        self._subscribers: list[queue.Queue] = []
        self._feedback: dict[str, list[str]] = {}  # lesson_id（或"*"）→ 未消费插话
        self._lock = threading.Lock()
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%S")
        self.log_path = RUNS_DIR / f"{stamp}_{concept}_{self.job_id}.jsonl"

    # ---------------- 事件
    def emit(self, kind: str, agent: str, **payload: Any) -> None:
        event = {
            "seq": len(self.events),
            "ts": round(time.time(), 3),
            "kind": kind,
            "agent": AGENTS.get(agent, agent),
            **payload,
        }
        with self._lock:
            self.events.append(event)
            with self.log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
            for q in self._subscribers:
                q.put(event)

    def subscribe(self) -> Iterator[dict[str, Any]]:
        """先补发历史，再跟直播。任务结束后由哨兵事件收尾。"""
        q: queue.Queue = queue.Queue()
        with self._lock:
            backlog = list(self.events)
            self._subscribers.append(q)
        try:
            yield from backlog
            while True:
                event = q.get()
                yield event
                if event["kind"] in ("course_done", "course_failed"):
                    return
        finally:
            with self._lock:
                if q in self._subscribers:
                    self._subscribers.remove(q)

    # ---------------- 插话
    def add_feedback(self, note: str, lesson_id: str = "*") -> None:
        note = note.strip()
        if not note:
            return
        with self._lock:
            self._feedback.setdefault(lesson_id, []).append(note)
        self.emit("feedback_received", "human", lesson_id=lesson_id, note=note)

    def take_feedback(self, lesson_id: str) -> list[str]:
        """取走该课时（含全局"*"）的未消费插话。"""
        with self._lock:
            notes = self._feedback.pop(lesson_id, []) + self._feedback.pop("*", [])
        return notes


_current: StudioJob | None = None
_jobs: dict[str, StudioJob] = {}
_run_lock = threading.Lock()


# ---------------- build_curriculum 埋点用的模块级函数（无任务在跑=全部 no-op）
def publish(kind: str, agent: str, **payload: Any) -> None:
    if _current is not None:
        _current.emit(kind, agent, **payload)


def take_feedback(lesson_id: str) -> list[str]:
    if _current is None:
        return []
    return _current.take_feedback(lesson_id)


def get_job(job_id: str) -> StudioJob | None:
    return _jobs.get(job_id)


def current_job() -> StudioJob | None:
    return _current


def start_job(concept: str, generator_model: str = "") -> StudioJob:
    """后台线程跑 build_semester_course。同时只允许一个任务。"""
    global _current
    with _run_lock:
        if _current is not None and _current.status == "running":
            raise RuntimeError(f"已有造课任务在跑：{_current.concept}（{_current.job_id}）")
        job = StudioJob(concept, generator_model)
        _jobs[job.job_id] = job
        _current = job

    def _run() -> None:
        global _current
        import os
        import sys

        os.environ.setdefault("AGENT_GENERATION_MODE", "api")
        if generator_model:
            os.environ["CURRICULUM_GENERATOR_MODEL"] = generator_model
        sys.path.insert(0, str(ROOT / "scripts"))
        try:
            job.emit("course_start", "planner", concept=concept,
                     generator_model=generator_model or "默认路由")
            from build_curriculum import OUT_DIR, build_catalog, build_semester_course

            course = build_semester_course(concept)
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            (OUT_DIR / f"{concept}.json").write_text(
                course.model_dump_json(indent=2), encoding="utf-8")
            catalog = build_catalog()
            (OUT_DIR / "catalog.json").write_text(
                catalog.model_dump_json(indent=2), encoding="utf-8")
            job.status = "done"
            lessons = [l for ch in course.chapters for l in ch.lessons]
            job.emit("course_done", "planner",
                     lessons=len(lessons),
                     minutes=course.minutes_total,
                     theory_exam=len(course.theory_exam),
                     course_id=course.course_id)
        except BaseException as exc:  # SystemExit 也要抓：未过门禁属于正常业务失败
            job.status = "failed"
            job.error = str(exc)
            job.emit("course_failed", "planner", error=str(exc)[:500])
        finally:
            with _run_lock:
                _current = None

    threading.Thread(target=_run, name=f"studio-{job.job_id}", daemon=True).start()
    return job
