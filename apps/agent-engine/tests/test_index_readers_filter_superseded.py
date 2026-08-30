# -*- coding: utf-8 -*-
"""读索引的地方必须过归档块过滤。

## 为什么要一条静态断言

T1 之后 `knowledge_index.jsonl` 里同时躺着活块与归档块（`superseded`）。
检索侧只有一个装载口（`retriever.load_index`），过滤好办；**离线脚本各读各的**——
2026-08-23 盘点出 13 处自己 `json.loads` 逐行读索引的地方，一处都没过滤。

后果不是少个功能，是**读数在说谎**：`corpus_fitness` 的素材量闸 A 数的是
「够不够铺一门课」，归档块进来直接虚高约一倍（重建过的库翻倍），
红黄绿灯当场判错——把不够的库判成够。错误数据比缺功能伤，因为没人会去核它。

一处一处修完之后，挡住第 14 个才是重点。所以这条测试**扫源码**：
谁再写一遍裸读，它就红。
"""
from __future__ import annotations

import re
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]

#: 允许自己解析索引行的文件。**加进来要写理由，不是随手加。**
ALLOWED = {
    # 索引的唯一写入口：它要读旧文件才能把上一代活块标成归档，
    # 天然得看见全部行（包括归档层），过滤了就没法去重。
    "backend/rag/ingest.py",
    # 检索侧的唯一装载口，过滤判据就在它自己身上。
    "backend/rag/retriever.py",
    # 追加路径要拿全部 source_id 判撞号，归档块的号也算撞
    #（撞了说明那个位置曾经存在过，不能再占）。
    "scripts/ingest_domain.py",
    # 难度回填是**原地改写整份索引**：只动 difficulty 一格，其余逐行原样写回。
    # 用 read_index_rows 会把归档行过滤掉，再整份写回就等于把它们删了——
    # 那是数据丢失，不是过滤。它自己另有判断：归档行读得到但不参与分位、不改值。
    "scripts/backfill_chunk_difficulty.py",
}

#: 裸读的特征：把索引文件按行 json.loads。
_RAW_READ = re.compile(
    r"json\.loads\((?:line|ln|l)\b|for\s+line\s+in\s+.*\.splitlines\(\)",
)


def _index_readers() -> list[Path]:
    """提到 knowledge_index 的 py 文件。"""
    out = []
    for root in ("backend", "scripts", "app"):
        for f in (ENGINE / root).rglob("*.py"):
            if "knowledge_index" in f.read_text(encoding="utf-8", errors="replace"):
                out.append(f)
    return out


def _rel(f: Path) -> str:
    return f.relative_to(ENGINE).as_posix()


def test_共用入口存在且默认只给活块(tmp_path):
    from backend.rag.ingest import is_active_row, read_index_rows

    idx = tmp_path / "knowledge_index.jsonl"
    idx.write_text(
        '{"source_id":"a#s1","content":"活的"}\n'
        '{"source_id":"a#s1","content":"旧的","superseded":true}\n'
        '{"source_id":"b#s1","content":"也是活的"}\n',
        encoding="utf-8",
    )
    rows = read_index_rows(idx)
    assert [r["content"] for r in rows] == ["活的", "也是活的"]
    assert len(read_index_rows(idx, include_superseded=True)) == 3
    assert is_active_row({"source_id": "x"}) is True
    assert is_active_row({"source_id": "x", "superseded": True}) is False


def test_坏行整个抛_不悄悄跳过(tmp_path):
    """跳过的可能正是某门课的出处，而「少了一块」在计数类脚本里看不出来。"""
    import json

    import pytest

    from backend.rag.ingest import read_index_rows

    idx = tmp_path / "knowledge_index.jsonl"
    idx.write_text('{"source_id":"a#s1"}\n这不是 json\n', encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        read_index_rows(idx)


def test_没有第十四个裸读():
    """路障：谁再自己逐行 json.loads 读索引，这条就红。

    修法只有一个：`from backend.rag.ingest import read_index_rows`。
    真有理由自己读（比如要看归档层），把文件加进 ALLOWED 并写清为什么。
    """
    offenders = []
    for f in _index_readers():
        rel = _rel(f)
        if rel in ALLOWED:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        # 只关心「既提到索引、又在逐行解析」的那些
        if _RAW_READ.search(text) and "read_index_rows" not in text:
            offenders.append(rel)
    assert offenders == [], (
        "这些文件自己逐行读索引、没过归档块过滤——素材量与计数会虚高：\n  "
        + "\n  ".join(offenders)
        + "\n改用 backend.rag.ingest.read_index_rows"
    )


def test_已改的那批确实都在用共用入口():
    """反向钉一次：修过的文件不许被人改回裸读。

    只钉「用了共用入口」，不钉具体行号——行号会随重构漂，判据不该挂在行号上。
    """
    expected = [
        "scripts/corpus_fitness.py",
        "backend/services/concept_difficulty.py",
        "scripts/auto_outline.py",
        "scripts/build_curriculum.py",
        "scripts/build_prereq_graph.py",
        "scripts/export_blind_claims.py",
        "scripts/export_blind_review_kit.py",
        "scripts/label_chunk_difficulty.py",
        "scripts/validate_difficulty.py",
        "scripts/experiments/course_depth_audit.py",
        "scripts/experiments/derive_scene_concepts.py",
        "scripts/experiments/excerpt_difficulty_placement.py",
        "scripts/experiments/prereq_reviewer_sanity.py",
        "scripts/experiments/lecture_body_audit_corpora.py",
        "backend/services/domain_intake.py",
    ]
    missing = [
        rel
        for rel in expected
        if "read_index_rows" not in (ENGINE / rel).read_text(encoding="utf-8")
    ]
    assert missing == [], "这些文件被改回裸读了：" + "、".join(missing)
