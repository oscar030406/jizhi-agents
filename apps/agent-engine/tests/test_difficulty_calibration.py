"""难度定标校准：单调性抓逆序、区分度抓平题、正常标签通过。"""
from backend.services.difficulty_calibration import CalibrationItem, calibrate

STRONG = {"rag": 0.9, "agent_basics": 0.9}
WEAK = {"rag": 0.1, "agent_basics": 0.1}
PROFILES = {"强": STRONG, "弱": WEAK}


def _item(iid, level):
    return CalibrationItem(item_id=iid, difficulty=level, concept_tags=["rag"])


def test_well_ordered_difficulty_passes():
    report = calibrate([_item("a", "L1"), _item("b", "L2"), _item("c", "L3")], PROFILES)
    assert report.passed and not report.monotone_violations
    # 难度升档，平均预测正确率单调下降
    assert report.level_mean_prob["L1"] > report.level_mean_prob["L2"] > report.level_mean_prob["L3"]


def test_monotone_violation_detected():
    # 把一批"实际很容易"的题错标成 L4：L4 档均值反而高于 L3 档不可能出现在
    # 模型内部（b 单调），所以构造违例要走概念差：L3 题挂弱概念、L4 题挂强概念
    strong_concept = {"easy": 0.95}
    profiles = {"甲": {"easy": 0.95, "hard": 0.05}}
    items = [
        CalibrationItem(item_id="x", difficulty="L3", concept_tags=["hard"]),
        CalibrationItem(item_id="y", difficulty="L4", concept_tags=["easy"]),
    ]
    report = calibrate(items, profiles)
    assert not report.passed
    assert report.monotone_violations[0].higher_level == "L4"
    assert strong_concept  # silence lint


def test_low_discrimination_flagged():
    # 两画像掌握度相同 → 每道题 spread=0 → 全部低区分度
    report = calibrate([_item("a", "L2")], {"甲": {"rag": 0.5}, "乙": {"rag": 0.5}})
    assert report.low_discrimination_items == ["a"]
