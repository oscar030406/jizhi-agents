r"""适配率噪声区 δ：判官读数误差 + 聚类抽样误差。零 API 调用。

    python scripts/experiments/adaptation_noise_band.py

口径与结论见 `docs/05-evidence/prereg-v5-blind-transfer-20260812.md` 第 2 节。
改那份文档里任何一个数字之前先重跑本脚本。

## 为什么要两块

功效分析（`docs/05-evidence/adaptation-power-analysis-20260811.md`）的 Wilson 区间
只覆盖抽样误差，且假设 54 次判定独立同分布——而 54 例是 6 主题 × 9 画像的交叉设计，
同主题共享素材。那份文档第 1 条限制自己承认了这个欠账并指出正解是聚类自助法。
本脚本补上，另加一块判官读数误差（Wilson 完全不覆盖它）。

## 块一怎么算

用 `20260811-retest` 的 486 次调用（54 例 × 3 判官 × 3 轮，同输入同温度，
唯一变量是采样噪声）做 leave-one-round-out：抽掉一轮重算 v5 聚合，看总数抖多少。
顺带回答一个成本问题——三轮去噪比单轮多买到几个点。实测答案是零，
所以 v5 定成单轮（162 次/批）而不是三轮（486 次/批）。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics as st
from collections import Counter, defaultdict
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
DEFAULT_RETEST = ENGINE / "data" / "eval" / "adaptation_probe" / "reliability" / "20260811-retest"

Z = 1.959963984540054
#: 自助重抽次数。20000 次上区间端点已稳到小数点后一位，再加没有意义。
BOOTSTRAP_N = 20000
#: 固定种子，保证复算得到同一个区间。换种子要在文档里说明。
SEED = 20260812


def wilson(k: int, n: int, z: float = Z) -> tuple[float, float]:
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def topic_of(case_id: str) -> str:
    """b1-attention -> attention。画像编号在前，主题在后。"""
    return case_id.split("-", 1)[1]


def modal(tiers: list[str]) -> str:
    """众数。平票取字典序最小——三轮时平票即三轮全不同，取哪个都是任意的，
    固定规则是为了复算一致。"""
    c = Counter(tiers)
    top = max(c.values())
    return sorted(k for k, v in c.items() if v == top)[0]


def majority(votes: list[str]) -> str | None:
    """三判官多数决。三方全不同返回 None（v5 规则记 0）。"""
    c = Counter(votes).most_common()
    return None if len(c) == 3 else c[0][0]


def load_retest(root: Path) -> tuple[dict, dict]:
    """calls.jsonl -> {case: {judge: {round: tier}}}, {case: target}"""
    calls = root / "calls.jsonl"
    data: dict[str, dict[str, dict[int, str]]] = defaultdict(lambda: defaultdict(dict))
    target: dict[str, str] = {}
    for line in calls.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("error") or not r.get("tier"):
            continue
        data[r["caseId"]][r["judge"]][r["round"]] = r["tier"]
        target[r["caseId"]] = r["target"]
    return data, target


def v5_hits(data: dict, target: dict, rounds: list[int]) -> tuple[int, dict[str, int]]:
    """按 v5 规则（三判官多数决）算命中数；rounds 指定用哪几轮去噪。"""
    per_case: dict[str, int] = {}
    for case_id in sorted(data):
        votes = []
        for judge in "ABC":
            seen = [data[case_id][judge][r] for r in rounds if r in data[case_id][judge]]
            if seen:
                votes.append(modal(seen))
        ok = len(votes) == 3 and majority(votes) == target[case_id]
        per_case[case_id] = int(ok)
    return sum(per_case.values()), per_case


def cluster_ci(hits: dict[str, int], seed: int = SEED, n_boot: int = BOOTSTRAP_N):
    """按主题重抽的自助区间。抽的是**主题**不是用例——同主题的 9 组共享素材，
    按用例重抽会假装它们独立，把区间算窄。

    盲投泛化协议里原领域与新领域都用这一个函数，两边口径才对得上。
    """
    by_topic: dict[str, list[int]] = defaultdict(list)
    for case_id, hit in hits.items():
        by_topic[topic_of(case_id)].append(hit)
    topics = sorted(by_topic)
    rng = random.Random(seed)
    boot = []
    for _ in range(n_boot):
        picked = [rng.choice(topics) for _ in topics]
        vals = [x for t in picked for x in by_topic[t]]
        boot.append(sum(vals) / len(vals))
    boot.sort()
    return boot[int(0.025 * n_boot)], boot[int(0.975 * n_boot)], by_topic


def report_run(run_dir: Path) -> int:
    """对一个已跑完的 run 报聚类区间。`--run` 走这条。"""
    rows = [
        json.loads(line)
        for line in (run_dir / "verdicts.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    hits = {r["caseId"]: int(r.get("hit", 0)) for r in rows}
    n, k = len(hits), sum(hits.values())
    print(f"run {run_dir.name}｜{k}/{n} = {k / n:.1%}")
    lo_c, hi_c, by_topic = cluster_ci(hits)
    lo_w, hi_w = wilson(k, n)
    print("  逐主题：" + "  ".join(f"{t} {sum(v)}/{len(v)}" for t, v in sorted(by_topic.items())))
    print(f"  聚类自助 95% CI [{lo_c:.1%}, {hi_c:.1%}]  宽 {(hi_c - lo_c) * 100:.1f} pp")
    print(f"  Wilson   95% CI [{lo_w:.1%}, {hi_w:.1%}]  宽 {(hi_w - lo_w) * 100:.1f} pp")
    print("  盲投协议用聚类区间，不用 Wilson——54 例不是独立同分布的伯努利试验。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--retest", type=Path, default=DEFAULT_RETEST)
    ap.add_argument("--run", type=Path, help="对一个已跑完的 run 报聚类区间（盲投协议的基线口径）")
    ap.add_argument("--json", type=Path, help="把结果落成 json")
    args = ap.parse_args()

    if args.run:
        return report_run(args.run)

    data, target = load_retest(args.retest)
    n = len(data)
    print(f"用例 {n}，判官 {len({j for c in data.values() for j in c})}，轮次 3")

    # ---- 块一：判官读数误差 ----
    print("\n=== 块一 判官读数误差（leave-one-round-out） ===")
    readings: dict[str, int] = {}
    full, per_case = v5_hits(data, target, [1, 2, 3])
    readings["三轮取众数"] = full
    for drop in (1, 2, 3):
        readings[f"抽掉第{drop}轮"] = v5_hits(data, target, [r for r in (1, 2, 3) if r != drop])[0]
    for r in (1, 2, 3):
        readings[f"只用第{r}轮"] = v5_hits(data, target, [r])[0]
    for name, hits in readings.items():
        print(f"  {name:<14} {hits}/{n} = {hits / n:.1%}")

    denoised = [readings[k] for k in readings if "轮取众数" in k or "抽掉" in k]
    single = [readings[k] for k in readings if "只用" in k]
    range_denoised = (max(denoised) - min(denoised)) / n * 100
    range_single = (max(single) - min(single)) / n * 100
    print(f"\n  去噪后极差 {range_denoised:.1f} pp ｜ 单轮无去噪极差 {range_single:.1f} pp")
    if range_single <= range_denoised:
        print("  -> 三判官多数决本身已压掉采样噪声，三轮去噪对总数零增益；v5 用单轮")
    half_judge = range_denoised / 2

    # ---- 块二：聚类抽样误差 ----
    print("\n=== 块二 聚类抽样误差（按主题重抽） ===")
    by_topic: dict[str, list[int]] = defaultdict(list)
    for case_id, hit in per_case.items():
        by_topic[topic_of(case_id)].append(hit)
    topics = sorted(by_topic)
    print("  逐主题命中：" + "  ".join(f"{t} {sum(v)}/{len(v)}" for t, v in sorted(by_topic.items())))

    rng = random.Random(SEED)
    boot = []
    for _ in range(BOOTSTRAP_N):
        picked = [rng.choice(topics) for _ in topics]
        vals = [x for t in picked for x in by_topic[t]]
        boot.append(sum(vals) / len(vals))
    boot.sort()
    lo_c, hi_c = boot[int(0.025 * BOOTSTRAP_N)], boot[int(0.975 * BOOTSTRAP_N)]
    lo_w, hi_w = wilson(full, n)
    print(f"  聚类自助 95% CI [{lo_c:.1%}, {hi_c:.1%}]  宽 {(hi_c - lo_c) * 100:.1f} pp")
    print(f"  Wilson   95% CI [{lo_w:.1%}, {hi_w:.1%}]  宽 {(hi_w - lo_w) * 100:.1f} pp")
    print(f"  聚类比 Wilson 宽 {(hi_c - lo_c) * 100 - (hi_w - lo_w) * 100:+.1f} pp"
          "（方向与功效分析限制 1 的预判一致）")
    half_cluster = (hi_c - lo_c) / 2 * 100

    # ---- 合成 ----
    print("\n=== 合成 δ ===")
    d_rss = math.hypot(half_cluster, half_judge)
    d_sum = half_cluster + half_judge
    print(f"  抽样半宽 {half_cluster:.1f} pp ｜ 判官读数半极差 {half_judge:.1f} pp")
    print(f"  平方和开方 ±{d_rss:.1f} pp ｜ 直接相加（保守，采用）±{d_sum:.1f} pp")
    print(f"  抽样是判官的 {half_cluster / half_judge:.1f} 倍 -> 收窄 δ 只能加主题，换判官无用")

    if args.json:
        args.json.write_text(json.dumps({
            "n_cases": n,
            "readings": readings,
            "range_denoised_pp": round(range_denoised, 2),
            "range_single_pp": round(range_single, 2),
            "per_topic": {t: [sum(v), len(v)] for t, v in sorted(by_topic.items())},
            "cluster_ci": [round(lo_c, 4), round(hi_c, 4)],
            "wilson_ci": [round(lo_w, 4), round(hi_w, 4)],
            "delta_rss_pp": round(d_rss, 2),
            "delta_sum_pp": round(d_sum, 2),
            "bootstrap_n": BOOTSTRAP_N,
            "seed": SEED,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n已落盘 {args.json}")
    return 0


def _selftest() -> None:
    assert abs(wilson(44, 54)[0] - 0.6916) < 1e-3
    assert modal(["a", "b", "a"]) == "a"
    assert modal(["a", "b", "c"]) == "a"          # 平票取字典序最小
    assert majority(["a", "a", "b"]) == "a"
    assert majority(["a", "b", "c"]) is None      # 三方全不同记 0
    assert topic_of("b1-softmax-temp") == "softmax-temp"


if __name__ == "__main__":
    _selftest()
    raise SystemExit(main())
