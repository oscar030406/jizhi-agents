# -*- coding: utf-8 -*-
"""teaching_aid_scout 的确定性部分：候选筛除、卡片校验、审核发布流。不打网络、不调模型。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.services import teaching_aid_scout as scout
from backend.services.practice_scout import ScoutError

CONCEPTS = {"llm_basics", "deep_learning", "rag"}


class FakeGateway:
    def __init__(self, payload):
        self.payload = payload

    def structured_chat(self, *a, **kw):
        return self.payload

    def is_enabled(self, _agent):
        return True

    def route_for(self, _agent):
        return SimpleNamespace(model="fake-model")


def candidate(**over):
    base = {
        "full_name": "poloclub/cnn-explainer",
        "html_url": "https://github.com/poloclub/cnn-explainer",
        "stars": 8000,
        "description": "Learning Convolutional Neural Networks with Interactive Visualization",
        "license": "MIT",
        "pushed_at": "2026-05-01",
        "demo_url": "https://poloclub.github.io/cnn-explainer/",
        "matched_keyword": "cnn explainer",
        "concept": "deep_learning",
        "readme_excerpt": "An interactive visualization system",
        "embeddable": True,
        "embed_note": "",
    }
    base.update(over)
    return base


def aid_payload(**over):
    base = {
        "repo": "poloclub/cnn-explainer",
        "concept": "deep_learning",
        "name": "卷积神经网络交互讲解",
        "what_it_shows": "把一张图片送进卷积网络后每一层的输出摊开显示。可以逐层看到卷积核在找什么。",
        "use_in_class": ["打开演示站选一张示例图片", "点开第一个卷积层看激活图", "换一张图片对比激活的位置"],
        "duration_minutes": 10,
        "level": "starter",
    }
    base.update(over)
    return base


# ---- 候选筛除 ----------------------------------------------------------------


@pytest.mark.parametrize(
    "over, expect",
    [
        ({}, None),
        ({"stars": 40}, "星数不足"),
        ({"pushed_at": "2020-01-01"}, "年未提交"),
        ({"description": "A curated list of awesome LLM papers"}, "清单类仓库"),
        ({"license": "无许可证信息", "demo_url": None}, "许可证不合格"),
        # 有公开演示站的放行：课堂上打开的是人家的网站，不是分发人家的代码
        ({"license": "无许可证信息"}, None),
    ],
)
def test_candidate_rejection(over, expect):
    reason = scout.candidate_rejection(candidate(**over), "2023-09-04")
    if expect is None:
        assert reason is None
    else:
        assert reason and expect in reason


def test_list_repo_detection():
    assert scout.is_list_repo("awesome-llm")
    assert scout.is_list_repo("A curated list of resources")
    assert not scout.is_list_repo("Interactive visualization of transformers")


# ---- 卡片门禁 ----------------------------------------------------------------


def valid_aid(**over):
    base = {
        "id": "poloclub-cnn-explainer",
        "concept": "deep_learning",
        "name": "卷积神经网络交互讲解",
        "what_it_shows": "两句话",
        "use_in_class": ["一", "二", "三"],
        "duration_minutes": 10,
        "level": "starter",
        "url": "https://github.com/poloclub/cnn-explainer",
        "demo_url": "https://poloclub.github.io/cnn-explainer/",
        "embeddable": True,
    }
    base.update(over)
    return base


@pytest.mark.parametrize(
    "over, expect",
    [
        ({}, None),
        ({"use_in_class": ["一", "二"]}, "3–5 步"),
        ({"concept": "not_a_concept"}, "概念不在本领域概念表内"),
        ({"level": "portfolio"}, "档位"),
        ({"duration_minutes": 90}, "课堂时长"),
        ({"embeddable": "yes"}, "embeddable 必须是布尔值"),
        ({"embeddable": True, "demo_url": None}, "没有演示站却标了可嵌入"),
        ({"name": ""}, "关键字段为空"),
    ],
)
def test_aid_errors(over, expect):
    errors = scout._aid_errors(valid_aid(**over), CONCEPTS)
    if expect is None:
        assert errors == []
    else:
        assert any(expect in e for e in errors), errors


# ---- 起草：只能从候选清单里选，事实字段由代码填 --------------------------------


def test_draft_cards_keeps_valid_and_fills_facts():
    kept, dropped = scout.draft_cards(
        FakeGateway({"aids": [aid_payload()]}), "ai", [candidate()], CONCEPTS, 5
    )
    assert dropped == []
    assert len(kept) == 1
    aid = kept[0]
    assert aid["id"] == "poloclub-cnn-explainer"
    assert aid["url"] == "https://github.com/poloclub/cnn-explainer"
    assert aid["demo_url"] == "https://poloclub.github.io/cnn-explainer/"
    assert aid["embeddable"] is True
    assert aid["approved"] is False
    assert aid["provenance"] == {
        "source": "github-api",
        "stars": 8000,
        "license": "MIT",
        "pushed_at": "2026-05-01",
    }


def test_draft_cards_rejects_repo_outside_candidates():
    with pytest.raises(ScoutError, match="全部未过校验"):
        scout.draft_cards(
            FakeGateway({"aids": [aid_payload(repo="evil/made-up")]}),
            "ai",
            [candidate()],
            CONCEPTS,
            5,
        )


def test_draft_cards_drops_bad_step_count():
    with pytest.raises(ScoutError, match="全部未过校验"):
        scout.draft_cards(
            FakeGateway({"aids": [aid_payload(use_in_class=["只有一步"])]}),
            "ai",
            [candidate()],
            CONCEPTS,
            5,
        )


# ---- 发布流：快照校验 + 门禁 --------------------------------------------------


@pytest.fixture()
def aid_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(scout, "AID_DIR", tmp_path)
    monkeypatch.setattr(scout, "concepts_for", lambda _c: sorted(CONCEPTS))
    return tmp_path


def write_draft(aids):
    doc = {
        "version": scout.DRAFT_SCHEMA_VERSION,
        "corpus": "ai",
        "status": "draft",
        "aids": aids,
    }
    doc["snapshot_id"] = scout._snapshot_id(scout._snapshot_payload([], [], aids))
    scout._write_json(scout.draft_path("ai"), doc)
    return doc


def test_approve_publishes_and_bumps_version(aid_dir):
    doc = write_draft([valid_aid()])
    result = scout.approve("ai", ["poloclub-cnn-explainer"], doc["snapshot_id"])
    assert result["current_version"] == 1
    assert result["release"]["aids"][0]["approved"] is True
    assert [a["id"] for a in scout.published_aids("ai")] == ["poloclub-cnn-explainer"]

    doc2 = write_draft([valid_aid(), valid_aid(id="b", name="第二个")])
    second = scout.approve("ai", ["poloclub-cnn-explainer", "b"], doc2["snapshot_id"])
    assert second["current_version"] == 2
    assert len(scout.published_aids("ai")) == 2
    assert [v["version"] for v in scout.release_history("ai")["versions"]] == [1, 2]


def test_approve_rejects_stale_snapshot(aid_dir):
    write_draft([valid_aid()])
    with pytest.raises(ScoutError, match="初稿已变化"):
        scout.approve("ai", ["poloclub-cnn-explainer"], "sha256:" + "0" * 64)


def test_approve_refuses_aid_failing_gate(aid_dir):
    doc = write_draft([valid_aid(embeddable="yes")])
    with pytest.raises(ScoutError, match="未过发布门禁"):
        scout.approve("ai", ["poloclub-cnn-explainer"], doc["snapshot_id"])


def test_published_rejects_tampered_release(aid_dir):
    doc = write_draft([valid_aid()])
    scout.approve("ai", ["poloclub-cnn-explainer"], doc["snapshot_id"])
    path = scout.release_path("ai")
    store = json.loads(path.read_text(encoding="utf-8"))
    store["versions"][0]["aids"][0]["name"] = "被人手改过的名字"
    path.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ScoutError, match="快照校验失败"):
        scout.published_aids("ai")


def test_published_empty_when_never_released(aid_dir):
    assert scout.published_aids("ai") == []
    assert scout.release_history("ai")["current_version"] is None


# ---- 演示站探测：只有明确允许才算能嵌 ------------------------------------------


@pytest.mark.parametrize(
    "headers, embeddable",
    [
        ({}, True),
        ({"X-Frame-Options": "DENY"}, False),
        ({"X-Frame-Options": "sameorigin"}, False),
        ({"Content-Security-Policy": "frame-ancestors 'none'"}, False),
        ({"Content-Security-Policy": "frame-ancestors 'self'"}, False),
        ({"Content-Security-Policy": "default-src *"}, True),
        ({"Content-Security-Policy": "frame-ancestors *"}, True),
    ],
)
def test_probe_embeddable(monkeypatch, headers, embeddable):
    class FakeResp:
        status_code = 200

        def __init__(self):
            self.headers = headers

        def close(self):
            pass

    monkeypatch.setattr(scout.requests, "get", lambda *a, **kw: FakeResp())
    assert scout.probe_embeddable("https://example.com")["embeddable"] is embeddable


def test_probe_embeddable_non_200(monkeypatch):
    class FakeResp:
        status_code = 404
        headers: dict = {}

        def close(self):
            pass

    monkeypatch.setattr(scout.requests, "get", lambda *a, **kw: FakeResp())
    probe = scout.probe_embeddable("https://example.com/gone")
    assert probe["embeddable"] is False and "404" in probe["reason"]


def test_demo_host():
    assert scout.demo_host("https://poloclub.github.io/cnn-explainer/") == "poloclub.github.io"
    assert scout.demo_host(None) == ""
