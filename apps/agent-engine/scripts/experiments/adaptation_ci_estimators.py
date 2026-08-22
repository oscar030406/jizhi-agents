r"""适配准确率 92/108 的区间下界对照表：换任何一种估计量，下界都过不了 85%。

    python scripts/experiments/adaptation_ci_estimators.py
    python scripts/experiments/adaptation_ci_estimators.py --json

## 这张表是干什么的

我们的适配准确率是 92/108，点估计 85.2%，目标线是 ≥85%。点估计压线过了，
主口径（按主题聚类的 bootstrap 百分位区间）的下界没过。

于是有一个显而易见的诱惑：换个区间算法，把下界抬到 85% 以上。
**这张表存在的目的就是把这条路堵死**，不是为了从里面挑一个好看的数字。
我们把能想到的九种二项区间、精确检验、聚类修正、扩样本全都算一遍，
证明「下界过不了线」不是主口径挑出来的结论，而是这个样本量下的普遍结果。

所以读这张表的正确方式是：看有没有哪一行的下界 ≥ 85%。
如果哪天真有一行过了，那说明的是那一行的假设不成立（见下面每块的说明），
不是说明我们过线了。

## 六块内容

1. 九种二项区间的下界（双侧 95% 与单侧 95% 各一列）。
   这些方法**全部假设 108 次判定独立同分布**，而我们是 12 主题 × 9 画像的交叉设计，
   同主题共享素材。也就是说这一块给出的是**下界的乐观上限**——真实下界只会更低。
2. 精确二项单侧检验 P(X >= 92 | n=108, p=0.85)。回答「如果真值恰好在线上，
   看到 92 或更好有多常见」。
3. 同一个 n=108 下，各方法要让下界过线分别需要 x 至少多少。差几个用例，一目了然。
4. 从判官逐条数据实算 ICC / DEFF / n_eff（单因素随机效应 ANOVA，主题当簇）。
   量化第 1 块那个「独立同分布」假设有多离谱。
5. 少簇修正：12 个主题的簇均值走 CRVE-t 区间，t 自由度 = 簇数 − 1 = 11。
   依据 Cameron/Gelbach/Miller (2008), REStat 90(3):414-427——簇数在 5~30 这一档时，
   用正态近似会过度拒绝，要用 t(G−1)。注意这是**另起一个算法**（用簇均值做 t 区间），
   不是把 `adaptation_noise_band.cluster_ci` 里的 z 换成 t：那个函数是百分位法 pairs
   bootstrap，里面根本没有 z 也没有标准误，"换成 t" 这个操作在那里没有定义。
6. 扩样本无效的演示：把每主题的样本按比例复制到 n=216/324/540/1080，重跑聚类 bootstrap。
   区间纹丝不动——聚类 bootstrap 的精度上限由**簇数**决定，不由用例数决定。

## 数据来源与复算

判官逐条投票取自 `data/eval/adaptation_probe/runs/20260813-001359/verdicts.jsonl`
（三判官全量独立盲评，2-of-3 多数决，见同目录 summary.json）。
聚类 bootstrap 直接复用 `adaptation_noise_band.cluster_ci` 的抽样规则和种子，
两边口径必须对得上，所以本脚本的自检里断言了两者在双侧 95% 上逐位相等。
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import optimize, stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
from adaptation_noise_band import BOOTSTRAP_N, SEED, cluster_ci, topic_of  # noqa: E402

ENGINE = Path(__file__).resolve().parents[2]
DEFAULT_RUN = ENGINE / "data" / "eval" / "adaptation_probe" / "runs" / "20260813-001359"
DEFAULT_JSON = ENGINE / "data" / "eval" / "adaptation_ci_estimators.json"

#: 目标线。产品口径写的是「适配准确率 ≥85%」。
TARGET = 0.85
#: 显著性水平。双侧时每尾 α/2，单侧时 α 全部压在下尾。
ALPHA = 0.05
#: 扩样本演示的倍数：n=108 → 216 / 324 / 540 / 1080。
SCALE_FACTORS = (2, 3, 5, 10)


# ---------------------------------------------------------------- 九种二项区间

def _z(alpha: float, two_sided: bool) -> float:
    """双侧取 z_{1-α/2}，单侧取 z_{1-α}。"""
    return stats.norm.ppf(1 - (alpha / 2 if two_sided else alpha))


def wald(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    p = x / n
    h = _z(alpha, two_sided) * math.sqrt(p * (1 - p) / n)
    return max(0.0, p - h), min(1.0, p + h)


def wilson(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    z = _z(alpha, two_sided)
    p = x / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d


def jeffreys(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """Beta(1/2, 1/2) 无信息先验的后验分位。x=0 或 x=n 时端点按惯例夹到 0/1。"""
    a, b = alpha / 2 if two_sided else alpha, alpha / 2 if two_sided else alpha
    lo = 0.0 if x == 0 else float(stats.beta.ppf(a, x + 0.5, n - x + 0.5))
    hi = 1.0 if x == n else float(stats.beta.ppf(1 - b, x + 0.5, n - x + 0.5))
    return lo, hi


def clopper_pearson(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """精确法：下界是使 P(X>=x|p)=α 的 p，等价于 Beta(x, n-x+1) 的 α 分位。"""
    a = alpha / 2 if two_sided else alpha
    lo = 0.0 if x == 0 else float(stats.beta.ppf(a, x, n - x + 1))
    hi = 1.0 if x == n else float(stats.beta.ppf(1 - a, x + 1, n - x))
    return lo, hi


def agresti_coull(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """加 z²/2 次成功、z²/2 次失败后再做 Wald。"""
    z = _z(alpha, two_sided)
    nt = n + z * z
    pt = (x + z * z / 2) / nt
    h = z * math.sqrt(pt * (1 - pt) / nt)
    return max(0.0, pt - h), min(1.0, pt + h)


def logit_ci(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """在 logit 尺度上做 Wald，再变换回来。x=0 或 x=n 时 SE 发散，返回 (0,1)。"""
    if x == 0 or x == n:
        return 0.0, 1.0
    z = _z(alpha, two_sided)
    lam = math.log(x / (n - x))
    se = math.sqrt(1 / x + 1 / (n - x))
    expit = lambda t: 1 / (1 + math.exp(-t))  # noqa: E731
    return expit(lam - z * se), expit(lam + z * se)


def arcsine(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """方差稳定变换 φ = arcsin(√p)，在 φ 尺度上 SE = 1/(2√n)。不做 Anscombe 修正。"""
    z = _z(alpha, two_sided)
    phi = math.asin(math.sqrt(x / n))
    h = z / (2 * math.sqrt(n))
    clamp = lambda t: min(math.pi / 2, max(0.0, t))  # noqa: E731
    return math.sin(clamp(phi - h)) ** 2, math.sin(clamp(phi + h)) ** 2


def _loglik(p: float, x: int, n: int) -> float:
    if p <= 0:
        return 0.0 if x == 0 else -math.inf
    if p >= 1:
        return 0.0 if x == n else -math.inf
    return x * math.log(p) + (n - x) * math.log(1 - p)


def likelihood_ratio(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """似然比（profile likelihood）区间：2[l(p̂)−l(p)] = χ²_1 的临界值。
    双侧用 χ²_1(1−α)，单侧下界用 χ²_1(1−2α)——后者等于 z_{1−α}²。"""
    crit = stats.chi2.ppf(1 - alpha if two_sided else 1 - 2 * alpha, 1)
    p_hat = x / n
    top = _loglik(p_hat, x, n)
    g = lambda p: 2 * (top - _loglik(p, x, n)) - crit  # noqa: E731
    lo = 0.0 if x == 0 else float(optimize.brentq(g, 1e-12, p_hat))
    hi = 1.0 if x == n else float(optimize.brentq(g, p_hat, 1 - 1e-12))
    return lo, hi


def bayes_uniform(x: int, n: int, alpha: float, two_sided: bool) -> tuple[float, float]:
    """Beta(1,1) 均匀先验 → 后验 Beta(x+1, n−x+1) 的等尾可信区间。
    注意这是可信区间不是置信区间，写进材料时别混着说。"""
    a = alpha / 2 if two_sided else alpha
    return (float(stats.beta.ppf(a, x + 1, n - x + 1)),
            float(stats.beta.ppf(1 - a, x + 1, n - x + 1)))


METHODS = [
    ("Wald（正态近似）", wald),
    ("Wilson（score）", wilson),
    ("Jeffreys", jeffreys),
    ("Clopper-Pearson（精确）", clopper_pearson),
    ("Agresti-Coull", agresti_coull),
    ("logit（delta 法）", logit_ci),
    ("arcsine（方差稳定）", arcsine),
    ("似然比（profile）", likelihood_ratio),
    ("Bayes Beta(1,1) 可信区间", bayes_uniform),
]


# -------------------------------------------------------------------- 聚类部分

def cluster_boot(by_topic: dict[str, list[int]], seed: int = SEED,
                 n_boot: int = BOOTSTRAP_N) -> list[float]:
    """按主题重抽的 bootstrap 分布（排好序）。抽样规则与种子跟
    `adaptation_noise_band.cluster_ci` 完全一致——那个函数只吐 2.5/97.5 两个分位，
    我们还要 5% 分位做单侧下界，所以把整条分布留下来。自检里断言两者双侧相等。"""
    topics = sorted(by_topic)
    rng = random.Random(seed)
    boot = []
    for _ in range(n_boot):
        picked = [rng.choice(topics) for _ in topics]
        vals = [x for t in picked for x in by_topic[t]]
        boot.append(sum(vals) / len(vals))
    boot.sort()
    return boot


def icc_oneway(by_topic: dict[str, list[int]]) -> dict:
    """单因素随机效应 ANOVA 的 ICC，主题当簇。簇不等大时 m 用 Donner 的调和式平均。

    MSB = Σ m_i(ȳ_i − ȳ)² / (k−1)，MSW = ΣΣ(y_ij − ȳ_i)² / (N−k)
    ICC = (MSB − MSW) / (MSB + (m₀−1)MSW)，DEFF = 1 + (m₀−1)ICC，n_eff = N/DEFF
    """
    groups = [np.asarray(v, dtype=float) for _, v in sorted(by_topic.items())]
    k = len(groups)
    sizes = np.array([g.size for g in groups], dtype=float)
    N = sizes.sum()
    grand = float(np.concatenate(groups).mean())
    msb = float(sum(g.size * (g.mean() - grand) ** 2 for g in groups) / (k - 1))
    msw = float(sum(((g - g.mean()) ** 2).sum() for g in groups) / (N - k))
    m0 = float((N - (sizes ** 2).sum() / N) / (k - 1))  # 簇等大时 m0 == 簇大小
    denom = msb + (m0 - 1) * msw
    icc_raw = (msb - msw) / denom if denom > 0 else 0.0
    # MSB < MSW 时 ICC 估计值为负——方差分量估计的已知现象，没有对应的现实解释。
    # 报原值，但算 DEFF 时截到 0（否则 DEFF 可能为 0 甚至为负，n_eff 无意义）。
    icc = max(0.0, icc_raw)
    deff = 1 + (m0 - 1) * icc
    return {"k": k, "N": int(N), "m0": m0, "MSB": msb, "MSW": msw,
            "ICC": icc, "ICC_raw": icc_raw, "DEFF": deff, "n_eff": N / deff}


def crve_t(by_topic: dict[str, list[int]], alpha: float, two_sided: bool) -> dict:
    """簇均值上的 t 区间。等大簇时它就是 CR1 聚类稳健标准误的解析解，
    自由度 G−1 = 11。Cameron/Gelbach/Miller (2008) REStat 90(3):414-427：
    簇数 5~30 这一档用正态临界值会过度拒绝，要用 t(G−1)。"""
    means = np.array([np.mean(v) for _, v in sorted(by_topic.items())], dtype=float)
    g = means.size
    center = float(means.mean())
    se = float(means.std(ddof=1) / math.sqrt(g))
    q = 1 - (alpha / 2 if two_sided else alpha)
    t_crit = float(stats.t.ppf(q, g - 1))
    z_crit = float(stats.norm.ppf(q))
    return {"G": g, "center": center, "se": se, "df": g - 1,
            "t_crit": t_crit, "z_crit": z_crit,
            "t_lo": center - t_crit * se, "t_hi": center + t_crit * se,
            "z_lo": center - z_crit * se, "z_hi": center + z_crit * se}


# ------------------------------------------------------------------------ 主流程

def load_hits(run_dir: Path) -> dict[str, int]:
    rows = [json.loads(l) for l in (run_dir / "verdicts.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    return {r["caseId"]: int(r.get("hit", 0)) for r in rows}


def group_by_topic(hits: dict[str, int]) -> dict[str, list[int]]:
    by: dict[str, list[int]] = defaultdict(list)
    for case_id, hit in hits.items():
        by[topic_of(case_id)].append(hit)
    return dict(by)


def min_x_to_pass(fn, n: int, alpha: float, two_sided: bool, target: float) -> int | None:
    """扫一遍 x=0..n，找让下界 ≥ target 的最小 x。找不到返回 None。"""
    for x in range(n + 1):
        if fn(x, n, alpha, two_sided)[0] >= target:
            return x
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="适配准确率下界对照表（用途是证明过不了线）")
    ap.add_argument("--run", type=Path, default=DEFAULT_RUN)
    ap.add_argument("--json", type=Path, nargs="?", const=DEFAULT_JSON,
                    help=f"落盘路径，不给值时用 {DEFAULT_JSON.relative_to(ENGINE)}")
    args = ap.parse_args()

    hits = load_hits(args.run)
    by_topic = group_by_topic(hits)
    n, x = len(hits), sum(hits.values())
    p_hat = x / n
    out: dict = {"run": args.run.name, "n": n, "x": x, "p_hat": p_hat,
                 "target": TARGET, "alpha": ALPHA, "seed": SEED, "bootstrap_n": BOOTSTRAP_N}

    print(f"样本 {args.run.name}：{x}/{n} = {p_hat:.4%}，目标线 {TARGET:.0%}")
    print(f"簇（主题）{len(by_topic)} 个：" + "  ".join(
        f"{t} {sum(v)}/{len(v)}" for t, v in sorted(by_topic.items())))
    print("\n本表的用途是证明「换估计量抬下界」这条路走不通，不是从中挑一个好看的数字。")

    # ---- 1. 九种二项区间 ----
    print(f"\n=== 1. 二项区间下界（全部假设 {n} 次判定独立同分布，见第 4 块）===")
    print(f"{'方法':<26}{'双侧95%下界':>13}{'双侧95%上界':>13}{'单侧95%下界':>13}   过线?")
    print(f"{'':<26}{'α=.05 每尾.025':>13}{'α=.05 每尾.025':>13}{'α=.05 全在下尾':>13}")
    binom_rows = {}
    for name, fn in METHODS:
        lo2, hi2 = fn(x, n, ALPHA, True)
        lo1, _ = fn(x, n, ALPHA, False)
        flag = "过" if lo1 >= TARGET else "不过"
        print(f"{name:<26}{lo2:>13.4%}{hi2:>13.4%}{lo1:>13.4%}   {flag}")
        binom_rows[name] = {"two_sided_lo": lo2, "two_sided_hi": hi2, "one_sided_lo": lo1,
                            "one_sided_passes": bool(lo1 >= TARGET)}
    out["binomial_intervals"] = binom_rows
    best = max(binom_rows.values(), key=lambda r: r["one_sided_lo"])
    best_name = [k for k, v in binom_rows.items() if v is best][0]
    print(f"\n  最宽松的一行是「{best_name}」的单侧下界 {best['one_sided_lo']:.4%}，"
          f"距 {TARGET:.0%} 还差 {(TARGET - best['one_sided_lo']) * 100:.2f} pp。")

    # ---- 2. 精确二项单侧检验 ----
    print(f"\n=== 2. 精确二项单侧检验（α=.05，单侧，H0: p={TARGET:.0%}）===")
    p_greater = float(stats.binom.sf(x - 1, n, TARGET))
    p_less = float(stats.binom.cdf(x, n, TARGET))
    print(f"  P(X >= {x} | n={n}, p={TARGET}) = {p_greater:.4f}")
    print(f"  P(X <= {x} | n={n}, p={TARGET}) = {p_less:.4f}")
    print(f"  在 p={TARGET:.0%} 下看到 {x} 或更好是 {p_greater:.1%} 的常规事件，"
          "拒绝不了「真值就在线上」；反过来也拒绝不了「真值在线下」。")
    out["exact_binomial_test"] = {"H0_p": TARGET, "P_X_ge_x": p_greater, "P_X_le_x": p_less}

    # ---- 3. 要过线得中几个 ----
    print(f"\n=== 3. n={n} 固定，各方法要让下界 ≥ {TARGET:.0%} 需要 x 至少多少 ===")
    print(f"{'方法':<26}{'双侧95%':>10}{'单侧95%':>10}   还差几个（单侧）")
    need_rows = {}
    for name, fn in METHODS:
        x2 = min_x_to_pass(fn, n, ALPHA, True, TARGET)
        x1 = min_x_to_pass(fn, n, ALPHA, False, TARGET)
        gap = "—" if x1 is None else f"{x1 - x:+d}"
        print(f"{name:<26}{'不可能' if x2 is None else x2:>10}"
              f"{'不可能' if x1 is None else x1:>10}   {gap}")
        need_rows[name] = {"two_sided": x2, "one_sided": x1,
                           "one_sided_gap_from_x": None if x1 is None else x1 - x}
    out["min_x_to_pass"] = need_rows

    # ---- 4. ICC / DEFF / n_eff ----
    print("\n=== 4. 判官逐条数据实算 ICC / DEFF / n_eff（单因素随机效应 ANOVA，主题当簇）===")
    a = icc_oneway(by_topic)
    print(f"  簇数 k={a['k']}，N={a['N']}，平均簇大小 m0={a['m0']:.1f}")
    print(f"  MSB={a['MSB']:.6f}  MSW={a['MSW']:.6f}")
    print(f"  ICC={a['ICC']:.4f}   DEFF=1+(m0−1)·ICC={a['DEFF']:.3f}   n_eff=N/DEFF={a['n_eff']:.1f}")
    x_eff = p_hat * a["n_eff"]
    lo_eff = wilson(round(x_eff), round(a["n_eff"]), ALPHA, False)[0]
    print(f"  即：{a['N']} 条判定携带的信息量约等于 {a['n_eff']:.0f} 条独立判定。")
    print(f"  把 n 换成 n_eff（x≈{x_eff:.1f}）重算 Wilson 单侧95%下界：{lo_eff:.4%}"
          f"（α=.05 单侧），比第 1 块低了 {(binom_rows['Wilson（score）']['one_sided_lo'] - lo_eff) * 100:.2f} pp。")
    out["icc"] = a | {"wilson_one_sided_lo_on_n_eff": lo_eff}

    # ---- 5. 少簇修正 CRVE-t ----
    print("\n=== 5. 少簇修正：簇均值 CRVE-t 区间（Cameron/Gelbach/Miller 2008, REStat 90(3):414-427）===")
    c2 = crve_t(by_topic, ALPHA, True)
    c1 = crve_t(by_topic, ALPHA, False)
    print(f"  G={c2['G']} 簇，df=G−1={c2['df']}，簇均值中心 {c2['center']:.4%}，簇间 SE {c2['se']:.4%}")
    print(f"  双侧95%（α=.05，每尾.025）t({c2['df']})={c2['t_crit']:.3f}："
          f"[{c2['t_lo']:.4%}, {c2['t_hi']:.4%}]")
    print(f"  单侧95%（α=.05，全在下尾）t({c1['df']})={c1['t_crit']:.3f}：下界 {c1['t_lo']:.4%}")
    print(f"  对照：同一个 SE 换成正态临界值 z={c2['z_crit']:.3f} 时双侧下界 {c2['z_lo']:.4%}，"
          f"比 t 高 {(c2['z_lo'] - c2['t_lo']) * 100:.2f} pp——这就是 5~30 簇下过度拒绝的来源。")
    print("  这是另起的一个算法（簇均值 t 区间），不是把 cluster_ci 里的 z 换成 t："
          "那个函数是百分位法 pairs bootstrap，里面没有 z 也没有标准误。")
    out["crve_t"] = {"two_sided": c2, "one_sided": c1}

    # ---- 主口径：聚类 bootstrap ----
    boot = cluster_boot(by_topic)
    b_lo2, b_hi2 = boot[int(0.025 * BOOTSTRAP_N)], boot[int(0.975 * BOOTSTRAP_N)]
    b_lo1 = boot[int(ALPHA * BOOTSTRAP_N)]
    print(f"\n=== 主口径对照：按主题聚类的 pairs bootstrap 百分位区间（{BOOTSTRAP_N} 次，seed={SEED}）===")
    print(f"  双侧95%（α=.05，每尾.025）[{b_lo2:.4%}, {b_hi2:.4%}]")
    print(f"  单侧95%（α=.05，全在下尾）下界 {b_lo1:.4%}")
    out["cluster_bootstrap"] = {"two_sided": [b_lo2, b_hi2], "one_sided_lo": b_lo1}

    # ---- 6. 扩样本无效 ----
    print("\n=== 6. 扩样本演示：每主题样本按比例复制，重跑聚类 bootstrap ===")
    scale_rows = []
    for f in (1,) + SCALE_FACTORS:
        scaled = {t: v * f for t, v in by_topic.items()}
        bt = cluster_boot(scaled)
        lo2, hi2 = bt[int(0.025 * BOOTSTRAP_N)], bt[int(0.975 * BOOTSTRAP_N)]
        lo1 = bt[int(ALPHA * BOOTSTRAP_N)]
        print(f"  n={n * f:>5}（×{f}，簇数仍 {len(by_topic)}）"
              f"  双侧95% [{lo2:.4%}, {hi2:.4%}]   单侧95%下界 {lo1:.4%}")
        scale_rows.append({"factor": f, "n": n * f, "clusters": len(by_topic),
                           "two_sided": [lo2, hi2], "one_sided_lo": lo1})
    same = all(abs(r["two_sided"][0] - scale_rows[0]["two_sided"][0]) < 1e-12
               and abs(r["two_sided"][1] - scale_rows[0]["two_sided"][1]) < 1e-12
               for r in scale_rows)
    print(f"  各行是否逐位相同：{'是' if same else '否'}")
    print("  原因不是巧合：簇等大时，重抽后的总体均值只取决于抽到哪 12 个主题，")
    print("  每个主题内部复制多少份都会被同倍数的分母约掉。用例数不进入这个式子，簇数才进。")
    print("  要收窄这个区间只有一条路——加主题（加簇），不是加用例。")
    out["scale_demo"] = {"rows": scale_rows, "identical": same}

    # ---- 结论 ----
    all_los = ([r["one_sided_lo"] for r in binom_rows.values()]
               + [lo_eff, c1["t_lo"], b_lo1])
    print(f"\n=== 结论 ===")
    print(f"  上面所有口径的单侧95%下界最高一个是 {max(all_los):.4%}，没有任何一个 ≥ {TARGET:.0%}。")
    print(f"  点估计 {p_hat:.2%} 过线，是因为它不含不确定性；下界不过线，"
          "换算法换不出来，只能加簇或者提准确率。")
    out["max_one_sided_lo_across_all"] = max(all_los)
    out["any_method_passes"] = bool(max(all_los) >= TARGET)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n已落盘 {args.json}")
    return 0


def _selftest() -> None:
    # 区间端点：拿教科书上算得出的关系做锚，不是拿本脚本自己的输出当基准。
    # 1) Wilson 双侧应该被 Clopper-Pearson 双侧包住（精确法总是更保守）。
    lo_w, hi_w = wilson(92, 108, ALPHA, True)
    lo_cp, hi_cp = clopper_pearson(92, 108, ALPHA, True)
    assert lo_cp < lo_w and hi_cp > hi_w
    # 2) Clopper-Pearson 下界的定义：P(X>=x | p=lo) 恰好等于 α。
    assert abs(stats.binom.sf(91, 108, clopper_pearson(92, 108, ALPHA, False)[0]) - ALPHA) < 1e-9
    # 3) 单侧下界必须高于双侧下界（同一 α，单尾比双尾松）。
    for _, fn in METHODS:
        assert fn(92, 108, ALPHA, False)[0] >= fn(92, 108, ALPHA, True)[0] - 1e-12
    # 4) 退化点不能炸：x=0 / x=n。
    for _, fn in METHODS:
        for xx in (0, 108):
            lo, hi = fn(xx, 108, ALPHA, True)
            assert 0.0 <= lo <= hi <= 1.0
    # 5) 等大簇时 m0 就是簇大小；簇均值全相同时 MSB=0，ICC 估计为负、DEFF 截到 1。
    deg = icc_oneway({"a": [1, 0, 1], "b": [0, 1, 1]})
    assert abs(deg["m0"] - 3) < 1e-9 and deg["ICC_raw"] < 0 and deg["DEFF"] == 1.0
    # 6) 本脚本的 cluster_boot 必须与 adaptation_noise_band.cluster_ci 逐位相等，
    #    否则两份材料里的「聚类 95% 区间」会对不上。
    hits = load_hits(DEFAULT_RUN)
    ref_lo, ref_hi, _ = cluster_ci(hits)
    bt = cluster_boot(group_by_topic(hits))
    assert bt[int(0.025 * BOOTSTRAP_N)] == ref_lo and bt[int(0.975 * BOOTSTRAP_N)] == ref_hi


if __name__ == "__main__":
    _selftest()
    raise SystemExit(main())
