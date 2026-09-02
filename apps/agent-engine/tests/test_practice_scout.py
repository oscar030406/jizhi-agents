# -*- coding: utf-8 -*-
"""practice_scout 的确定性部分：卡片校验丢弃、审核发布流。不打网络、不调模型。"""

from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from backend.services import practice_scout


class FakeGateway:
    def __init__(self, payload):
        self.payload = payload

    def structured_chat(self, *a, **kw):
        return self.payload


class FakeRunGateway(FakeGateway):
    def is_enabled(self, _agent):
        return True

    def route_for(self, _agent):
        return SimpleNamespace(model="fake-model")


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
    },
    {
        "full_name": "acme/advanced-repo",
        "html_url": "https://github.com/acme/advanced-repo",
        "stars": 567,
        "description": "advanced",
        "license": "Apache-2.0",
        "pushed_at": "2026-01-02",
        "matched_keyword": "advanced",
        "readme_excerpt": "advanced readme",
    },
    {
        "full_name": "acme/portfolio-repo",
        "html_url": "https://github.com/acme/portfolio-repo",
        "stars": 234,
        "description": "portfolio",
        "license": "MIT",
        "pushed_at": "2026-01-03",
        "matched_keyword": "portfolio",
        "readme_excerpt": "portfolio readme",
    },
]
COURSES = [{"id": "course-ai", "title": "AI 工程课"}]
JOBS = [{"id": "job-ai", "title": "AI 工程师"}]


def _card(repo="acme/good-repo", **over):
    base = {
        "repo": repo,
        "name": "任务",
        "level": "starter",
        "difficulty": 2,
        "hours": "8h",
        "prereq": "",
        "steps": ["拉取并安装项目依赖", "按 README 启动示例", "对照验收标准记录结果"],
        "courseIds": ["course-ai"],
        "jobIds": ["job-ai"],
        "cost": "",
        "networkNote": "",
        "why": "练什么",
        "acceptance": "验收",
        "deliverable": "产出",
        "resumeAdvice": "",
    }
    base.update(over)
    return base


def _tiered_cards(**over):
    return [
        _card(**over),
        _card(
            repo="acme/advanced-repo",
            name="进阶任务",
            level="advanced",
            difficulty=3,
            **over,
        ),
    ]


def test_attach_readmes_marks_one_failure_and_continues(monkeypatch):
    candidates = [dict(CANDIDATES[0]), dict(CANDIDATES[1])]

    def fake_get(_session, url, **_kwargs):
        if "good-repo" in url:
            raise practice_scout.ScoutError("GitHub README 404")
        return SimpleNamespace(text="advanced README")

    monkeypatch.setattr(practice_scout, "_get", fake_get)

    practice_scout.attach_readmes(object(), candidates)

    assert "README 拉取失败" in candidates[0]["readme_excerpt"]
    assert "404" in candidates[0]["readme_excerpt"]
    assert candidates[1]["readme_excerpt"] == "advanced README"


def test_draft_cards_drops_invented_repo_and_fills_facts_from_api_data():
    gw = FakeGateway(
        {"projects": _tiered_cards() + [_card(repo="acme/invented", level="portfolio")]}
    )
    kept, dropped = practice_scout.draft_cards(gw, "c", "s", CANDIDATES, COURSES, JOBS, 6)
    assert len(kept) == 2 and len(dropped) == 1
    assert "不在候选清单内" in dropped[0]["reasons"][0]
    # 事实字段来自 API 数据，不来自模型
    p = kept[0]
    assert p["org"] == "acme（1.2k★）"
    assert p["links"] == [{"label": "仓库", "url": "https://github.com/acme/good-repo"}]
    assert p["steps"] == ["拉取并安装项目依赖", "按 README 启动示例", "对照验收标准记录结果"]
    assert p["courseIds"] == ["course-ai"] and p["jobIds"] == ["job-ai"]
    assert p["approved"] is False


def test_draft_cards_drops_second_repo_with_same_normalized_project_id():
    first = {
        **CANDIDATES[0],
        "full_name": "acme/foo_bar",
        "html_url": "https://github.com/acme/foo_bar",
    }
    collision = {
        **CANDIDATES[2],
        "full_name": "acme/foo.bar",
        "html_url": "https://github.com/acme/foo.bar",
    }
    candidates = [first, collision, CANDIDATES[1]]
    cards = [
        _card(repo="acme/foo_bar"),
        _card(repo="acme/foo.bar", level="portfolio", difficulty=4),
        _card(
            repo="acme/advanced-repo",
            name="进阶任务",
            level="advanced",
            difficulty=3,
        ),
    ]

    kept, dropped = practice_scout.draft_cards(
        FakeGateway({"projects": cards}), "c", "s", candidates, COURSES, JOBS, 6
    )

    assert [item["id"] for item in kept] == ["acme-foo-bar", "acme-advanced-repo"]
    assert len(dropped) == 1
    assert "项目 ID 冲突" in " ".join(dropped[0]["reasons"])


