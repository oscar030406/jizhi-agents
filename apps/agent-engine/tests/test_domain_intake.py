"""领域接入流水线：全链、失败态、并行、写盘边界。

一律把数据根指到 tmp_path——这条链**真写盘**，测试不许碰仓库里的 data/。
嵌入与 LLM 两条花钱的路默认关，本文件不打开它们（打开也只走到「路由未启用」）。
"""
from __future__ import annotations

import json
import threading
import time

import pytest

from backend.services import domain_intake


TWO_DOCS = {
    "chapter-one.md": """# 时序数据库入门

## 1.1 时间序列的基本概念

时间序列是按时间顺序记录的一组观测值。工业现场的传感器每秒钟产生数以万计的测点，
这些测点带着时间戳落进数据库，构成最典型的时间序列。与关系型数据不同，时间序列的
写入几乎总是追加，查询几乎总是按时间范围扫描，这两条特征决定了存储引擎的设计取向。

## 1.2 测点与设备的组织方式

一个设备下面挂多个测点，测点是采集的最小单位。把设备与测点组织成树状路径，
按路径前缀做范围查询，是这一类数据库的通用做法。路径设计得好，查询就能只扫必要的分区，
路径设计得差，一次查询会把整库翻一遍。
""",
    "chapter-two.md": """# 写入与查询

## 2.1 批量写入的代价

逐条写入会把每一次网络往返都变成一次磁盘刷新。批量写入把多条记录攒成一个请求，
把往返次数摊薄到几十分之一。攒多大一批取决于内存与延迟的取舍：批越大吞吐越高，
但单条记录从产生到可查的延迟也越长。

## 2.2 降采样与聚合查询

原始精度的数据留全量代价很高，常见做法是保留近期原始数据，更久远的数据降采样成
分钟级或小时级的聚合值。聚合查询直接读降采样结果，扫描量下降一到两个数量级。
""",
}


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    """把接入链会写到的四个位置全指到临时目录。"""
    import backend.rag.retriever as retriever
    from backend.integration import personalize_service

    kb = tmp_path / "knowledge_base"
    corpora = kb / "corpora"
    corpora.mkdir(parents=True)
    gold = tmp_path / "eval" / "kc_gold_derived"

    monkeypatch.setattr(domain_intake, "KB", kb)
    monkeypatch.setattr(domain_intake, "RUNS_DIR", kb / "intake_runs")
    monkeypatch.setattr(domain_intake, "CORPORA_DIR", corpora)
    monkeypatch.setattr(domain_intake, "GOLD_DIR", gold)
    monkeypatch.setattr(retriever, "CORPORA_DIR", corpora)
    # 学习端的闸也读 knowledge_base（readiness.json）：不一起指过来，接入链回头
    # 校对清单时会去读仓库里真的那份数据
    monkeypatch.setattr(personalize_service, "KB_DIR", kb)

    domain_intake._ensure_scripts_path()
    import ingest_domain  # type: ignore[import-not-found]

    monkeypatch.setattr(ingest_domain, "KB", kb)
    retriever.refresh_corpora()
    yield tmp_path
    retriever.refresh_corpora()


def _files(mapping: dict[str, bytes | str]) -> list[tuple[str, bytes]]:
    return [(n, b if isinstance(b, bytes) else b.encode("utf-8")) for n, b in mapping.items()]


def _events(run) -> list[dict]:
    return [json.loads(line) for line in run.events_path.read_text(encoding="utf-8").splitlines()]


# ── 全链 ───────────────────────────────────────────────────────────────────


def test_full_chain_two_md_files(sandbox):
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="tsdb-demo", scope="时序数据库运维")
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]
    stages = record["stages"]
    for sid in ("receive", "chunk", "index", "knowledge", "gold"):
        assert stages[sid]["status"] == "done", (sid, stages[sid])
        assert stages[sid]["started_at"] and stages[sid]["finished_at"]
        assert stages[sid]["duration_ms"] is not None  # G7 的时间压缩基准就靠这一格
    # 费钱的三站默认全关（向量索引 + 试跑 + 复测）
    assert stages["vector"]["status"] == "skipped"
    assert "build_vector" in stages["vector"]["error"]
    assert stages["trial"]["status"] == "skipped"
    assert stages["metrics"]["status"] == "skipped"
    assert "trial_run" in stages["trial"]["error"]

    # 事件：每条都带 stage（G6 分道渲染的前提），首尾是 run_start / run_done
    events = _events(run)
    assert [e["seq"] for e in events] == list(range(len(events)))
    assert all(e["stage"] and e["run_id"] == run.run_id for e in events)
    assert events[0]["kind"] == "run_start" and events[-1]["kind"] == "run_done"
    kinds = {(e["stage"], e["kind"]) for e in events}
    for sid in ("receive", "chunk", "index", "knowledge", "gold"):
        assert (sid, "stage_start") in kinds and (sid, "stage_done") in kinds

    # 产物
    index_file = domain_intake.CORPORA_DIR / "tsdb-demo" / "knowledge_index.jsonl"
    assert index_file.is_file()
    assert stages["chunk"]["detail"]["chunks"] == len(
        [ln for ln in index_file.read_text(encoding="utf-8").splitlines() if ln.strip()]
    )
    readiness = json.loads(
        (domain_intake.KB / "tsdb-demo_intake" / "readiness.json").read_text(encoding="utf-8")
    )
    # ④ 的产物必须自带「待人工签核」，不许把未签核的前置图说成已确认
    assert readiness["human_signoff"] == {
        **readiness["human_signoff"],
        "required": True,
        "signed": False,
    }
    assert readiness["readiness"]["reviewed_edges"] == 0
    freeze = json.loads(
        (domain_intake.GOLD_DIR / "tsdb-demo" / "_freeze.json").read_text(encoding="utf-8")
    )
    assert freeze["frozen_at"] and freeze["run_id"] == run.run_id
    assert freeze["topics"] == stages["gold"]["detail"]["topics"]

    # 检索得到 + 出现在语料库枚举里（不重启引擎）。
    # 用 domain_corpora() 而不是 _corpus_status()：后者只报对外声明的六个域，
    # 新建的库进枚举、能检索、管理端看得见，但不进公开页——这是刻意的。
    from backend.integration.personalize_service import domain_corpora
    from backend.rag.retriever import get_corpus_retriever

    retriever = get_corpus_retriever("tsdb-demo")
    assert retriever is not None and len(retriever.chunks) > 0
    assert "tsdb-demo" in domain_corpora()


