"""伴学教练：判分压档、任务清单规整、缓存路径。模型调用用假网关。"""

from __future__ import annotations

import pytest

from backend.services import practice_coach as pc


class _FakeGateway:
    def __init__(self, parsed=None, reply=None, enabled=True):
        self.parsed = parsed
        self.reply = reply
        self.enabled = enabled

    def is_enabled(self, agent):
        return self.enabled

    def structured_chat(self, agent, system, user, **kw):
        return self.parsed

    def chat(self, agent, messages, **kw):
        return {"choices": [{"message": {"content": self.reply}}]}


TASK = {
    "id": "t1",
    "title": "读入数据",
    "brief": "写一个函数把文件读成列表",
    "criteria": ["用 open 读文件", "返回列表"],
    "hints": ["想想 open", "for line in f: ...", "def load(p):\n    with open(p) as f:\n        return [l.strip() for l in f]"],
}


def test_grade_caps_correct_after_reference_hint(monkeypatch):
    monkeypatch.setattr(pc, "LLMGateway", lambda: _FakeGateway(parsed={"verdict": "correct", "because": ["用了 open"], "problems": [], "next": "进入下一任务"}))
    plain = pc.grade_code(TASK, "def load(p):\n    with open(p) as f:\n        return [l.strip() for l in f]", hints_used=0)
    assert plain["verdict"] == "correct"
    capped = pc.grade_code(TASK, "def load(p):\n    with open(p) as f:\n        return [l.strip() for l in f]", hints_used=3)
    assert capped["verdict"] == "partial"
    assert any("第三级提示" in b for b in capped["because"])


def test_grade_rejects_garbage_and_short_code(monkeypatch):
    monkeypatch.setattr(pc, "LLMGateway", lambda: _FakeGateway(parsed={"verdict": "maybe"}))
    with pytest.raises(pc.CoachError):
        pc.grade_code(TASK, "def load(p):\n    return []", 0)
    with pytest.raises(pc.CoachError):
        pc.grade_code(TASK, "x", 0)


def test_grade_requires_enabled_route(monkeypatch):
    monkeypatch.setattr(pc, "LLMGateway", lambda: _FakeGateway(enabled=False))
    with pytest.raises(pc.CoachError):
        pc.grade_code(TASK, "def load(p):\n    return []", 0)


def test_tasks_path_sits_next_to_guide_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(pc.pg, "GUIDE_DIR", tmp_path)
    p = pc._tasks_path("ai", "owner-repo", "L1-e0-m4", 2)
    assert p.parent == tmp_path / "ai"
    assert p.name.endswith("-L1-e0-m4-m2-tasks.json")


def test_coach_chat_collects_only_known_citations(monkeypatch):
    fake = _FakeGateway(reply="先看 open 的用法（hl04s02#s3）。库外的（zz99#s1）不算。")
    monkeypatch.setattr(pc, "LLMGateway", lambda: fake)
    monkeypatch.setattr(pc.pg, "build_guide", lambda *a, **k: {"profile_key": "L1-e0-m4", "decisions": {"tier": "L1"}, "guide": {"milestones": [{"index": 1, "title": "跑通", "goal": "g", "build": [], "how": [], "acceptance": "a"}]}})
    monkeypatch.setattr(pc, "build_code_tasks", lambda *a, **k: {"tasks": [dict(TASK)]})
    monkeypatch.setattr(pc.pg, "_find_project", lambda c, p: {"name": "demo", "acceptance": "跑通"})
    monkeypatch.setattr(pc.pg, "_evidence", lambda *a, **k: [{"source_id": "hl04s02#s3", "title": "t", "excerpt": "e"}])
    out = pc.coach_chat("ai", "demo", {}, 1, "t1", [{"role": "user", "content": "之前问过"}], "open 怎么用")
    assert out["reply"].startswith("先看 open")
    assert out["cited"] == ["hl04s02#s3"]