def test_draft_cards_drops_project_outside_three_to_six_nonempty_steps():
    gw = FakeGateway(
        {
            "projects": [
                _card(
                    repo="acme/portfolio-repo",
                    level="portfolio",
                    difficulty=4,
                    steps=["只写了一步", " "],
                ),
                *_tiered_cards(),
            ]
        }
    )
    kept, dropped = practice_scout.draft_cards(gw, "c", "s", CANDIDATES, COURSES, JOBS, 6)
    assert len(kept) == 2 and len(dropped) == 1
    assert "steps" in " ".join(dropped[0]["reasons"])


def test_draft_cards_all_invalid_raises():
    gw = FakeGateway({"projects": [_card(level="bogus")]})
    with pytest.raises(practice_scout.ScoutError):
        practice_scout.draft_cards(gw, "c", "s", CANDIDATES, COURSES, JOBS, 6)


@pytest.mark.parametrize("step_count", [3, 6])
def test_draft_cards_accepts_three_or_six_steps(step_count):
    kept, dropped = practice_scout.draft_cards(
        FakeGateway({"projects": _tiered_cards(steps=[f"步骤 {i}" for i in range(step_count)])}),
        "c", "s", CANDIDATES, COURSES, JOBS, 6,
    )
    assert len(kept) == 2 and dropped == []


def test_draft_cards_drops_malformed_card_without_hiding_error():
    malformed = _card(
        repo="acme/portfolio-repo",
        level="portfolio",
        difficulty="hard",
    )
    kept, dropped = practice_scout.draft_cards(
        FakeGateway({"projects": [malformed, *_tiered_cards()]}),
        "c", "s", CANDIDATES, COURSES, JOBS, 6,
    )
    assert {item["level"] for item in kept} == {"starter", "advanced"}
    assert len(dropped) == 1 and "difficulty" in " ".join(dropped[0]["reasons"])


def test_draft_cards_rejects_missing_required_level_and_excess_count():
    with pytest.raises(practice_scout.ScoutError, match="advanced"):
        practice_scout.draft_cards(
            FakeGateway({"projects": [_card()]}),
            "c", "s", CANDIDATES, COURSES, JOBS, 6,
        )

    three = _tiered_cards() + [
        _card(repo="acme/portfolio-repo", level="portfolio", difficulty=4)
    ]
    with pytest.raises(practice_scout.ScoutError, match="数量"):
        practice_scout.draft_cards(
            FakeGateway({"projects": three}),
            "c", "s", CANDIDATES, COURSES, JOBS, 2,
        )


def test_draft_cards_allows_empty_jobs_but_never_unknown_ids():
    kept, dropped = practice_scout.draft_cards(
        FakeGateway({"projects": _tiered_cards(jobIds=[])}),
        "c",
        "s",
        CANDIDATES,
        COURSES,
        [],
        6,
    )
    assert len(kept) == 2 and dropped == [] and all(not item["jobIds"] for item in kept)

    kept, dropped = practice_scout.draft_cards(
        FakeGateway(
            {
                "projects": [
                    _card(courseIds=["course-other"]),
                    _card(jobIds=["job-other"]),
                    _card(courseIds=[]),
                    _card(jobIds=[]),
                    *_tiered_cards(),
                ]
            }
        ),
        "c",
        "s",
        CANDIDATES,
        COURSES,
        JOBS,
        6,
    )
    assert len(kept) == 2
    assert "未知或越域课程 ID" in dropped[0]["reasons"][0]
    assert "未知或越域岗位 ID" in dropped[1]["reasons"][0]
    assert "至少关联一个 课程 ID" in dropped[2]["reasons"][0]
    assert "至少关联一个 岗位 ID" in dropped[3]["reasons"][0]