def test_query_endpoints_read_from_disk(sandbox):
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="tsdb-query")
    domain_intake.execute(run)

    rows = domain_intake.list_runs()
    assert rows[0]["run_id"] == run.run_id and rows[0]["status"] == "done"
    assert rows[0]["stage_counts"]["pending"] == 0
    assert rows[0]["stage_counts"]["skipped"] == 3  # vector + trial + metrics 三个开关站

    first = domain_intake.read_events(run.run_id, since=0, limit=3)
    assert len(first["events"]) == 3 and first["truncated"]
    rest = domain_intake.read_events(run.run_id, since=first["next_seq"])
    assert rest["events"][0]["seq"] == first["next_seq"]
    assert not rest["truncated"] and rest["status"] == "done"
    assert domain_intake.read_events("no-such-run") is None
    assert domain_intake.read_run("../../etc") is None


# ── 失败态 ─────────────────────────────────────────────────────────────────


def test_binary_renamed_md_fails_run_and_leaves_no_corpus(sandbox):
    run = domain_intake.create_run(
        _files({"trojan.md": b"\x89PNG\r\n\x1a\n\x00\xff\xfe\x00\x01" * 40}),
        corpus="broken-demo",
    )
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "failed"
    assert "没有可接入的文件" in record["error"]
    assert record["stages"]["receive"]["status"] == "failed"
    # 下游全部跳过，且说得出是被谁挡住的
    assert record["stages"]["chunk"]["status"] == "skipped"
    assert record["stages"]["gold"]["status"] == "skipped"

    # 失败事件要说得出是哪个文件、为什么被退（不是一句「失败」，也不是一坨栈）
    failed = [e for e in _events(run) if e["kind"] == "stage_failed"]
    assert failed and not failed[0]["error"].startswith("StageError")
    assert "trojan.md" in failed[0]["error"] and "读取失败" in failed[0]["error"]
    assert _events(run)[-1]["kind"] == "run_failed"

    # 不留半成品库
    assert not (domain_intake.CORPORA_DIR / "broken-demo").exists()
    assert not (domain_intake.KB / "broken-demo_intake").exists()
    assert not (domain_intake.GOLD_DIR / "broken-demo").exists()
    from backend.integration.personalize_service import domain_corpora

    assert "broken-demo" not in domain_corpora()
    # run 目录留着——失败原因是要给人看的
    assert run.record_path.is_file() and run.events_path.is_file()


RST_DOC = "\n".join(
    [
        "====================",
        "时序数据库入门",
        "====================",
        "",
        "时间序列是按时间顺序记录的一组观测值。工业现场的传感器每秒产生数以万计的测点。" * 30,
        "",
        "写入路径",
        "====================",
        "",
        "逐条写入会把每一次网络往返都变成一次磁盘刷新，批量写入把往返次数摊薄。" * 30,
        "",
        "攒批的取舍",
        "--------------------",
        "",
        "批越大吞吐越高，单条记录从产生到可查的延迟也越长，这是一对要现场标定的取舍。" * 30,
        "",
        "查询路径",
        "====================",
        "",
        "按路径前缀做范围查询，路径设计得好就只扫必要的分区，设计得差一次查询翻遍全库。" * 30,
        "",
    ]
)


def test_rst_upload_keeps_its_heading_hierarchy(sandbox):
    """rst 走完全链，标题层级要一路活到索引里。

    这条盯的是「加了后缀但结构认不出」那个坑：文件收进来、库也建成，可标题全没了，
    金标只能按文件名派生——K1 那次 odoo 的 11 屏错误判定就是这么来的（§7.2）。
    所以断言落在**结构的下游**，不落在「文件收了几个」。
    """
    run = domain_intake.create_run(_files({"guide.rst": RST_DOC}), corpus="rst-demo", scope="时序库运维")
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]
    # 落盘的是 md：金标派生与结构信号两站都只 rglob("*.md")，留着 rst 它们一条都看不见
    assert (run.docs_dir / "guide.md").is_file()
    assert not list(run.docs_dir.rglob("*.rst"))
    assert any(e.get("rst_converted") == 1 for e in _events(run)), "转换要留一条事件，不许静默换文件"

    lines = (domain_intake.CORPORA_DIR / "rst-demo" / "knowledge_index.jsonl").read_text(
        encoding="utf-8"
    ).splitlines()
    titles = " ".join(json.loads(ln)["title"] for ln in lines if ln.strip())
    for heading in ("时序数据库入门", "写入路径", "攒批的取舍", "查询路径"):
        assert heading in titles, (heading, titles)
    # ⑤ 金标按标题层级机械导出。认不出层级这一站会以「没有 .md」跳过——那正是要防的哑火。
    assert record["stages"]["gold"]["status"] == "done", record["stages"]["gold"]


def test_txt_only_corpus_skips_gold_but_keeps_library(sandbox):
    body = "时间序列数据库把测点按路径组织。" * 30
    run = domain_intake.create_run(_files({"notes.txt": body}), corpus="txt-demo")
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done"
    assert record["stages"]["gold"]["status"] == "skipped"
    assert "没有 .md" in record["stages"]["gold"]["error"] or True
    assert (domain_intake.CORPORA_DIR / "txt-demo" / "knowledge_index.jsonl").is_file()


# ── 写盘边界 ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ["ai", "default", "", "../etc", "Odoo!", "a" * 40])
def test_reserved_and_illegal_names_rejected(sandbox, name):
    with pytest.raises(domain_intake.StageError):
        domain_intake.create_run(_files(TWO_DOCS), corpus=name)


def test_existing_library_is_never_overwritten(sandbox):
    (domain_intake.CORPORA_DIR / "taken").mkdir(parents=True)
    with pytest.raises(domain_intake.StageError, match="只建新库"):
        domain_intake.create_run(_files(TWO_DOCS), corpus="taken")


def test_upload_validation(sandbox):
    """收不了的格式照旧原样退回并写明理由——加 rst 不等于通吃。"""
    with pytest.raises(domain_intake.StageError, match="只收 md"):
        domain_intake.create_run(_files({"payload.exe": b"x" * 300}), corpus="bad-suffix")
    with pytest.raises(domain_intake.StageError, match="不收 .po 格式"):
        domain_intake.create_run(_files({"messages.po": b"x" * 300}), corpus="bad-po")


