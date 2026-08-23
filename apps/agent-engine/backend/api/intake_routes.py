"""领域接入流水线的 HTTP 面：发起一次 run，和三个只读查询口。

## 三条投料形态，三选一

`files` 多文件、`zip` 压缩包、`gitUrl` 仓库地址。后两条是给整本知识库准备的——
iotdb 922 个文件、odoo 963 个，浏览器多选选不动，而少了这两条口，管理者就只能
找工程师跑 CLI。zip 与 git 都在 `intake_sources` 里解成一棵目录树，之后与多文件
走同一条链（同一个 `triage`、同一套限额）。解压安全与 clone 超时也都在那个模块里。

## 权限

- **发起（POST）走 `verify_internal_token`**（x-internal-token），与
  `/internal/v1/personalize/*` 同一把锁。引擎自己没有角色系统，manager 这一层在
  classroom 侧（R19 角色）——产品面的写入口由 classroom 的 manager 路由代理过来，
  代理时带上 `GROUNDING_TOKEN`，跟既有四个桥一模一样。
  token 没配 = 一律 401（fail closed），本机跑起来要 `AI_SERVICE_TOKEN=...`。
- **查询（GET）只读、不鉴权**，与 `/api/*` 其余读端点一致。run 里没有敏感数据，
  上传的原文也不从这里出。

## 为什么不做 SSE

造课工坊是逐 token 直播，需要长连接；接入 run 是分钟级批处理，事件按 seq 增量拉就够。
事件与 run 记录本来就落盘，轮询端点直接读文件——引擎重启后历史还在，
不用在内存里再维护一份订阅者队列。
"""
from __future__ import annotations

import json
import time
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, UploadFile

from backend.integration.personalize_api import verify_internal_token
from backend.services import domain_intake, intake_sources

router = APIRouter(prefix="/api/domain-intake", tags=["domain-intake"])


