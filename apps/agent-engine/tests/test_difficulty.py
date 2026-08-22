"""难度标注的纯函数部分：平均秩、等权合成、分位切档、锚点池。

特征本身有没有用是实测问题（`scripts/validate_difficulty.py`），不在这里断言——
这里只钉住计算逻辑不会悄悄坏掉。
"""

from backend.rag.difficulty import (
    TIERS,
    assign_tiers,
    extract_features,
    score,
    _ranks,
)


def test_ranks_average_ties():
    assert _ranks([10.0, 20.0, 20.0, 30.0]) == [0.0, 1.5, 1.5, 3.0]


def test_ranks_is_order_only_not_magnitude():
    """秩只看顺序——这正是它能跨形态用、而绝对阈值不能的原因。"""
    assert _ranks([1.0, 2.0, 3.0]) == _ranks([1.0, 1000.0, 1e9])


def test_score_is_monotonic_in_a_single_feature():
    rows = [extract_features(t) for t in ("纯中文散文。" * 30, "$\\frac{a}{b}$ " * 30)]
    s = score(rows, use=("formula_density",))
    assert s[1] > s[0]


def test_assign_tiers_covers_all_four_and_is_ordered():
    scores = [i / 100 for i in range(100)]
    tiers = assign_tiers(scores)
    assert set(tiers) <= set(TIERS)
    # 分数单调递增，档位不能回头
    assert [TIERS.index(t) for t in tiers] == sorted(TIERS.index(t) for t in tiers)


def test_anchor_pool_makes_a_shallow_corpus_stay_low():
    """整体很浅的新语料，若在自身内切档会切出 L4；挂上锚点池就不会。

    这条是「相对难度 ≠ 绝对档位」那个局限的缓解办法，也是它唯一的验收点。
    """
    # 一批分数全挤在低位的「浅」语料
    shallow = [0.01 + i / 10000 for i in range(100)]
    anchor = [i / 100 for i in range(100)]
    assert set(assign_tiers(shallow, anchor=anchor)) == {"L1"}
    assert "L4" in assign_tiers(shallow)  # 不挂锚点，语料内部相对排序照样切出 L4


def test_empty_input_does_not_explode():
    assert score([]) == []
    assert assign_tiers([]) == []