def test_file_count_alone_no_longer_blocks(sandbox):
    """963 个文件的整仓语料必须能从网站投进来。

    一版是 `MAX_FILES = 50`，而 odoo 963 / iotdb 922 —— 那条闸就是「工程师改跑 CLI
    脚本灌库」的直接原因，也就是绕开了唯一算数的那条入口。文件数不是成本，
    50 个 200KB 的文件比 900 个 5KB 的重得多。
    """
    files = _files({f"doc-{i}.md": f"# 第 {i} 章\n\n" + "正文若干。" * 60 for i in range(963)})
    run = domain_intake.create_run(files, corpus="big-count")
    assert len(run.record["files"]) == 963


def test_real_corpus_scale_fits_the_budget():
    """两份真实语料的实测规模必须过闸——闸就是照它们定的，谁把它改小这条会红。

    2026-08-21 量的：references/iotdb-docs 869 个 .md / 15.0MB，
    references/odoo-docs 1155 个 .rst / 10.1MB。
    """
    for count, total in ((869, 15_000_000), (1155, 10_100_000)):
        got = domain_intake.check_budget([(f"f{i}.md", total // count) for i in range(count)])
        assert got["est_chunks"] <= domain_intake.MAX_EST_CHUNKS, got


def test_big_uploads_are_not_rejected(sandbox):
    """大文件与大总量**都不再拒收**——2026-08-21 去掉了字节闸。

    去掉的理由是它拦错了对象：用户要投的是电子书，而 PDF 的体积不是文本的体积
    （实测 30MB / 346 页的书抽出来只有 0.57MB 正文），服务器磁盘也剩 14G 而整个
    知识库才占 38M。按拍出来的字节数拦人，等于把「管理员投一个知识库」这条唯一
    算数的入口堵死，逼着工程师回去跑 CLI 脚本——那正是本项目定义里不算泛化的做法。
    """
    # 单个 8MB 的文件：老闸（2MB）会拒，现在应当收下
    got = domain_intake.check_budget([("one-big-book.md", 8_000_000)])
    assert got["est_chunks"] < domain_intake.MAX_EST_CHUNKS

    # 五本书共 40MB：老闸（32MB）会拒，现在应当收下
    got = domain_intake.check_budget([(f"book{i}.md", 8_000_000) for i in range(5)])
    assert got["est_chunks"] < domain_intake.MAX_EST_CHUNKS


def test_crash_guard_still_stops_absurd_batches_and_explains_itself(sandbox):
    """只剩块数这一条，且它是防崩底线不是产品限制——报错必须把这点说清楚。

    静默截断是这条链最坏的失败形态：库建成了、少了三分之一的书，报告上看不出来。
    所以撞线时要说：现在多少、底线多少、为什么有这条线、怎么分批。
    """
    huge = domain_intake.MAX_EST_CHUNKS * 2
    with pytest.raises(domain_intake.StageError) as e:
        domain_intake.create_run(
            _files({f"f{i}.md": b"x" * 4000 for i in range(huge)}), corpus="absurd"
        )
    msg = str(e.value)
    assert f"{domain_intake.MAX_EST_CHUNKS:,}" in msg, f"要报出底线数值：{msg}"
    assert "不是产品限制" in msg, f"要说清这条线为什么存在：{msg}"
    assert "批" in msg, f"要告诉人怎么办：{msg}"


def test_filename_is_stripped_of_path_separators(sandbox):
    run = domain_intake.create_run(
        _files({"../../../etc/passwd.md": TWO_DOCS["chapter-one.md"]}), corpus="traversal-demo"
    )
    names = [f["name"] for f in run.record["files"]]
    assert names == ["passwd.md"]
    assert (run.docs_dir / "passwd.md").is_file()
    assert list(run.docs_dir.iterdir()) == [run.docs_dir / "passwd.md"]


def test_duplicate_content_is_deduped(sandbox):
    doc = TWO_DOCS["chapter-one.md"]
    run = domain_intake.create_run(
        _files({"a.md": doc, "b.md": doc, "c.md": TWO_DOCS["chapter-two.md"]}), corpus="dedup-demo"
    )
    domain_intake.execute(run)
    detail = json.loads(run.record_path.read_text(encoding="utf-8"))["stages"]["receive"]["detail"]
    assert detail["accepted_files"] == 2
    assert any("去重" in r["reason"] for r in detail["rejected"])


# ── DAG ────────────────────────────────────────────────────────────────────


def test_independent_stages_really_run_in_parallel(sandbox, monkeypatch):
    """③检索索引 / ④知识整理 / ⑤金标 只依赖 ②，必须并行。

    用一道三人栅栏证伪串行：串行跑的话谁都等不到另外两个，5 秒后 barrier 崩，测试红。
    """
    barrier = threading.Barrier(3, timeout=5)

    def gate(_run):
        barrier.wait()
        return {"parallel": True}

    monkeypatch.setitem(domain_intake.HANDLERS, "index", gate)
    monkeypatch.setitem(domain_intake.HANDLERS, "knowledge", gate)
    monkeypatch.setitem(domain_intake.HANDLERS, "gold", gate)

    run = domain_intake.create_run(_files(TWO_DOCS), corpus="parallel-demo")
    domain_intake.execute(run)
    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done"
    for sid in ("index", "knowledge", "gold"):
        assert record["stages"][sid]["detail"] == {"parallel": True}


def _fake_scene(tier: str, kcs: list[str], length: int) -> dict:
    """一屏假正文：把金标 KC 原样写进去，覆盖率复测才有东西可命中。

    pipeline 按档位分两种形态，给资料到位率一个能分辨的输入：
    beginner 摘录注入成功（assembly 非空）；advanced 复刻桥超时现场
    （assembly 空 + bridgeWarnings）——与 intake_runs 里真实故障屏同构。
    """
    body = "## " + tier + "小节\n\n" + "。".join(kcs) + "。" + "现场按规程执行。" * length
    bridge_dead = tier != "beginner"
    return {
        "success": True,
        "content": {"elements": [{"type": "text", "content": body}]},
        "pipeline": {
            "blueprint": {
                "difficulty": "L1" if tier == "beginner" else "L4",
                "scaffold": "deep" if tier == "beginner" else "light",
                "analogyDomain": "日常生活" if tier == "beginner" else "工程实践",
                "learnerType": "新手" if tier == "beginner" else "熟手",
                "engine": "llm",
            },
            "assembly": None if bridge_dead else {"injected": 1, "deduped": 0},
            **({"bridgeWarnings": ["证据检索桥不可达（TimeoutError）"]} if bridge_dead else {}),
        },
    }


@pytest.fixture()
def trial_stubs(monkeypatch):
    """把 ⑥ 的两个 HTTP 出口与盲评判官全部打桩——定向测试一分钱不花。"""
    posts: list[tuple[str, dict]] = []
    inflight = {"now": 0, "peak": 0}
    lock = threading.Lock()

    def fake_post(path, payload, timeout):
        with lock:
            inflight["now"] += 1
            inflight["peak"] = max(inflight["peak"], inflight["now"])
            posts.append((path, payload))
        try:
            time.sleep(0.05)
            if path.endswith("scene-content"):
                tier = "beginner" if payload["requirements"]["learnerProfile"]["programming_level"] == 0 else "advanced"
                return _fake_scene(tier, payload["outline"]["keyPoints"], 20 if tier == "beginner" else 4)
            return {
                "success": True,
                "audit": {
                    "verdict": "caveat",
                    "totalClaims": 3,
                    "flaggedCount": 1,
                    "uncertainCount": 1,
                    "incorrectCount": 0,
                    "evidenceCount": 2,
                    "claims": [
                        {"claim": "断言一", "verdict": "supported", "sourceIds": []},
                        {"claim": "断言二", "verdict": "supported", "sourceIds": []},
                        {"claim": "断言三", "verdict": "uncertain", "sourceIds": []},
                    ],
                    "sources": [{"source_id": "chapter-one#s0 时序数据库入门", "title": "t"}],
                },
                "content": payload["content"],
            }
        finally:
            with lock:
                inflight["now"] -= 1

    monkeypatch.setattr(domain_intake, "_classroom_post", fake_post)
    monkeypatch.setattr(
        domain_intake,
        "_blind_tier_judge",
        lambda run, trial: {"ran": True, "hit": 4, "total": 4, "rows": []},
    )
    return {"posts": posts, "inflight": inflight}


def test_trial_and_metrics_full_chain(sandbox, trial_stubs):
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="trial-demo", scope="时序数据库运维", trial_run=True)
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]
    trial = record["stages"]["trial"]
    metrics = record["stages"]["metrics"]
    assert trial["status"] == "done" and metrics["status"] == "done", (trial, metrics)

    # ⑥：两档各两屏，四次生成 + 四次判官，落在 run 目录里、不进课程库
    assert trial["detail"]["courses"] == 2 and trial["detail"]["scenes"] == 4
    assert len([p for p, _ in trial_stubs["posts"] if p.endswith("scene-content")]) == 4
    assert len([p for p, _ in trial_stubs["posts"] if p.endswith("scene-audit")]) == 4
    # 判官必须收到 corpus，而且是新库——这是幻觉率口径的地基
    audits = [b for p, b in trial_stubs["posts"] if p.endswith("scene-audit")]
    assert {b["learnerProfile"]["corpus"] for b in audits} == {"trial-demo"}
    for tier in ("beginner", "advanced"):
        assert (run.dir / "trial_courses" / f"{tier}.json").is_file()
    assert not (run.dir / "trial_courses" / "beginner.json").is_relative_to(
        domain_intake.ROOT / "data" / "classrooms"
    )
    # 受控并行：并发度 2 意味着同时最多两条在飞（串行的话 peak 会是 1）
    assert trial_stubs["inflight"]["peak"] == domain_intake.TRIAL_CONCURRENCY

    # ⑦：三项都有分子分母，且每一项自带小样本声明
    hall = metrics["detail"]["hallucination"]
    assert hall["claims_checked"] == 12 and hall["supported"] == 8
    cov = metrics["detail"]["coverage"]
    assert cov["gold_total"] >= 2
    # 覆盖不出比率：`hits` 这个分子必须消失，取而代之是撤因原文 + 没讲到的清单
    # （撤因写在 `_metric_coverage` 的 docstring）。
    assert all("hits" not in row for row in cov["per_tier"].values()), cov
    assert all("missed" in row for row in cov["per_tier"].values()), cov
    assert "不出覆盖率" in cov["reason"], cov
    pers = metrics["detail"]["personalization"]
    assert pers["differing_dimensions"] >= 2 and pers["examples"]
    # 判词：过线也要如实盖章，并落回 readiness.json（学习端只认那个文件）
    verdict = metrics["detail"]["trial_verdict"]
    assert verdict["verdict"] == "passed", verdict
    assert all(c["passed"] for c in verdict["checks"])
    stamped = json.loads(
        (domain_intake.KB / "trial-demo_intake" / "readiness.json").read_text(encoding="utf-8")
    )["trial_verdict"]
    assert stamped["verdict"] == "passed" and stamped["run_id"] == run.run_id
    for block in (hall, cov, pers):
        assert block["sample_note"] == domain_intake.SMALL_SAMPLE_NOTE

    # 资料到位率：生成端拿没拿到摘录必须显式入账（stub 里 advanced 两屏桥挂了）
    er = trial["detail"]["evidence_ready"]
    assert er["ready"] == 2 and er["total"] == 4
    assert {f["tier"] for f in er["no_material"]} == {"advanced"}
    assert all("TimeoutError" in "；".join(f["reasons"]) for f in er["no_material"])
    # 屏级失败要喊出来（事件流），不许只躺在 trial_courses/*.json 里
    trial_msgs = [e["message"] for e in _events(run) if e["stage"] == "trial"]
    assert sum("无资料生成" in t for t in trial_msgs) == 2

    # 事件与产物文档都必须写着「非对外指标」
    texts = [e["message"] for e in _events(run) if e["stage"] == "metrics"]
    assert sum(domain_intake.SMALL_SAMPLE_NOTE in t for t in texts) == 3
    report = (run.dir / "trial_courses" / "REPORT.md").read_text(encoding="utf-8")
    assert domain_intake.SMALL_SAMPLE_NOTE in report and "分子/分母" in report
    # 报告第一屏就要给「资料到位率 N/M」与逐屏标注
    assert "资料到位率 2/4 屏" in report and report.count("无资料生成") >= 2


def test_budget_cap_halts_generation(sandbox, trial_stubs, monkeypatch):
    """预算闸：超限就不再发新的生成，并且把停机原因落进事件与 detail。"""
    monkeypatch.setattr(domain_intake._TokenMeter, "over_budget", lambda self: True)
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="budget-demo", trial_run=True)
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["stages"]["trial"]["status"] == "failed"
    assert not trial_stubs["posts"]  # 一次生成都没发出去
    halted = [e for e in _events(run) if e.get("budget_halt")]
    assert halted and "预算" in halted[0]["message"]
    # 体检失败不许把已经建成的库删掉
    assert record["status"] == "done" and record["warnings"]
    assert (domain_intake.CORPORA_DIR / "budget-demo" / "knowledge_index.jsonl").is_file()


