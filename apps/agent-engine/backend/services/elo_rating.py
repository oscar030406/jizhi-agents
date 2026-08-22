"""Elo 难度评级：冷启动场景下的练习难度自适应。

为什么用 Elo 而不是 BKT/IRT：本系统上线时没有任何历史作答数据，BKT/IRT 都需要
离线预标定参数，冷启动直接被排除；Elo 用默认参数即可上线，每次作答在线更新，
且效果与 IRT 相当（Pelánek 2016, "Applications of the Elo rating system in
adaptive educational systems", Computers & Education；Duolingo Birdbrain 为同族做法）。
学习者初始分不从固定值起步，而是由画像五维映射（协变量初始化能显著缩短收敛期，
Park et al. 2019, Behavior Research Methods）。

全部为纯函数、无状态，输入输出均可 JSON 序列化，由调用方负责持久化 rating。
"""

import math

DEFAULT_RATING = 1200.0
K_LEARNER = 32.0  # 学习者作答样本少，步长大让分数快速收敛
K_ITEM = 16.0     # 题目被很多人做，步长小保持稳定

# 难度档 → 初始 rating，同时是 rating_to_difficulty 的反映射基准
_DIFFICULTY_RATINGS = {"L1": 1000.0, "L2": 1150.0, "L3": 1300.0, "L4": 1450.0}


def initial_learner_rating(levels: dict[str, int]) -> float:
    """画像 5 维 0-4 档 → 初始 rating。均值 0 档=1000，每档 +100，封顶 1600。"""
    if not levels:
        return DEFAULT_RATING
    # 越界档位夹回 0-4，画像来自 LLM 抽取，不可全信
    mean = sum(max(0, min(4, v)) for v in levels.values()) / len(levels)
    return min(1600.0, 1000.0 + mean * 100.0)


def initial_item_rating(difficulty: str, bloom: str = "") -> float:
    """题目元数据 → 初始 rating。未知难度回 DEFAULT_RATING，不加 bloom 修正。"""
    base = _DIFFICULTY_RATINGS.get(difficulty)
    if base is None:
        return DEFAULT_RATING
    # 应用/分析类认知层级比同档记忆题实际更难，上调半档
    if "应用" in bloom or "分析" in bloom:
        base += 50.0
    return base


def expected_score(learner: float, item: float) -> float:
    """标准 Elo 期望胜率：学习者答对该题的预测概率。"""
    return 1.0 / (1.0 + 10.0 ** ((item - learner) / 400.0))


def update(learner: float, item: float, correct: bool) -> tuple[float, float]:
    """一次作答后的 (新学习者分, 新题目分)。零和方向、K 值不对称。"""
    e = expected_score(learner, item)
    s = 1.0 if correct else 0.0
    # 学习者答对涨分，题目被答对说明没那么难、降分；答错反向
    return learner + K_LEARNER * (s - e), item - K_ITEM * (s - e)


def pick_target_rating(learner: float, target_success: float = 0.75) -> float:
    """反解 expected_score(learner, item)=target 的 item rating。

    默认 75% 命中率：文献甜区 70-80%，太高学不到东西，太低打击信心。
    """
    # 夹到开区间，避免 log10(0) / 除零
    t = max(0.01, min(0.99, target_success))
    return learner + 400.0 * math.log10(1.0 / t - 1.0)


def rating_to_difficulty(rating: float) -> str:
    """rating 反映射回 L1-L4 档，阈值即各档初始 rating，保证往返一致。"""
    if rating < _DIFFICULTY_RATINGS["L2"]:
        return "L1"
    if rating < _DIFFICULTY_RATINGS["L3"]:
        return "L2"
    if rating < _DIFFICULTY_RATINGS["L4"]:
        return "L3"
    return "L4"
