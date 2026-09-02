from __future__ import annotations

import pytest
from fastapi import HTTPException

from backend.api import practice_scout_routes as routes


COURSES = [{"id": "course-a", "title": "课程 A"}]


def test_approve_requires_current_domain_courses() -> None:
    with pytest.raises(HTTPException) as caught:
        routes.approve_draft(
            "domain-a",
            {"projectIds": ["project-a"], "draftSnapshotId": "sha256:current"},
        )

    assert caught.value.status_code == 400
    assert "courses" in str(caught.value.detail)


def test_approve_forwards_current_courses_and_returns_release_version(monkeypatch) -> None:
    seen = {}

    def approve(corpus, project_ids, courses, draft_snapshot_id):
        seen.update(
            corpus=corpus,
            project_ids=project_ids,
            courses=courses,
            draft_snapshot_id=draft_snapshot_id,
        )
        return {"corpus": corpus, "current_version": 4, "release": {"version": 4}}

    monkeypatch.setattr(routes.practice_scout, "approve", approve)

    got = routes.approve_draft(
        "domain-a",
        {
            "projectIds": ["project-a"],
            "draftSnapshotId": "sha256:current",
            "courses": COURSES,
        },
    )

    assert seen == {
        "corpus": "domain-a",
        "project_ids": ["project-a"],
        "courses": COURSES,
        "draft_snapshot_id": "sha256:current",
    }
    assert got["current_version"] == 4


def test_restore_requires_version_and_current_courses(monkeypatch) -> None:
    seen = {}

    def restore(corpus, version, courses):
        seen.update(corpus=corpus, version=version, courses=courses)
        return {
            "corpus": corpus,
            "current_version": 5,
            "release": {"version": 5, "restored_from_version": version},
        }

    monkeypatch.setattr(routes.practice_scout, "restore_release", restore)

    got = routes.restore_release("domain-a", {"version": 2, "courses": COURSES})

    assert seen == {"corpus": "domain-a", "version": 2, "courses": COURSES}
    assert got["release"]["restored_from_version"] == 2