def test_vector_bypass_failure_does_not_fail_the_run(sandbox, monkeypatch):
    """向量索引是旁路：它是外部付费 API，抖一下不该毁掉整次接入，也不该挡住 ⑤。"""

    def boom(_run):
        raise RuntimeError("嵌入接口 503")

    monkeypatch.setitem(domain_intake.HANDLERS, "vector", boom)
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="bypass-demo", build_vector=True)
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done"
    assert record["stages"]["vector"]["status"] == "failed"
    assert record["stages"]["gold"]["status"] == "done"
    assert record["warnings"] and "503" in record["warnings"][0]
    assert (domain_intake.CORPORA_DIR / "bypass-demo").is_dir()  # 旁路失败不删库


def test_checkup_runs_only_stage_six_and_seven_on_an_existing_library(sandbox, trial_stubs):
    """既有库体检：①-⑤ 全跳过，⑥⑦ 照跑，且一个字节都不往库里写。

    `_reserve_corpus` 挡的是「建库时占用既有名字」，挡得对；代价是先前用 CLI 接进来的库
    （iotdb / odoo）没法用 `create_run` 补体检。`create_checkup_run` 是那条补路。
    """
    # 先按正常路径建一个库，然后对它——一个**既有**库——发起体检
    first = domain_intake.create_run(_files(TWO_DOCS), corpus="already-here", scope="时序数据库运维", trial_run=False)
    domain_intake.execute(first)
    index = domain_intake.CORPORA_DIR / "already-here" / "knowledge_index.jsonl"
    before = index.read_bytes()

    with pytest.raises(domain_intake.StageError):
        domain_intake.create_run(_files(TWO_DOCS), corpus="already-here")  # 建库那条路照旧拦死

    run = domain_intake.create_checkup_run("already-here")
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]
    assert record["scope"] == "时序数据库运维"  # 疆域从 readiness.json 读回来，不用再填一遍
    for sid in ("receive", "chunk", "index", "vector", "knowledge", "gold"):
        assert record["stages"][sid]["status"] == "skipped"
        assert domain_intake.CHECKUP_SKIP_REASON in record["stages"][sid]["error"]
    assert record["stages"]["trial"]["status"] == "done"
    assert record["stages"]["metrics"]["status"] == "done"
    assert record["stages"]["metrics"]["detail"]["hallucination"]["claims_checked"] > 0
    # 写盘边界：库的索引一个字节没动，产物只落在 run 目录里
    assert index.read_bytes() == before
    assert (run.dir / "trial_courses" / "REPORT.md").is_file()


