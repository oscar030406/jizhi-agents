# -*- coding: utf-8 -*-
"""practice_scout 的确定性部分：卡片校验丢弃、审核发布流。不打网络、不调模型。"""

from __future__ import annotations

import json

import pytest

from backend.services import practice_scout


class FakeGateway:
    def __init__(self, payload):
        self.payload = payload

    def structured_chat(self, *a, **kw):
        return self.payload


CANDIDATES = [
    {
        "full_name": "acme/good-repo",
        "html_url": "https://github.com/acme/good-repo",
        "stars": 1234,
        "description": "d",
        "license": "MIT",
        "pushed_at": "2026-01-01",
        "matched_keyword": "kw",
        "readme_excerpt": "r",
    }
]


def _card(repo="acme/good-repo", **over):
    base = {
        "repo": repo,
        "name": "任务",
        "level": "starter",
        "difficulty": 2,
        "hours": "8h",
        "prereq": "",
        "steps": ["拉取并安装项目依赖", "按 README 启动示例", "对照验收标准记录结果"],
        "cost": "",
        "networkNote": "",
        "why": "练什么",
        "acceptance": "验收",
        "deliverable": "产出",
        "resumeAdvice": "",
    }
    base.update(over)
    return base


def test_draft_cards_drops_invented_repo_and_fills_facts_from_api_data():
    gw = FakeGateway({"projects": [_card(), _card(repo="acme/invented")]})
    kept, dropped = practice_scout.draft_cards(gw, "c", "s", CANDIDATES, 6)
    assert len(kept) == 1 and len(dropped) == 1
    assert "不在候选清单内" in dropped[0]["reasons"][0]
    # 事实字段来自 API 数据，不来自模型
    p = kept[0]
    assert p["org"] == "acme（1.2k★）"
    assert p["links"] == [{"label": "仓库", "url": "https://github.com/acme/good-repo"}]
    assert p["steps"] == ["拉取并安装项目依赖", "按 README 启动示例", "对照验收标准记录结果"]
    assert p["approved"] is False


def test_draft_cards_drops_project_with_fewer_than_two_nonempty_steps():
    gw = FakeGateway(
        {"projects": [_card(steps=["只写了一步", " "]), _card(name="有效任务")]}
    )
    kept, dropped = practice_scout.draft_cards(gw, "c", "s", CANDIDATES, 6)
    assert len(kept) == 1 and len(dropped) == 1
    assert dropped[0]["reasons"] == ["可执行步骤少于 2 条"]


def test_draft_cards_all_invalid_raises():
    gw = FakeGateway({"projects": [_card(level="bogus")]})
    with pytest.raises(practice_scout.ScoutError):
        practice_scout.draft_cards(gw, "c", "s", CANDIDATES, 6)


def test_approve_publish_and_unpublish_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    doc = {
        "version": 1,
        "corpus": "x",
        "status": "draft",
        "projects": [{"id": "a", "approved": False}, {"id": "b", "approved": False}],
    }
    (tmp_path / "x.json").write_text(json.dumps(doc), encoding="utf-8")

    out = practice_scout.approve("x", ["a"])
    assert out["status"] == "published"
    assert [p["id"] for p in practice_scout.published_projects("x")] == ["a"]

    # 空数组 = 全部下架，学习端拿到空清单
    out = practice_scout.approve("x", [])
    assert out["status"] == "draft"
    assert practice_scout.published_projects("x") == []


def test_published_projects_empty_when_no_draft(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    assert practice_scout.published_projects("nope") == []
