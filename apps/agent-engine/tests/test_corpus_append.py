# -*- coding: utf-8 -*-
"""增量补币 T0：往已有库追加文档（E31）。

「只是想补几篇文档进已有的库」此前唯一的出路是整库重建，而重建会让 source_id
重新编号——旧课正文里的 `[docs-plc#s31]` 集体指向别的段落。课看着没变，引文全错位。

所以这条路的**第一铁律是既有行一个字节不动**。下面每条都盯着这一点：
逐行比对，不比条数。
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

import ingest_domain  # noqa: E402
from backend.services import domain_intake  # noqa: E402


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    """一个只有三块的临时库。真库不碰。"""
    kb = tmp_path / "knowledge_base"
    (kb / "corpora" / "probe").mkdir(parents=True)
    monkeypatch.setattr(ingest_domain, "KB", kb)
    monkeypatch.setattr(domain_intake, "KB", kb)
    monkeypatch.setattr(domain_intake, "CORPORA_DIR", kb / "corpora")

    rows = [
        {
            "source_id": f"old-doc#s{i}",
            "title": f"既有第 {i} 节",
            "topic": "old",
            "difficulty": "L1",
            "concept_tags": [],
            "section": f"section-{i}",
            "url": None,
            "content": f"既有正文 {i}",
        }
        for i in (1, 2, 3)
    ]
    index = kb / "corpora" / "probe" / "knowledge_index.jsonl"
    index.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8"
    )
    return index


NEW = [
    ("new-doc.md#1 新章一", "新正文一，讲逆变器巡检。", ["新章一"]),
    ("new-doc.md#2 新章二", "新正文二，讲告警处理。", ["新章二"]),
]


def test_existing_lines_survive_byte_for_byte(corpus):
    before = corpus.read_text(encoding="utf-8").splitlines()
    ingest_domain.append_corpus_index("probe", NEW, [], "L1-L3")
    after = corpus.read_text(encoding="utf-8").splitlines()
    # 逐行比对而不是比条数：条数对得上、内容被重排过，旧课出处照样错位
    assert after[: len(before)] == before
    assert len(after) == len(before) + 2


def test_appended_ids_do_not_collide(corpus):
    _, added, collided = ingest_domain.append_corpus_index("probe", NEW, [], "L1-L3")
    assert (added, collided) == (2, [])
    ids = [json.loads(l)["source_id"] for l in corpus.read_text(encoding="utf-8").splitlines()]
    assert ids == ["old-doc#s1", "old-doc#s2", "old-doc#s3", "new-doc#s1", "new-doc#s2"]


def test_same_file_again_is_refused_not_duplicated(corpus):
    ingest_domain.append_corpus_index("probe", NEW, [], "L1-L3")
    snapshot = corpus.read_text(encoding="utf-8")
    _, added, collided = ingest_domain.append_corpus_index("probe", NEW, [], "L1-L3")
    # 同名文件的新版本属于「改」不属于「补」——拦下来，不是悄悄写两遍
    assert added == 0
    assert collided == ["new-doc#s1", "new-doc#s2"]
    assert corpus.read_text(encoding="utf-8") == snapshot


def test_stem_ledger_reads_from_the_index_itself(corpus):
    # 存量六个库都建在追加这条路之前，没有 sha256 台账。判据只能是索引本身。
    assert ingest_domain.corpus_source_stems("probe") == {"old-doc"}
    ingest_domain.append_corpus_index("probe", NEW, [], "L1-L3")
    assert ingest_domain.corpus_source_stems("probe") == {"old-doc", "new-doc"}


def test_append_to_missing_corpus_refuses(corpus):
    with pytest.raises(FileNotFoundError):
        ingest_domain.append_corpus_index("no-such-corpus", NEW, [], "L1-L3")


def test_concept_tags_use_existing_vocab(corpus):
    ingest_domain.append_corpus_index("probe", NEW, [{"concept": "告警处理"}], "L1-L3")
    last = json.loads(corpus.read_text(encoding="utf-8").splitlines()[-1])
    # 词表沿用既有的（④ 不重跑），但也不能不给——不给的话同一个库里
    # 老块有标签新块没有，检索排序上新文档天然吃亏
    assert last["concept_tags"] == ["告警处理"]


def test_one_id_recipe_for_both_paths():
    """路障：整库重建与追加必须共用 `_build_chunks`。

    两份实现迟早在 source_id 上分叉，而 source_id 分叉就是旧课引文错位——
    那是这条路唯一不能出的事。
    """
    src = (ENGINE / "scripts" / "ingest_domain.py").read_text(encoding="utf-8")
    assert src.count("def _build_chunks(") == 1
    assert src.count("_build_chunks(name, sections, vocab, tier_range)") >= 2


class _Rec:
    def __init__(self, **options):
        self.record = {"options": options}


def test_append_mode_skips_the_whole_corpus_stages():
    """④⑤⑦⑧ 描述的是整个库，追加几篇文档不该把它们重算一遍。"""
    run = _Rec(append=True)
    for sid in ("receive", "chunk", "index"):
        assert domain_intake._skip_reason(run, sid) == ""
    for sid in ("knowledge", "gold", "trial", "metrics", "personalize", "vector"):
        assert domain_intake._skip_reason(run, sid) == domain_intake.APPEND_SKIP_REASON


def test_append_failure_never_deletes_the_existing_corpus():
    """路障：`_cleanup_partial` 的前提是「这个库是本次 run 建的」。

    追加模式下这个前提不成立——库是既有的，正被线上课程引用着。
    删了就是把别人的库删了。
    """
    src = (
        ENGINE / "backend" / "services" / "domain_intake.py"
    ).read_text(encoding="utf-8")
    assert 'options"].get("append")' in src
    assert "skip_cleanup = " in src
    # 清理调用必须挂在 skip_cleanup 上，不能是裸的 checkup 判断
    assert "removed = [] if skip_cleanup else _cleanup_partial(run.corpus)" in src


def test_all_run_constructors_accept_append():
    """签名齐平。少一个就是线上 500——`hands_on_safety` 已经这么炸过一次。"""
    import inspect

    for fn in (
        domain_intake.create_run,
        domain_intake.create_run_from_dir,
        domain_intake.create_run_deferred,
        domain_intake._new_run,
    ):
        assert "append" in inspect.signature(fn).parameters, fn.__name__


def test_a7_copy_no_longer_says_unsupported():
    """A7 文案：追加已经能用了，别再让人以为只能整库重建。"""
    src = (
        ENGINE / "backend" / "services" / "domain_intake.py"
    ).read_text(encoding="utf-8")
    assert "这条链还不支持增量" not in src
    assert "勾上「追加到已有库」直接投" in src
    # 但「改删仍需重建」这句不能丢——含糊了就会有人拿它当全量增量用
    assert "仍需整库重建" in src


def teardown_module():
    for leftover in (ingest_domain.KB / "corpora").glob("zz-*"):
        shutil.rmtree(leftover, ignore_errors=True)