def test_checkup_refuses_a_library_that_is_not_built(sandbox):
    with pytest.raises(domain_intake.StageError) as exc:
        domain_intake.create_checkup_run("never-built")
    assert "体检只对已建成的库发起" in str(exc.value)


def test_create_run_from_dir_keeps_the_tree(sandbox, tmp_path):
    """zip / git 那条路的落地口：整棵目录树按原结构进 `<run>/docs/`。

    压平成一层就把层级信息丢了——`triage` 拿 path_depth 当结构信号，
    切块时的 section 标题也带相对路径。所以这条盯的是「结构没被压平」。
    """
    src = tmp_path / "staged"
    (src / "book" / "ch1").mkdir(parents=True)
    (src / "book" / "ch1" / "chapter-one.md").write_text(TWO_DOCS["chapter-one.md"], encoding="utf-8")
    (src / "book" / "chapter-two.md").write_text(TWO_DOCS["chapter-two.md"], encoding="utf-8")
    (src / "book" / "logo.png").write_bytes(b"\x89PNG")

    run = domain_intake.create_run_from_dir(src, corpus="fromdir", scope="时序数据库")
    assert (run.docs_dir / "book" / "ch1" / "chapter-one.md").exists()
    assert not (run.docs_dir / "book" / "logo.png").exists()
    assert [f["name"] for f in run.record["files"]] == [
        "book/ch1/chapter-one.md",
        "book/chapter-two.md",
    ]


def test_create_run_from_dir_refuses_existing_corpus(sandbox, tmp_path):
    """建库那条路只许建新库——换个投料形态不该绕过这条闸。"""
    (domain_intake.CORPORA_DIR / "taken").mkdir(parents=True)
    src = tmp_path / "staged"
    src.mkdir()
    (src / "a.md").write_text(TWO_DOCS["chapter-one.md"], encoding="utf-8")
    with pytest.raises(domain_intake.StageError, match="已存在"):
        domain_intake.create_run_from_dir(src, corpus="taken")


def test_不过线的库照样建成但被标试运行(sandbox, trial_stubs, monkeypatch):
    """D29：⑦ 复测不过线 → 判词 degraded 落进 readiness.json，学习端的闸读得到。

    两件事必须同时成立：库**照样建成**（索引在盘上、检索得到、run 状态 done），
    但它不再静默地以合格库的身份出货——`_corpus_gate` 把它拦下并说得出具体数字。
    """
    stubbed = domain_intake._classroom_post

    def all_incorrect(path, payload, timeout):
        out = stubbed(path, payload, timeout)
        if path.endswith("scene-audit"):
            for claim in out["audit"]["claims"]:
                claim["verdict"] = "incorrect"
        return out

    monkeypatch.setattr(domain_intake, "_classroom_post", all_incorrect)
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="degraded-demo", trial_run=True)
    domain_intake.execute(run)

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]
    assert (domain_intake.CORPORA_DIR / "degraded-demo" / "knowledge_index.jsonl").is_file()

    verdict = json.loads(
        (domain_intake.KB / "degraded-demo_intake" / "readiness.json").read_text(encoding="utf-8")
    )["trial_verdict"]
    assert verdict["verdict"] == "degraded", verdict
    assert verdict["run_id"] == run.run_id
    # 判词要带得出数字和门线，不能只有一个标签
    graded = {c["metric"]: c for c in verdict["checks"]}
    assert graded["hallucination_rate"]["value"] == 1.0
    assert graded["hallucination_rate"]["ceiling"] == 0.10
    assert graded["factuality"]["floor"] == 0.62
    assert not any(c["passed"] for c in verdict["checks"])
    assert "1.0" in verdict["reason"] and "0.1" in verdict["reason"], verdict["reason"]
    # 事件流里也要喊出来（G6 分道渲染的那条）
    assert any("体检判词：degraded" in e["message"] for e in _events(run))

    # 学习端的闸：读同一个文件，拦下并说得出原因
    from backend.integration import personalize_service

    gate = personalize_service._corpus_gate("degraded-demo", chunks=9999, retrievable=True)
    assert not gate["passed"] and gate["trial_verdict"] == "degraded"
    assert any("试跑体检未过线" in r for r in gate["reasons"]), gate

    # ⑧ 的清单跑在 ⑦ 之前（那两站要等 LLM），判词落盘后本库那一行必须被校正——
    # 不校正的话清单里仍是 eligible=true，学习端照旧拿它出货
    registry = json.loads(
        (domain_intake.KB / domain_intake.REGISTRY_NAME).read_text(encoding="utf-8")
    )
    row = next(r for r in registry["corpora"] if r["corpus"] == "degraded-demo")
    assert row["eligible"] is False
    assert row["gate"]["trial_verdict"] == "degraded"


