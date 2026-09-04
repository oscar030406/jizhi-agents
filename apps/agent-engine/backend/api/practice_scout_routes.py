"""域级实操项目侦察的 HTTP 面：起草（写）、读取、审核发布（写）。

权限与 intake_routes 同一套：写入口走 `verify_internal_token`（classroom 的
manager 桥带 GROUNDING_TOKEN 代理过来），读端点只读不鉴权（草稿内容全是公开
仓库信息，无敏感数据）。

起草是同步的（GitHub 搜索 + 两次模型调用，实测约 1-2 分钟）：管理端点按钮后
转圈等待即可，不值得为一个低频管理操作建后台任务 + 轮询链。桥的超时要放到
180s 以上。
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from backend.integration.personalize_api import verify_internal_token
from backend.services import practice_scout

router = APIRouter(prefix="/api/practice-scout", tags=["practice-scout"])


def _corpus_meta(corpus: str) -> tuple[str, list[str]]:
    """从域注册清单拿 scope，从语料索引抽主题样本；库不存在就 404。"""
    import json
    from collections import Counter
    from pathlib import Path

    from backend.rag.ingest import read_index_rows

    root = Path(practice_scout.ROOT)
    registry = root / "data" / "knowledge_base" / "domain_registry.json"
    scope = ""
    known = False
    if registry.exists():
        for entry in json.loads(registry.read_text(encoding="utf-8")).get("corpora", []):
            if entry.get("corpus") == corpus:
                scope = entry.get("scope") or entry.get("label") or ""
                known = True
                break
    index = root / "data" / "knowledge_base" / "corpora" / corpus / "knowledge_index.jsonl"
    if not known and not index.exists():
        raise HTTPException(status_code=404, detail=f"未知语料库：{corpus}")
    topics: Counter[str] = Counter()
    if index.exists():
        for row in read_index_rows(index):  # 唯一入口，归档块过滤同源
            if row.get("topic"):
                topics[row["topic"]] += 1
    return scope, [t for t, _ in topics.most_common(20)]


@router.post("/{corpus}/draft", dependencies=[Depends(verify_internal_token)])
def create_draft(corpus: str, payload: dict = Body(default={})) -> dict:
    scope, topics = _corpus_meta(corpus)
    courses = payload.get("courses")
    if not isinstance(courses, list):
        raise HTTPException(status_code=400, detail="courses 必须是课程 {id,title} 数组（可为空）")
    try:
        count = int(payload.get("count") or 6)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="count 必须是整数") from exc
    try:
        return practice_scout.run_draft(
            corpus,
            scope,
            topics,
            courses,
            count=max(3, min(10, count)),
        )
    except practice_scout.ScoutError as exc:
        # 失败必须对管理端可见——网络不通/模型未启用都不许静默成空结果
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/{corpus}")
def read_draft(corpus: str) -> dict:
    doc = practice_scout.load_draft(corpus)
    if not doc:
        return {
            "corpus": corpus,
            "status": "none",
            "projects": [],
            "publication": practice_scout.release_history(corpus),
        }
    return {**doc, "publication": practice_scout.release_history(corpus)}


@router.get("/{corpus}/published")
def read_published(corpus: str) -> dict:
    try:
        return {"corpus": corpus, "projects": practice_scout.published_projects(corpus)}
    except practice_scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{corpus}/approve", dependencies=[Depends(verify_internal_token)])
def approve_draft(corpus: str, payload: dict = Body(...)) -> dict:
    ids = payload.get("projectIds")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="projectIds 必须是数组（可为空数组=全部下架）")
    draft_snapshot_id = payload.get("draftSnapshotId")
    if not isinstance(draft_snapshot_id, str) or not draft_snapshot_id.startswith("sha256:"):
        raise HTTPException(status_code=400, detail="draftSnapshotId 必须来自当前实操初稿")
    courses = payload.get("courses")
    if not isinstance(courses, list):
        raise HTTPException(
            status_code=400,
            detail="courses 必须是当前领域课程 {id,title} 数组（可为空）",
        )
    try:
        return practice_scout.approve(
            corpus,
            [str(i) for i in ids],
            courses,
            draft_snapshot_id,
        )
    except practice_scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{corpus}/releases")
def read_releases(corpus: str) -> dict:
    try:
        return practice_scout.release_history(corpus)
    except practice_scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{corpus}/restore", dependencies=[Depends(verify_internal_token)])
def restore_release(corpus: str, payload: dict = Body(...)) -> dict:
    courses = payload.get("courses")
    if not isinstance(courses, list):
        raise HTTPException(
            status_code=400,
            detail="courses 必须是当前领域课程 {id,title} 数组（可为空）",
        )
    version = payload.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise HTTPException(status_code=400, detail="version 必须是正整数")
    try:
        return practice_scout.restore_release(corpus, version, courses)
    except practice_scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/{corpus}/guide", dependencies=[Depends(verify_internal_token)])
def build_guide(corpus: str, payload: dict = Body(...)) -> dict:
    """项目带练：按画像把一张已发布实操卡拆成里程碑。同档缓存，首次约 20-40 秒。"""
    from backend.services import practice_guide

    project_id = str(payload.get("project_id") or "").strip()
    if not project_id:
        raise HTTPException(status_code=400, detail="project_id 必填")
    profile = payload.get("profile")
    if not isinstance(profile, dict):
        profile = {}
    try:
        return practice_guide.build_guide(corpus, project_id, profile, refresh=bool(payload.get("refresh")))
    except practice_guide.GuideError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except practice_scout.ScoutError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
