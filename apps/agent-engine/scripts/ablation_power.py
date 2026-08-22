"""消融实验的标准误、置信区间与功效分析。

为什么要这个：我们报过「审核层增益 −0.003 (p=0.89)」，但没报样本量、标准误和
最小可检测效应。没有这三个数，「零增益」和「样本量不够、测不出来」在数据上长得一样，
答辩时这是最容易被一击命中的地方。

三件事：
1. **逐案成对差分**——同一个 case 在两种模式下的分数配对相减，天然消掉 case 难度差异，
   比两组均值相减方差小得多。
2. **聚类标准误**——60 个 case 只来自 5 个概念族，同族内的分数相关。按 case 算 SE 会
   低估真实不确定性；按概念族做 cluster bootstrap 才诚实。
3. **功效分析**——在当前样本量下，多大的效应才测得出来（MDE）。如果 MDE 比我们关心的
   效应还大，那「没测出差异」只能说明实验没这个分辨率。

用法：
    python scripts/ablation_power.py
    python scripts/ablation_power.py --metric hallucination_rate
    python scripts/ablation_power.py --contrast rag rag_audit_debate
"""

import argparse
import csv
import json
import math
import os
import random
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EVAL = os.path.join(ROOT, "data", "eval")

# 固定种子：bootstrap 结果必须可复算
SEED = 20260730
N_BOOT = 10000
# 双侧 0.05 + 80% 功效对应的常数（1.96 + 0.84）
Z_ALPHA, Z_POWER = 1.959964, 0.8416212


def load_cases_by_cluster(path: str) -> dict[str, str]:
    """case_id → 概念族。用第一个 expected_concept 当族标签。"""
    out = {}
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            concepts = row.get("expected_concepts") or ["unknown"]
            out[row["id"]] = concepts[0]
    return out


def paired_diffs(rows, mode_a, mode_b, metric, drop_degraded=False):
    """按 (case_id, seed) 配对，返回 [(case_id, diff)]。

    drop_degraded=True 时只保留两档都没降级的配对（fallback_rate=0），
    对齐 ablation_final_analysis.md 的「同 case 双档均未降级」口径。
    """
    table = defaultdict(dict)
    for r in rows:
        try:
            val = float(r[metric])
        except (KeyError, ValueError):
            continue
        fb = r.get("fallback_rate")
        try:
            degraded = float(fb) > 0 if fb not in (None, "") else False
        except ValueError:
            degraded = False
        table[(r["case_id"], r["seed"])][r["mode"]] = (val, degraded)

    diffs = []
    for (case_id, _seed), by_mode in table.items():
        if mode_a not in by_mode or mode_b not in by_mode:
            continue
        (va, da), (vb, db) = by_mode[mode_a], by_mode[mode_b]
        if drop_degraded and (da or db):
            continue
        diffs.append((case_id, vb - va))
    return diffs


def cluster_bootstrap_se(diffs, clusters, n_boot=N_BOOT, seed=SEED):
    """按概念族整族重抽样。同族内相关 → 必须整族抽，不能抽单个 case。"""
    by_cluster = defaultdict(list)
    for case_id, d in diffs:
        by_cluster[clusters.get(case_id, "unknown")].append(d)
    names = list(by_cluster)
    rng = random.Random(seed)
    means = []
    for _ in range(n_boot):
        pool = []
        for _ in range(len(names)):
            pool.extend(by_cluster[names[rng.randrange(len(names))]])
        if pool:
            means.append(sum(pool) / len(pool))
    means.sort()
    m = sum(means) / len(means)
    var = sum((x - m) ** 2 for x in means) / (len(means) - 1)
    lo = means[int(0.025 * len(means))]
    hi = means[int(0.975 * len(means))]
    return math.sqrt(var), lo, hi, len(names)


def naive_se(diffs):
    vals = [d for _, d in diffs]
    n = len(vals)
    m = sum(vals) / n
    var = sum((x - m) ** 2 for x in vals) / (n - 1)
    return m, math.sqrt(var / n), math.sqrt(var), n