@pytest.mark.parametrize(
    ("skill_jobs", "card_job_ids", "expected_jobs"),
    [
        ([{"job_id": "job-ai", "title": "AI 工程师"}], ["job-ai"], JOBS),
        ([], [], []),
    ],
)
def test_run_draft_uses_current_corpus_jobs_and_persists_candidate_snapshot(
    tmp_path, monkeypatch, skill_jobs, card_job_ids, expected_jobs
):
    seen_domains = []
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    monkeypatch.setattr(
        practice_scout,
        "LLMGateway",
        lambda: FakeRunGateway({"projects": _tiered_cards(jobIds=card_job_ids)}),
    )
    monkeypatch.setattr(practice_scout, "suggest_keywords", lambda *args: ["tutorial"])
    monkeypatch.setattr(practice_scout, "search_candidates", lambda *args: CANDIDATES)
    monkeypatch.setattr(practice_scout, "attach_readmes", lambda *args: None)
    monkeypatch.setattr(practice_scout, "_session", lambda: object())

    def fake_skill_map(domain):
        seen_domains.append(domain)
        return {"jobs": skill_jobs}

    monkeypatch.setattr(practice_scout, "skill_map_api", fake_skill_map)
    doc = practice_scout.run_draft("smart-manufacturing", "制造", [], COURSES, count=4)

    assert seen_domains == ["smart-manufacturing"]
    assert doc["version"] == 3
    assert doc["course_candidates"] == COURSES
    assert doc["job_candidates"] == expected_jobs
    assert doc["projects"][0]["jobIds"] == card_job_ids
    assert json.loads((tmp_path / "smart-manufacturing.json").read_text(encoding="utf-8"))[
        "job_candidates"
    ] == expected_jobs


def _write_draft(tmp_path, corpus="x", projects=None, courses=None, jobs=None):
    doc = {
        "version": 3,
        "corpus": corpus,
        "status": "draft",
        "generated_at": "2026-09-01T00:00:00+00:00",
        "course_candidates": courses if courses is not None else COURSES,
        "job_candidates": jobs if jobs is not None else JOBS,
        "projects": projects if projects is not None else [_card(id="a")],
    }
    doc["snapshot_id"] = practice_scout._snapshot_id(
        practice_scout._snapshot_payload(
            doc["course_candidates"], doc["job_candidates"], doc["projects"]
        )
    )
    (tmp_path / f"{corpus}.json").write_text(
        json.dumps(doc, ensure_ascii=False), encoding="utf-8"
    )
    return doc


def _current_jobs(monkeypatch, jobs=None):
    normalized = jobs if jobs is not None else JOBS
    monkeypatch.setattr(
        practice_scout,
        "skill_map_api",
        lambda _corpus: {
            "jobs": [
                {"job_id": item["id"], "title": item["title"]}
                for item in normalized
            ]
        },
    )


def test_new_draft_does_not_replace_live_release_and_approve_versions_it(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    first_draft = _write_draft(tmp_path, projects=[_card(id="a")])

    first = practice_scout.approve("x", ["a"], COURSES, first_draft["snapshot_id"])
    assert first["current_version"] == 1
    assert first["release"]["status"] == "published"
    assert [p["id"] for p in practice_scout.published_projects("x")] == ["a"]

    # 新草稿只改工作区，学习端继续读 v1。
    second_draft = _write_draft(tmp_path, projects=[_card(id="b", name="第二版任务")])
    assert [p["id"] for p in practice_scout.published_projects("x")] == ["a"]

    second = practice_scout.approve("x", ["b"], COURSES, second_draft["snapshot_id"])
    assert second["current_version"] == 2
    assert [p["id"] for p in practice_scout.published_projects("x")] == ["b"]

    # 空数组也形成可恢复的下架版本，不删除历史。
    unpublished = practice_scout.approve("x", [], COURSES, second_draft["snapshot_id"])
    assert unpublished["current_version"] == 3
    assert unpublished["release"]["status"] == "unpublished"
    assert practice_scout.published_projects("x") == []
    assert [item["version"] for item in practice_scout.release_history("x")["versions"]] == [
        1,
        2,
        3,
    ]


def test_restore_appends_exact_historical_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    original = _card(id="a", name="第一版任务")
    first_draft = _write_draft(tmp_path, projects=[original])
    v1 = practice_scout.approve(
        "x", ["a"], COURSES, first_draft["snapshot_id"]
    )["release"]

    second_draft = _write_draft(tmp_path, projects=[_card(id="b", name="第二版任务")])
    practice_scout.approve("x", ["b"], COURSES, second_draft["snapshot_id"])

    restored = practice_scout.restore_release("x", 1, COURSES)

    assert restored["current_version"] == 3
    assert restored["release"]["restored_from_version"] == 1
    assert restored["release"]["snapshot_id"] == v1["snapshot_id"]
    assert restored["release"]["projects"] == v1["projects"]
    assert practice_scout.published_projects("x") == v1["projects"]


@pytest.mark.parametrize(
    ("current_courses", "current_jobs", "message"),
    [
        ([{"id": "course-new", "title": "新课"}], JOBS, "课程候选已失效"),
        (COURSES, [{"id": "job-new", "title": "新岗位"}], "岗位候选已失效"),
    ],
)
def test_approve_rejects_stale_draft_candidate_ids(
    tmp_path, monkeypatch, current_courses, current_jobs, message
):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch, current_jobs)
    draft = _write_draft(tmp_path)

    with pytest.raises(practice_scout.ScoutError, match=message):
        practice_scout.approve("x", ["a"], current_courses, draft["snapshot_id"])


