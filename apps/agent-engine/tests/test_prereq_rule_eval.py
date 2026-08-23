# -*- coding: utf-8 -*-
"""措辞信号记录 + 规则打分脚本。

`link_intent` 写好很久了却**故意没接进产出**（理由在它自己的文档里：
评估口径不干净，规则和标签是同一个人产的）。这一批改的不是那个决定，
改的是「决定所需的数字算不出来」——两份审表是空模板，08-12 那轮判定
没落成机器可读的形式，想再问一次只能重跑整条链。

所以：① 每条边记下措辞分布（只记不判）；② 一个打分脚本，
标注表填进来四种规则的正确率当场出。**验证工具自己要先自证**，
所以下面有一半是在验脚本本身算得对。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
if str(ENGINE / "scripts") not in sys.path:
    sys.path.insert(0, str(ENGINE / "scripts"))

from backend.rag.structure_edges import page_refs, page_refs_at, structural_edges  # noqa: E402
import prereq_rule_eval as ev  # noqa: E402


# ── 措辞分布 ────────────────────────────────────────────────


def test_每次引用拿到自己那句话():
    """原来 `_context` 用 find() 找第一次出现，同页多次引用共用一句话——
    审表上两条不同的边贴着一模一样的引文就是这么来的。"""
    text = "开头。详见 [基础](../b/y.md)。中间很长的一段正文。请先启用 [基础](../b/y.md)。"
    positions = [pos for _t, pos in page_refs_at(text)]
    assert len(positions) == 2
    assert positions[0] != positions[1]


def test_page_refs_与带位置版同源():
    text = "看 [a](../x/a.md) 和 <../y/b> 两处。"
    assert page_refs(text) == [t for t, _p in page_refs_at(text)]


def test_边上带措辞分布():
    files = {
        "a/x.md": "正文。详见 [基础](../b/y.md)。更多细节参见 [基础](../b/y.md)。",
        "a/z.md": "请先启用 [基础](../b/y.md) 才能继续。",
    }
    (edge,) = structural_edges(files, min_links=2)
    assert edge["links"] == 3
    assert edge["intents"] == {"seealso": 2, "prereq": 1}


def test_判措辞只看本句_不吃邻句():
    """宽窗口会把邻句卷进来。「请先」是唯一能把边留下来的信号，
    串味等于凭邻居那句话留下这条边——Odoo 上实测六成的 prereq 命中是这么来的。"""
    files = {
        "a/x.md": "详见 [基础](../b/y.md)。请先准备好环境再动手。详见 [基础](../b/y.md)。",
    }
    (edge,) = structural_edges(files, min_links=2)
    # 两次引用都在「详见」句里，隔壁那句「请先」不算数
    assert edge["intents"] == {"seealso": 2}


def test_措辞只记不判_产出条数不变():
    """路障：记分布不许改变哪些边被产出。改了就是偷偷接了过滤器。"""
    files = {
        "a/x.md": "详见 [基础](../b/y.md)。参见 [基础](../b/y.md)。",  # 两次都是「参见」
    }
    (edge,) = structural_edges(files, min_links=2)
    assert edge["intents"] == {"seealso": 2}
    assert edge["links"] == 2  # 仍然产出，没被过滤掉


# ── 打分脚本自证 ────────────────────────────────────────────

SHEET = """# 抽检表

**1. 甲 → 乙**（引用 6 次，反向 0 次）  方向对吗：[✓]

**2. 丙 → 丁**（引用 4 次，反向 0 次）  方向对吗：[✗]

**3. 戊 → 己**（引用 2 次，反向 0 次）  方向对吗：[ ]
"""


def test_只有填过的才进分母(tmp_path):
    sheet = tmp_path / "s.md"
    sheet.write_text(SHEET, encoding="utf-8")
    labels = ev.read_labels(sheet)
    assert labels == {("甲", "乙"): True, ("丙", "丁"): False}
    assert ("戊", "己") not in labels  # 没填的不算，也就不进分母


def test_空表直接报错而不是算出空数(tmp_path, capsys):
    sheet = tmp_path / "s.md"
    sheet.write_text("**1. 甲 → 乙**（引用 6 次）  方向对吗：[ ]\n", encoding="utf-8")
    assert ev.read_labels(sheet) == {}
    with pytest.raises(SystemExit):
        ev.evaluate([{"prereq": "甲", "target": "乙"}], {}, {})


EDGES = [
    # 方向对：引用里有「请先」
    {"prereq": "甲", "target": "乙", "links": 6, "back_links": 0,
     "intents": {"prereq": 4, "seealso": 2}},
    # 方向错：全是「详见」
    {"prereq": "丙", "target": "丁", "links": 4, "back_links": 0,
     "intents": {"seealso": 4}},
]


def test_规则打分算得对(tmp_path, capsys):
    sheet = tmp_path / "s.md"
    sheet.write_text(SHEET, encoding="utf-8")
    ev.evaluate(EDGES, ev.read_labels(sheet), {})
    out = capsys.readouterr().out
    assert "已标注 2 条" in out
    # baseline 留 2 条对 1 条 = 50%；prereq-only 留 1 条对 1 条 = 100%
    assert "baseline" in out and "50%" in out
    assert "prereq-only" in out and "100%" in out


def test_没有intents的审计要提醒而不是静默算错(tmp_path, capsys):
    sheet = tmp_path / "s.md"
    sheet.write_text(SHEET, encoding="utf-8")
    old = [{k: v for k, v in e.items() if k != "intents"} for e in EDGES]
    ev.evaluate(old, ev.read_labels(sheet), {})
    out = capsys.readouterr().out
    # 静默按「没有 prereq 命中」算，会得出「过滤后一条不剩」这种假结论
    assert "没有 intents 字段" in out


def test_规则集覆盖三根杠杆():
    assert set(ev.RULES) == {"baseline", "seealso-filter", "prereq-only", "two-of-three"}


def test_打分脚本不写盘():
    """路障：这个脚本只算数不改产出。要不要按规则改，是看完数字之后的决定。"""
    src = (ENGINE / "scripts" / "prereq_rule_eval.py").read_text(encoding="utf-8")
    for forbidden in ("write_text", "open(", "dump("):
        assert forbidden not in src, f"打分脚本不该写盘，出现了 {forbidden}"
