"""时间预算够不够：确定性判定，判据从我们自己出过的课量出来。

设计稿 §5.4 最后一条：**系统必须能说「做不到」**——时间预算要求的压缩比低于下限时，
正确行为是拒绝或改目标，不是硬压（`docs/03-design/blackbox-architecture-20260811.md:455`）。
同一节还写死了两件不许做的事：不许从历史通过率回归出下限（同文 434-437 行，
Lee et al. 2026 / arXiv:2605.01690 的复核证明我们这个数据量回归出来的是噪声），
以及压缩下限本身是 `f(知识点, 学习者画像)`（同文 418 行），不是一个常数。

所以我们不发明学时公式，只做一次算术：

    需要的最少小时 = 要补的知识点数 × 一个知识点的实测体量

右边那个乘数不是拍的，是量的——`data/course_volume_stats.json`，由
`scripts/measure_course_volume.py` 从 `apps/classroom/data/classrooms/*.json`（23 门课）
实测得到；字数换分钟的速率有出处（Brysbaert 2019, JML 109:104047，中文默读 260 wpm
× 该文声明的 1.5 字/词 = 390 字/分钟）。

**三档的分界线也是实测分位数，不是阈值**：

| 档 | 判据 | 读法 |
|---|---|---|
| ok | 预算 ≥ 知识点数 × 中位课时长 | 按我们平时出的体量排得下 |
| tight | 预算 ≥ 知识点数 × 最小课时长 | 只有每个知识点都压到我们出过的最小体量才排得下 |
| infeasible | 预算 < 知识点数 × 最小课时长 | 比我们出过的最小体量还紧，做不到 |

这三条等价于 §5.4 的原话「时间预算要求的压缩比低于下限」：预算 ÷ 知识点数 = 每个知识点
分到多少分钟，拿它跟我们实际出过的单课体量比，比不过就是压过头了。

**判词的适用范围写在这里，不要在别处放大**：分钟数只算「读」，不算做题、不算动手、
不算回看，所以这是下限判定——判成 infeasible 的一定做不到，判成 ok 只说明「读得完」，
不等于「学得会」。

ponytail: 上限就在这——我们没有真人学习耗时数据，所以没有「读 → 学」的乘数，
也不许拍一个（同节 434-437 行禁的就是这类自造系数）。要让 ok 这一档也有说服力，
得先按 §5.4 的 L2 配对标定收几十人的真实耗时，把乘数量出来再换进这里。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from backend.schemas.learner import Feasibility

STATS_PATH = Path(__file__).resolve().parents[2] / "data" / "course_volume_stats.json"


@lru_cache(maxsize=1)
def load_volume_stats(path: str | None = None) -> dict[str, Any] | None:
    """读实测快照。读不到就返回 None——我们宁可不判，也不拿编的数去判。"""
    target = Path(path) if path else STATS_PATH
    try:
        stats = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    minutes = stats.get("read_minutes") or {}
    if not minutes.get("median") or not minutes.get("min"):
        return None
    return stats


def assess_feasibility(
    time_budget_hours: int | None,
    concept_count: int,
    *,
    stats: dict[str, Any] | None = None,
) -> Feasibility | None:
    """预算 × 知识点数 → 可行性。缺预算、缺快照、或没有要补的知识点时返回 None。

    返回 None 是「不判」，不是「可行」。调用方不要把 None 当放行信号展示。
    """
    if not time_budget_hours or concept_count <= 0:
        return None
    stats = stats or load_volume_stats()
    if not stats:
        return None

    minutes = stats["read_minutes"]
    typical_hours = round(concept_count * minutes["median"] / 60, 1)
    fastest_hours = round(concept_count * minutes["min"] / 60, 1)
    basis = (
        f"{stats.get('course_count')} 门实测课程（{stats.get('source_dir')}，"
        f"量于 {stats.get('measured_on')}）：单课可读体量中位 {minutes['median']} 分钟、"
        f"最小 {minutes['min']} 分钟；{stats.get('chars_per_minute_source')}。"
        "只算读不算练，因此是下限。"
    )

    # 预算摊到每个知识点上是多少分钟——§5.4 说的「时间预算要求的压缩比」就是这个数。
    per_concept = round(time_budget_hours * 60 / concept_count, 1)

    if time_budget_hours >= typical_hours:
        verdict = "ok"
        reason = (
            f"{concept_count} 个知识点按我们平时的课程体量约需 {typical_hours} 小时（只算读），"
            f"预算 {time_budget_hours} 小时排得下。"
        )
        suggested = None
    elif time_budget_hours >= fastest_hours:
        verdict = "tight"
        reason = (
            f"{concept_count} 个知识点按平时体量要 {typical_hours} 小时，预算只有 "
            f"{time_budget_hours} 小时——每个知识点摊到 {per_concept} 分钟，"
            f"低于我们的中位体量 {minutes['median']} 分钟，只有压到出过的最小体量"
            f"（{minutes['min']} 分钟）才排得下，讲解会明显变薄。"
        )
        suggested = f"把目标收窄到 {_fits(time_budget_hours, minutes['median'])} 个知识点，其余留到下一轮。"
    else:
        verdict = "infeasible"
        fits = _fits(time_budget_hours, minutes["median"])
        reason = (
            f"{concept_count} 个知识点摊下来每个只有 {per_concept} 分钟，"
            f"比我们出过的最小一门课（{minutes['min']} 分钟）还短：全部压到那个体量也要 "
            f"{fastest_hours} 小时，超过预算 {time_budget_hours} 小时。"
            "这个目标在这个时间里做不到。"
        )
        suggested = (
            f"把目标收窄到 {fits} 个知识点（预算内按正常体量能讲透的量），其余排进下一期。"
            if fits >= 1
            else "这点时间连一个知识点都讲不完整，先加时间或换一个更小的目标。"
        )

    return Feasibility(
        verdict=verdict,
        concept_count=concept_count,
        required_hours_typical=typical_hours,
        required_hours_floor=fastest_hours,
        reason=reason,
        suggested_goal=suggested,
        basis=basis,
    )


def _fits(time_budget_hours: int, median_minutes: float) -> int:
    """预算内按中位体量能讲透几个知识点。"""
    return int(time_budget_hours * 60 // median_minutes)
