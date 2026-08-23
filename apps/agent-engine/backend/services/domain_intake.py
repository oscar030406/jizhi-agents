"""领域接入 run：把既有的接入脚本编排成一次**可观察**的流水线。

范式抄的是造课工坊（`course_studio.py`）：事件逐条落 jsonl，前端按事件流渲染。
差别有两处，都是被需求逼出来的：

1. **按依赖图跑，不是串行。** 每站声明它依赖谁，依赖满足就发车。③检索索引 与
   ④知识整理 与 ⑤金标 都只依赖 ②切块，三站并行；向量索引挂在 ③ 后面当旁路，
   没有任何下游依赖它，所以它慢它的、不挡 ⑤。换域总时长的压缩空间就在这里，
   `run.json` 里每站的起止时刻是量它的基准数据。
2. **状态全在磁盘，进程内不留 registry。** 事件与 run 记录都落
   `data/knowledge_base/intake_runs/<run_id>/`，查询端点直接读文件。
   代价是每次轮询一次文件读；换来的是引擎重启后历史还在、并发阶段交错写不用
   在内存里再维护一份副本。造课工坊那套 SSE 订阅队列在这里用不上——
   接入 run 是分钟级的批处理，不是需要逐 token 直播的场。

## 阶段各自复用谁

    ① 接收与清洗   backend.rag.intake.triage / detect_license（+ 本文件的内容去重）
    ② 切块入库     backend.rag.intake.outline_sections + ingest_domain.write_corpus_index
    ③ 检索索引     retriever.get_corpus_retriever（TF-IDF 在加载时现建，没有独立产物）
      └ 向量索引   scripts/build_embedding_index.build_corpus_index（**默认关，调嵌入 API 花钱**）
    ④ 知识整理     structure_edges.probe（零 API）+ 概念抽取/前置图（默认关，调 LLM 花钱）
    ⑤ 金标派生     scripts/derive_kc_gold.derive + write_gold，落盘时盖冻结时间戳
    ⑥ 试跑课程     classroom 的 `/api/generate/scene-content` + `/api/generate/scene-audit`
                   （**默认关，真花钱**；开关 trial_run，另有 run 级 token 预算闸）
    ⑦ 指标复测     ⑥ 那一遍判官的判定 + scripts/compute_kc_coverage.py + 盲评判档
    ⑧ 个性化注册   personalize_service._corpus_status（eligible/gate 判据不另写一份）
                   → `data/knowledge_base/domain_registry.json`，学习端读它认库

一律 import 函数进来跑，不 shell 出去——shell 出去就拿不到分步事件，
而分步事件正是这一单要交的东西。

## 写盘边界

一次 run 只碰四个位置（外加 ⑧ 那一份全局的域注册清单），全部按新库名限定，且**开跑前先确认它们都不存在**
（`_reserve_corpus`）：run 目录、`corpora/<新库名>/`、`<新库名>_intake/`、
`kc_gold_derived/<新库名>/`。既有六库与 ai 主语料一个字节都不写。
run 失败时把这次建的目录删掉，不留半成品库。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[2]
KB = ROOT / "data" / "knowledge_base"
RUNS_DIR = KB / "intake_runs"
CORPORA_DIR = KB / "corpora"
GOLD_DIR = ROOT / "data" / "eval" / "kc_gold_derived"
# 指向主语料的几个写法（与 `retriever.DEFAULT_CORPUS_ALIASES` 同一套）。
_MAIN_CORPUS_ALIASES = {"", "default", "ai"}

# ── 上传限额：只留一条防崩底线，不设拒收闸 ──────────────────────────────────
# 这里经历过两版都是错的：
#   一版 `MAX_FILES = 50`——把整仓语料挡在网站之外，工程师只能改跑 CLI 脚本灌库，
#     等于绕开「管理员投一个知识库、剩下全是系统的事」这条唯一算数的入口。
#   二版按字节与块数预算（32MB / 24000 块）——数是拿本地两份语料拍的，
#     而用户要传的是电子书：本地 32 本书 4.2G，一本 30MB 的 PDF 直接顶掉整个预算。
#
# 2026-08-21 实测两组数把口径定死了：
#   ① **PDF 的体积不是文本的体积**。AI Agents in Action 30.0MB / 346 页 → 抽出文本
#      仅 0.57MB（每页 1730 字符），图片占掉 98%。解析在 classroom 侧（unpdf，1.1 秒），
#      引擎收到的已经是 .md，按原文件字节卡等于卡了个不相干的量。
#   ② **服务器余量远大于我们拍的数**：40G 磁盘用 24G 剩 14G，而整个知识库现占 38M。
#      14G 够传几百本书，32MB 这条闸是我们自己拍出来卡自己的。
#
# 所以拒收闸全部去掉。**只留一条防崩底线**：建索引要把全部块读进内存做 TF-IDF 矩阵，
# 块数无上限有可能把机器压垮——那台 2vCPU/4G 上还跑着另外两个站点，压死了是它们陪葬
# （这个坑踩过：在服务器上跑 next build 把整机压死，同机的灵山一起挂）。
#
# **依据是实测，不是估算**（2026-08-22，拿主库真语料在本机量的）：
#
#     1,704 块 →  0.1s  进程 RSS +15MB   矩阵非零 0.10M
#     5,000 块 →  0.2s  进程 RSS  +6MB   矩阵非零 0.30M
#    20,000 块 →  0.7s  RSS 182MB        正文 18M 字符
#    60,000 块 →  2.0s  RSS 213MB        正文 53M 字符
#
# 也就是说建索引这一步**几乎不吃内存**：TF-IDF 出来是稀疏矩阵，6 万块的矩阵
# 只有 350 万个非零元。真正占地方的是正文字符串本身，而它是线性增长的。
#
# 早先这里写的是「TF-IDF 稀疏矩阵约与正文同量级，0.8G ÷ 2.8KB ≈ 28 万块」——
# **那个前提是错的**，稀疏矩阵比正文小两个数量级。按实测线性外推，20 万块的正文
# 约 180M 字符、进程 RSS 大致落在 400–500MB，离压垮 2.3G 可用内存还很远。
#
# 那为什么还留这条线？因为它防的不是「内存不够」，是**没有上界这件事本身**：
# 一次投进来的东西不该没有任何数量级检查，撞线时至少有个地方告诉人「这批太大了、
# 分批投」，而不是跑了两小时之后在某个说不清的地方失败。20 万这个数偏保守，
# 但保守的代价是零——真实语料离它差两个数量级（验收那包 1670 个文件才 1456 块）。
#
# 这不是「不许超过」，是「超过就先分批」。撞到它的报错要说清这一点，
# 别让人以为是产品限制。
MAX_EST_CHUNKS = 200_000

ALLOWED_SUFFIXES = {".md", ".markdown", ".txt", ".rst", ".pdf"}

#: 语料名进路径，字符集与 `retriever.CORPUS_NAME_RE` 同一条——外部输入不可信。
#: 这几个名字指向主语料，永远不许被流水线建的新库占用。
RESERVED_NAMES = {"", "default", "ai"}


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _rel(path: Path) -> str:
    """展示用的引擎相对路径。测试里数据根被指到临时目录，那时退回绝对路径，不炸。"""
    try:
        return str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        return path.as_posix()


# ── 阶段定义 ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class StageSpec:
    #: 用户看到的站号（① ② …）。并行的站可以共号，`vector` 就挂在 ③ 下面。
    order: int
    label: str
    #: 依赖谁。空 = 可以马上发车。
    deps: tuple[str, ...]
    #: 旁路站：失败只记 warning，不判 run 失败（向量索引是外部 API，抖一下不该毁掉整次接入）。
    optional: bool = False
    #: 本单只留桩，不实现。
    pending: bool = False


STAGES: dict[str, StageSpec] = {
    "receive": StageSpec(1, "接收与清洗", ()),
    "chunk": StageSpec(2, "切块入库", ("receive",)),
    "index": StageSpec(3, "检索索引", ("chunk",)),
    "vector": StageSpec(3, "向量索引（异步旁路）", ("index",), optional=True),
    "knowledge": StageSpec(4, "知识整理", ("chunk",)),
    "gold": StageSpec(5, "金标派生并冻结", ("chunk",)),
    # ⑥⑦ 是 optional：它们跑的是**新库建好之后**的体检，体检失败不该把已经建成的库删掉
    # （`_cleanup_partial` 只在 run 硬失败时动手，而 optional 站失败只记 warning）。
    "trial": StageSpec(6, "试跑课程", ("gold", "knowledge"), optional=True),
    "metrics": StageSpec(7, "指标复测", ("trial",), optional=True),
    # ⑧ **不是 optional**：这一站不产出就等于学习端认不出新库——域中文名、画像里的
    # 知识库选项、示例提示词全落空，管理者传完还得有人回来改代码。那是硬伤不是旁路。
    # 它只写一个清单文件，不碰库本身，所以放在 ⑤④ 之后、与 ⑥ 并列发车。
    "personalize": StageSpec(8, "个性化注册", ("gold", "knowledge")),
}


class StageError(RuntimeError):
    """业务性失败（语料全被退回、库名冲突……）。带原因进事件，不吞。"""


class StageSkipped(RuntimeError):
    """这一站在这份语料上无从谈起，但不算 run 失败（如：全 txt 的语料派生不出金标）。

    与 failed 分开，是因为两者对产物的处置相反：failed 要把半成品库删掉，
    skipped 不删——库照样建成了，只是少了这一站的产物。
    """


# ── run 对象：事件与记录都是磁盘上的文件，这个类只负责往里写 ──────────────────


class IntakeRun:
    def __init__(self, run_id: str, corpus: str, scope: str, options: dict[str, Any]) -> None:
        self.run_id = run_id
        self.corpus = corpus
        self.dir = RUNS_DIR / run_id
        self.docs_dir = self.dir / "docs"
        self.events_path = self.dir / "events.jsonl"
        self.record_path = self.dir / "run.json"
        self._lock = threading.Lock()
        self._seq = 0
        #: 阶段之间传数据用（sections、manifest……）。每站只写自己的键。
        self.ctx: dict[str, Any] = {}
        self.record: dict[str, Any] = {
            "run_id": run_id,
            "corpus": corpus,
            "scope": scope,
            "status": "running",
            "created_at": now_iso(),
            "finished_at": None,
            "duration_ms": None,
            "options": options,
            "limits": {
                "max_est_chunks": MAX_EST_CHUNKS,
                "allowed_suffixes": sorted(ALLOWED_SUFFIXES),
            },
            "files": [],
            "stages": {
                sid: {
                    "order": spec.order,
                    "label": spec.label,
                    "deps": list(spec.deps),
                    "optional": spec.optional,
                    "status": "waiting",
                    "started_at": None,
                    "finished_at": None,
                    "duration_ms": None,
                    "detail": None,
                    "error": "",
                }
                for sid, spec in STAGES.items()
            },
            "products": {},
            "warnings": [],
            "error": "",
        }
        self._started = time.perf_counter()

    # ---------------- 事件
    def emit(self, stage: str, kind: str, message: str, **payload: Any) -> dict[str, Any]:
        """一条事件 = jsonl 的一行。**每条都带 stage**，G6 按 stage 分道渲染。"""
        event = {
            "seq": -1,  # 真正的 seq 在锁内取——并行阶段同时 emit 时，锁外取号会发重号
            "ts": round(time.time(), 3),
            "iso": now_iso(),
            "run_id": self.run_id,
            "stage": stage,
            "kind": kind,
            "message": message,
            **payload,
        }
        with self._lock:
            event["seq"] = self._seq
            self._seq += 1
            self.dir.mkdir(parents=True, exist_ok=True)
            with self.events_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
            self._write_record()
        return event

    def _write_record(self) -> None:
        """调用方必须已持锁。"""
        self.record_path.write_text(
            json.dumps(self.record, ensure_ascii=False, indent=1), encoding="utf-8"
        )

    def flush(self) -> None:
        with self._lock:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._write_record()

    # ---------------- 阶段状态
    def stage_start(self, sid: str) -> None:
        slot = self.record["stages"][sid]
        slot["status"] = "running"
        slot["started_at"] = now_iso()
        slot["_t0"] = time.perf_counter()
        self.emit(sid, "stage_start", f"{STAGES[sid].label} 开始")

    def stage_finish(
        self, sid: str, status: str, message: str, detail: Any = None, error: str = ""
    ) -> None:
        slot = self.record["stages"][sid]
        t0 = slot.pop("_t0", None)
        slot["status"] = status
        slot["finished_at"] = now_iso()
        slot["duration_ms"] = round((time.perf_counter() - t0) * 1000) if t0 else None
        slot["detail"] = detail
        slot["error"] = error
        # kind 只有三种，status 有五种（skipped 与 pending 都落在 stage_skipped 这个 kind 上）。
        # 事件里把 status 也带上，G6 不用从 message 里猜这一站到底是「主动关掉」还是「还没做」。
        # partial 与 done 同属「跑完了」这一类收尾（kind=stage_done），差别在事件自带的
        # status——前端按 status 上色，不从 message 里猜这一站是不是缺了点东西。
        kind = {"done": "stage_done", "partial": "stage_done", "failed": "stage_failed"}.get(
            status, "stage_skipped"
        )
        self.emit(sid, kind, message, status=status, detail=detail, error=error)


# ── 各站实现 ───────────────────────────────────────────────────────────────


def _materialize_inbox(run: IntakeRun) -> None:
    """把 `<run>/_inbox/` 里的原始投料变成 `<run>/docs/`。

    **这一步曾经在 HTTP 请求路径里**，1670 个文件 + 245MB PDF 的包把 2vCPU/4G
    的机器 CPU 与内存同时打满，整机失联（连 sshd 都发不出 banner）。挪到这里之后
    请求路径几百毫秒就返回，解压进度在事件流里可见。

    投料处理完就删——原始包不留第二份，磁盘只剩 `docs/` 那一份。
    """
    from backend.services.intake_sources import clone_repo, collect_readable, extract_zip

    inbox = run.record.get("inbox")
    if not isinstance(inbox, dict):
        return  # 老路径（多文件直传）已经把 docs/ 填好了

    kind, ref = str(inbox.get("kind") or ""), str(inbox.get("ref") or "")
    limit = MAX_EST_CHUNKS * 1400
    source: dict[str, Any] = {"kind": kind}
    staged = run.dir / "_staged"

    run.emit("receive", "stage_progress", f"开始处理投料（{kind}）")
    try:
        if kind == "zip":
            source.update(extract_zip(Path(ref), staged, limit))
            # 优先记路由存下的原始包名；落盘名（upload-<stamp>.zip）只是兜底。
            source["filename"] = str(inbox.get("filename") or Path(ref).name)
            Path(ref).unlink(missing_ok=True)
        elif kind == "git":
            staged.mkdir(parents=True, exist_ok=True)
            source.update(clone_repo(ref, staged))
        elif kind == "dir":
            staged = Path(ref)
        else:
            raise StageError(f"不认识的投料形态：{kind}")

        run.emit(
            "receive",
            "stage_progress",
            f"投料就位：{source.get('files', '?')} 个文件"
            + (f"，跳过 {source['skipped']} 个非文档" if source.get("skipped") else ""),
            # source 里的 "kind" 与 emit 的位置参数 kind 撞名——不滤掉就是
            # TypeError、整个 run 判 failed（测试实弹抓到的，别删这个过滤）。
            **{k: v for k, v in source.items() if k != "kind" and isinstance(v, (int, str))},
        )

        kept = collect_readable(staged, run.docs_dir, limit)
        if not kept:
            raise StageError("这份投料里没有任何可读文档")
        check_budget(_effective_sizes(run.docs_dir, kept))
        run.record["files"] = [
            {"name": rel, "original": rel, "bytes": size} for rel, size in kept
        ]
        run.record["source"] = source
        run.flush()
        # dir 形态的 staged 就是 _inbox 里的上传目录本身（staged == ref），上面那个
        # 只清「staged != ref」的 finally 兜不住它——成功搬进 docs/ 后这里显式清，
        # 否则每次多文件投币都在 _inbox 留一份全量副本。失败时故意保留，便于排查。
        if kind == "dir":
            shutil.rmtree(Path(ref), ignore_errors=True)
    finally:
        if staged.exists() and staged != Path(ref):
            shutil.rmtree(staged, ignore_errors=True)
        run.record.pop("inbox", None)
        run.flush()


#: 单次接入最多转写多少页。877 页并发 4 约 41 分钟；再多就该分批投，
#: 否则一次接入占着后台线程小半天，其它库排不上队。撞线时如实说，不静默截断。
MAX_TRANSCRIBE_PAGES = 1200


def _transcribe_scans(run: IntakeRun, pending: list[tuple[str, str]]) -> dict[str, Any]:
    """把扫描件 PDF 逐页交给视觉模型转写，产出的 markdown 落进 `docs/`。

    用户原话「扫描件人类能读我们读不了」——那不是能力边界，是没做。
    管理者手上的教材大量是扫描件（验收包三本 877 页全是整页图、零文本层）。

    这一站慢（约 11s/页），所以：**逐页落盘可断点续跑**、**页级进度进事件流**。
    投币口那次「转了八分钟只有三个字」的教训刚流过血，不能在这里重演。
    """
    from backend.rag import pdf_transcribe as T
    from backend.services.llm_gateway import LLMGateway

    if not pending:
        return {}

    gateway = LLMGateway()
    route = gateway.route_for("ResourceGenerationAgent")
    if not route.enabled:
        for rel, why in pending:
            run.record.setdefault("_scan_skipped", []).append(rel)
        run.emit(
            "receive",
            "stage_warning",
            f"{len(pending)} 份扫描件没能转写：LLM 路由未启用。"
            "这些书不会进库——不是内容不合格，是这次跑的时候转写不可用。",
        )
        return {"transcribed": 0, "skipped": len(pending)}

    import base64

    import requests

    # 网关的模型由 agent 路由决定（strong 档是文本模型），而转写必须走视觉模型。
    # 不改网关——那是共用件，改它的路由语义会波及所有 agent；这里只借它的凭据直连。
    api_key = gateway.env.get(route.api_key_env) or os.environ.get(route.api_key_env, "")
    endpoint = f"{route.base_url.rstrip('/')}/chat/completions"

    def call_model(image: Path) -> str:
        payload = base64.b64encode(image.read_bytes()).decode()
        resp = requests.post(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": T.TRANSCRIBE_MODEL,
                "temperature": 0.0,
                "max_tokens": 4000,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/png;base64,{payload}"},
                            },
                            {"type": "text", "text": T.TRANSCRIBE_PROMPT},
                        ],
                    }
                ],
            },
            timeout=300,
        )
        resp.raise_for_status()
        return str(resp.json()["choices"][0]["message"]["content"] or "")

    done = pages = figures = 0
    for rel, _why in pending:
        pdf = run.docs_dir / rel
        out_dir = run.dir / "transcribed" / Path(rel).stem
        run.emit("receive", "stage_progress", f"开始转写扫描件《{Path(rel).stem}》")

        def progress(cur: int, total: int, _rel: str = rel) -> None:
            # 每 20 页报一次：877 页逐页报会把事件流淹掉，全不报又回到「纯黑等待」。
            if cur % 20 == 0 or cur == total:
                run.emit("receive", "stage_progress", f"《{Path(_rel).stem}》已转写 {cur}/{total} 页")

        report = T.transcribe_pdf(
            pdf, out_dir, call_model=call_model, on_progress=progress,
            max_pages=MAX_TRANSCRIBE_PAGES,
        )
        if report.pages_done == 0:
            run.emit("receive", "stage_warning", f"《{Path(rel).stem}》一页都没转出来，跳过")
            continue

        # 转写产出替掉原 PDF：下游只认 md，PDF 留着会被 triage 再收一遍。
        # **写在原 PDF 旁边**，不是 docs 根——投料的目录层次是结构信号
        # （triage 拿 path_depth、切块拿相对路径当 section 标题），
        # 把深层书的转写产物拍到根上等于把它的位置信息抹掉。
        md = pdf.with_suffix(".md")
        md.write_text(T.assemble(out_dir, Path(rel).name), encoding="utf-8")
        pdf.unlink(missing_ok=True)
        done += 1
        pages += report.pages_done
        figures += report.figure_lines
        run.emit(
            "receive",
            "stage_progress",
            f"《{Path(rel).stem}》转写完成：{report.summary()}",
            pages=report.pages_done,
            failed=report.pages_failed,
        )

    return {"transcribed": done, "pages": pages, "figure_lines": figures}


def _install_figures(run: IntakeRun) -> dict[str, Any]:
    """把插图搬进 `corpora/<库>/figures/`，两个来源都收。

    来源一：链内转写的产物 `<run>/transcribed/<书名>/figures/`。
    来源二：**投料自带的** `<run>/docs/**/figures/`——管理者投一份已经转写好的
    教材包时图在这里（2026-08-23 实测：离线转写的 PLC 书投进去，
    正文 322 条图引用全是死链，因为这一路当时没人搬）。

    run 目录是过程产物、随时可清；课程生成读的是 `corpora/<库>/`。
    命名带前缀：两本书都有 p0001.png，直接平铺会互相覆盖。
    """
    # 两个来源：链内转写的产物，以及**投料自带的** `docs/**/figures/`
    # （管理者投一份已经转写好的教材包时图在那里）。
    # 少搬任何一路，正文里的 `[图：… → figures/x.png]` 就是死链。
    pairs: list[tuple[str, Path]] = []

    transcribed = run.dir / "transcribed"
    if transcribed.exists():
        for book_dir in sorted(p for p in transcribed.iterdir() if p.is_dir()):
            pairs.extend(
                (book_dir.name, png) for png in sorted((book_dir / "figures").glob("*"))
            )

    for figures_dir in sorted(run.docs_dir.rglob("figures")):
        if not figures_dir.is_dir():
            continue
        # 前缀用它相对 docs/ 的父路径，两本书各有 p0001.png 时不互相覆盖
        parent = figures_dir.parent.relative_to(run.docs_dir).as_posix().replace("/", "-")
        pairs.extend((parent or "docs", f) for f in sorted(figures_dir.glob("*")))

    pairs = [(prefix, f) for prefix, f in pairs if f.is_file()]
    if not pairs:
        return {}

    dest = CORPORA_DIR / run.corpus / "figures"
    dest.mkdir(parents=True, exist_ok=True)
    for prefix, src in pairs:
        shutil.copy2(src, dest / f"{prefix}-{src.name}")
    return {"figures": len(pairs)}


def _stage_receive(run: IntakeRun) -> dict[str, Any]:
    """① 投料落地 + 分诊 + 许可 + 内容去重。一个文件都收不进来就在这里失败，②之后不会动盘。"""
    from backend.rag.intake import detect_license, normalize_rst_dir, triage

    # 解压 / clone / 搬运——这些重活挪到了这里，不再占着 HTTP 请求路径。
    _materialize_inbox(run)

    # rst 先就地转成 markdown：下游三站（金标派生、结构信号、⑤ 的开跑前判断）只认 `.md`。
    # 放在 triage 之前，退回清单里就不会出现「已经转成 md 的那份」与 rst 原件两条。
    rst = normalize_rst_dir(run.docs_dir)
    if rst:
        run.emit(
            "receive",
            "stage_progress",
            f"{len(rst)} 个 .rst 按下划线还原成 markdown 标题层级（例：{rst[0][0]} → {rst[0][1]}）",
            rst_converted=len(rst),
        )

    manifest = triage(run.docs_dir)
    rejected = [{"file": rel, "reason": why} for rel, why in manifest.rejected]

    # 去重：同内容的文件只留第一个。triage 不做这件事（它按文件判），
    # 而上传是人手选的，重复投同一份文档很常见。
    seen: dict[str, str] = {}
    kept = []
    for f in manifest.accepted:
        digest = hashlib.sha256(f.path.read_bytes()).hexdigest()
        if digest in seen:
            rejected.append({"file": f.relative, "reason": f"内容与 {seen[digest]} 完全相同，去重"})
            continue
        seen[digest] = f.relative
        kept.append(f)
    manifest.accepted = kept

    # 追加模式再过一道：库里已经有的文件直接退回，不重复入库。
    # 判据用既有索引里的 source_id stem——存量六个库都建在追加这条路之前，
    # 没有 sha256 台账可查，而索引本身一直都在。
    if run.record["options"].get("append"):
        _ensure_scripts_path()
        from ingest_domain import corpus_source_stems  # type: ignore[import-not-found]

        have = corpus_source_stems(run.corpus)
        fresh = []
        for f in manifest.accepted:
            stem = re.sub(r"[^0-9A-Za-z]+", "-", f.relative.rsplit(".", 1)[0]).strip("-").lower()
            if stem in have:
                rejected.append({"file": f.relative, "reason": "库里已经有这份文档了，跳过"})
                continue
            fresh.append(f)
        skipped = len(manifest.accepted) - len(fresh)
        manifest.accepted = fresh
        kept = fresh
        if skipped:
            run.emit(
                "receive",
                "stage_progress",
                f"{skipped} 份文档库里已经有了，这次跳过（追加只收新文档）",
                already_present=skipped,
            )

    lic = detect_license(run.docs_dir)
    run.emit(
        "receive",
        "stage_progress",
        f"收 {len(kept)} 个文件（{manifest.accepted_chars:,} 字符），退回 {len(rejected)} 个",
        accepted=len(kept),
        rejected=len(rejected),
        chars=manifest.accepted_chars,
    )
    # 扫描件转写：分诊把它们放进了 pending_transcribe。转完写回 docs/ 再分诊一遍——
    # 转写产出也要过注入扫描，不能因为「是我们自己转出来的」就免检。
    if manifest.pending_transcribe:
        run.emit(
            "receive",
            "stage_progress",
            f"{len(manifest.pending_transcribe)} 份扫描件进转写旁路（整本是图、没有文本层）",
        )
        scan_stats = _transcribe_scans(run, manifest.pending_transcribe)
        if scan_stats.get("transcribed"):
            manifest = triage(run.docs_dir)  # 转写产出重新分诊，与其它文档同一条路
            rejected = [{"file": rel, "reason": why} for rel, why in manifest.rejected]

    # 提示注入扫描（WO-N16 B14）：扫了不上屏等于没扫。命中只报不拦——
    # 讲提示注入的教材正文里本来就有这些字样，处置权归管理者。
    if manifest.injection_hits:
        files = sorted({h["file"] for h in manifest.injection_hits})
        run.emit(
            "receive",
            "stage_warning",
            f"提示注入特征命中 {len(manifest.injection_hits)} 处，涉及 {len(files)} 个文件"
            f"（首条：{files[0]} 第 {manifest.injection_hits[0]['line']} 行"
            f"——{manifest.injection_hits[0]['what']}）。**已照常入库**："
            "教材讲注入时正文里就会出现这些字样，是否要剔除请自行判断。",
            injection_hits=manifest.injection_hits[:50],
        )
    if not kept:
        raise StageError(
            f"没有可接入的文件：{len(rejected)} 个全部被退回"
            + (f"（首条：{rejected[0]['file']} —— {rejected[0]['reason']}）" if rejected else "")
        )
    run.ctx["manifest"] = manifest
    return {
        "accepted_files": len(kept),
        "accepted_chars": manifest.accepted_chars,
        "rejected": rejected,
        "license": {"spdx": lic.spdx, "evidence": lic.evidence, "unknown": lic.unknown},
    }


def _existing_vocab(corpus: str) -> list[dict]:
    """既有库的概念词表（④ 落在 readiness.json 里的那份）。

    追加时沿用，不重算。读不到就返回空表——新块的 concept_tags 会是空的，
    检索照样能用（TF-IDF 吃 title/topic/content，tag 只是排序加成）。
    """
    path = KB / f"{corpus}_intake" / "readiness.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    vocab = data.get("vocabulary") or data.get("concepts") or []
    return [v for v in vocab if isinstance(v, dict) and v.get("concept")]


def _stage_chunk(run: IntakeRun) -> dict[str, Any]:
    """② 按标题路径切块并落成可检索的 jsonl。

    concept_tags 这一格此刻是空的——词表要等 ④ 才有。检索本身不依赖它
    （TF-IDF 吃 title/topic/content，tag 只是排序加成），所以先建库、
    ④ 出了词表再回填，不为一个加成把两站串起来。
    """
    from backend.rag.intake import outline_sections, read_body

    _ensure_scripts_path()
    from ingest_domain import append_corpus_index, write_corpus_index  # type: ignore[import-not-found]

    manifest = run.ctx["manifest"]
    sections: list[tuple[str, str, list[str]]] = []
    for f in manifest.accepted:
        body = read_body(f.path)
        for meta in outline_sections(body, path_depth=f.path_depth):
            label = " / ".join(meta.heading_path) or f.relative
            sections.append((f"{f.relative}#{meta.order} {label}", meta.text, meta.heading_path))
    run.ctx["sections"] = sections

    tier_range = run.record["options"].get("tier_range", "L1-L3")
    if run.record["options"].get("append"):
        # 追加：既有行原样保留，只把新文件的块接在后面。
        # 词表取既有库的——不重算（重算是 ④ 的活，追加不跑 ④），
        # 但也不能不给：不给的话新块的 concept_tags 全空，同一个库里
        # 老块有标签新块没有，检索排序上新文档天然吃亏。
        vocab = _existing_vocab(run.corpus)
        index_path, count, collided = append_corpus_index(run.corpus, sections, vocab, tier_range)
        if collided:
            run.emit(
                "chunk",
                "stage_warning",
                f"{len(collided)} 个块的出处编号已经在库里了，这次没有写入"
                f"（首条 {collided[0]}）。同名文件的新版本属于「改」不属于「补」，"
                "要让它生效得整库重建。",
                collided=collided[:50],
            )
        run.record["products"]["corpus_index"] = _rel(index_path)
        run.emit(
            "chunk",
            "stage_progress",
            f"追加 {count} 块（词表沿用既有 {len(vocab)} 个概念，既有块一个字节没动）",
            appended=count,
        )
    else:
        index_path, count = write_corpus_index(run.corpus, sections, [], tier_range)
    rel = _rel(index_path)
    run.record["products"]["corpus_index"] = rel
    # 转写产出的原图跟着搬进库——课程生成引用的是这里，不是 run 目录。
    figures = _install_figures(run)
    if figures:
        run.record["products"]["figures"] = figures["figures"]
        run.emit(
            "chunk",
            "stage_progress",
            f"原书插图 {figures['figures']} 张入库，课程里嵌原件而不是模型转述",
            **figures,
        )
    sample = sections[0][1][:180] if sections else ""
    return {
        "sections": len(sections),
        "chunks": count,
        "index_path": rel,
        "sample_chunk": sample,
        "concept_tags": "空——词表出自 ④，届时回填",
    }


def _stage_index(run: IntakeRun) -> dict[str, Any]:
    """③ TF-IDF 索引。

    没有独立产物文件：检索器在**加载 jsonl 时**现建矩阵。所以这一站做两件事——
    清掉按域检索器的进程内缓存（不然新库要重启引擎才看得见），然后真的把它加载起来
    并打一次样本查询，证明「这个库现在检索得到」。
    """
    from backend.rag.retriever import get_corpus_retriever, refresh_corpora

    refresh_corpora()
    retriever = get_corpus_retriever(run.corpus)
    if retriever is None:
        raise StageError(f"语料「{run.corpus}」的索引建起来了却加载不出检索器")

    probe_query = retriever.chunks[0].title if retriever.chunks else run.corpus
    hits = retriever.search(probe_query, top_k=3)
    return {
        "backend": type(retriever).__name__,
        "chunks": len(retriever.chunks),
        "probe_query": probe_query,
        "probe_hits": len(hits.retrieved_chunks),
        "probe_top_score": hits.retrieved_chunks[0].score if hits.retrieved_chunks else None,
        "probe_warning": hits.missing_evidence_warning,
    }


def _stage_vector(run: IntakeRun) -> dict[str, Any]:
    """③旁路 向量索引。**要花钱**（bge-m3 嵌入），默认关。

    没有任何下游依赖它，所以它慢它的，⑤ 该跑跑。TF-IDF 已经先行可用，
    这一站完成时事件里带 upgraded=true，前端据此把该库的检索后端改标成向量。
    """
    _ensure_scripts_path()
    from build_embedding_index import build_corpus_index  # type: ignore[import-not-found]

    out, rows, dim = build_corpus_index(run.corpus)
    rel = _rel(out)
    run.record["products"]["embeddings"] = rel
    from backend.rag.retriever import refresh_corpora

    refresh_corpora()
    run.emit("vector", "stage_progress", "向量索引就绪，检索后端可升级", upgraded=True)
    return {"path": rel, "rows": rows, "dim": dim}


def _stage_knowledge(run: IntakeRun) -> dict[str, Any]:
    """④ 知识整理 → readiness.json。

    产物**一律标待人工签核**：这一站抽出来的前置边是模型判的，2026-08-12 按引用原句
    逐条初审过一轮，两个语料合计 10/21 = 47.6% 正确、没过 80% 线
    （`docs/05-evidence/prereq-review-iotdb-20260812.md`）。所以设计稿 §7.6 的口径是
    人工签字才算硬前置，未签核的一律只作软前置，报告里不许说成已确认。

    概念抽取与前置判定要调 LLM（O(n) 到 O(n²) 次），默认关；关着的时候这一站仍然做
    零 API 的结构信号探测，并如实写「词表未抽取」。
    """
    from backend.rag import structure_edges as se

    structure = se.probe(run.docs_dir)
    if structure:
        run.emit(
            "knowledge",
            "stage_progress",
            f"结构信号：章级概念面 {structure['chapters']} 个，交叉引用 {structure['xrefs_total']} 条，"
            f"结构候选边 {len(structure['edges'])} 条",
            chapters=structure["chapters"],
            candidate_edges=len(structure["edges"]),
        )
        # 语料形态。**下游吃顺序的东西按它开关**：章节序当前置默认、
        # 难度冷启动的位置先验，只在 textbook 形态上激活。
        # docsite 形态如实说「这个库没有章节序」——不假装算得出来。
        form = structure.get("structure_form") or {}
        if form.get("form") == "docsite":
            run.emit(
                "knowledge",
                "stage_warning",
                f"这份语料是**文档站形态**：{form.get('why', '')}。"
                "所以前置关系只能给措辞级的软建议，难度也不做位置推断——"
                "这两样都要作者写下的顺序，这个库里没有。教材形态的库不受此限。",
                structure_form=form,
            )
        elif form.get("form") == "textbook":
            run.emit(
                "knowledge",
                "stage_progress",
                f"这份语料是**教材形态**：{form.get('why', '')}。章节序可用作前置默认与难度位置先验。",
                structure_form=form,
            )

    vocab: list[dict] = []
    graph: dict[str, Any] = {"items": [], "clauses": {}}
    vocab_note = "未抽取——概念抽取要调 LLM，本次 run 的 extract_concepts 开关是关的"
    if run.record["options"].get("extract_concepts"):
        vocab, graph, vocab_note = _extract_concepts(run)

    manifest = run.ctx["manifest"]
    sections = run.ctx["sections"]
    from backend.rag.intake import detect_license

    lic = detect_license(run.docs_dir)
    report = {
        "domain": run.corpus,
        "scope": run.record.get("scope", ""),
        "source_dir": str(run.docs_dir),
        "produced_by": {"pipeline": "domain_intake", "run_id": run.run_id, "at": now_iso()},
        "license": {"spdx": lic.spdx, "evidence": lic.evidence, "unknown": lic.unknown},
        "intake": {
            "accepted_files": len(manifest.accepted),
            "accepted_chars": manifest.accepted_chars,
            "rejected": [{"file": r, "reason": w} for r, w in manifest.rejected],
            "injection_hits": manifest.injection_hits[:50],
            "sections": len(sections),
        },
        "concepts": vocab,
        "vocabulary_note": vocab_note,
        "prereq_graph": graph,
        "structure_signals": None
        if not structure
        else {
            "chapters": structure["chapters"],
            "xrefs_total": structure["xrefs_total"],
            "xrefs_within_chapter": structure["xrefs_within_chapter"],
            "candidate_edges": len(structure["edges"]),
            # 形态门控的判据落盘：下游（③ 前置默认序、D28 位置先验）读它决定激活不激活。
            "structure_form": structure.get("structure_form"),
        },
        "corpus_index": {
            "path": run.record["products"].get("corpus_index", ""),
            "chunks": (run.record["stages"]["chunk"].get("detail") or {}).get("chunks", 0),
        },
        "human_signoff": {
            "required": True,
            "signed": False,
            "what": "前置边方向",
            "why": "模型初审两个语料合计 10/21 = 47.6% 正确，未过 80% 线；"
                   "设计稿 §7.6 要求人工签字才算硬前置",
            "evidence": "docs/05-evidence/prereq-review-iotdb-20260812.md",
        },
        "readiness": {
            "gate0_retrievable": bool(run.record["products"].get("corpus_index")),
            "gate1_vocabulary": len(vocab) >= 2,
            "gate2_graph_connected": bool(graph.get("clauses")),
            "gate3_item_mapping": False,
            "gate3_note": "测项映射未实现——该概念的掌握度置信封顶且禁止跳过",
            "reviewed_edges": 0,
            "note": "本报告由领域接入流水线生成。全部前置边未经人工签核，只作软前置（§7.6）；"
                    "不构成对前置图质量的效果承诺。",
        },
        # 先写「没测」，⑦ 站跑完再盖章（`_stamp_trial_verdict`）。写成显式的 unknown 而不是
        # 留空字段，是因为下游要能一眼分清「没测」和「测了没过」——缺字段会被读成前者也可能
        # 被读成后者，全看谁写的那行代码。
        "trial_verdict": {
            "verdict": "unknown",
            "reason": "本次 run 未跑 ⑦ 指标复测（⑥⑦ 是 optional，试跑体检默认关）",
            "checks": [],
        },
    }
    out_dir = KB / f"{run.corpus}_intake"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "readiness.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    rel = _rel(path)
    run.record["products"]["readiness"] = rel
    return {
        "readiness_path": rel,
        "concepts": len(vocab),
        "prereq_clauses": len(graph.get("clauses", {})),
        "human_signoff_required": True,
        "vocabulary_note": vocab_note,
    }


def _extract_concepts(run: IntakeRun) -> tuple[list[dict], dict[str, Any], str]:
    """开了 extract_concepts 才走这条：复用 `ingest_domain` 的词表与前置链，不另立一套。"""
    from backend.rag.concepts import (
        extract_from_sections,
        merge_candidates,
        prune,
        to_vocabulary,
    )
    from backend.services.llm_gateway import LLMGateway

    _ensure_scripts_path()
    from ingest_domain import (  # type: ignore
        AGENT_CONCEPT,
        build_prereq,
        concept_evidence,
        concept_positions,
    )

    gateway = LLMGateway()
    if not gateway.route_for(AGENT_CONCEPT).enabled:
        return [], {"items": [], "clauses": {}}, "未抽取——LLM 路由未启用（检查 SILICONFLOW_API_KEY 与 AGENT_GENERATION_MODE）"

    def ask(system: str, user: str) -> dict | None:
        return gateway.structured_chat(AGENT_CONCEPT, system, user, temperature=0.1, max_tokens=800)

    sections = run.ctx["sections"]
    max_sections = int(run.record["options"].get("max_sections", 120))
    picked = sections
    if len(sections) > max_sections:
        step = len(sections) / max_sections
        picked = [sections[int(i * step)] for i in range(max_sections)]
    found = extract_from_sections(picked, ask)
    kept = prune(found)
    merged, _log = merge_candidates(kept, ask)
    vocab = to_vocabulary(merged)
    run.emit(
        "knowledge",
        "stage_progress",
        f"词表：候选 {len(found)} → 支撑够 {len(kept)} → 归并后 {len(merged)}",
        candidates=len(found),
        vocabulary=len(merged),
    )
    if len(merged) < 2:
        return vocab, {"items": [], "clauses": {}}, f"词表只抽到 {len(merged)} 个概念，前置图无从谈起"

    names = [v["concept"] for v in vocab]
    evidence = {v["concept"]: concept_evidence(v) for v in vocab}
    # 位置只对教材形态有意义；文档站形态 concept_positions 会退化成一堆 (999,)，
    # order_agrees 全落成 tie/None，等于没记——这正是我们要的降级行为。
    graph, _meta = build_prereq(gateway, names, evidence, concept_positions(vocab))
    _backfill_concept_tags(run, vocab)
    return vocab, graph, f"抽出 {len(merged)} 个概念（EXTRACT/MERGE 提示词复用 backend.rag.concepts）"


def _backfill_concept_tags(run: IntakeRun, vocab: list[dict]) -> None:
    """② 建库时 concept_tags 是空的，词表出来后重写一遍索引再刷缓存。

    `supersede=False` 是这里唯一的讲究：② 刚写下的那一代块，几分钟前才落盘、
    没出过任何一门课。按重建的默认口径它会被归档，而归档层是按 source_id
    新档盖旧档的——等于用一代从没上过屏的块，盖掉真正被旧课引用着的上一代归档。
    回填只换活层，归档层原样不动。
    """
    _ensure_scripts_path()
    from ingest_domain import write_corpus_index  # type: ignore[import-not-found]

    from backend.rag.retriever import refresh_corpora

    write_corpus_index(
        run.corpus,
        run.ctx["sections"],
        vocab,
        run.record["options"].get("tier_range", "L1-L3"),
        supersede=False,
    )
    refresh_corpora()
    run.emit("knowledge", "stage_progress", f"已用 {len(vocab)} 个概念回填 concept_tags 并重建索引")


def _stage_gold(run: IntakeRun) -> dict[str, Any]:
    """⑤ 从语料结构机械导出覆盖率金标，落盘时盖冻结时间戳。

    冻结不是仪式：覆盖率复测的前提是分母在生成之前就定死。规则（derive_kc_gold）
    先于语料存在、不含领域词，落盘时间戳只是把「这一份用于此后所有复测」写下来。
    """
    _ensure_scripts_path()
    from derive_kc_gold import derive, write_gold  # type: ignore[import-not-found]

    if not any(run.docs_dir.rglob("*.md")):
        raise StageSkipped(
            "这份语料里没有 .md——金标按 markdown 的标题层级机械导出，纯 txt 没有可用结构。"
            "库照建，覆盖率复测这一格空着"
        )
    topics = derive(run.docs_dir)
    kept = {t: kcs for t, kcs in topics.items() if len(kcs) >= 2}
    out_dir = GOLD_DIR / run.corpus
    write_gold(kept, out_dir, run.docs_dir)
    frozen_at = now_iso()
    (out_dir / "_freeze.json").write_text(
        json.dumps(
            {
                "corpus": run.corpus,
                "run_id": run.run_id,
                "frozen_at": frozen_at,
                "topics": len(kept),
                "knowledge_components": sum(len(v) for v in kept.values()),
                "derived_by": "scripts/derive_kc_gold.py（机械规则，零 LLM 调用，规则先于语料）",
                "note": "此后覆盖率复测以本目录为分母。语料变更要重新派生并重新冻结。",
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    rel = _rel(out_dir)
    run.record["products"]["kc_gold"] = rel
    return {
        "gold_dir": rel,
        "topics": len(kept),
        "knowledge_components": sum(len(v) for v in kept.values()),
        "dropped_topics": len(topics) - len(kept),
        "frozen_at": frozen_at,
    }


# ── ⑥⑦ 试跑与复测：本文件里唯一真花钱的两站 ──────────────────────────────────
#
# 为什么走 HTTP 打到 classroom：**引擎自己没有换库生成的路**。
# `scripts/build_curriculum.py` 钉死默认语料，LangGraph 那条的 `KnowledgeRetrievalAgent`
# 用的是 `get_retriever()`（默认索引）。能按 corpus 换书生成、且正文与判官读同一本书的，
# 只有 classroom 侧那条链（正文 `/api/generate/scene-content`、判官
# `/api/generate/scene-audit`，两边都吃 `learnerProfile.corpus`）。这里**只调用不改**。
# classroom 没起就如实跳过——不假装跑过，也不换个别的语料凑数。

#: 生成端地址。默认本机 dev/prod 常用口，部署时用环境变量指过去。
CLASSROOM_BASE_URL = os.environ.get("CLASSROOM_BASE_URL", "http://127.0.0.1:3000")
#: 成本的唯一真源：LLM 调用发生在 classroom 那侧，账本也只有那一份。
CLASSROOM_USAGE_DIR = ROOT.parent / "classroom" / "data" / "usage"

#: 受控并行度。参照物是 classroom 既有的 `PARALLEL_SCENE_CONCURRENCY=3`
#: （`.env.local`，场景内容预取）。这里取 2 而不是 3：那边一格是「一次正文生成」，
#: 这里一格是「正文 + 判官全链」——判官单轮实测 392s、最长一次 592.9s，单位重得多。
TRIAL_CONCURRENCY = int(os.environ.get("TRIAL_CONCURRENCY", "2") or 2)

#: run 级 token 预算，超了就停机（不再发新的生成），并落一条事件。
#: 默认值出处：F1 的三次真实补救生成（每次 = 1 次正文 + 判官全链），
#: 按 `apps/classroom/data/usage/2026-08.jsonl` 时间窗求和 = 31 次调用 /
#: 106,004 input + 82,380 output = 188,384 token，均值 62,795 一次、最贵一次 106,329。
#: 本站最小配置是 4 次生成，按**最贵那次**估 4 × 106,329 ≈ 425k，取 500k（约 18% 余量）。
TRIAL_TOKEN_BUDGET = int(os.environ.get("TRIAL_TOKEN_BUDGET", "500000") or 500000)

#: 一门试跑课几屏。屏数直接决定花的钱（每屏 = 一次正文 + 一次判官全链）。
TRIAL_SCENES_PER_COURSE = 2
#: 单次生成的读超时。F1 实测最长一次 592.9s，留到 15 分钟。
TRIAL_HTTP_TIMEOUT = 900

#: 两档画像。除等级与背景外一个字段不差——差异只能来自档位，否则「个性化跟随」不成立。
#: `corpus` 单独给（G3 的口径：corpus 选书，domain 是培训领域语义，两件事不合并）。
TRIAL_TIERS: dict[str, dict[str, Any]] = {
    "beginner": {
        "label": "入门档",
        "profile": {
            "education": "college",
            "role": "零基础转岗的新员工",
            "programming_level": 0,
            "python_level": 0,
            "agent_level": 0,
            "rag_level": 0,
            "engineering_level": 0,
        },
    },
    "advanced": {
        "label": "进阶档",
        "profile": {
            "education": "master",
            "role": "有多年现场经验的工程师",
            "programming_level": 4,
            "python_level": 4,
            "agent_level": 4,
            "rag_level": 4,
            "engineering_level": 4,
        },
    },
}

#: 这句话必须原样出现在事件与产物文档里。⑦ 的每个数字都是个位数分母的体检，
#: 与对外三指标不是一回事，混比就是造假。
SMALL_SAMPLE_NOTE = "小样本体检，非对外指标"

#: 上屏文案。红线：不写「真花钱」这类自我担保口吻，只写事实（调什么、按什么计费、开关叫什么）。
TRIAL_OFF_REASON = "默认关闭——试跑课程会调用生成与审核接口，按 token 计费。开关 trial_run"

#: 覆盖这一站为什么不出比率。`{screens}` 屏、`{outline}` 个大纲点名的知识成分、
#: `{gold}` 个金标知识成分，三个数都在运行期填真值。
COVERAGE_NO_RATIO = (
    "试跑固定 {screens} 屏，大纲机械点名 {outline} 个知识成分，而金标主题共 {gold} 个。"
    "两者相除量到的是试跑规模与金标规模之比，不是覆盖能力，"
    "所以这一站不出覆盖率，只列没讲到的知识成分供排查。"
)

#: 既有库体检时 ①-⑤ 的跳过原因。
CHECKUP_SKIP_REASON = "既有库体检——语料、索引与金标已在盘上，本次不重建"


class _TokenMeter:
    """成本计量 + 预算闸。

    账本按月一个文件、只追加，所以开跑时记下行数，此后每次只读新增的那几行。
    ponytail: 跨月那一刻会读不到上个月文件的新增行（凌晨零点开跑才会撞上），
    不为这一秒加一份跨文件合并逻辑。
    """

    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.path = CLASSROOM_USAGE_DIR / f"{time.strftime('%Y-%m')}.jsonl"
        self._base = len(self._rows())
        self.engine_tokens = 0  # 盲评判官走引擎自己的网关，不进 classroom 账本

    def _rows(self) -> list[str]:
        try:
            return [ln for ln in self.path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        except OSError:
            return []

    def snapshot(self) -> dict[str, int]:
        calls = inp = out = 0
        for line in self._rows()[self._base :]:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            calls += 1
            inp += int(row.get("inputTokens") or 0)
            out += int(row.get("outputTokens") or 0)
        return {
            "llm_calls": calls,
            "input_tokens": inp,
            "output_tokens": out,
            "engine_tokens": self.engine_tokens,
            "total_tokens": inp + out + self.engine_tokens,
            "budget_tokens": self.budget,
        }

    def over_budget(self) -> bool:
        return self.snapshot()["total_tokens"] >= self.budget


def _classroom_post(path: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    import requests

    url = f"{CLASSROOM_BASE_URL.rstrip('/')}{path}"
    response = requests.post(url, json=payload, timeout=(15, timeout))
    try:
        body = response.json()
    except ValueError:
        raise StageError(f"生成端返回的不是 JSON（HTTP {response.status_code}）") from None
    if not response.ok or not body.get("success"):
        raise StageError(f"生成端 HTTP {response.status_code}：{body.get('error') or '未知原因'}")
    return body


def _pick_gold_topic(run: IntakeRun) -> dict[str, Any]:
    """从 ⑤ 冻结的金标里挑供给最厚的一个主题当试跑课题。"""
    # 主语料 ai 的金标在 GOLD_DIR 根目录，各领域库才各占一个子目录（见 checkup_gold_dir）。
    gold_dir = checkup_gold_dir(run.corpus)
    best: dict[str, Any] | None = None
    for path in sorted(gold_dir.glob("*.json")):
        if path.name == "_freeze.json":
            continue
        data = _read_json(path)
        if not data or not data.get("knowledge_components"):
            continue
        if best is None or len(data["knowledge_components"]) > len(best["knowledge_components"]):
            best = {**data, "_path": str(path)}
    if best is None:
        raise StageSkipped("⑤ 没冻结出任何带知识成分的金标主题，试跑无题可跑")
    return best


def _trial_outlines(course_title: str, kcs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把金标主题的知识成分机械切成 N 屏大纲。

    这里**不调大纲生成**：大纲那一步与 corpus 无关（G3 查明它只加了未建库拦截，
    不做检索），花一次钱换不来本单要证的任何一件事。屏题与要点直接取金标 KC——
    副作用是覆盖率复测的分子分母对得上，谁没讲到一眼可查。
    """
    per = max(1, (len(kcs) + TRIAL_SCENES_PER_COURSE - 1) // TRIAL_SCENES_PER_COURSE)
    outlines = []
    for i in range(TRIAL_SCENES_PER_COURSE):
        group = kcs[i * per : (i + 1) * per][:5]
        if not group:
            break
        names = [str(kc.get("name") or kc.get("id")) for kc in group]
        outlines.append(
            {
                "id": f"s{i + 1}",
                "type": "slide",
                "title": "、".join(names[:2]),
                "description": f"{course_title}：讲清 " + "、".join(names),
                "keyPoints": names,
                "order": i,
                "estimatedDuration": 300,
            }
        )
    return outlines


def _generate_and_audit(
    run: IntakeRun, tier: str, outline: dict, outlines: list[dict], course_title: str, corpus: str
) -> dict[str, Any]:
    """一屏：正文生成 → **紧接着**判官。

    判官不等整门课生成完再批量跑：一屏出来就审一屏，这样 ⑦ 的幻觉抽检拿到的
    就是生成期判官的原始判定，不用为同一批断言再花第二遍钱。
    """
    profile = {**TRIAL_TIERS[tier]["profile"], "corpus": corpus}
    requirements = {"requirement": course_title, "learnerProfile": profile}
    t0 = time.perf_counter()
    content_body = _classroom_post(
        "/api/generate/scene-content",
        {
            "outline": outline,
            "allOutlines": outlines,
            "stageId": f"{run.run_id}:{tier}",
            "stageInfo": {"name": course_title},
            "requirements": requirements,
        },
        TRIAL_HTTP_TIMEOUT,
    )
    content = content_body.get("content")
    gen_ms = round((time.perf_counter() - t0) * 1000)

    t1 = time.perf_counter()
    audit_body = _classroom_post(
        "/api/generate/scene-audit",
        {
            "outline": outline,
            "content": content,
            "courseTitle": course_title,
            "learnerProfile": profile,
        },
        TRIAL_HTTP_TIMEOUT,
    )
    audit = audit_body.get("audit") or {}
    return {
        "id": outline["id"],
        "title": outline["title"],
        "type": outline["type"],
        "keyPoints": outline["keyPoints"],
        "content": audit_body.get("content") or content,
        "audit": audit,
        "pipeline": content_body.get("pipeline"),
        "generate_ms": gen_ms,
        "audit_ms": round((time.perf_counter() - t1) * 1000),
    }


def _stage_trial(run: IntakeRun) -> dict[str, Any]:
    """⑥ 在新库上真跑课程：1 个课题 × 2 档画像 × N 屏，受控并行。"""
    topic = _pick_gold_topic(run)
    kcs = topic["knowledge_components"]
    names = [str(kc.get("name") or kc.get("id")) for kc in kcs]
    subject = run.record.get("scope") or run.corpus
    course_title = f"{subject}：{names[0]}与{names[1]}" if len(names) > 1 else f"{subject}：{names[0]}"
    outlines = _trial_outlines(course_title, kcs)
    meter = _TokenMeter(TRIAL_TOKEN_BUDGET)
    run.ctx["meter"] = meter

    run.emit(
        "trial",
        "stage_progress",
        f"课题「{course_title}」：两档画像各 {len(outlines)} 屏，共 {len(outlines) * 2} 次生成"
        f"（并行 {TRIAL_CONCURRENCY}，token 预算 {TRIAL_TOKEN_BUDGET:,}）",
        course_title=course_title,
        gold_topic=topic["topic"],
        scenes_per_course=len(outlines),
        tiers=list(TRIAL_TIERS),
        concurrency=TRIAL_CONCURRENCY,
        budget_tokens=TRIAL_TOKEN_BUDGET,
    )

    units = [(tier, outline) for tier in TRIAL_TIERS for outline in outlines]
    scenes: dict[str, list[dict]] = {tier: [] for tier in TRIAL_TIERS}
    failures: list[str] = []
    halted = ""
    pending = list(units)
    with ThreadPoolExecutor(max_workers=TRIAL_CONCURRENCY, thread_name_prefix="trial") as pool:
        running: dict[Future, tuple[str, dict]] = {}
        while pending or running:
            while pending and len(running) < TRIAL_CONCURRENCY and not halted:
                if meter.over_budget():
                    snap = meter.snapshot()
                    halted = (
                        f"已用 {snap['total_tokens']:,} token，达到本次预算 "
                        f"{TRIAL_TOKEN_BUDGET:,}，停止发起新的生成"
                    )
                    run.emit("trial", "stage_progress", f"预算闸触发：{halted}", budget_halt=True, **snap)
                    break
                tier, outline = pending.pop(0)
                running[pool.submit(_generate_and_audit, run, tier, outline, outlines, course_title, run.corpus)] = (
                    tier,
                    outline,
                )
            if not running:
                break
            finished, _ = wait(list(running), return_when=FIRST_COMPLETED)
            for fut in finished:
                tier, outline = running.pop(fut)
                label = TRIAL_TIERS[tier]["label"]
                try:
                    scene = fut.result()
                except BaseException as exc:  # noqa: BLE001 —— 一屏失败不该毁掉另外三屏
                    reason = (str(exc) if isinstance(exc, StageError) else f"{type(exc).__name__}: {exc}")[:300]
                    failures.append(f"{label}「{outline['title']}」：{reason}")
                    run.emit("trial", "stage_progress", f"{label}「{outline['title']}」生成失败：{reason}")
                    continue
                scenes[tier].append(scene)
                audit = scene["audit"]
                snap = meter.snapshot()
                # 资料到位判据（WO-L1，与 scripts/audit-grounding-scan.py 同口径）：
                # pipeline.assembly 空 = 生成端一块摘录都没拿到，正文凭模型记忆写。
                # 判官那条链是独立的（audit.evidenceCount 照样是 6），光看审核层看不出来
                # ——所以必须在这里显式喊出来，不许只躺在 trial_courses/*.json 里。
                pipe = scene.get("pipeline") or {}
                material_note = ""
                if not pipe.get("assembly"):
                    reasons = "；".join(pipe.get("bridgeWarnings") or ["检索零命中或未接地"])
                    material_note = f"⚠ 无资料生成（{reasons}）；"
                run.emit(
                    "trial",
                    "stage_progress",
                    f"{label}「{outline['title']}」完成：{material_note}"
                    f"断言 {audit.get('totalClaims', 0)} 条、"
                    f"存疑 {audit.get('flaggedCount', 0)} 条，判官对照资料 {audit.get('evidenceCount', 0)} 块，"
                    f"生成 {scene['generate_ms'] / 1000:.0f}s + 审核 {scene['audit_ms'] / 1000:.0f}s；"
                    f"累计 {snap['total_tokens']:,} token",
                    tier=tier,
                    scene_title=outline["title"],
                    material_ok=bool(pipe.get("assembly")),
                    bridge_warnings=pipe.get("bridgeWarnings") or [],
                    claims=audit.get("totalClaims", 0),
                    flagged=audit.get("flaggedCount", 0),
                    evidence_count=audit.get("evidenceCount", 0),
                    verdict=audit.get("verdict"),
                    generate_ms=scene["generate_ms"],
                    audit_ms=scene["audit_ms"],
                    **snap,
                )
        if halted:
            pending.clear()

    produced = {t: sorted(v, key=lambda s: s["id"]) for t, v in scenes.items() if v}
    if not produced:
        raise StageError(
            f"预算闸在第一次生成前就触发：{halted}"
            if halted
            else f"{len(units)} 次生成全部失败：" + ("；".join(failures[:2]) or "无成功产出")
        )

    out_dir = run.dir / "trial_courses"
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {}
    for tier, tier_scenes in produced.items():
        # 落成与 classroom 课程同形的 json：覆盖率复测直接喂给
        # `scripts/compute_kc_coverage.py`，不另造一套读法。**不进 data/classrooms/**。
        path = out_dir / f"{tier}.json"
        path.write_text(
            json.dumps(
                {
                    "stage": {"name": f"{course_title}（{TRIAL_TIERS[tier]['label']}）"},
                    "corpus": run.corpus,
                    "tier": tier,
                    "gold_topic": topic["topic"],
                    "note": f"领域接入流水线的试跑产物，{SMALL_SAMPLE_NOTE}；不进课堂课程库。",
                    "scenes": tier_scenes,
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        paths[tier] = _rel(path)

    # 资料到位率（WO-L1）：生成端真拿到摘录的屏数 / 总屏数。没拿到的屏凭模型
    # 记忆写，接地率天然趋零——那是管道故障不是领域泛化的证据（2026-08-17 之前
    # 12/48 屏就是这样把工程 bug 伪装成「泛化不过关」，骗过两天诊断）。
    no_material: list[dict[str, Any]] = []
    for tier, tier_scenes in produced.items():
        for scene in tier_scenes:
            pipe = scene.get("pipeline") or {}
            if not pipe.get("assembly"):
                no_material.append({
                    "tier": tier,
                    "scene": scene["title"],
                    "reasons": pipe.get("bridgeWarnings") or ["检索零命中或未接地"],
                })
    total_scenes = sum(len(v) for v in produced.values())
    evidence_ready = {
        "ready": total_scenes - len(no_material),
        "total": total_scenes,
        "no_material": no_material,
    }

    run.ctx["trial"] = {
        "course_title": course_title,
        "gold_path": topic["_path"],
        "gold_topic": topic["topic"],
        "courses": produced,
        "paths": paths,
        "evidence_ready": evidence_ready,
    }
    snap = meter.snapshot()
    run.record["products"]["trial_courses"] = _rel(out_dir)
    return {
        "course_title": course_title,
        "gold_topic": topic["topic"],
        "courses": len(produced),
        "scenes": total_scenes,
        "planned_scenes": len(units),
        "evidence_ready": evidence_ready,
        "failures": failures,
        "budget_halt": halted,
        "cost": snap,
        "paths": paths,
        "sample_note": SMALL_SAMPLE_NOTE,
    }


# ── ⑦ 三项复测：互不依赖，并行 ─────────────────────────────────────────────


def _metric_hallucination(run: IntakeRun, trial: dict) -> dict[str, Any]:
    """幻觉抽检：口径就是生成期那一遍判官的逐条判定，不重跑。

    重跑等于对同一批断言付第二遍钱换同一批判定；判官是同一个（`/api/generate/scene-audit`
    的异族判官团 + 仲裁），口径一个字不差。
    """
    claims: list[dict] = []
    sources: list[dict] = []
    for tier, scenes in trial["courses"].items():
        for scene in scenes:
            audit = scene.get("audit") or {}
            for claim in audit.get("claims") or []:
                claims.append({**claim, "tier": tier, "scene": scene["title"]})
            sources.extend(audit.get("sources") or [])
    total = len(claims)
    supported = sum(1 for c in claims if c.get("verdict") == "supported")
    incorrect = sum(1 for c in claims if c.get("verdict") == "incorrect")
    uncertain = sum(1 for c in claims if c.get("verdict") == "uncertain")
    corpus_prefixes = _corpus_source_ids(run.corpus)
    pool_ids = [s.get("source_id", "") for s in sources]
    in_corpus = sum(1 for sid in pool_ids if sid in corpus_prefixes)
    return {
        "claims_checked": total,
        "supported": supported,
        "incorrect": incorrect,
        "uncertain": uncertain,
        "supported_rate": round(supported / total, 4) if total else None,
        "judge_evidence_pool": len(pool_ids),
        "judge_evidence_from_new_corpus": in_corpus,
        "sample_claims": [
            {"claim": c["claim"][:120], "verdict": c.get("verdict"), "sourceIds": c.get("sourceIds") or []}
            for c in claims[:2]
        ],
        "sample_note": SMALL_SAMPLE_NOTE,
    }


def _corpus_source_ids(corpus: str) -> set[str]:
    """本库索引里全部 source_id——判官看到的资料到底是不是这本书，靠它对。

    路径必须走 `checkup_index_path()`：主语料 ai 的索引在 `knowledge_base/` 根目录，
    不在 `corpora/` 下。写死 `CORPORA_DIR / corpus` 时对 ai 恒返回空集，
    于是 `judge_evidence_from_new_corpus` 恒为 0——2026-08-16 第一次给主库跑体检时
    量出 `0/49`，而同一轮的 supported 率是 86.2%，两个数自相矛盾。
    这不是「主库判官没读本库资料」，是这个函数根本没找到主库的索引文件。
    """
    path = checkup_index_path(corpus)
    ids: set[str] = set()
    try:
        # **归档块也算数**，所以这里显式要全量。这个集合回答的是
        # 「判官引的这条出处是不是本库的」——旧课引的正是被顶替的那一代块，
        # 只看活块会把它们判成「不是本库的资料」，接地率凭空掉一截。
        # 与其他计数类读点方向相反，所以写明 include_superseded=True。
        from backend.rag.ingest import read_index_rows

        ids = {row.get("source_id", "") for row in read_index_rows(path, include_superseded=True)}
    except (OSError, json.JSONDecodeError):
        pass
    return ids


def _metric_coverage(run: IntakeRun, trial: dict) -> dict[str, Any]:
    """覆盖：对 ⑤ 冻结的金标点名，**只出没讲到的清单，不出比率**。

    ponytail: shell 出去调 `scripts/compute_kc_coverage.py` 而不是 import——
    命中规则（特异词/泛词、MIN_CONTEXT 讲解门）整段写在那个脚本的 main() 里，
    把它抄一份进来就等于开第二个口径真源。宁可多起一个进程。

    ## 为什么撤掉「命中 x / 金标 N」这个比率（2026-08-17）

    分母是金标全集（实测 ai 25、iotdb 29、odoo 20），而分子来自固定 2 屏的试跑课。
    `_trial_outlines()` 把金标切成 `TRIAL_SCENES_PER_COURSE` 组、**每组再截断到 5 个**，
    所以大纲实际点名的知识成分恒为 2×5=10 个——三个域跑出来都是 10（实测
    `intake_runs/20260816T172513-e64b6e`(ai) / `…T164153-5e4961`(iotdb) /
    `…T115536-1cc043`(odoo) 的 trial_courses/*.json `keyPoints` 去重后各 10）。
    另外 15/19/10 个知识成分从来没被要求讲，却记在分母里。

    于是这个比率量的是「试跑规模 ÷ 金标规模」：三个域一齐失真，主语料自己最低
    （最新一轮 1/25、1/25）。它既证不了泛化差、也证不了主语料好。

    换成小分母（大纲点名的 10 个）也不成立：那个 10 是 `TRIAL_SCENES_PER_COURSE × 5`
    这条配置常量，不随领域变；比出来的是「生成器有没有照自己的大纲讲」，
    与这一站要回答的「换库之后覆盖得住吗」不是一件事，换个标签印上去只是换了一个指标。
    所以撤下这一格，改出没讲到的清单——排查用得上，且不冒充覆盖率。
    """
    gold = _read_json(Path(trial["gold_path"])) or {}
    total = len(gold.get("knowledge_components") or [])
    outline_kcs = len({
        kp
        for scenes in trial["courses"].values()
        for scene in scenes
        for kp in (scene.get("keyPoints") or [])
    })
    script = ROOT / "scripts" / "compute_kc_coverage.py"
    per_tier: dict[str, Any] = {}
    for tier in trial["courses"]:
        course_path = run.dir / "trial_courses" / f"{tier}.json"
        misses_path = run.dir / "trial_courses" / f"{tier}_kc_misses.json"
        proc = subprocess.run(
            [
                sys.executable,
                str(script),
                "--gold",
                trial["gold_path"],
                "--course",
                str(course_path),
                "--emit-misses",
                str(misses_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ROOT),
            timeout=120,
        )
        if proc.returncode != 0:
            per_tier[tier] = {"error": (proc.stderr or "").strip()[-200:]}
            continue
        report = _read_json(misses_path) or {}
        # `hits` 不再返回：那是比率的分子，留着就会有人再把它除以 gold_total 印上屏。
        per_tier[tier] = {
            "gold_total": total,
            "mentions_only": len(report.get("mentions") or []),
            "missed": [m.get("name") for m in (report.get("misses") or [])],
        }
    return {
        "gold_topic": trial["gold_topic"],
        "gold_total": total,
        "frozen_gold": _rel(Path(trial["gold_path"])),
        "reason": COVERAGE_NO_RATIO.format(
            screens=TRIAL_SCENES_PER_COURSE, outline=outline_kcs, gold=total
        ),
        "per_tier": per_tier,
        "sample_note": SMALL_SAMPLE_NOTE,
    }


_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)


def _scene_texts(scenes: list[dict]) -> str:
    _ensure_scripts_path()
    from compute_kc_coverage import scene_text  # type: ignore[import-not-found]

    return "\n".join(scene_text(s) for s in scenes)


def _metric_personalization(run: IntakeRun, trial: dict) -> dict[str, Any]:
    """个性化跟随：同题两档的差异归因 + 盲评判官判档。

    差异归因是机械的（照 compare_service 的做法：每处差异指回一个结构化事实），
    不让模型事后编解释。盲评那一半才调模型：把两档的正文脱去档位标签丢给判官，
    问它这屏是给谁写的。
    """
    tiers = list(trial["courses"])
    if len(tiers) < 2:
        return {
            "comparable": False,
            "reason": f"只有 {len(tiers)} 档产出，同题异档无从谈起",
            "sample_note": SMALL_SAMPLE_NOTE,
        }
    a, b = tiers[0], tiers[1]
    diffs: list[dict[str, Any]] = []

    def blueprint(tier: str, key: str) -> Any:
        for scene in trial["courses"][tier]:
            bp = ((scene.get("pipeline") or {}).get("blueprint")) or {}
            if bp.get(key):
                return bp[key]
        return None

    for key, label in (
        ("difficulty", "推荐难度"),
        ("scaffold", "脚手架深度"),
        ("analogyDomain", "类比取材域"),
        ("learnerType", "学习者画像判定"),
    ):
        va, vb = blueprint(a, key), blueprint(b, key)
        if va and vb and va != vb:
            diffs.append(
                {
                    "dimension": key,
                    "observation": f"{label}不同：{TRIAL_TIERS[a]['label']}={va}；{TRIAL_TIERS[b]['label']}={vb}",
                    "because": "学情诊断按两档画像的等级字段算出的蓝图，不是事后解释",
                }
            )

    text_a, text_b = _scene_texts(trial["courses"][a]), _scene_texts(trial["courses"][b])
    if text_a and text_b and abs(len(text_a) - len(text_b)) / max(len(text_a), len(text_b)) >= 0.15:
        diffs.append(
            {
                "dimension": "length",
                "observation": f"正文体量差 {abs(len(text_a) - len(text_b)):,} 字"
                f"（{TRIAL_TIERS[a]['label']} {len(text_a):,} / {TRIAL_TIERS[b]['label']} {len(text_b):,}）",
                "because": "同一份大纲、同一个语料，唯一变量是画像等级",
            }
        )
    heads_a = set(_HEADING_RE.findall(text_a))
    heads_b = set(_HEADING_RE.findall(text_b))
    only = sorted(heads_a ^ heads_b)
    if only:
        diffs.append(
            {
                "dimension": "sections",
                "observation": f"小节标题有 {len(only)} 处只在一档里出现，例：「{only[0][:40]}」",
                "because": "同题同大纲下的展开取舍差异",
            }
        )
    code_a, code_b = text_a.count("```"), text_b.count("```")
    if code_a != code_b:
        diffs.append(
            {
                "dimension": "code",
                "observation": f"代码块数不同：{TRIAL_TIERS[a]['label']} {code_a // 2}；{TRIAL_TIERS[b]['label']} {code_b // 2}",
                "because": "配比计划里的 code_example_count 随档位变",
            }
        )

    blind = _blind_tier_judge(run, trial)
    return {
        "comparable": True,
        "differing_dimensions": len(diffs),
        "differences": diffs,
        "examples": diffs[:2],
        "blind_tier_judge": blind,
        "sample_note": SMALL_SAMPLE_NOTE,
    }


_BLIND_SYSTEM = (
    "你是课程难度盲评员。下面给你一屏课程正文，它可能面向零基础新人，也可能面向资深从业者。"
    '只输出 JSON：{"tier":"beginner"或"advanced","reason":"一句理由"}。'
)


def _blind_tier_judge(run: IntakeRun, trial: dict) -> dict[str, Any]:
    """盲评：正文里不带任何档位标签，问判官这屏写给谁。命中 x/n。"""
    from backend.services.llm_gateway import LLMGateway

    gateway = LLMGateway()
    if not gateway.route_for("EvaluationJudge").enabled:
        return {"ran": False, "reason": "判官路由未启用（AGENT_GENERATION_MODE / API key），盲评这一格空着"}

    items = [(tier, scene) for tier in trial["courses"] for scene in trial["courses"][tier]]
    rows = []
    hits = 0
    for tier, scene in items:
        text = _scene_texts([scene])[:3000]
        if not text.strip():
            rows.append({"scene": scene["title"], "truth": tier, "guess": None, "reason": "正文取不到文字"})
            continue
        reply = gateway.structured_chat("EvaluationJudge", _BLIND_SYSTEM, text, temperature=0.0, max_tokens=300)
        guess = str((reply or {}).get("tier", "")).strip().lower() or None
        hits += 1 if guess == tier else 0
        rows.append(
            {
                "scene": scene["title"],
                "truth": tier,
                "guess": guess,
                "reason": str((reply or {}).get("reason", ""))[:120],
            }
        )
    meter = run.ctx.get("meter")
    if meter is not None:
        snap = gateway.telemetry_snapshot()
        meter.engine_tokens += int(snap.get("total_tokens") or 0)
    return {"ran": True, "hit": hits, "total": len(rows), "rows": rows, "sample_note": SMALL_SAMPLE_NOTE}


def _grade_trial(result: dict[str, Any]) -> dict[str, Any]:
    """把 ⑦ 的复测数字对着**现成的门线**过一遍，出 passed / degraded / unknown 三态。

    门线不在这里立：事实性下限与幻觉上限直接取仲裁闸（`ArbitrationAgent` 的放行同参），
    样本量下限取 `claim_statistics` 的 `insufficient_claims` 同一条。这一站只做比对。

    三态必须分得开。`unknown` 是「没测 / 样本不足以判定」，`degraded` 是「测了没过线」。
    ⑥⑦ 本来就是 optional（管理者可以不勾试跑体检），把没测的库报成没过线是虚报；
    反过来把没测的报成过线更糟。所以两者永不合并成一个布尔。

    覆盖与个性化不参与判词：覆盖站按设计只点名不出比率（见 `_metric_coverage`），
    个性化那项也没有既有门线，给它们拍一条线就是新造口径。两项的数原样带在
    `not_graded` 里给人读。
    """
    from backend.agents.arbitration_agent import HALLUCINATION_CEILING, PUBLISH_FLOOR
    from backend.rag.claims import MIN_CLAIMS_FOR_VERDICT

    not_graded = [
        {"metric": "coverage", "why": "覆盖站只对金标点名、不出比率，没有可比的既有门线"},
        {"metric": "personalization", "why": "没有既有门线，只记差异维度数，不判定"},
    ]
    base = {
        "gate_source": "backend/agents/arbitration_agent.py（与仲裁放行同参）",
        "sample_note": SMALL_SAMPLE_NOTE,
        "not_graded": not_graded,
        "checks": [],
    }
    hall = result.get("hallucination") or {}
    total = hall.get("claims_checked") or 0
    if "error" in hall:
        return {**base, "verdict": "unknown", "reason": f"幻觉抽检没跑出来：{hall['error']}"}
    if total < MIN_CLAIMS_FOR_VERDICT:
        return {
            **base,
            "verdict": "unknown",
            "reason": f"抽检断言 {total} 条，不足 {MIN_CLAIMS_FOR_VERDICT} 条，判不了",
        }

    # ⑦ 判官的三态与 `backend/rag/claims.py` 的判词一一对应：
    # supported↔supported、uncertain↔weak、incorrect↔unsupported。
    factuality = round((hall["supported"] + 0.6 * hall["uncertain"]) / total, 3)
    hallucination = round(hall["incorrect"] / total, 3)
    checks = [
        {
            "metric": "factuality",
            "value": factuality,
            "floor": PUBLISH_FLOOR,
            "passed": factuality >= PUBLISH_FLOOR,
            "caliber": f"(supported {hall['supported']} + 0.6×uncertain {hall['uncertain']}) / "
                       f"{total}，与 claim_statistics.support_rate 同式",
        },
        {
            "metric": "hallucination_rate",
            "value": hallucination,
            "ceiling": HALLUCINATION_CEILING,
            "passed": hallucination <= HALLUCINATION_CEILING,
            "caliber": f"incorrect {hall['incorrect']} / {total}，严格下界（uncertain 不计入），"
                       "与 claim_statistics.hallucination_rate 同式",
        },
    ]
    failed = [c for c in checks if not c["passed"]]
    if failed:
        reason = "；".join(
            f"{c['metric']} {c['value']} "
            + (f"低于下限 {c['floor']}" if "floor" in c else f"高于上限 {c['ceiling']}")
            for c in failed
        )
        return {**base, "checks": checks, "verdict": "degraded", "reason": reason}
    return {
        **base,
        "checks": checks,
        "verdict": "passed",
        "reason": f"事实性 {factuality} ≥ {PUBLISH_FLOOR}，幻觉率 {hallucination} ≤ {HALLUCINATION_CEILING}",
    }


def _stamp_trial_verdict(run: IntakeRun, verdict: dict[str, Any]) -> None:
    """判词落回该库的 `readiness.json`——学习端只认这一个文件（`_corpus_gate` 读它）。

    库照样建成，这里只如实盖章：不过线的标 degraded（学习端按试运行处理），
    没测的仍是 ④ 站写下的 unknown。文件不在盘上（主库 `ai` 没有 intake 记录）就不新建，
    凭空造半张 readiness 会让知识中心把主库的原件数、章节数全读成 0。
    """
    path = KB / f"{run.corpus}_intake" / "readiness.json"
    report = _read_json(path)
    if not report:
        run.emit(
            "metrics",
            "stage_progress",
            f"`{run.corpus}` 没有 readiness.json，判词「{verdict['verdict']}」只留在本次 run 记录里",
            trial_verdict=verdict["verdict"],
        )
        return
    report["trial_verdict"] = {**verdict, "run_id": run.run_id, "at": now_iso()}
    path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    _refresh_registry_gate(run)


def _refresh_registry_gate(run: IntakeRun) -> None:
    """判词盖章后，把 ⑧ 清单里本库那一行的闸位重算一遍。

    ⑧ 只依赖 ④⑤，跑得比 ⑥⑦ 快得多（那两站要等 LLM），所以清单几乎必然是在判词落盘
    **之前**写好的——不补这一手，一个 degraded 的库在清单里仍然是 `eligible: true`，
    学习端照旧拿它出货，D29 就白做了。

    只改 `eligible` / `gate` 两格，且值来自 `_corpus_gate` 本身（判据仍是那一个真源）；
    行里其余字段（中文名、示例、岗位要求）是 ⑧ 的产物，一个字不动。
    """
    path = _registry_path()
    registry = _read_json(path)
    if not registry:
        return
    from backend.integration.personalize_service import _corpus_gate
    from backend.rag.retriever import get_corpus_retriever

    retriever = get_corpus_retriever(run.corpus)
    gate = _corpus_gate(run.corpus, len(retriever.chunks) if retriever else 0, retriever is not None)
    for row in registry.get("corpora") or []:
        if isinstance(row, dict) and row.get("corpus") == run.corpus:
            row["eligible"] = gate["passed"]
            row["gate"] = gate
            path.write_text(json.dumps(registry, ensure_ascii=False, indent=1), encoding="utf-8")
            return


def _stage_metrics(run: IntakeRun) -> dict[str, Any]:
    """⑦ 三项复测互不依赖 → 并行。每个数字自带分子分母，且自带小样本声明。"""
    trial = run.ctx.get("trial")
    if not trial:
        raise StageSkipped("⑥ 没有留下试跑产物，复测无从谈起")

    jobs = {
        "hallucination": _metric_hallucination,
        "coverage": _metric_coverage,
        "personalization": _metric_personalization,
    }
    result: dict[str, Any] = {}
    with ThreadPoolExecutor(max_workers=3, thread_name_prefix="metrics") as pool:
        futures = {pool.submit(fn, run, trial): name for name, fn in jobs.items()}
        for fut, name in list(futures.items()):
            try:
                result[name] = fut.result()
            except BaseException as exc:  # noqa: BLE001
                result[name] = {"error": f"{type(exc).__name__}: {exc}"[:300]}

    hall = result["hallucination"]
    if "error" not in hall:
        run.emit(
            "metrics",
            "stage_progress",
            f"幻觉抽检：{hall['supported']}/{hall['claims_checked']} 条断言判为有据"
            f"（存疑 {hall['uncertain']}、判错 {hall['incorrect']}）——{SMALL_SAMPLE_NOTE}",
            **{k: v for k, v in hall.items() if k != "sample_claims"},
        )
    cov = result["coverage"]
    if "error" not in cov:
        summary = "；".join(
            f"{TRIAL_TIERS[t]['label']}没讲到 {len(v.get('missed') or [])} 个、"
            f"只提及 {v.get('mentions_only', 0)} 个"
            for t, v in cov["per_tier"].items()
        )
        run.emit(
            "metrics",
            "stage_progress",
            f"覆盖复测（对 ⑤ 冻结金标点名，不出比率）：{summary}。"
            f"{cov['reason']}——{SMALL_SAMPLE_NOTE}",
            gold_total=cov["gold_total"],
            reason=cov["reason"],
            per_tier=cov["per_tier"],
        )
    pers = result["personalization"]
    if "error" not in pers and pers.get("comparable"):
        blind = pers.get("blind_tier_judge") or {}
        blind_txt = (
            f"，盲评判档命中 {blind['hit']}/{blind['total']}" if blind.get("ran") else "，盲评未跑"
        )
        run.emit(
            "metrics",
            "stage_progress",
            f"个性化跟随：同题两档有实质差异的维度 {pers['differing_dimensions']} 个{blind_txt}"
            f"——{SMALL_SAMPLE_NOTE}",
            differing_dimensions=pers["differing_dimensions"],
            examples=pers["examples"],
            blind_tier_judge=blind,
        )

    meter = run.ctx.get("meter")
    cost = meter.snapshot() if meter is not None else {}
    _write_trial_report(run, trial, result, cost)

    # 复测跑完就得有判词，且判词要落盘——不然「跑过体检」和「体检过了」在下游没有区别，
    # 不过线的库照样被学习端当合格库用（D29）。
    verdict = _grade_trial(result)
    _stamp_trial_verdict(run, verdict)
    run.emit(
        "metrics",
        "stage_progress",
        f"体检判词：{verdict['verdict']}——{verdict['reason']}",
        trial_verdict=verdict["verdict"],
        checks=verdict["checks"],
    )
    return {**result, "trial_verdict": verdict, "cost": cost, "sample_note": SMALL_SAMPLE_NOTE}


def _write_trial_report(run: IntakeRun, trial: dict, result: dict, cost: dict) -> None:
    """产物文档。口径声明写在第一段，谁拿走这份数都得先读到它。"""
    lines = [
        f"# 试跑体检：{trial['course_title']}",
        "",
        f"语料库 `{run.corpus}`，金标主题 `{trial['gold_topic']}`（⑤ 站冻结）。",
        "",
        f"**口径：{SMALL_SAMPLE_NOTE}。** 下面每个数字的分母都是个位数，"
        "只用来回答「新库接进来之后这条链还转不转」，"
        "不与对外指标同框、不做任何形式的换算或合并。",
        "",
    ]
    # 资料到位率顶到分子/分母之前（WO-L1）：桥失败的屏凭模型记忆写，
    # 接地那一格量到的是管道故障不是内容质量——读数的人必须先看到这一行。
    er = trial.get("evidence_ready") or {}
    if er.get("total"):
        lines.append(
            f"**资料到位率 {er['ready']}/{er['total']} 屏**"
            "（生成端真拿到教材摘录的屏数；没拿到的屏为「无资料生成」，"
            "其接地数字不可当体检结果读）。"
        )
        for item in er.get("no_material") or []:
            lines.append(
                f"- ⚠ {TRIAL_TIERS[item['tier']]['label']}「{item['scene']}」无资料生成："
                + "；".join(item["reasons"])
            )
        lines.append("")
    lines += [
        "## 分子/分母",
        "",
    ]
    hall = result.get("hallucination") or {}
    if "claims_checked" in hall:
        lines += [
            f"- 幻觉抽检：有据 {hall['supported']}/{hall['claims_checked']} 条"
            f"（存疑 {hall['uncertain']}、判错 {hall['incorrect']}）；"
            f"判官对照资料池 {hall['judge_evidence_from_new_corpus']}/{hall['judge_evidence_pool']} 块来自本库",
        ]
    cov = result.get("coverage") or {}
    if cov.get("reason"):
        # 覆盖这一站不出比率，理由与「没讲到的是哪几个」一起写，免得读的人自己去除。
        lines.append(f"- 覆盖：不出比率。{cov['reason']}")
        for tier, row in (cov.get("per_tier") or {}).items():
            missed = row.get("missed") or []
            lines.append(
                f"  - {TRIAL_TIERS[tier]['label']}：没讲到 {len(missed)} 个"
                f"（{'、'.join(str(m) for m in missed[:5]) or '无'}"
                f"{' 等' if len(missed) > 5 else ''}），"
                f"只提及不展开 {row.get('mentions_only', 0)} 个"
            )
    pers = result.get("personalization") or {}
    if pers.get("comparable"):
        lines.append(f"- 个性化跟随：有实质差异的维度 {pers['differing_dimensions']} 个")
        blind = pers.get("blind_tier_judge") or {}
        if blind.get("ran"):
            lines.append(f"- 盲评判档：命中 {blind['hit']}/{blind['total']}")
        for d in pers.get("examples") or []:
            lines.append(f"  - 差异样例：{d['observation']}")
    if cost:
        lines += [
            "",
            "## 成本",
            "",
            f"- LLM 调用 {cost.get('llm_calls', 0)} 次，input {cost.get('input_tokens', 0):,} / "
            f"output {cost.get('output_tokens', 0):,} token"
            f"（另引擎侧盲评 {cost.get('engine_tokens', 0):,}），"
            f"预算 {cost.get('budget_tokens', 0):,}",
            "- 来源：`apps/classroom/data/usage/<月>.jsonl`（账本无单价字段，不折算金额）",
        ]
    (run.dir / "trial_courses" / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── ⑧ 个性化注册 ───────────────────────────────────────────────────────────
#
# 这一站补的是「投币口通了、饮料机不认识新币」那段空白：新库建成之后，学习端要认出它
# ——域中文名、画像里的知识库选项、点开就能问的示例提示词、课程的域归属——在此之前
# 这四个面全是前端硬编码，加一个库就要改一次代码或手跑一次脚本。
#
# 边界：**引擎只产清单，不写前端的任何源码文件**。反过来（引擎去改 classroom 的 TS）
# 会长出「引擎改前端代码」的反向依赖，以后谁都不敢动它。清单落
# `data/knowledge_base/domain_registry.json`，classroom 运行时读它。

#: 域注册清单文件名：学习端认库的唯一真源。KB 在测试里被指到临时目录，路径不在导入期定死。
REGISTRY_NAME = "domain_registry.json"

#: 出示例提示词只走这两档结构化输出模型。判官档当前是 Qwen 系（`.env` 的
#: LLM_MODEL_JUDGE），这类判断/出题任务不许交给它——ZPD-SCA（arXiv:2508.14377）Table 4
#: 里 Qwen 商用档在三分类上低于随机基线，同一条依据已经把难度标注钉在 strong 档了。
#: 走 strong（`.env`：deepseek-ai/DeepSeek-V3.2）。真配成别的，这一站如实回退，不硬跑。
EXAMPLE_MODEL_WHITELIST = ("deepseek-v3.2", "minimax-m2.5")
#: 复用既有生成智能体的路由（strong 档），不为一次出题在 AGENT_TIERS 里另开一行。
EXAMPLE_AGENT = "ResourceGenerationAgent"
#: 清单里跟着库走、不该被下一次 run 冲掉的字段（示例、岗位要求、产它们的那次 run）。
_CARRIED_FIELDS = (
    "examples",
    "examples_note",
    "job_requirements",
    "hands_on_safety",
    "generated_at",
    "source_run_id",
)

EXAMPLE_SYSTEM = (
    "你在给一个知识库写三条示例提问，学员点开就能直接问，答案必须能在这个库的语料里找到。\n"
    "硬要求：\n"
    "1. 每条都要点名下面清单里的一个章节/主题，并把该主题写进问句；\n"
    "2. 禁止写「介绍一下这个领域」「有哪些应用场景」这类换个库照样成立的模板句；\n"
    "3. 三条各挂不同章节，句子是一句中文疑问句，不超过 40 字。\n"
    '只输出 JSON：{"examples":[{"anchor":"清单里的章节原文","prompt":"提问"}]}'
)


def _registry_path() -> Path:
    return KB / REGISTRY_NAME


def _scope_label(corpus: str, scope: str) -> str:
    """域中文名：取该库 `readiness.json` 的 scope（接入时管理者填的疆域一句话）截成一行。

    **不凭空起名**——读不到就用库名本身上屏，让人一眼看出这个库没填疆域，
    而不是看到一个模型编出来的好听名字。
    """
    line = re.split(r"[。；;\n]", scope.strip())[0].strip()
    return line[:24] or corpus


def _corpus_examples(run: IntakeRun) -> tuple[list[dict[str, str]], str]:
    """三条示例提示词。返回 (示例, 说明)；出不来就返回 ([], 原因)——**不抛异常**。

    生成失败不阻塞建库：库已经在盘上了，示例只是入口处的三句话，为它把一次成功的
    接入判成 failed 是本末倒置。所以这里把失败压成回退，站点状态由 `partial` 表达。
    """
    from backend.rag.retriever import get_corpus_retriever
    from backend.services.llm_gateway import LLMGateway

    retriever = get_corpus_retriever(run.corpus)
    titles: list[str] = []
    seen: set[str] = set()
    for chunk in getattr(retriever, "chunks", None) or []:
        title = str(getattr(chunk, "title", "") or "").strip()
        if title and title not in seen:
            seen.add(title)
            titles.append(title)
    if len(titles) < 3:
        return [], f"库里只有 {len(titles)} 个章节标题，凑不出三条有出处的示例"

    gateway = LLMGateway()
    route = gateway.route_for(EXAMPLE_AGENT)
    if not route.enabled:
        return [], "LLM 路由未启用（检查 SILICONFLOW_API_KEY 与 AGENT_GENERATION_MODE）"
    if not any(m in route.model.lower() for m in EXAMPLE_MODEL_WHITELIST):
        allowed = "、".join(EXAMPLE_MODEL_WHITELIST)
        return [], f"当前 strong 档是 {route.model}，不在出题白名单（{allowed}）内"

    # 均匀采样，别只喂开头几章——开头往往是「环境搭建」，出出来的三条会全挤在一处。
    step = max(1, len(titles) // 24)
    sample = titles[::step][:24]
    reply = gateway.structured_chat(
        EXAMPLE_AGENT,
        EXAMPLE_SYSTEM,
        f"知识库：{run.corpus}\n疆域：{run.record.get('scope') or '（未填）'}\n"
        f"章节清单（{len(sample)} 条，anchor 必须原样取自这里）：\n"
        + "\n".join(f"- {t}" for t in sample),
        temperature=0.3,
        max_tokens=800,
    )
    items = (reply or {}).get("examples")
    if not isinstance(items, list):
        return [], "模型没返回 examples 数组"

    picked: list[dict[str, str]] = []
    used: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        anchor = str(item.get("anchor") or "").strip()
        # anchor 必须原样落在本库章节里：这是「这条问题本库真答得上」的机械判据，
        # 也是挡泛化模板句的唯一硬闸——挡不住的，宁可一条不出。
        if anchor not in seen or anchor in used or len(prompt) < 10:
            continue
        used.add(anchor)
        picked.append({"prompt": prompt[:120], "anchor": anchor})
    if len(picked) < 3:
        return [], f"只有 {len(picked)}/3 条示例对得上本库章节，其余是泛化模板句，已丢弃"
    return picked[:3], ""


def _stage_personalize(run: IntakeRun) -> dict[str, Any]:
    """⑧ 产出域注册清单：学习端凭它认出新库，不用改前端代码。

    每个库一条，判据一律复用既有那份（`personalize_service._corpus_status`——
    eligible / gate / cross_domain 都在里面），不在这里另写第二套口径。
    """
    from backend.integration.personalize_service import _corpus_status
    from backend.rag.retriever import refresh_corpora

    # ⑧ 只依赖 ④⑤，与 ③ 无先后关系。③ 万一还没跑到刷新那步，新库会被缓存成
    # 「不存在」写进清单（chunks=0 / eligible=false）——那正是这一站要治的病。
    refresh_corpora()

    prev = {
        row.get("corpus"): row
        for row in (_read_json(_registry_path()) or {}).get("corpora", [])
        if isinstance(row, dict)
    }
    examples, note = _corpus_examples(run)
    stamp = now_iso()
    label = _scope_label(run.corpus, corpus_scope(run.corpus))

    entries: list[dict[str, Any]] = []
    for row in _corpus_status():
        name = row["corpus"]
        scope = corpus_scope(name)
        entry: dict[str, Any] = {
            "corpus": name,
            "label": _scope_label(name, scope),
            # 中文名可被管理端改写：把改过的那条置 label_overridden=true，
            # 下一次 run 就照抄不覆盖（管理端接改名入口时写这一格）。
            "label_source": "readiness.scope" if scope else "corpus_name",
            "scope": scope,
            "chunks": row["chunk_count"],
            "eligible": row["eligible"],
            "gate": row["gate"],
            "cross_domain": row["cross_domain"],
            "examples": [],
            "examples_note": "",
            # 可选投料槽：管理者给了岗位要求就填（`options.job_requirements`，
            # 与 tier_definitions 同一条路进 run.json），没给就是 null，不编。
            "job_requirements": None,
            # C21：这个域教不教动手操作。**由投料方声明，不从语料里猜**——
            # 试过关键词判据，主库与 ROS2 语料上命中的全是误报（「性价比接地气」
            # 「高温度 Temperature」「上下文腐蚀」），关键词认字面不认语境。
            # 漏标是安全责任，误标是每门 AI 课都顶着「注意触电」。
            "hands_on_safety": False,
            "generated_at": stamp,
            "source_run_id": run.run_id,
        }
        old = prev.get(name)
        if name == run.corpus:
            entry["examples"] = examples
            entry["examples_note"] = note
            entry["job_requirements"] = run.record["options"].get("job_requirements")
            entry["hands_on_safety"] = bool(run.record["options"].get("hands_on_safety"))
        elif old:
            # 别的库这次没重跑：原样留着它们的示例与出处，不被这次 run 冲成空。
            for key in _CARRIED_FIELDS:
                if key in old:
                    entry[key] = old[key]
        if old and old.get("label_overridden"):
            entry["label"] = old.get("label") or entry["label"]
            entry["label_source"] = "override"
            entry["label_overridden"] = True
        entries.append(entry)

    path = _registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "generated_at": stamp,
                "source_run_id": run.run_id,
                "corpus": run.corpus,
                "note": "领域接入流水线 ⑧ 产出；classroom 运行时读它认库。"
                        "手改会被下一次 run 覆盖——改中文名请置 label_overridden=true",
                "corpora": entries,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    rel = _rel(path)
    run.record["products"]["domain_registry"] = rel
    run.emit(
        "personalize",
        "stage_progress",
        f"域注册清单已更新：{len(entries)} 个库，本库中文名「{label}」"
        + (f"、示例提示词 {len(examples)} 条" if examples else f"、示例未出（{note}）"),
        registry_path=rel,
        corpora=len(entries),
        examples=len(examples),
    )
    return {
        "registry_path": rel,
        "corpora": len(entries),
        "label": label,
        "examples": examples,
        "examples_note": note,
        # 示例没出来 = 这一站只做成了一半：库照样建成、清单照样有这个库，
        # 少的是那三句提问。标 partial 而不是 failed。
        "partial": not examples,
    }


HANDLERS: dict[str, Callable[[IntakeRun], dict[str, Any]]] = {
    "receive": _stage_receive,
    "chunk": _stage_chunk,
    "index": _stage_index,
    "vector": _stage_vector,
    "knowledge": _stage_knowledge,
    "gold": _stage_gold,
    "trial": _stage_trial,
    "metrics": _stage_metrics,
    "personalize": _stage_personalize,
}


def _ensure_scripts_path() -> None:
    p = str(ROOT / "scripts")
    if p not in sys.path:
        sys.path.insert(0, p)


# ── DAG 调度 ───────────────────────────────────────────────────────────────


APPEND_SKIP_REASON = (
    "追加模式只走 ①②③（收文件、切块、刷索引）。"
    "④⑤⑦⑧ 描述的是整个库——词表、金标、注册清单都是全库口径，"
    "追加几篇文档不该把它们重算一遍（重算就等于整库重建，那是另一条路）"
)


def _skip_reason(run: IntakeRun, sid: str) -> str:
    """开关关掉的站。返回空串 = 该跑。"""
    if run.record["options"].get("append") and sid not in ("receive", "chunk", "index"):
        return APPEND_SKIP_REASON
    if run.record["options"].get("checkup") and sid not in ("trial", "metrics"):
        return CHECKUP_SKIP_REASON
    if sid == "vector" and not run.record["options"].get("build_vector"):
        return "默认关闭——构建向量索引会调用嵌入接口，按 token 计费。开关 build_vector"
    # ⑥⑦ 同理默认关：一次试跑是 4 次「正文 + 判官全链」，几十万 token。
    # 建库这件事本身不需要它，愿意花钱体检的人自己开。
    if sid in ("trial", "metrics") and not run.record["options"].get("trial_run"):
        return TRIAL_OFF_REASON
    return ""


def execute(run: IntakeRun) -> None:
    """按 STAGES 声明的依赖跑完一次 run。依赖满足就发车，互不依赖的站并行。"""
    run.emit(
        "run",
        "run_start",
        f"领域接入 run 开始：{run.corpus}（{len(run.record['files'])} 个文件）",
        corpus=run.corpus,
        options=run.record["options"],
    )
    done: set[str] = set()
    dead: dict[str, str] = {}  # 站 → 死因（failed / skipped / pending）
    scheduled: set[str] = set()
    futures: dict[Future, str] = {}
    hard_failed = False

    with ThreadPoolExecutor(max_workers=3, thread_name_prefix=f"intake-{run.run_id}") as pool:
        while True:
            for sid, spec in STAGES.items():
                if sid in scheduled or not set(spec.deps) <= (done | set(dead)):
                    continue
                scheduled.add(sid)
                blocked = [d for d in spec.deps if d in dead]
                if spec.pending:
                    run.stage_finish(sid, "pending", PENDING_REASON)
                    dead[sid] = "pending"
                elif blocked:
                    why = f"上游「{STAGES[blocked[0]].label}」{dead[blocked[0]]}"
                    run.stage_finish(sid, "skipped", f"跳过：{why}")
                    dead[sid] = "skipped"
                elif (reason := _skip_reason(run, sid)):
                    # 原因同时进 error：schema 里 stage_skipped 就是带 error 的，
                    # 前端不该从 message 里抠「是哪个开关关着」。
                    run.stage_finish(sid, "skipped", f"跳过：{reason}", error=reason)
                    done.add(sid)  # 主动关掉不算死，下游照跑（此处无下游）
                else:
                    run.stage_start(sid)
                    futures[pool.submit(HANDLERS[sid], run)] = sid
            if not futures:
                break
            finished, _ = wait(list(futures), return_when=FIRST_COMPLETED)
            for fut in finished:
                sid = futures.pop(fut)
                spec = STAGES[sid]
                try:
                    detail = fut.result()
                except StageSkipped as exc:
                    run.stage_finish(sid, "skipped", f"跳过：{exc}")
                    done.add(sid)  # 不算死：库还在，下游照跑
                except BaseException as exc:  # noqa: BLE001 —— 失败原因要原样进事件，不吞
                    # 业务性失败给人话；意料之外的异常带上类型名，不然「'NoneType' object
                    # is not subscriptable」这种话读起来像产品在装傻。
                    reason = (str(exc) if isinstance(exc, StageError) else f"{type(exc).__name__}: {exc}")[:500]
                    run.stage_finish(sid, "failed", f"{spec.label} 失败：{reason}", error=reason)
                    dead[sid] = "failed"
                    if spec.optional:
                        run.record["warnings"].append(f"{spec.label}：{reason}")
                    else:
                        hard_failed = True
                else:
                    # 站自己说「这次只做成了一半」：detail.partial=True。用在「主产物已落盘、
                    # 某个可选成分回退了」的场合（⑧ 的示例提示词生成失败即如此），
                    # 标 failed 会把一次成功的建库说成失败，标 done 又把回退藏了。
                    partial = isinstance(detail, dict) and bool(detail.get("partial"))
                    run.stage_finish(
                        sid,
                        "partial" if partial else "done",
                        f"{spec.label} " + ("部分完成" if partial else "完成"),
                        detail=detail,
                    )
                    done.add(sid)

    run.record["status"] = "failed" if hard_failed else "done"
    run.record["finished_at"] = now_iso()
    run.record["duration_ms"] = round((time.perf_counter() - run._started) * 1000)
    if hard_failed:
        first = next(
            (s["error"] for s in run.record["stages"].values() if s["status"] == "failed"), ""
        )
        run.record["error"] = first
        # 体检 run 一个字节都没往库里写，清理无从谈起——真要走到这里就是删既有库。
        # （当下走不到：体检时 ①-⑤ 全 skipped、⑥⑦ 是 optional，hard_failed 恒假。
        # 留这道闸是因为下一个人给某站去掉 optional 时不会想起这里。）
        # 追加模式一个字节都不许删：库是既有的，正被线上课程引用着。
        # 与体检 run 同理——`_cleanup_partial` 的前提是「这个库是本次 run 建的」，
        # 追加模式下这个前提不成立。
        skip_cleanup = run.record["options"].get("checkup") or run.record["options"].get("append")
        removed = [] if skip_cleanup else _cleanup_partial(run.corpus)
        # C25：失败之后管理者最需要知道的是「现在能不能重来」。
        # 半成品三处（corpora / <库>_intake / 金标）已经清干净，同名可以直接重投——
        # 不说清楚的话人会被 `_reserve_corpus` 的「已经建过了」挡住，
        # 以为库还占着名字，卡在那里不知道下一步。
        retry_hint = (
            f"半成品已清理（{len(removed)} 处），" if removed else "没有留下半成品，"
        ) + f"「{run.corpus}」这个库名可以直接重新投币，不用换名字。"
        run.emit(
            "run",
            "run_failed",
            f"run 失败：{first}\n{retry_hint}",
            error=first,
            cleaned=removed,
            retriable=True,
        )
    else:
        _refresh_corpus_caches()
        run.emit(
            "run",
            "run_done",
            f"run 完成：语料库「{run.corpus}」已可检索"
            + (f"（{len(run.record['warnings'])} 条告警）" if run.record["warnings"] else ""),
            corpus=run.corpus,
            warnings=run.record["warnings"],
            duration_ms=run.record["duration_ms"],
            products=run.record["products"],
        )
    run.flush()


def _refresh_corpus_caches() -> None:
    """新库落盘后，不重启引擎也要能被检索到、能出现在语料库枚举里。"""
    from backend.integration.personalize_service import skill_map_api
    from backend.rag.retriever import refresh_corpora

    refresh_corpora()
    skill_map_api.cache_clear()


#: 一条 run 跑多久还没结束就算「进程中断」。⑥⑦ 两站最慢——实测投币全链
#: 71.77 秒、带试跑体检的补测 427 秒；877 页转写那种极端情况约 40 分钟。
#: 取 4 小时：比最慢的真实场景宽一个数量级，又不会让昨天挂掉的 run 挂到明天。
ORPHAN_RUN_AFTER_SECONDS = 4 * 3600


def sweep_orphan_runs(now: float | None = None) -> list[dict[str, Any]]:
    """把进程中断留下的 running 残 run 判成 failed，并清掉半成品库。

    `_cleanup_partial` 只在 run **硬失败**那条路上跑。进程被杀时（OOM、部署重启、
    机器饱和）它根本没机会执行——run.json 永远停在 `running`，半成品库留在盘上，
    可能过了块数闸进学习者的下拉。**残库假装建成**是这条链最难发现的失败形态：
    管理端看着「正在建」，学习端已经能选到它了。

    引擎启动时调一次。改判写进 run 记录与事件流，不静默处理——
    管理者要能看出「这条 run 是被判死的，不是自己失败的」。
    """
    stamp = now if now is not None else time.time()
    swept: list[dict[str, Any]] = []
    if not RUNS_DIR.exists():
        return swept

    for run_dir in sorted(p for p in RUNS_DIR.iterdir() if p.is_dir()):
        record_path = run_dir / "run.json"
        record = _read_json(record_path)
        if not record or record.get("status") != "running":
            continue
        try:
            age = stamp - record_path.stat().st_mtime
        except OSError:
            continue
        if age < ORPHAN_RUN_AFTER_SECONDS:
            continue  # 还在跑，别动

        corpus = str(record.get("corpus") or "")
        removed = [] if record.get("options", {}).get("checkup") else _cleanup_partial(corpus)
        record["status"] = "failed"
        record["finished_at"] = now_iso()
        record["error"] = (
            f"进程中断：这条 run 停在「进行中」超过 {ORPHAN_RUN_AFTER_SECONDS // 3600} 小时，"
            "判定为服务重启或被系统杀掉。"
            + (f"半成品已清理（{'、'.join(removed)}）。" if removed else "没有留下半成品。")
            + "这个库名现在可以重新投币。"
        )
        record.setdefault("events", []).append(
            {
                "seq": len(record.get("events") or []) + 1,
                "at": now_iso(),
                "stage": "run",
                "kind": "run_failed",
                "message": record["error"],
            }
        )
        record_path.write_text(
            json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        swept.append({"run_id": record.get("run_id"), "corpus": corpus, "removed": removed})

    return swept


def _cleanup_partial(corpus: str) -> list[str]:
    """失败就把这次建的库删干净。

    只删 `_reserve_corpus` 开跑前确认过「不存在」的那三个路径，所以不可能误删既有库。
    run 目录留着——事件与失败原因是要给人看的。
    """
    removed = []
    for path in (CORPORA_DIR / corpus, KB / f"{corpus}_intake", GOLD_DIR / corpus):
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)
            removed.append(_rel(path))
    return removed


# ── 创建 run：校验 + 落盘 + 发车 ────────────────────────────────────────────


def safe_filename(name: str) -> str:
    """剥掉路径分隔符与穿越片段，只留一个安全的文件名。"""
    base = name.replace("\\", "/").split("/")[-1]
    base = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", base).lstrip(".")
    return (base or "file")[:80]


def _require_corpus(corpus: str) -> str:
    """追加模式的库名闸：与 `_reserve_corpus` 相反，库**必须已经存在**。

    只认索引文件在不在。三个目录里 `corpora/<name>/knowledge_index.jsonl`
    才是追加真正要动的那个，另外两个（就绪度、金标）追加不碰。
    """
    from backend.rag.retriever import CORPUS_NAME_RE

    name = corpus.strip().lower()
    if not CORPUS_NAME_RE.fullmatch(name):
        raise StageError(f"库名不合法：只允许小写字母数字与 - _，1-32 位（收到「{corpus}」）")
    index = CORPORA_DIR / name / "knowledge_index.jsonl"
    if not index.exists():
        raise StageError(
            f"「{name}」还没有这个库，没法往里追加（找不到 {_rel(index)}）。"
            "新建库请走建库那条路，不要勾追加。"
        )
    return name


def _reserve_corpus(corpus: str) -> None:
    from backend.rag.retriever import CORPUS_NAME_RE

    name = corpus.strip().lower()
    if name in RESERVED_NAMES:
        raise StageError(f"「{name}」是主语料的保留名，流水线不许占用")
    if not CORPUS_NAME_RE.fullmatch(name):
        raise StageError(f"库名不合法：只允许小写字母数字与 - _，1-32 位（收到「{corpus}」）")
    for path in (CORPORA_DIR / name, KB / f"{name}_intake", GOLD_DIR / name):
        if path.exists():
            # 只拒不指路的报错会让人卡住（A7）：管理者重投同一批语料是常态——
            # 上次投失败了、书更新了、想换个档位设置重来。说清三条出路。
            raise StageError(
                f"「{name}」已经建过了（{_rel(path)}）。这条链只建新库、不覆盖既有库——"
                "覆盖意味着正在用它的课程和学情记录会对不上原来的出处。\n"
                "想继续的话有三条路：\n"
                "  · 换个库名新建（比如加个版本后缀），两份并存、旧课不受影响；\n"
                "  · 确认旧库不再需要，先在知识库中心删掉它，再用同名投一次；\n"
                "  · 只是想补几篇文档进已有的库——勾上「追加到已有库」直接投，"
                "既有块原样保留、旧课出处不断链；改过或要删的文档不在此列，那仍需整库重建。"
            )


def _new_run(
    corpus: str,
    scope: str,
    tier_range: str,
    build_vector: bool,
    extract_concepts: bool,
    trial_run: bool,
    hands_on_safety: bool = False,
    append: bool = False,
) -> IntakeRun:
    """建库那条路的共同开头：库名过闸 + 空 run 对象。投料形态在这之后各走各的。

    追加模式走的是相反的闸：库**必须已经存在**（`_require_corpus`），
    而建库模式要求它**不存在**（`_reserve_corpus`）。两条闸都不许省——
    追加进一个不存在的库会建出一个只有 ①②③ 产物的半截库，
    没有词表没有金标，学习端认不出来。
    """
    name = corpus.strip().lower()
    if append:
        _require_corpus(name)
    else:
        _reserve_corpus(name)
    run = IntakeRun(
        f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}",
        name,
        scope,
        {
            "tier_range": tier_range,
            "build_vector": bool(build_vector),
            "extract_concepts": bool(extract_concepts),
            "trial_run": bool(trial_run),
            "hands_on_safety": bool(hands_on_safety),
            "append": bool(append),
        },
    )
    run.docs_dir.mkdir(parents=True, exist_ok=True)
    return run


def estimate_chunks(sizes: list[int]) -> int:
    """按字节数估这批投料会切出多少块。**恒高估**，所以能当上界用。

    分母是切块器自己的 `TARGET_CHUNK_CHARS`，一个字节按一个字符算——中文一个字符
    占三字节，所以中文语料估出来是实际的两三倍。每个文件至少记一块，海量小文件
    （odoo 那种一页一文件）才不会被算成零。

    对着盘上两份真实语料校过：iotdb 的 Master 子树估 4693 块 / 实际 3202，
    odoo 转换产物估 6004 块 / 实际 3046。高估在这里是对的——闸是拦上限的。
    """
    from backend.rag.ingest import TARGET_CHUNK_CHARS

    return sum(max(1, -(-n // TARGET_CHUNK_CHARS)) for n in sizes)


def _effective_sizes(docs_dir: Path, kept: list[tuple[str, int]]) -> list[tuple[str, int]]:
    """块数预算的输入：文本文件按原字节，PDF 按**实际抽取出的正文字符数**。

    第七坎（2026-08-23 验收实证）：验收包 309.7MB 里绝大部分是 PDF 原体积，
    按 900 字符/块折算出 34 万块直接撞 20 万防崩线——而那些 PDF 抽出的正文合计
    不到 2MB。原体积是磁盘概念，块数是正文概念，两者差两个数量级。
    这里对 PDF 真抽一次（PyMuPDF 快路径，30MB/346 页实测 1.1 秒），
    用抽出的字符数进预算；抽不出字（扫描件）就是 0——它本来也切不出块。
    """
    from backend.rag.pdf_extract import extract_pdf

    out: list[tuple[str, int]] = []
    for rel, size in kept:
        if rel.lower().endswith(".pdf"):
            text = extract_pdf(docs_dir / rel)
            out.append((rel, len(text.text)))
        else:
            out.append((rel, size))
    return out


def check_budget(sizes: list[tuple[str, int]]) -> dict[str, int]:
    """投料预算闸：单文件字节、总字节、预估块数，三条各自报各自的。

    **不许静默截断**。超限时截掉尾巴照样建库，是这条链最坏的失败形态：库建成了、
    少了三分之一的书，报告上一个字都看不出来，等到覆盖率复测量出怪数才回头找。
    所以这里一律抛错，并且把「超的是哪一项、现在多少、上限多少、分几批」写进文案——
    管理者拿到的必须是能自己动手的下一步，不是一句「超过上限」。
    """
    from backend.rag.ingest import TARGET_CHUNK_CHARS

    if not sizes:
        raise StageError("没有可接入的文件")
    total = sum(n for _f, n in sizes)
    est = estimate_chunks([n for _f, n in sizes])

    # 只剩一条闸，且它不是产品限制而是防崩底线——见文件头「上传限额」那段。
    # 单文件大小与总字节数**都不再拒收**：PDF 的体积不是文本的体积（30MB 的书抽出来
    # 0.57MB），服务器磁盘也剩 14G 而知识库才占 38M，按那些拍出来的数拦人是拦错了对象。
    # 只剩这一条闸，且它不是产品限制而是防崩底线——见文件头「上传限额」那段。
    # 单文件大小与总字节数**都不再拒收**：PDF 的体积不是文本的体积（30MB 的书抽出来
    # 只有 0.57MB），服务器磁盘也剩 14G 而整个知识库才占 38M，按那些拍出来的数拦人
    # 是拦错了对象——用户要传的正是「几本书的 pdf」。
    if est > MAX_EST_CHUNKS:
        raise StageError(
            f"这批语料预估约 {est:,} 块，超过一次能安全处理的 {MAX_EST_CHUNKS:,} 块。"
            f"（{len(sizes)} 个文件共 {total / 1e6:.1f}MB，按每块 {TARGET_CHUNK_CHARS} 字符估算；"
            "每个文件至少占一块，所以文件特别碎时块数会比体积看起来多。）"
            "这不是产品限制——建索引要把全部块读进内存做矩阵，再多会把这台机器压垮，"
            "而同机还跑着别的站点。请拆成 "
            f"{-(-est // MAX_EST_CHUNKS)} 批分次接入：一次 run 建一个库，拆批即拆库；"
            "若要落进同一个库，先剔除图片目录与非正文子目录再投。"
        )
    return {"total_bytes": total, "est_chunks": est}


def create_run(
    files: list[tuple[str, bytes]],
    corpus: str,
    scope: str = "",
    tier_range: str = "L1-L3",
    build_vector: bool = False,
    extract_concepts: bool = False,
    trial_run: bool = False,
    # C21：这个域教不教动手操作。由投料方在接入表单声明，不从语料里猜。
    hands_on_safety: bool = False,
    # E31 T0：往已有库追加文档。走反向库名闸，且只跑 ①②③。
    append: bool = False,
) -> IntakeRun:
    """校验上传、落盘、建 run 记录。**不发车**——发车走 `start_run`。"""
    if not files:
        raise StageError("没有上传任何文件")
    for raw_name, _blob in files:
        suffix = Path(safe_filename(raw_name)).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            raise StageError(
                f"不收 {suffix or '无扩展名'} 格式：{safe_filename(raw_name)}（只收 md/markdown/txt/rst）"
            )
    check_budget([(safe_filename(n), len(b)) for n, b in files])
    run = _new_run(
        corpus, scope, tier_range, build_vector, extract_concepts, trial_run, hands_on_safety, append
    )
    used: set[str] = set()
    for raw_name, blob in files:
        name = safe_filename(raw_name)
        stem, suffix = Path(name).stem, Path(name).suffix
        i = 2
        while name in used:
            name = f"{stem}-{i}{suffix}"
            i += 1
        used.add(name)
        (run.docs_dir / name).write_bytes(blob)
        run.record["files"].append({"name": name, "original": raw_name, "bytes": len(blob)})
    run.flush()
    return run


def create_run_from_dir(
    src: Path,
    corpus: str,
    scope: str = "",
    tier_range: str = "L1-L3",
    build_vector: bool = False,
    extract_concepts: bool = False,
    trial_run: bool = False,
    # C21：这个域教不教动手操作。由投料方在接入表单声明，不从语料里猜。
    hands_on_safety: bool = False,
    # E31 T0：往已有库追加文档。走反向库名闸，且只跑 ①②③。
    append: bool = False,
) -> IntakeRun:
    """zip 与 git 两条路的落地口：把一棵已经解好的目录树收进 run。

    与 `create_run` 的分工：那条收的是浏览器多选来的一把文件，压平成一层；
    这条收的是**整个知识库**，按原有目录结构搬进 `<run>/docs/`——`triage` 的
    `path_depth` 与切块时的 section 标题都要这层结构。
    """
    from backend.services.intake_sources import collect_readable

    run = _new_run(
        corpus, scope, tier_range, build_vector, extract_concepts, trial_run, hands_on_safety, append
    )
    # 解压/落盘的字节上界：防 zip bomb 用，不是产品限额。按防崩底线的块数折算
    # （每块正文约 1.4KB），比任何真实语料都宽，只拦「解开来是几百 G」那种。
    kept = collect_readable(src, run.docs_dir, MAX_EST_CHUNKS * 1400)
    if not kept:
        raise StageError("这份投料里没有任何可读文档")
    check_budget(_effective_sizes(run.docs_dir, kept))
    run.record["files"] = [{"name": rel, "original": rel, "bytes": size} for rel, size in kept]
    run.flush()
    return run


#: `_inbox` 里的残包多久算过期。站点化之后投料先落这里、接收站①处理完就删，
#: 但**中途失败或进程被杀时删不掉**——2026-08-22 那次机器饱和就留下一个 375MB 的包。
#: 一次失败的投币留几百 MB，攒几次就把 13G 余量吃掉了。
INBOX_TTL_SECONDS = 24 * 3600


def sweep_inbox(now: float | None = None) -> list[str]:
    """删掉 `_inbox` 里过期的残包，返回删掉的名字。

    只按时间判，不去查「有没有 run 还在用它」——正在处理的包最多存在几分钟，
    离 24 小时差着两个数量级；而查引用要遍历所有 run.json，为一个清理动作
    引入这种耦合不划算。
    """
    inbox = RUNS_DIR / "_inbox"
    if not inbox.exists():
        return []
    cutoff = (now if now is not None else time.time()) - INBOX_TTL_SECONDS
    removed: list[str] = []
    for entry in inbox.iterdir():
        try:
            if entry.stat().st_mtime > cutoff:
                continue
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
            removed.append(entry.name)
        except OSError:
            continue  # 清理失败不该影响主流程，下次再来
    return removed


def create_run_deferred(
    inbox_kind: str,
    inbox_ref: str,
    corpus: str,
    scope: str = "",
    tier_range: str = "L1-L3",
    build_vector: bool = False,
    extract_concepts: bool = False,
    trial_run: bool = False,
    hands_on_safety: bool = False,
    # E31 T0：往已有库追加文档。走反向库名闸，且只跑 ①②③。
    append: bool = False,
) -> IntakeRun:
    """**只建 run，不碰投料内容。** 解压与收集留给接收站①在后台做。

    2026-08-22 第五坎：1670 个文件 + 245MB PDF 的包打进来，解压与 `collect_readable`
    都在 HTTP 请求路径里跑，2vCPU/4G 的机器 CPU 与内存同时打满——web 和 nginx 被
    饿死，**sshd 连协议 banner 都发不出来**。整机失联十几分钟。

    站点化本来就该做到底：跑链在后台，收料也该在后台。这个入口让请求路径的耗时
    与包多大无关（几百毫秒），管理者立刻拿到 run_id 跳去看时间线，解压进度在
    事件流里逐步可见——而不是上传 100% 之后一段纯黑。

    `inbox_kind` 是 `zip` / `dir` / `git`，`inbox_ref` 对应落盘的包路径、
    目录路径或仓库地址。接收站①按它决定怎么把投料变成 `<run>/docs/`。
    """
    run = _new_run(
        corpus, scope, tier_range, build_vector, extract_concepts, trial_run, hands_on_safety, append
    )
    run.record["inbox"] = {"kind": inbox_kind, "ref": inbox_ref}
    # 文件清单这时还不知道——接收站①收完才填。留空数组而不是不写这个键，
    # 免得观看端要判两种形态。
    run.record["files"] = []
    run.flush()
    return run


def corpus_scope(corpus: str) -> str:
    """既有库的疆域一句话——接入时人工填的，落在 `<库>_intake/readiness.json`。"""
    r = _read_json(KB / f"{corpus}_intake" / "readiness.json") or {}
    return str(r.get("scope") or "")


# 主语料 ai 不在 `corpora/` 下：索引是 `knowledge_base/knowledge_index.jsonl`、
# 金标是 `kc_gold_derived/` 根目录（各领域库才各占一个子目录）。这条规则与
# `retriever.DEFAULT_CORPUS_ALIASES` 和课堂 `lib/server/knowledge-center.ts` 的
# `indexPathOf()` 同源，改一处要三处一起改。
#
# 2026-08-16 补这两个函数的直接原因：体检入口把路径写死成 `corpora/<库>/`，
# 于是**主域 ai 从设计上就跑不了体检**——泛化域量出 52.9% 的幻觉抽检支持率时，
# 没有任何同口径的主域数字可比，既说不了「合格」也说不了「不合格」。
# 缺基线不是没人想跑，是入口把它排除了。
def checkup_index_path(corpus: str) -> Path:
    name = corpus.strip().lower()
    return KB / "knowledge_index.jsonl" if name in _MAIN_CORPUS_ALIASES else CORPORA_DIR / name / "knowledge_index.jsonl"


def checkup_gold_dir(corpus: str) -> Path:
    name = corpus.strip().lower()
    return GOLD_DIR if name in _MAIN_CORPUS_ALIASES else GOLD_DIR / name


def create_checkup_run(corpus: str, scope: str = "") -> IntakeRun:
    """对**既有库**单独发起 ⑥⑦ 体检：不收语料、不建库，只跑试跑与指标复测。

    为什么要另开一个口：`create_run` 第一步就是 `_reserve_corpus`，既有库名在那里被拦死
    （拦得对——建库那条路只许建新库）。可 iotdb/odoo 这些库是先前用 CLI 接进来的，
    ⑥⑦ 从来没在它们身上跑过。体检要的东西——`corpora/<库>/knowledge_index.jsonl` 与
    `kc_gold_derived/<库>/` 的冻结金标——盘上已经齐了，缺的只是发车。

    写盘边界比建库那条更窄：**只碰 `intake_runs/<run_id>/`**。①-⑤ 由
    `_skip_reason` 统一按 checkup 跳过（跳过不算死，⑥ 照发车）。
    """
    name = corpus.strip().lower()
    index = checkup_index_path(name)
    if not index.exists():
        raise StageError(f"「{name}」没有检索索引（{_rel(index)}）——体检只对已建成的库发起")
    gold = checkup_gold_dir(name)
    if not gold.is_dir():
        raise StageError(f"「{name}」没有冻结金标（{_rel(gold)}）——⑥ 无题可跑")
    run_id = f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}"
    run = IntakeRun(
        run_id,
        name,
        scope or corpus_scope(name) or name,
        {"checkup": True, "trial_run": True, "build_vector": False, "extract_concepts": False},
    )
    run.dir.mkdir(parents=True, exist_ok=True)
    run.flush()
    return run


#: 同时只许跑一条接入链。
#:
#: 每条 run 自己开 3 线程的池，跨 run 原本没有任何控制——两人同时投币就是
#: 6 线程抢 2 核。**2026-08-22 那次整机饱和（连 sshd 都发不出协议 banner、
#: 失联十几分钟）就是这么来的**：一份验证包与一次真实投币撞在一起。
#:
#: 串行而不是拒绝：管理者只是来早了，拒了他会以为系统坏了。
_CHAIN_GATE = threading.Semaphore(1)

#: 正在排队等着开跑的 run。只用于给等待者报「前面还有几个」——
#: 不说清楚的话排队和卡死在界面上长得一模一样。
_CHAIN_WAITING: list[str] = []
_CHAIN_WAITING_LOCK = threading.Lock()


def _run_with_gate(run: IntakeRun) -> None:
    """拿到闸再跑。等待期间把队列位置告诉管理者。"""
    with _CHAIN_WAITING_LOCK:
        ahead = len(_CHAIN_WAITING)
        _CHAIN_WAITING.append(run.run_id)

    if ahead or not _CHAIN_GATE.acquire(blocking=False):
        run.emit(
            "run",
            "run_queued",
            f"前面还有 {max(ahead, 1)} 个接入在跑，这条先排队。"
            "这台机器只有 2 核，同时跑两条链会把彼此都拖慢，"
            "所以一次只放一条进去——不用重投，轮到就自动开始。",
            ahead=max(ahead, 1),
        )
        _CHAIN_GATE.acquire()

    with _CHAIN_WAITING_LOCK:
        if run.run_id in _CHAIN_WAITING:
            _CHAIN_WAITING.remove(run.run_id)
    try:
        execute(run)
    finally:
        _CHAIN_GATE.release()


def start_run(run: IntakeRun) -> IntakeRun:
    # 走闸不直接 execute：同时只跑一条链（C24），排队时告诉管理者前面还有几个。
    threading.Thread(
        target=_run_with_gate, args=(run,), name=f"intake-{run.run_id}", daemon=True
    ).start()
    return run


# ── 查询：全部读磁盘，进程重启后历史还在 ─────────────────────────────────────


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def list_runs(limit: int = 30) -> list[dict[str, Any]]:
    """run 列表，新的在前。每条只给概要——详情走 `read_run`。"""
    if not RUNS_DIR.exists():
        return []
    rows = []
    for d in sorted(RUNS_DIR.iterdir(), reverse=True):
        record = _read_json(d / "run.json") if d.is_dir() else None
        if not record:
            continue
        stages = record.get("stages", {})
        rows.append(
            {
                "run_id": record.get("run_id", d.name),
                "corpus": record.get("corpus", ""),
                "scope": record.get("scope", ""),
                "status": record.get("status", "unknown"),
                "created_at": record.get("created_at"),
                "finished_at": record.get("finished_at"),
                "duration_ms": record.get("duration_ms"),
                "files": len(record.get("files", [])),
                "stage_counts": {
                    st: sum(1 for s in stages.values() if s.get("status") == st)
                    for st in (
                        "done",
                        "partial",
                        "failed",
                        "skipped",
                        "pending",
                        "running",
                        "waiting",
                    )
                },
                "error": record.get("error", ""),
            }
        )
        if len(rows) >= limit:
            break
    return rows


def read_run(run_id: str) -> dict[str, Any] | None:
    if not _safe_run_id(run_id):
        return None
    return _read_json(RUNS_DIR / run_id / "run.json")


def read_events(run_id: str, since: int = 0, limit: int = 500) -> dict[str, Any] | None:
    """增量拉取：`since` 是上次拿到的 next_seq，G6 轮询用。"""
    if not _safe_run_id(run_id):
        return None
    record = _read_json(RUNS_DIR / run_id / "run.json")
    if record is None:
        return None
    path = RUNS_DIR / run_id / "events.jsonl"
    events: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                event = json.loads(line)
                if event.get("seq", 0) >= since:
                    events.append(event)
    except (OSError, json.JSONDecodeError):
        pass
    truncated = len(events) > limit
    events = events[:limit]
    next_seq = (events[-1]["seq"] + 1) if events else since
    return {
        "run_id": run_id,
        "status": record.get("status", "unknown"),
        "next_seq": next_seq,
        "truncated": truncated,
        "events": events,
    }


def _safe_run_id(run_id: str) -> bool:
    return bool(re.fullmatch(r"[0-9A-Za-z:\-]{1,64}", run_id))
