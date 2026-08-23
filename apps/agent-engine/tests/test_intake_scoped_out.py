# -*- coding: utf-8 -*-
"""疆域「范围」里声明剔除的文件，不许出现在检索得到的索引里。

## 现状是红的：iotdb 就是活证据

`data/knowledge_base/iotdb_intake/readiness.json` 的 `intake.scoped_out.files`
写着 12 个文件（两条前缀 `Table/AI-capability`、`Tree/AI-capability`），
可这 12 个文件的 132 个块**一个不少**躺在
`data/knowledge_base/corpora/iotdb/knowledge_index.jsonl` 里，全是活块。
对账三个数：报告 `intake.sections = 3070`（剔除后 230 个文件），
索引 3202 块（未剔除的 242 个文件），差额 132 = 那 12 个文件的节数。

原因不在「①站没排除」——`scripts/ingest_domain.py:529-537` 确实把
`manifest.accepted` 换成了剔除后的清单，同一次进程里②站切块拿到的就是干净的。
原因是那份剔除清单**只活在 argv 里**：`--exclude` 不进任何持久判据，
`scoped_out` 落进 readiness 之后就是一个没人读的记录字段（全仓只有
`ingest_domain.py` 的写入侧四处，加上课堂页面拿它做对账展示）。
于是第二次跑 `--index-only` 补建索引时（`scripts/ingest_domain.py:567-571`
只从旧报告里取回了 `concepts`，没取 `intake.scoped_out.prefixes`），
剔除清单丢了，被剔除的文件原样重新入库。

下面这条用例把那次「第二趟补建」照原样重放一遍：先写一份声明了 `scoped_out`
的 readiness，再跑一次不带 `--exclude` 的 `--index-only`，看被声明剔除的文件
有没有回到索引里。

**2026-08-23 已修**：没给 `--exclude` 时从上一次的 readiness 里读回
`intake.scoped_out.prefixes` 沿用（`backend/rag/intake.remembered_exclusions`），
剔除声明从此是库的属性而不是某一次命令行的属性。第一条用例转绿。
第二条仍是红的——它对的是**现有那份**索引，要等 iotdb 重投才会自己转绿。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

import ingest_domain  # noqa: E402
from backend.rag.ingest import read_index_rows  # noqa: E402

# triage 的 MIN_USEFUL_CHARS 是 200，正文得够长才收得进来。
BODY = (
    "# 标题\n\n"
    + "这一节讲的是设备巡检的完整流程，从停机确认到并网点电压核对，"
    "每一步都写清预期读数与异常处置，篇幅足够越过分诊那道 200 字符的下限。" * 4
)

IOTDB_READINESS = (
    ENGINE / "data" / "knowledge_base" / "iotdb_intake" / "readiness.json"
)
IOTDB_INDEX = (
    ENGINE / "data" / "knowledge_base" / "corpora" / "iotdb" / "knowledge_index.jsonl"
)


def _slug(rel: str) -> str:
    """`_build_chunks` 的 source_id 口径：去扩展名、非字母数字折成 `-`、转小写。"""
    import re

    return re.sub(r"[^0-9A-Za-z]+", "-", rel.rsplit(".", 1)[0]).strip("-").lower()


def test_index_only_rebuild_honours_declared_scope(tmp_path, monkeypatch):
    """重放 iotdb 那两趟：第一趟声明剔除，第二趟补建索引把它捡了回来。"""
    docs = tmp_path / "docs"
    (docs / "Keep").mkdir(parents=True)
    (docs / "Drop").mkdir(parents=True)
    (docs / "Keep" / "guide.md").write_text(BODY, encoding="utf-8")
    (docs / "Drop" / "excluded.md").write_text(BODY, encoding="utf-8")

    kb = tmp_path / "kb"
    monkeypatch.setattr(ingest_domain, "KB", kb)
    monkeypatch.setattr(ingest_domain, "ROOT", tmp_path)
    # 素材量那一格会往真实 data/ 写 fitness.json，用例里不需要它。
    monkeypatch.setattr(ingest_domain, "report_fitness", lambda name: None)

    # 第一趟接入的产物：报告里明写了这一域不教 Drop/ 下面的东西。
    prior = kb / "probe_intake" / "readiness.json"
    prior.parent.mkdir(parents=True)
    prior.write_text(
        json.dumps(
            {
                "domain": "probe",
                "intake": {"scoped_out": {"prefixes": ["Drop"], "files": ["Drop/excluded.md"]}},
                "concepts": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    # 第二趟：补建索引。跑的人没有把 --exclude 再敲一遍——这正是 iotdb 的实况。
    monkeypatch.setattr(
        sys, "argv", ["ingest_domain.py", "--dir", str(docs), "--name", "probe", "--index-only"]
    )
    assert ingest_domain.main() == 0

    index = kb / "corpora" / "probe" / "knowledge_index.jsonl"
    stems = {row["source_id"].rsplit("#", 1)[0] for row in read_index_rows(index)}
    assert _slug("Keep/guide.md") in stems, "没被剔除的文件应该照常入库"
    assert _slug("Drop/excluded.md") not in stems, (
        "报告里声明剔除的文件又回到索引里了——声明没有约束力"
    )


@pytest.mark.skipif(
    not (IOTDB_READINESS.is_file() and IOTDB_INDEX.is_file()),
    reason="本机没有 iotdb 这个库的产物，跳过实盘对账",
)
def test_iotdb_index_has_no_scoped_out_chunks():
    """实盘对账：readiness 声明剔除的文件，索引里应当一块都没有。"""
    readiness = json.loads(IOTDB_READINESS.read_text(encoding="utf-8"))
    scoped = readiness["intake"]["scoped_out"]["files"]
    assert scoped, "这条用例的前提是 readiness 里确实声明了剔除清单"

    wanted = {_slug(f) for f in scoped}
    rows = read_index_rows(IOTDB_INDEX)
    leaked = [r["source_id"] for r in rows if r["source_id"].rsplit("#", 1)[0] in wanted]
    assert not leaked, (
        f"{len(wanted)} 个被声明剔除的文件里有 "
        f"{len({s.rsplit('#', 1)[0] for s in leaked})} 个仍在索引，共 {len(leaked)} 块"
    )


# ── 服务端接入链（管理端 UI 投币走的就是这条） ──────────────────────────────
#
# CLI 那条修好不等于 UI 那条也修好：2026-08-23 之前服务端**根本没有剔除这一格**，
# 表单、options、①站过滤一个都没有——从管理端投币压根没地方声明「本域不教什么」。
# 所以下面这两条不是重复用例，它们盯的是另一条链。

from backend.services import domain_intake  # noqa: E402


def _receive_with(sandbox_kb, monkeypatch, files: dict[str, str], **options):
    """跑到①站为止，返回 (run, 落库后的 source_id stem 集合)。"""
    payload = [(n, b.encode("utf-8")) for n, b in files.items()]
    run = domain_intake.create_run(payload, corpus=options.pop("corpus", "scope-demo"), **options)
    domain_intake.execute(run)
    return run


@pytest.fixture()
def kb_sandbox(tmp_path, monkeypatch):
    import backend.rag.retriever as retriever
    from backend.integration import personalize_service

    kb = tmp_path / "knowledge_base"
    corpora = kb / "corpora"
    corpora.mkdir(parents=True)
    monkeypatch.setattr(domain_intake, "KB", kb)
    monkeypatch.setattr(domain_intake, "RUNS_DIR", kb / "intake_runs")
    monkeypatch.setattr(domain_intake, "CORPORA_DIR", corpora)
    monkeypatch.setattr(domain_intake, "GOLD_DIR", tmp_path / "eval" / "kc_gold_derived")
    monkeypatch.setattr(retriever, "CORPORA_DIR", corpora)
    monkeypatch.setattr(personalize_service, "KB_DIR", kb)
    domain_intake._ensure_scripts_path()
    monkeypatch.setattr(ingest_domain, "KB", kb)
    retriever.refresh_corpora()
    yield kb
    retriever.refresh_corpora()


def _receive_msgs(run) -> list[str]:
    lines = run.events_path.read_text(encoding="utf-8").splitlines()
    return [json.loads(x)["message"] for x in lines if json.loads(x)["stage"] == "receive"]


def _stems(kb, corpus: str) -> set[str]:
    index = kb / "corpora" / corpus / "knowledge_index.jsonl"
    return {r["source_id"].rsplit("#", 1)[0] for r in read_index_rows(index)}


DOCS = {"keep.md": BODY, "drop.md": BODY.replace("巡检", "标定")}


def test_ui_intake_honours_declared_exclusions(kb_sandbox, monkeypatch):
    """管理端声明「本域不教 drop.md」，被声明的文件不许进索引。"""
    run = _receive_with(kb_sandbox, monkeypatch, DOCS, corpus="scope-a", exclude=["drop.md"])

    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]

    stems = _stems(kb_sandbox, "scope-a")
    assert _slug("keep.md") in stems
    assert _slug("drop.md") not in stems, "声明剔除的文件仍然进了索引"

    # 事件流里要说得出剔了几个——静默生效等于没声明。
    assert any("按声明剔除 1 个文件" in m for m in _receive_msgs(run)), _receive_msgs(run)

    # 剔除单列，不混进「格式不支持」的退回清单。
    detail = record["stages"]["receive"]["detail"]
    assert detail["scoped_out"]["files"] == ["drop.md"]
    assert not any(r["file"] == "drop.md" for r in detail["rejected"])

    readiness = json.loads(
        (kb_sandbox / "scope-a_intake" / "readiness.json").read_text(encoding="utf-8")
    )
    assert readiness["intake"]["scoped_out"] == {"prefixes": ["drop.md"], "files": ["drop.md"]}


def test_ui_intake_inherits_previous_declaration(kb_sandbox, monkeypatch):
    """第二趟没重复声明也不许把剔掉的捡回来——这正是 iotdb 栽的那一跤。"""
    _receive_with(kb_sandbox, monkeypatch, DOCS, corpus="scope-b", exclude=["drop.md"])

    prior = json.loads(
        (kb_sandbox / "scope-b_intake" / "readiness.json").read_text(encoding="utf-8")
    )
    assert prior["intake"]["scoped_out"]["prefixes"] == ["drop.md"]

    # 第二趟：同一个库名追加一篇新文档，剔除声明一个字都没填。
    # drop.md 第一趟就被剔了、从没进过索引，所以追加模式的「库里已经有了」这道闸
    # **拦不住它**——能拦住它的只有沿用下来的声明。
    run = _receive_with(
        kb_sandbox,
        monkeypatch,
        {"extra.md": BODY.replace("巡检", "并网"), "drop.md": DOCS["drop.md"]},
        corpus="scope-b",
        append=True,
    )
    record = json.loads(run.record_path.read_text(encoding="utf-8"))
    assert record["status"] == "done", record["error"]

    stems = _stems(kb_sandbox, "scope-b")
    assert _slug("extra.md") in stems, "追加的新文档应该照常入库"
    assert _slug("drop.md") not in stems, (
        "第二趟没重复声明，被剔除的文件又回到索引里了——声明还是没有约束力"
    )
    assert any("沿用上一次接入的声明" in m for m in _receive_msgs(run)), _receive_msgs(run)


def test_dropping_a_previously_declared_prefix_is_reported(kb_sandbox, monkeypatch):
    """重投时少写了上次声明过的前缀，要点名报出来。

    沿用是全有或全无（填了新声明就一条旧的都不继承）——这个语义本身是对的，
    能合并就永远删不掉一条前缀了。但少掉了不吭声不行：iotdb 现有 readiness 带着
    两条 AI-capability 前缀，重投时填 22 条新的，那两条会静默消失。
    """
    docs = {"keep.md": BODY, "drop.md": BODY.replace("巡检", "标定"), "other.md": BODY.replace("巡检", "并网")}
    _receive_with(kb_sandbox, monkeypatch, docs, corpus="scope-c", exclude=["drop.md", "other.md"])

    # 第二趟只声明了其中一条，另一条没再提。
    run2 = _receive_with(
        kb_sandbox,
        monkeypatch,
        {"extra.md": BODY.replace("巡检", "变频"), "other.md": docs["other.md"]},
        corpus="scope-c",
        append=True,
        exclude=["drop.md"],
    )
    msgs = _receive_msgs(run2)
    assert any("other.md" in m and "这次没再声明" in m for m in msgs), msgs
    # 说到做到：没再声明的那个确实入库了，警告不是空话
    assert _slug("other.md") in _stems(kb_sandbox, "scope-c")
