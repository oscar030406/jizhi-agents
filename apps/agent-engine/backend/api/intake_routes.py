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

from fastapi import APIRouter, Body, Depends, File, Form, Header, HTTPException, UploadFile

from backend.integration.personalize_api import verify_internal_token
from backend.rag.intake import parse_exclusions
from backend.services import domain_intake, intake_sources

router = APIRouter(prefix="/api/domain-intake", tags=["domain-intake"])


def parse_job_requirements(raw: str) -> list[dict[str, Any]]:
    """岗位/技能清单：管理者投的料 → 域注册清单 `job_requirements` 槽的内容。

    **校验严、一条坏就整份退**，与 `tier_definitions` 那一格的宽松处理相反，
    因为两者的下游差得远：档位定义只在 run 页面回看时露一面，写坏了看的人一眼
    就知道是自己填的；这份清单会原样成为学习端岗位技能页的唯一数据源，
    静默丢掉一条坏岗位，学员看到的就是一份没人写过的岗位表——而且没有任何一处
    会报错，因为在下游看来「这个域就登记了这么多岗位」。

    投的人此刻还在表单前面，报错他能立刻改；学员看到错的岗位表，改不了也不知道。
    """
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"岗位/技能清单不是合法 JSON（{exc}）。形如："
                   '[{"title":"液压设备维护技师","skills":["液压系统日常点检","泵阀故障判读"]}]',
        ) from exc
    if not isinstance(parsed, list) or not parsed:
        raise HTTPException(
            status_code=400,
            detail="岗位/技能清单要是一个非空 JSON 数组，每项一个岗位。"
                   "不想登记岗位就把这一格留空——留空是合法的，学习端会如实显示未登记。",
        )
    jobs: list[dict[str, Any]] = []
    for i, job in enumerate(parsed, 1):
        where = f"第 {i} 个岗位"
        if not isinstance(job, dict):
            raise HTTPException(status_code=400, detail=f"{where}不是一个对象：{job!r}")
        title = str(job.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail=f"{where}缺 title（岗位名），这是列表上屏的那一行字")
        skills = job.get("skills")
        if not isinstance(skills, list) or not skills:
            raise HTTPException(
                status_code=400,
                detail=f"{where}「{title}」的 skills 要是一个非空字符串数组"
                       "——没有技能项的岗位在技能地图上是一张空卡片",
            )
        cleaned: list[str] = []
        for item in skills:
            if not isinstance(item, str) or not item.strip():
                raise HTTPException(
                    status_code=400,
                    detail=f"{where}「{title}」的 skills 里有非字符串条目：{item!r}",
                )
            cleaned.append(item.strip())
        jobs.append({
            # job_id 缺了按序号补：学习端拿它当列表 key、也拿它挂实操项目，
            # 一串空字符串会让所有岗位共用一个 key（React 渲染会串）。
            "job_id": str(job.get("job_id") or f"job-{i}"),
            "title": title,
            "summary": str(job.get("summary") or "").strip(),
            "skills": cleaned,
        })
    ids = [j["job_id"] for j in jobs]
    dup = sorted({x for x in ids if ids.count(x) > 1})
    if dup:
        # 学习端拿 job_id 当列表 key、也拿它挂实操项目，重了两个岗位会串成一个。
        raise HTTPException(status_code=400, detail=f"job_id 重复：{'、'.join(dup)}，每个岗位要有各自的 id")
    return jobs


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
    job_requirements: str = Form(
        "",
        description=(
            "岗位/技能清单（JSON 数组，每项 {title, skills, summary?}）。选填，填了才进域注册"
            "清单的 `job_requirements` 槽——学习端的岗位技能地图按它列岗位、拿这个域自己的库"
            "逐技能判覆盖；不填那一页如实显示「该领域未登记岗位要求」。"
            "形状不对当场 400，不静默丢条目。"
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
    exclude: str = Form(
        "",
        description=(
            "疆域的「范围」：这个域**明确不教**什么，一行一条路径前缀（也吃逗号分隔）。"
            "整个目录写目录名，单个文件写完整相对路径。明说不教的不算就绪度缺口，没提的才算。"
            "留空则沿用这个库上一次接入时声明过的那份——剔除声明是库的属性，"
            "不是某一次投币的属性（iotdb 就是因为第二趟没重复声明，12 个文件原样回到了索引里）。"
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
    x_jizhi_corpus: str = Header("", alias="x-jizhi-corpus"),
    x_jizhi_owner_org: str = Header("", alias="x-jizhi-owner-org"),
) -> dict[str, Any]:
    # classroom 已按机构归属核过这个头；这里再与 multipart 真值对照，避免桥核 A 写 B。
    # 头为空保留内部维护脚本兼容性；面向浏览器的桥始终会发送。
    if x_jizhi_corpus and x_jizhi_corpus != corpus:
        raise HTTPException(status_code=400, detail="知识库归属与接入目标不一致。")
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

    # 岗位/技能清单的形状**在建 run 之前校**：纯字符串检查、零成本，和 gitUrl 的合法性
    # 同一条理由。放到后面校的代价很实：`_reserve_corpus` 已经把库名占住了，
    # 管理者拿着一句「形状不对」改完再投，会被告知这个库已经存在。
    jobs = parse_job_requirements(job_requirements) if job_requirements.strip() else None
    if jobs and append:
        # 追加模式只跑 ①②③，⑧ 个性化注册站整站跳过（`APPEND_SKIP_REASON`），
        # 收下这份清单就等于收下之后扔掉——投的人以为登记好了，学习端那一页照旧空着。
        # 宁可当场拒，也不做这种没人看得见的丢弃。
        raise HTTPException(
            status_code=400,
            detail="追加模式不重算域注册清单，这次投的岗位/技能清单不会生效。"
                   "登记岗位要求请在整库重建（不勾追加）时投，或先把这一格清空再追加文档。",
        )

    options = {
        "corpus": corpus,
        "scope": scope,
        "tier_range": tier_range,
        "exclude": parse_exclusions(exclude),
        "build_vector": build_vector,
        "hands_on_safety": hands_on_safety,
        "extract_concepts": extract_concepts,
        "trial_run": trial_run,
        "append": append,
        # 仅内部桥发送；由 IntakeRun 首次落盘，历史授权不再随知识库归属变化。
        "owner_org_id": x_jizhi_owner_org.strip(),
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
            # 传进「多文件」那一格的整包，改走 zip 那条路，别让它十分钟后才失败。
            #
            # 2026-08-24 实测：一个 149MB 的 sm-merge.zip 从这一格传上来，落进
            # `_inbox/files-<stamp>/`，走 dir 分支；`collect_readable` 在目录里找不到
            # md/txt/rst/pdf，报「这份投料里没有任何可读文档」——包本身完好、
            # 里面 389 个 md 也在，只是没人解它。**传完才失败，那次白等了十分钟。**
            #
            # 直传那条路（`create_run`）本来就按 ALLOWED_SUFFIXES 挡了 .zip 并说得清楚，
            # 但延迟收料这条路绕过了那道校验。两条路的判据不该有分叉。
            names = [Path(f.filename or "").suffix.lower() for f in files]
            single_zip = len(files) == 1 and names[0] == ".zip"
            bad = sorted({x for x in names if x not in domain_intake.ALLOWED_SUFFIXES})
            if bad and not single_zip:
                raise HTTPException(
                    status_code=400,
                    detail=f"不收 {'、'.join(x or '无扩展名' for x in bad)} 格式："
                    f"这一格只收 {'/'.join(sorted(x.lstrip('.') for x in domain_intake.ALLOWED_SUFFIXES))}。"
                    "整包语料请传到「压缩包」那一格（单个 .zip 传到这里会自动改走压缩包那条路）。",
                )
            if single_zip:
                spooled = inbox_dir / f"upload-{stamp}.zip"
                with spooled.open("wb") as fh:
                    while chunk := await files[0].read(1 << 20):
                        fh.write(chunk)
                run = domain_intake.create_run_deferred("zip", str(spooled), **options)
                run.record["inbox"]["filename"] = files[0].filename or spooled.name
                run.flush()
            else:
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
    # 岗位/技能清单同路进 options：⑧ 个性化注册站从这里取值写进域注册清单的
    # 同名槽（`_CARRIED_FIELDS` 保证后续别的库重跑时不被冲掉），学习端的
    # `skill_map_api(域)` 读那一格列岗位。形状上面校过了，这里只落盘。
    if jobs is not None:
        run.record["options"]["job_requirements"] = jobs
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
