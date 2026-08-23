# -*- coding: utf-8 -*-
"""素材量报告要说清「活块」，重建过的库还要报归档块。

T1 之后索引里躺着两代块。闸 A 的分母只能是活块（归档块检索不到、铺不了课，
拿它凑数就是虚高）；但报告只说「N 个证据块」，核对的人拿它对文件行数会对不上，
以为报告在瞒数——所以两个数都要出现，各自说清是什么。

顺带把 T1 的存在讲成特性：归档块是「旧课出处永不断链」的兑现方式，不是脚注。
"""
from __future__ import annotations

import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

import corpus_fitness as cf  # noqa: E402


def test_没有归档块时不提它():
    """绝大多数库没重建过，多一句「另有归档块 0 个」是噪声。"""
    _light, why = cf.verdict({"chunks": 4}, archived=0)
    assert "归档" not in "".join(why)


def test_有归档块时两个数都出现():
    # 60(红线) <= 70 < 78(黄线) → 黄灯
    light, why = cf.verdict({"chunks": 70}, archived=70)
    text = "".join(why)
    assert light == "yellow"
    assert "活块 70" in text
    assert "归档块 70" in text
    # 说清它为什么在那儿，而不是只报个数
    assert "旧课出处" in text


def test_归档块不参与判灯():
    """闸 A 的分母只能是活块。归档块能把灯从红顶成绿，那正是这次要治的虚高。"""
    for archived in (0, 500, 5000):
        light, _why = cf.verdict({"chunks": 4}, archived=archived)
        assert light == "red", f"归档 {archived} 块时灯变成了 {light}"


def test_绿灯也报归档块():
    """绿灯原来一句话都不说。重建过的库连行数都对不上，至少得说清多出来的是什么。"""
    _light, why = cf.verdict({"chunks": 900}, archived=900)
    assert "归档块 900" in "".join(why)
    _light2, why2 = cf.verdict({"chunks": 900}, archived=0)
    assert why2 == []


def test_归档块数走共用入口算(tmp_path):
    idx = tmp_path / "knowledge_index.jsonl"
    idx.write_text(
        '{"source_id":"a#s1","content":"活"}\n'
        '{"source_id":"a#s1","content":"旧","superseded":true}\n'
        '{"source_id":"b#s1","content":"活2"}\n',
        encoding="utf-8",
    )
    assert cf.archived_count(idx) == 1


def test_闸A只数活块(tmp_path):
    """反向钉一次：load() 必须过滤，不然 gate_a 的 chunks 直接翻倍。"""
    idx = tmp_path / "knowledge_index.jsonl"
    idx.write_text(
        '{"source_id":"a#s1","content":"活的正文够长够长够长"}\n'
        '{"source_id":"a#s1","content":"旧的正文","superseded":true}\n',
        encoding="utf-8",
    )
    assert len(cf.load(idx)) == 1
