"""外部可视化教具的 HTTP 面：起草（写）、读取、审核发布（写）、已发布清单。

权限与 practice_scout_routes 同一套：写入口走 `verify_internal_token`（classroom 的
manager 桥带 GROUNDING_TOKEN 代理过来），读端点只读不鉴权——教具卡全是公开仓库信息
与公开演示站地址，无敏感数据。

起草是同步的（每概念一轮 GitHub 搜索 + 演示站探测 + 一次模型调用），桥的超时要放宽。
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from backend.integration.personalize_api import verify_internal_token
from backend.services import teaching_aid_scout as scout

router = APIRouter(prefix="/api/teaching-aids", tags=["teaching-aids"])


@router.post("/{corpus}/draft", dependencies=[Depends(verify_internal_token)])
def create_draft(corpus: str, payload: dict = Body(default={})) -> dict:
    concepts = payload.get("concepts")
    if concepts is not None and not isinstance(concepts, list):
        raise HTTPException(status_code=400, detail="concepts 必须是概念 ID 数组（可省略=全部）")
    try:
        count = int(payload.get("count") or 16)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="count 必须是整数") from exc
    try:
        return scout.run_draft(
            corpus,
            [str(c) for c in concepts] if concepts else None,
            count=max(4, min(30, count)),
        )
    except scout.ScoutError as exc:
        # 失败必须对管理端可见——网络不通/模型未启用都不许静默成空结果
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/{corpus}")
def read_draft(corpus: str) -> dict:
    doc = scout.load_draft(corpus)
    if not doc:
        return {
            "corpus": corpus,
            "status": "none",
            "aids": [],
            "publication": scout.release_history(corpus),
        }
    return {**doc, "publication": scout.release_history(corpus)}


@router.post("/{corpus}/approve", dependencies=[Depends(verify_internal_token)])
def approve_draft(corpus: str, payload: dict = Body(...)) -> dict:
    ids = payload.get("aidIds")
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="aidIds 必须是数组（可为空数组=全部下架）")
    snapshot_id = payload.get("draftSnapshotId")
    if not isinstance(snapshot_id, str) or not snapshot_id.startswith("sha256:"):
        raise HTTPException(status_code=400, detail="draftSnapshotId 必须来自当前教具初稿")
    try:
        return scout.approve(corpus, [str(i) for i in ids], snapshot_id)
    except scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/{corpus}/published")
def read_published(corpus: str) -> dict:
    try:
        return {"corpus": corpus, "aids": scout.published_aids(corpus)}
    except scout.ScoutError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
