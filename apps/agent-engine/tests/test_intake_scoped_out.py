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
有没有回到索引里。修完请去掉 `xfail`。
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


@pytest.mark.xfail(
    reason="剔除清单只活在 argv 里：--index-only 补建（ingest_domain.py:567-571）"
    "不读回 readiness 的 intake.scoped_out.prefixes，被声明剔除的文件重新入库。"
    "修完去掉 xfail。",
    strict=True,
)
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
@pytest.mark.xfail(
    reason="iotdb 现有索引里 12 个被声明剔除的文件共 132 块全在。"
    "重投并修好接入链之后，这一条会自己转绿；届时去掉 xfail。",
    strict=True,
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