def test_published_projects_empty_when_no_draft(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    assert practice_scout.published_projects("nope") == []


def test_approve_rejects_project_without_executable_steps(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    legacy = _card(id="legacy", steps=[])
    draft = _write_draft(tmp_path, projects=[legacy])

    with pytest.raises(practice_scout.ScoutError, match="3–6"):
        practice_scout.approve("x", ["legacy"], COURSES, draft["snapshot_id"])


def test_approve_revalidates_project_candidate_boundaries(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    project = _card(id="cross-domain", courseIds=["course-other"])
    draft = _write_draft(tmp_path, projects=[project])
    with pytest.raises(practice_scout.ScoutError, match="越域课程"):
        practice_scout.approve(
            "x", ["cross-domain"], COURSES, draft["snapshot_id"]
        )


def test_old_draft_schema_is_not_accepted_as_release_input(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    (tmp_path / "x.json").write_text(
        json.dumps(
            {
                "version": 2,
                "corpus": "x",
                "course_candidates": COURSES,
                "job_candidates": JOBS,
                "projects": [_card(id="legacy")],
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(practice_scout.ScoutError, match="草稿版本"):
        practice_scout.approve("x", ["legacy"], COURSES, "sha256:legacy")


def test_approve_rejects_page_opened_before_draft_changed(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    viewed = _write_draft(tmp_path, projects=[_card(id="a", name="管理员看到的版本")])
    _write_draft(tmp_path, projects=[_card(id="a", name="后来生成的版本")])

    with pytest.raises(practice_scout.ScoutError, match="初稿已变化"):
        practice_scout.approve("x", ["a"], COURSES, viewed["snapshot_id"])


def test_concurrent_approvals_append_without_lost_versions(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    draft = _write_draft(tmp_path)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(
            pool.map(
                lambda _index: practice_scout.approve(
                    "x", ["a"], COURSES, draft["snapshot_id"]
                ),
                range(6),
            )
        )

    assert sorted(result["current_version"] for result in results) == list(range(1, 7))
    history = practice_scout.release_history("x")
    assert history["current_version"] == 6
    assert [version["version"] for version in history["versions"]] == list(range(1, 7))


def test_draft_replace_and_approve_are_serialized_by_same_corpus_lock(tmp_path, monkeypatch):
    monkeypatch.setattr(practice_scout, "DRAFT_DIR", tmp_path)
    _current_jobs(monkeypatch)
    viewed = _write_draft(tmp_path, projects=[_card(id="a", name="管理员看到的版本")])
    monkeypatch.setattr(
        practice_scout,
        "LLMGateway",
        lambda: FakeRunGateway({"projects": _tiered_cards()}),
    )
    monkeypatch.setattr(practice_scout, "suggest_keywords", lambda *args: ["tutorial"])
    monkeypatch.setattr(practice_scout, "search_candidates", lambda *args: CANDIDATES)
    monkeypatch.setattr(practice_scout, "attach_readmes", lambda *args: None)
    monkeypatch.setattr(practice_scout, "_session", lambda: object())

    writer_holds_lock = threading.Event()
    release_writer = threading.Event()
    approval_read = threading.Event()
    original_write = practice_scout._write_json
    original_require = practice_scout._require_draft

    def delayed_draft_replace(path, doc):
        if path == practice_scout.draft_path("x"):
            writer_holds_lock.set()
            assert release_writer.wait(2)
        original_write(path, doc)

    def observed_require(corpus):
        approval_read.set()
        return original_require(corpus)

    monkeypatch.setattr(practice_scout, "_write_json", delayed_draft_replace)
    monkeypatch.setattr(practice_scout, "_require_draft", observed_require)

    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(
            practice_scout.run_draft,
            "x",
            "测试领域",
            [],
            COURSES,
            4,
        )
        assert writer_holds_lock.wait(2)
        approval = pool.submit(
            practice_scout.approve,
            "x",
            ["a"],
            COURSES,
            viewed["snapshot_id"],
        )
        try:
            assert not approval_read.wait(0.2), "审核在草稿替换尚未完成时读到了旧快照"
        finally:
            release_writer.set()
        writer.result(timeout=2)
        assert approval_read.wait(2)
        with pytest.raises(practice_scout.ScoutError, match="初稿已变化"):
            approval.result(timeout=2)