@router.post("/runs", dependencies=[Depends(verify_internal_token)])
async def create_run(
    files: list[UploadFile] = File(None, description="md / markdown / txt 多文件"),
    archive: UploadFile = File(None, alias="zip", description="一个 .zip，服务端解开后走同一条链"),
    git_url: str = Form("", alias="gitUrl", description="https 的仓库地址，服务端 clone 后走同一条链"),
    corpus: str = Form(..., description="新语料库名（小写字母数字与 -_，只能建新库）"),
    scope: str = Form("", description="疆域：这个域要培养什么人"),
    tier_range: str = Form("L1-L3", description="这批素材的难度区间（人工输入，实测自动标不准）"),
    tier_definitions: str = Form(
        "",
        description=(
            "档位定义（JSON 数组，每项 {label, audience}）。管理端表单让接入者用自己的话"
            "写「这批语料的学习者分几档、每档面向谁」，档数经映射层折成 tier_range 传上来；"
            "这个字段存的是没被折过的原文，只落 run 记录供回看，链上任何一站都不读它。"
        ),
    ),
    build_vector: bool = Form(False, description="建向量索引——调嵌入 API，真花钱，默认关"),
    hands_on_safety: bool = Form(
        False,
        description=(
            "这个域教动手操作（带电/机械/化学/高温）——由投料方声明，不从语料里猜。"
            "勾了则该库生成的课程带安全提示层与「以现行国标和厂商手册为准」的说明。"
        ),
    ),
    extract_concepts: bool = Form(False, description="抽概念词表与前置图——调 LLM，真花钱，默认关"),
    trial_run: bool = Form(
        False,
        description="⑥⑦ 试跑课程与指标复测——调生成与审核接口，按 token 计费，默认关",
    ),
    append: bool = Form(
        False,
        description=(
            "追加到已有库（E31 T0）。库必须已经存在，既有块原样保留、旧课出处不断链；"
            "只跑 ①②③，词表金标注册清单沿用既有的。**改过或要删的文档不走这条**——"
            "那仍需整库重建。"
        ),
    ),
) -> dict[str, Any]:
    given = [
        name
        for name, value in (("files", files), ("zip", archive), ("gitUrl", git_url.strip()))
        if value
    ]
    if len(given) != 1:
        raise HTTPException(
            status_code=400,
            detail="files / zip / gitUrl 三选一："
            + (f"这次给了 {len(given)} 条（{'、'.join(given)}）" if given else "这次一条都没给"),
        )

    options = {
        "corpus": corpus,
        "scope": scope,
        "tier_range": tier_range,
        "build_vector": build_vector,
        "hands_on_safety": hands_on_safety,
        "extract_concepts": extract_concepts,
        "trial_run": trial_run,
        "append": append,
    }
    # **请求路径只落盘，不解压、不遍历。**
    #
    # 2026-08-22 第五坎：解压与 `collect_readable` 原本都在这里跑，1670 个文件 +
    # 245MB PDF 的包把 2vCPU/4G 的机器 CPU 与内存同时打满——web 与 nginx 被饿死，
    # sshd 连协议 banner 都发不出来，整机失联十几分钟。
    #
    # 站点化本来就该做到底：跑链在后台，收料也该在后台。现在这里的耗时与包多大
    # 无关（几百毫秒），管理者立刻拿到 run_id 跳去看时间线，解压进度在事件流里
    # 逐步可见——而不是上传 100% 之后一段纯黑。
    inbox_dir = domain_intake.RUNS_DIR / "_inbox"
    inbox_dir.mkdir(parents=True, exist_ok=True)
    # 顺手清过期残包。放在这里而不是定时任务：投币是唯一往 _inbox 写东西的动作，
    # 谁弄脏谁顺手擦，不用额外挂一个 cron。
    domain_intake.sweep_inbox()
    # 顺带清进程中断留下的残 run（A4）。放这里不挂定时任务：投币是唯一会
    # 产生 run 的动作，谁弄脏谁擦。残 run 的害处是「假装还在建」——
    # 管理端看着转圈，学习端却可能已经能选到那个半成品库了。
    # 清理结果写进各自的 run.json 与事件流（管理端看得到），
    # 这里不另记日志——那会变成第二个真源。
    domain_intake.sweep_orphan_runs()
    stamp = f"{int(time.time() * 1000):x}"
    try:
        if given[0] == "files":
            # 多文件也不整包进内存：逐个边读边写。
            staged = inbox_dir / f"files-{stamp}"
            staged.mkdir(parents=True, exist_ok=True)
            for item in files:
                target = staged / Path(item.filename or "unnamed").name
                with target.open("wb") as fh:
                    while chunk := await item.read(1 << 20):
                        fh.write(chunk)
            run = domain_intake.create_run_deferred("dir", str(staged), **options)
        elif given[0] == "zip":
            spooled = inbox_dir / f"upload-{stamp}.zip"
            with spooled.open("wb") as fh:
                while chunk := await archive.read(1 << 20):
                    fh.write(chunk)
            run = domain_intake.create_run_deferred("zip", str(spooled), **options)
            # 原始包名只在这一刻拿得到（落盘名是 upload-<stamp>.zip）。不记，
            # 回看 run 就说不清这库是从哪个包来的——旧同步路径一直记，别丢。
            run.record["inbox"]["filename"] = archive.filename or spooled.name
            run.flush()
        else:
            # 仓库地址的合法性**留在请求路径**：这是纯字符串检查、零成本，
            # 而且是唯一一种「一眼就知道错了」的投料错误。挪到后台等于让人
            # 填错个地址还要等时间线跑起来才知道。真正的拉取仍在后台。
            intake_sources.check_git_url(git_url.strip())
            run = domain_intake.create_run_deferred("git", git_url.strip(), **options)
    except intake_sources.SourceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except domain_intake.StageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 原文进 options 就落 run.json（`create_run` 已 flush 过一次，这里补一次）。
    # 解析失败不拦车：这是一条备注字段，跑链不读它，写坏了也只是回看时看到原始串。
    if tier_definitions.strip():
        try:
            parsed: Any = json.loads(tier_definitions)
        except ValueError:
            parsed = tier_definitions
        run.record["options"]["tier_definitions"] = parsed
        run.flush()
    domain_intake.start_run(run)
    return {
        "run_id": run.run_id,
        "corpus": run.corpus,
        "status": run.record["status"],
        # 文件数这时还是 0——解压与收集在接收站①做，事件流里逐步可见。
        # 观看端拿 run_id 就能开始轮询，不必等这里给出终值。
        "files": len(run.record["files"]),
        "source": {"kind": given[0], "deferred": True},
        "events_url": f"/api/domain-intake/runs/{run.run_id}/events",
    }