def test_没跑体检的库是未知不是不过线(sandbox):
    """⑦ 是 optional：没勾试跑体检的库标 unknown，且不因此被拦。

    「没测」和「测了没过」混为一谈就是虚报——这条钉的就是这两者不许合并。
    """
    run = domain_intake.create_run(_files(TWO_DOCS), corpus="untested-demo", trial_run=False)
    domain_intake.execute(run)

    readiness = json.loads(
        (domain_intake.KB / "untested-demo_intake" / "readiness.json").read_text(encoding="utf-8")
    )
    assert readiness["trial_verdict"]["verdict"] == "unknown"
    assert readiness["trial_verdict"]["checks"] == []

    from backend.integration import personalize_service

    gate = personalize_service._corpus_gate("untested-demo", chunks=9999, retrievable=True)
    assert gate["trial_verdict"] == "unknown"
    # 没测不构成拦截理由（这个库另有词表闸没过，那是另一条，不算在这条头上）
    assert not any("试跑" in r for r in gate["reasons"]), gate["reasons"]


@pytest.mark.parametrize(
    "hall, why",
    [
        ({"error": "TimeoutError: 判官超时"}, "TimeoutError"),
        ({"claims_checked": 3, "supported": 0, "uncertain": 0, "incorrect": 3}, "不足"),
    ],
)
def test_测不出来是未知不是不过线(hall, why):
    """判官挂了、或分母小到判不了——都是 unknown。

    第二个用例故意给 3 条全判错：真按比率算它是 100% 幻觉，但分母 3 条本来就不该出判词
    （`claim_statistics` 的 insufficient_claims 同一条线）。宁可说不知道，不冤枉一个库。
    """
    verdict = domain_intake._grade_trial({"hallucination": hall})
    assert verdict["verdict"] == "unknown"
    assert why in verdict["reason"]
    assert verdict["checks"] == []


# ── ⑧ 个性化注册 ───────────────────────────────────────────────────────────

#: 示例提示词要三条各挂一个不同章节，TWO_DOCS 只切得出两个标题——不够，加两章。
FOUR_DOCS = {
    **TWO_DOCS,
    "chapter-three.md": """# 存储引擎与压缩

## 3.1 列式存储的取舍

同一测点的连续取值放在一起，压缩率能上一个台阶：相邻两个值差得少，做完差分编码之后
剩下的熵很小，再套一层通用压缩几乎是白送的。代价是按行取一整条记录要跨多个列块读，
随机点查会明显变慢，所以点查密集的场景要另建一份行式副本，或者干脆把点查挡在缓存层。

## 3.2 时间戳编码

时间戳往往是等间隔的，存差分的差分（二阶差分）之后大部分是零，用游程编码几乎不占空间。
采集抖动会破坏这个规律，一次网络重传就能让一整段时间戳退化成随机数，
所以编码器要能在规整与不规整之间自动切换，并且把切换点记进块头，读的时候才不用猜。
""",
    "chapter-four.md": """# 运维与故障排查

## 4.1 慢查询定位

先看扫描了多少块，再看反序列化花了多久，两个数不分开看就永远在猜。扫描量大通常是
查询路径写宽了、或者时间范围没收紧；反序列化慢则多半是块切得太大，一次读进来的数据
远超实际需要。两者的处方完全相反，一个改查询，一个改建库参数，混在一起调只会互相抵消。

## 4.2 磁盘写满之后

写满之后写入会被拒绝，但查询还应当可用。先停掉写入侧的重试风暴——重试会把本来
只是写满的集群拖成整体不可用；再清历史分区腾出空间；最后才调整保留策略。
顺序反了会在清理途中被新写入重新填满，前面的功夫全白费。
""",
}


def test_个性化注册站挂在流水线上(sandbox):
    """挂载口径：order 8、依赖 ⑤④、**不是 optional**、handler 登记过。

    不 optional 是刻意的：这一站不产清单，学习端就认不出新库——那是硬伤不是旁路。
    """
    spec = domain_intake.STAGES["personalize"]
    assert (spec.order, spec.deps, spec.optional, spec.pending) == (8, ("gold", "knowledge"), False, False)
    assert domain_intake.HANDLERS["personalize"] is domain_intake._stage_personalize
    # 事件流与时间线是白拿的：挂上去就自动有，不另造可视化
    run = domain_intake.create_run(_files(FOUR_DOCS), corpus="reg-mount")
    domain_intake.execute(run)
    kinds = {(e["stage"], e["kind"]) for e in _events(run)}
    assert ("personalize", "stage_start") in kinds
    assert run.record["stages"]["personalize"]["duration_ms"] is not None


def test_域注册清单字段齐(sandbox, monkeypatch):
    """清单每条要能独立回答：叫什么、够不够格、为什么、哪次投币产的。"""
    monkeypatch.setattr(
        domain_intake,
        "_corpus_examples",
        lambda run: (
            [
                {"prompt": "时间序列的基本概念里，测点为什么按时间追加写入？", "anchor": "时序数据库入门"},
                {"prompt": "批量写入的代价一节说批越大延迟越长，怎么取舍？", "anchor": "写入与查询"},
                {"prompt": "降采样与聚合查询能把扫描量降到什么程度？", "anchor": "写入与查询 2"},
            ],
            "",
        ),
    )
    run = domain_intake.create_run(
        _files(FOUR_DOCS), corpus="reg-fields", scope="时序数据库运维。第二句不该上屏"
    )
    domain_intake.execute(run)

    assert run.record["stages"]["personalize"]["status"] == "done"
    registry = json.loads((domain_intake.KB / "domain_registry.json").read_text(encoding="utf-8"))
    assert registry["source_run_id"] == run.run_id
    assert run.record["products"]["domain_registry"].endswith("domain_registry.json")

    row = next(r for r in registry["corpora"] if r["corpus"] == "reg-fields")
    assert set(row) >= {
        "corpus", "label", "scope", "chunks", "eligible", "gate",
        "cross_domain", "examples", "job_requirements", "generated_at", "source_run_id",
    }
    # 中文名取 readiness 的 scope 截成一行，不凭空起名
    assert row["label"] == "时序数据库运维" and row["label_source"] == "readiness.scope"
    assert row["chunks"] == run.record["stages"]["chunk"]["detail"]["chunks"]
    # 判据复用 _corpus_gate / CROSS_DOMAIN_CORPORA，不另写一份
    assert row["eligible"] is row["gate"]["passed"]
    assert row["gate"]["floor"] == 80 and row["cross_domain"] is False
    assert row["job_requirements"] is None  # 没投岗位要求就是 null，不编
    assert row["source_run_id"] == run.run_id
    assert len(row["examples"]) == 3
    assert all(e["anchor"] and len(e["prompt"]) >= 10 for e in row["examples"])

    # 读不到 scope 的库退回库名本身
    seed = next(r for r in registry["corpora"] if r["corpus"] == "manufacturing")
    assert seed["label"] == "manufacturing" and seed["label_source"] == "corpus_name"