def permutation_p(diffs, n_perm=N_BOOT, seed=SEED):
    """成对置换：随机翻转每个差分的符号。"""
    vals = [d for _, d in diffs]
    obs = abs(sum(vals) / len(vals))
    rng = random.Random(seed)
    hits = 0
    for _ in range(n_perm):
        s = sum(v if rng.random() < 0.5 else -v for v in vals)
        if abs(s / len(vals)) >= obs:
            hits += 1
    return (hits + 1) / (n_perm + 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(EVAL, "full_s1s2_merged.csv"))
    ap.add_argument("--cases", default=os.path.join(EVAL, "e2e_cases.jsonl"))
    ap.add_argument("--metric", default="faithfulness")
    ap.add_argument("--contrast", nargs=2, action="append",
                    metavar=("BASE", "TREATMENT"))
    args = ap.parse_args()

    contrasts = args.contrast or [
        ("rag", "rag_audit"),              # 审核门：我们的核心主张
        ("rag_audit", "rag_audit_debate"), # 再加辩论
        ("rag", "hetero_debate"),          # 异族辩论（已被 A1 证伪，留作对照）
        ("cot_single", "self_consistency"),
        ("direct", "rag"),                 # 接地本身
    ]

    with open(args.data, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    clusters = load_cases_by_cluster(args.cases)

    print(f"数据：{os.path.relpath(args.data, ROOT)}  共 {len(rows)} 行")
    print(f"指标：{args.metric}")
    print(f"聚类：{len(set(clusters.values()))} 个概念族 / {len(clusters)} 个 case\n")

    n_clusters = len(set(clusters.values()))
    if n_clusters < 30:
        print(f"⚠ 只有 {n_clusters} 个聚类。聚类稳健推断的经验门槛是 ≥30，"
              f"低于此时聚类 SE 本身就不稳（可能偏大也可能偏小）。")
        print("  下表的聚类 SE 只当参考，结论以「朴素 SE + MDE」为准，"
              "并在对外材料里注明这一点。\n")

    rows_out = []
    print(f"{'对照':<30}{'n':>4}{'均值差':>9}{'朴素SE':>8}{'MDE':>8}"
          f"{'能否测出':>10}{'聚类SE':>8}{'p':>7}")
    print("-" * 84)

    for base, treat in contrasts:
        diffs = paired_diffs(rows, base, treat, args.metric)
        if len(diffs) < 3:
            continue
        mean, se_naive, sd, n = naive_se(diffs)
        se_cl, lo, hi, _ = cluster_bootstrap_se(diffs, clusters)
        p = permutation_p(diffs)
        # 80% 功效、双侧 0.05：当前样本量能检出的最小效应
        mde = (Z_ALPHA + Z_POWER) * se_naive
        verdict = "可以" if abs(mean) >= mde else "测不出"
        label = f"{base}→{treat}"
        print(f"{label:<30}{n:>4}{mean:>9.4f}{se_naive:>8.4f}{mde:>8.4f}"
              f"{verdict:>10}{se_cl:>8.4f}{p:>7.3f}")
        rows_out.append((label, n, mean, se_naive, sd, mde, p))

    print("\n要把某个效应测出来，需要多少配对样本（80% 功效，双侧 0.05）：")
    print(f"{'对照':<30}{'当前n':>7}{'δ=0.02':>9}{'δ=0.03':>9}{'δ=0.05':>9}{'δ=0.10':>9}")
    print("-" * 74)
    for label, n, mean, se, sd, mde, p in rows_out:
        need = []
        for delta in (0.02, 0.03, 0.05, 0.10):
            # n = 2*(z_a+z_b)^2 * sd^2 / delta^2 的配对版本：n = (z_a+z_b)^2 * sd^2 / delta^2
            need.append(math.ceil(((Z_ALPHA + Z_POWER) ** 2) * (sd ** 2) / (delta ** 2)))
        print(f"{label:<30}{n:>7}" + "".join(f"{x:>9d}" for x in need))

    print("\n读法：")
    print("  MDE   = 当前样本量下 80% 功效能检出的最小效应。")
    print("  测不出 = |均值差| < MDE，此时「没测出差异」不等于「没有差异」，")
    print("           只能说这个实验没有这个分辨率。这是对外必须讲清的一句。")
    print(f"\n可复算：seed={SEED}，bootstrap/置换各 {N_BOOT} 次，改数据用 --data。")


if __name__ == "__main__":
    main()