@router.post("/checkups", dependencies=[Depends(verify_internal_token)])
def create_checkup(
    corpus: str = Body(..., embed=True, description="已建成的语料库名"),
    scope: str = Body("", embed=True, description="疆域一句话；留空则取该库 readiness.json 的 scope"),
) -> dict[str, Any]:
    """对既有库单独跑 ⑥⑦ 体检：不收语料、不建库、不覆盖。

    与 `POST /runs` 的分工：那条建新库（`_reserve_corpus` 只许新名字），
    这条给已经在盘上的库补体检。会调用生成与审核接口，按 token 计费。
    """
    try:
        run = domain_intake.create_checkup_run(corpus, scope=scope)
    except domain_intake.StageError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    domain_intake.start_run(run)
    return {
        "run_id": run.run_id,
        "corpus": run.corpus,
        "status": run.record["status"],
        "checkup": True,
        "events_url": f"/api/domain-intake/runs/{run.run_id}/events",
    }


@router.get("/runs")
def list_runs(limit: int = 30) -> dict[str, Any]:
    return {"runs": domain_intake.list_runs(limit=max(1, min(limit, 100)))}


@router.get("/runs/{run_id}")
def run_detail(run_id: str) -> dict[str, Any]:
    record = domain_intake.read_run(run_id)
    if record is None:
        raise HTTPException(status_code=404, detail=f"没有这个接入 run：{run_id}")
    return record


@router.get("/runs/{run_id}/events")
def run_events(run_id: str, since: int = 0, limit: int = 500) -> dict[str, Any]:
    """增量拉取。`since` 传上次返回的 `next_seq`。"""
    payload = domain_intake.read_events(run_id, since=max(0, since), limit=max(1, min(limit, 2000)))
    if payload is None:
        raise HTTPException(status_code=404, detail=f"没有这个接入 run：{run_id}")
    return payload


@router.get("/stages")
def stages() -> dict[str, Any]:
    """阶段枚举与依赖图。G6 照这个画泳道，不在前端再抄一份。"""
    return {
        "stages": [
            {
                "id": sid,
                "order": spec.order,
                "label": spec.label,
                "deps": list(spec.deps),
                "optional": spec.optional,
                "pending": spec.pending,
            }
            for sid, spec in domain_intake.STAGES.items()
        ],
        "event_kinds": [
            # 排队等闸（C24：一次只跑一条链）。观看端见到它应当显示「排队中」
            # 而不是「进行中」——两者在界面上长得一样就等于没做这件事。
            "run_queued",
            "run_start",
            "stage_start",
            "stage_progress",
            "stage_done",
            "stage_failed",
            "stage_skipped",
            "run_done",
            "run_failed",
        ],
        "limits": {
            "max_est_chunks": domain_intake.MAX_EST_CHUNKS,
            "allowed_suffixes": sorted(domain_intake.ALLOWED_SUFFIXES),
            "clone_timeout_sec": intake_sources.CLONE_TIMEOUT,
        },
        "sources": ["files", "zip", "gitUrl"],
    }
