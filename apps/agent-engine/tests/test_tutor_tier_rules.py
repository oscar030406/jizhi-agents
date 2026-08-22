"""导学出题的姿态档约束。

钉住 2026-08-13 实测那一句——零基础档的导学提问里出现：
「向量空间中的语义关系学习主要依赖于模型对大量文本上下文的自监督学习，
  通过预测下一个词的任务来学习语义表示，而非仅依赖训练数据中词语的表面共现频率。」
三个未定义术语一个从句，给的是刚被告知「不用代码和公式开场」的零基础学员。

根因：导学 prompt 只把「推荐难度 L1」当一句话塞进画像，没有可执行约束；
而讲义自撰区的 lint（L1-TERM 等）**看不到导学这条路**——它是另一条路由、另一次生成。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.tutor_service import _tier_ask_rules  # noqa: E402


def test_l1_rules_are_actionable_not_a_label():
    """L1 的约束必须是模型能执行的动作，不是「面向零基础」这种形容词。"""
    r = _tier_ask_rules("L1")
    assert r, "L1 必须有约束"
    assert "大白话解释" in r
    assert "最多引入 1 个新术语" in r
    # 病灶是连环从句本身，不是字数。此处原先写死「一句不超过 40 字」——
    # 那个数字是我们自己拍的、无出处，且面向的是上过大学的人，不用按小学生的句长教。
    # 2026-08-13 撤掉数字，改成同源的结构约束。
    assert "不许套多重从句" in r
    assert "40 字" not in r


def test_each_tier_has_distinct_rules():
    l1, l2, l3 = (_tier_ask_rules(t) for t in ("L1", "L2", "L3"))
    assert l1 and l2 and l3
    assert len({l1, l2, l3}) == 3, "三档不能共用一套措辞约束"


def test_l3_does_not_inherit_beginner_scaffolding():
    """进阶档不该被要求逐句解释术语——那会把 advanced 写软（t|a 边界本来就糊）。"""
    r = _tier_ask_rules("L3")
    assert "大白话" not in r
    assert "日常生活" not in r


def test_unknown_tier_returns_empty_not_a_guess():
    """读不出档位就不加约束，保持旧行为。瞎猜一个档比不猜更糟。"""
    for value in ("", "  ", "L9", "beginner", None):
        assert _tier_ask_rules(value) == ""


def test_case_and_whitespace_tolerant():
    assert _tier_ask_rules(" l1 ") == _tier_ask_rules("L1")