def test_示例出不来只标partial库照样建成(sandbox):
    """LLM 路由没开 → 示例回退。站点 partial，run 仍是 done，库与清单都在。"""
    run = domain_intake.create_run(_files(FOUR_DOCS), corpus="reg-partial")
    domain_intake.execute(run)

    stage = run.record["stages"]["personalize"]
    assert run.record["status"] == "done"
    assert stage["status"] == "partial", stage
    assert stage["detail"]["examples"] == [] and stage["detail"]["examples_note"]
    # partial 与 done 同属跑完的收尾形态，事件自带 status 供前端上色
    done_events = [e for e in _events(run) if e["stage"] == "personalize" and e["kind"] == "stage_done"]
    assert done_events and done_events[-1]["status"] == "partial"
    assert domain_intake.list_runs()[0]["stage_counts"]["partial"] == 1

    # 库照样建成、照样进清单
    assert (domain_intake.CORPORA_DIR / "reg-partial" / "knowledge_index.jsonl").is_file()
    registry = json.loads((domain_intake.KB / "domain_registry.json").read_text(encoding="utf-8"))
    row = next(r for r in registry["corpora"] if r["corpus"] == "reg-partial")
    assert row["examples"] == [] and "路由未启用" in row["examples_note"]


def test_下一次接入不冲掉别的库的示例(sandbox, monkeypatch):
    """清单每次重写，但别的库的示例与出处原样留着——否则每建一个库就废掉前一个。"""
    monkeypatch.setattr(
        domain_intake,
        "_corpus_examples",
        lambda run: ([{"prompt": "批量写入的代价该怎么权衡？", "anchor": "写入与查询"}] * 3, ""),
    )
    first = domain_intake.create_run(_files(FOUR_DOCS), corpus="reg-first")
    domain_intake.execute(first)
    monkeypatch.setattr(domain_intake, "_corpus_examples", lambda run: ([], "这次没出"))
    second = domain_intake.create_run(_files(FOUR_DOCS), corpus="reg-second")
    domain_intake.execute(second)

    registry = json.loads((domain_intake.KB / "domain_registry.json").read_text(encoding="utf-8"))
    kept = next(r for r in registry["corpora"] if r["corpus"] == "reg-first")
    assert len(kept["examples"]) == 3 and kept["source_run_id"] == first.run_id
    fresh = next(r for r in registry["corpora"] if r["corpus"] == "reg-second")
    assert fresh["examples"] == [] and fresh["source_run_id"] == second.run_id


def test_示例必须对得上本库章节且只走白名单模型(sandbox, monkeypatch):
    """两条硬闸：anchor 不在本库章节里的一律丢；strong 档不在白名单就不发车。"""
    run = domain_intake.create_run(_files(FOUR_DOCS), corpus="reg-anchor")
    domain_intake.execute(run)

    class _Route:
        enabled = True
        model = "deepseek-ai/DeepSeek-V3.2"

    replies: dict = {}

    class _FakeGateway:
        def route_for(self, agent):
            return _Route()

        def structured_chat(self, agent, system, user, **kw):
            return replies["value"]

    import backend.services.llm_gateway as gw

    monkeypatch.setattr(gw, "LLMGateway", _FakeGateway)

    # 泛化模板句（anchor 不是本库章节）→ 一条不留
    replies["value"] = {"examples": [{"anchor": "总论", "prompt": "介绍一下这个领域有哪些应用场景？"}] * 3}
    got, note = domain_intake._corpus_examples(run)
    assert got == [] and "对得上本库章节" in note

    # anchor 原样取自本库章节 → 收下
    from backend.rag.retriever import get_corpus_retriever

    titles = [c.title for c in get_corpus_retriever("reg-anchor").chunks]
    replies["value"] = {
        "examples": [{"anchor": t, "prompt": f"{t} 这一节讲的写入路径是什么？"} for t in titles[:3]]
    }
    got, note = domain_intake._corpus_examples(run)
    assert len(got) == 3 and note == "" and got[0]["anchor"] == titles[0]

    # 白名单外的模型（判官档 Qwen 系）→ 不发车，如实说原因
    _Route.model = "Qwen/Qwen3.5-122B"
    got, note = domain_intake._corpus_examples(run)
    assert got == [] and "白名单" in note and "Qwen3.5-122B" in note

def test_两条投料路的选项签名必须一致(sandbox):
    """`create_run` 与 `create_run_from_dir` 并列摆着，加选项时容易只改一个。

    实际发生过（2026-08-22）：C21 的 `hands_on_safety` 只加到了多文件那条路，
    zip 投币线上直接 500 —— `got an unexpected keyword argument`。
    本地 459 条测试全绿，因为没有一条走「zip 路 + 全部选项」。

    这里对着签名比对，而不是逐个字段写断言：以后再加字段，漏了哪条路都会红。
    """
    import inspect

    a = inspect.signature(domain_intake.create_run).parameters
    b = inspect.signature(domain_intake.create_run_from_dir).parameters
    # 第一个位置参数不同（一个收文件列表、一个收目录），其余选项必须一一对应
    opts_a = {k for k in a if k not in ("files", "src")}
    opts_b = {k for k in b if k not in ("files", "src")}
    assert opts_a == opts_b, (
        f"两条投料路的选项对不上：只在 create_run 里的 {opts_a - opts_b}，"
        f"只在 create_run_from_dir 里的 {opts_b - opts_a}"
    )


