"""难度定标校准（评测协议 §四，破"自家规则自证"循环）。

SMART 思路（arXiv 2507.05129）的确定性轻量版：把 5 类预设画像当作能力已知的
模拟学生，用 1PL（Rasch 型）模型预测每道分阶题的作答概率，检验：
1) 单调性——难度标签升档，平均预测正确率必须不升；
2) 区分度——同一道题在强弱画像间的预测正确率差应当可观。

模拟层给不出真实学生数据的效度，但能机器化地抓出"难度标签与掌握度模型矛盾"的
定标错误；人工层（教师盲标）按盲测协议另行执行。
"""
from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

from pydantic import BaseModel, Field

# 难度档 → Rasch 难度参数 b（logit 尺度，等距铺开）
DIFFICULTY_B = {"L1": -1.5, "L2": -0.5, "L3": 0.5, "L4": 1.5}
DISCRIMINATION_A = 1.7          # 1PL 固定区分度（logistic 近似正态用 1.7）
MIN_SPREAD = 0.15               # 强弱画像预测正确率差低于此值=题目不区分
MONOTONE_TOLERANCE = 0.02       # 相邻难度档平均正确率允许的逆序容差


class CalibrationItem(BaseModel):
    item_id: str
    difficulty: str             # L1-L4 声明难度
    concept_tags: List[str]


class ItemPrediction(BaseModel):
    item_id: str
    difficulty: str
    prob_by_profile: Dict[str, float]
    spread: float               # max-min 预测正确率（区分度代理）


class MonotoneViolation(BaseModel):
    lower_level: str
    higher_level: str
    lower_mean_prob: float
    higher_mean_prob: float     # 逆序：更难档的平均正确率反而更高


class CalibrationReport(BaseModel):
    items: List[ItemPrediction]
    level_mean_prob: Dict[str, float]
    monotone_violations: List[MonotoneViolation] = Field(default_factory=list)
    low_discrimination_items: List[str] = Field(default_factory=list)
    passed: bool


def _ability(mastery: Dict[str, float], concept_tags: Sequence[str]) -> float:
    """画像对某题的能力 θ：相关概念掌握度均值映射到 [-2, 2] logit 尺度。"""
    values = [mastery[c] for c in concept_tags if c in mastery]
    m = sum(values) / len(values) if values else sum(mastery.values()) / max(1, len(mastery))
    return 4.0 * m - 2.0


def predict_prob(mastery: Dict[str, float], item: CalibrationItem) -> float:
    theta = _ability(mastery, item.concept_tags)
    b = DIFFICULTY_B.get(item.difficulty, 0.0)
    return 1.0 / (1.0 + math.exp(-DISCRIMINATION_A * (theta - b)))


def calibrate(
    items: Sequence[CalibrationItem],
    profiles_mastery: Dict[str, Dict[str, float]],
) -> CalibrationReport:
    predictions: List[ItemPrediction] = []
    for item in items:
        probs = {name: round(predict_prob(m, item), 3) for name, m in profiles_mastery.items()}
        spread = round(max(probs.values()) - min(probs.values()), 3) if probs else 0.0
        predictions.append(ItemPrediction(
            item_id=item.item_id, difficulty=item.difficulty,
            prob_by_profile=probs, spread=spread))

    # 各难度档的全画像平均预测正确率
    by_level: Dict[str, List[float]] = {}
    for pred in predictions:
        by_level.setdefault(pred.difficulty, []).extend(pred.prob_by_profile.values())
    level_mean = {lvl: round(sum(v) / len(v), 3) for lvl, v in by_level.items() if v}

    # 单调性：按 L1<L2<L3<L4 顺序，平均正确率不得随难度升档而上升
    violations: List[MonotoneViolation] = []
    ordered = [lvl for lvl in ("L1", "L2", "L3", "L4") if lvl in level_mean]
    for lower, higher in zip(ordered, ordered[1:]):
        if level_mean[higher] > level_mean[lower] + MONOTONE_TOLERANCE:
            violations.append(MonotoneViolation(
                lower_level=lower, higher_level=higher,
                lower_mean_prob=level_mean[lower], higher_mean_prob=level_mean[higher]))

    low_disc = [p.item_id for p in predictions if p.spread < MIN_SPREAD]
    return CalibrationReport(
        items=predictions,
        level_mean_prob=level_mean,
        monotone_violations=violations,
        low_discrimination_items=low_disc,
        passed=not violations,
    )