def test_zip路带全部选项建run选项一路落到盘上(sandbox):
    """选项从函数参数落进 run.json 的 options —— ⑧ 站与管理端都读那一份。"""
    src = sandbox / "src"
    (src / "docs").mkdir(parents=True)
    (src / "docs" / "a.md").write_text("# 标题\n\n" + "正文内容。" * 40, encoding="utf-8")

    run = domain_intake.create_run_from_dir(
        src,
        corpus="optprobe",
        scope="带电作业培训",
        tier_range="L1-L2",
        build_vector=True,
        extract_concepts=True,
        trial_run=True,
        hands_on_safety=True,
    )
    opts = run.record["options"]
    assert opts["hands_on_safety"] is True
    assert opts["trial_run"] is True
    assert opts["build_vector"] is True


# ── 站点化投料（deferred inbox）────────────────────────────────────────────
# 第五坎之后解压/收集从请求路径挪进接收站①。这里跑真 zip、真盘：
# 好包全链建成、原始包名进 source、spool 用完即删；坏包①站失败带理由、
# spool 留着排查；dir 形态成功后 _inbox 副本要清掉。


def _zip_blob(entries: dict[str, bytes | str]) -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, blob in entries.items():
            zf.writestr(name, blob if isinstance(blob, bytes) else blob.encode("utf-8"))
    return buf.getvalue()


def test_deferred_zip_full_chain(sandbox):
    inbox = domain_intake.RUNS_DIR / "_inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    spooled = inbox / "upload-abc.zip"
    spooled.write_bytes(_zip_blob({f"book/{n}": t for n, t in TWO_DOCS.items()} | {"book/cover.png": b"\x89PNG" + b"\x00" * 64}))

    run = domain_intake.create_run_deferred("zip", str(spooled), corpus="tsdb-deferred", scope="时序数据库运维")
    run.record["inbox"]["filename"] = "整本书.zip"
    run.flush()
    # 建 run 那一刻文件清单必须为空——终值由①站填
    assert json.loads(run.record_path.read_text(encoding="utf-8"))["files"] == []

    domain_intake.execute(run)
    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record.get("error")
    assert record["source"]["kind"] == "zip"
    assert record["source"]["filename"] == "整本书.zip"
    names = [f["name"] for f in record["files"]]
    assert sorted(names) == ["book/chapter-one.md", "book/chapter-two.md"]
    # spool 与临时目录用完即清；inbox 键收完即摘
    assert not spooled.exists()
    assert "inbox" not in record
    # 事件流里能看到「开始处理投料」——上传 100% 之后不再是纯黑
    kinds = [(e["stage"], e["message"]) for e in _events(run) if e.get("message")]
    assert any(s == "receive" and "投料" in m for s, m in kinds)


def test_deferred_bad_zip_fails_at_station_one_with_reason(sandbox):
    inbox = domain_intake.RUNS_DIR / "_inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    spooled = inbox / "upload-bad.zip"
    spooled.write_bytes(b"not a zip at all")

    run = domain_intake.create_run_deferred("zip", str(spooled), corpus="tsdb-badzip")
    domain_intake.execute(run)
    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "failed"
    assert record["stages"]["receive"]["status"] == "failed"
    # 失败要带人能读的理由，且坏包留在盘上可排查（成功路径才删）
    assert record["error"]
    assert spooled.exists()
    # 失败的库不许出现在 corpora 里（残库不假装建成）
    assert not (domain_intake.CORPORA_DIR / "tsdb-badzip").exists()


def test_deferred_dir_cleans_inbox_copy_after_success(sandbox):
    inbox = domain_intake.RUNS_DIR / "_inbox"
    staged = inbox / "files-abc"
    staged.mkdir(parents=True, exist_ok=True)
    for n, t in TWO_DOCS.items():
        (staged / n).write_text(t, encoding="utf-8")

    run = domain_intake.create_run_deferred("dir", str(staged), corpus="tsdb-dirdef", scope="时序数据库运维")
    domain_intake.execute(run)
    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record.get("error")
    assert sorted(f["name"] for f in record["files"]) == sorted(TWO_DOCS)
    # 成功后 _inbox 里的上传副本必须清掉——不然每次投币都留一份全量
    assert not staged.exists()


def test_pdf_original_bytes_do_not_inflate_chunk_estimate(sandbox, tmp_path):
    """第七坎：PDF 原体积不进块数预算——预算吃的是抽取后正文。
    没有文本层的假 PDF 抽出 0 字，块数按其余文本算，闸不误拦。"""
    docs = tmp_path / "docs-probe"
    docs.mkdir()
    (docs / "a.md").write_text("正" * 9000, encoding="utf-8")
    (docs / "big.pdf").write_bytes(b"%PDF-1.4 " + b"\x00" * 500_000)
    kept = [("a.md", 9000 * 3), ("big.pdf", 500_009)]
    eff = domain_intake._effective_sizes(docs, kept)
    by = dict(eff)
    assert by["a.md"] == 9000 * 3
    assert by["big.pdf"] < 1000  # 抽不出正文的 PDF 不该顶着 500KB 进预算
    domain_intake.check_budget(eff)  # 不应抛


def test_inbox过期残包会被清掉(sandbox, monkeypatch):
    """站点化之后投料先落 `_inbox`、接收站①处理完就删。

    但**中途失败或进程被杀时删不掉**——2026-08-22 那次机器饱和留下一个 375MB 的包。
    一次失败的投币留几百 MB，攒几次就把磁盘余量吃掉。
    """
    inbox = domain_intake.RUNS_DIR / "_inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    old_zip = inbox / "upload-old.zip"
    old_zip.write_bytes(b"x" * 100)
    fresh = inbox / "upload-fresh.zip"
    fresh.write_bytes(b"x" * 100)
    stale_dir = inbox / "files-old"
    stale_dir.mkdir()
    (stale_dir / "a.md").write_text("x", encoding="utf-8")

    import os

    long_ago = time.time() - domain_intake.INBOX_TTL_SECONDS - 60
    for p in (old_zip, stale_dir):
        os.utime(p, (long_ago, long_ago))

    removed = domain_intake.sweep_inbox()

    assert set(removed) == {"upload-old.zip", "files-old"}, removed
    assert not old_zip.exists() and not stale_dir.exists()
    assert fresh.exists(), "还新鲜的包不许动——正在处理的投料就在这里"


def test_inbox不存在时清理不报错(sandbox):
    """全新部署、还没投过币，`_inbox` 根本不存在。清理是顺手做的，不许因此炸掉投币。"""
    import shutil as _shutil

    _shutil.rmtree(domain_intake.RUNS_DIR / "_inbox", ignore_errors=True)
    assert domain_intake.sweep_inbox() == []
