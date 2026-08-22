"""WO-L2 第 3 项：K3 适配性闸的标定表——语料画像分 vs 接地率，加了 vecdb / rag-adv 两个坐标后重算。

预注册条件照抄 K3 原单，一字不改：**拿接地率标定画像分，分数曲线若分不开这几个数，
这条闸作废。** n=3 时置换检验双尾 p 的下限就是 0.333，与「随便排也有 1/3 概率排对」
在统计上分不开——这正是本轮要靠新坐标解决的问题。分不开就写分不开，不换指标凑说法。

两个输入都从盘上读，不重算、不调模型：

- **接地率**：`audit-grounding-scan.py::load_screens()` 的 B 口径（该域全部 run 汇总、
  剔除桥挂了与未挂语料的屏）。剔废判据不在这里复制一份，直接调它，两边永远同源。
- **画像分**：`data/knowledge_base/fitness.json` 的 `gate_b.mean`（教育价值均分）、
  `gate_b.ge3_pct`（≥3 分占比）、`gate_a.chars_median`（块长中位）。
  vecdb 与 rag-adv 的闸 B 分 2026-08-17 04:09 那次已经跑过，本单不必再花钱。

两个玩具库（cold-chain-ops 4 块 / pv-ops 12 块）不进表：它们的体检屏全部未挂语料，
**在接地率这条轴上没有坐标**，既不能验证也不能推翻这条闸（K3 原单已写死）。

p 值用**精确置换检验**，不用 scipy 的渐近 p——n=5 时渐近近似根本不成立。

用法（项目根目录下）：

    python scripts/k3-fitness-calibration.py
    python scripts/k3-fitness-calibration.py --json   # 只吐结构化结果，给报告脚本用
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import itertools
import json
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FITNESS = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base", "fitness.json")

#: fitness.json 的库名 → 接地率扫描里的域名。odoo 的索引 08-17 已整个换成 rst 重建版，
#: 所以它的画像分对应的是 odoo(rst) 那一臂，不是 odoo(po旧)。
FITNESS_TO_SCAN = {
    "ai": "ai",
    "iotdb": "iotdb",
    "odoo": "odoo(rst)",
    "vecdb": "vecdb",
    "rag-adv": "rag-adv",
}

#: 三条画像轴：显示名 → (取值函数, 预期方向)。方向只用于把结论写成人话，不参与判据。
AXES = [
    ("教育价值均分", lambda c: c["gate_b"].get("mean"), "正"),
    ("≥3 分占比", lambda c: c["gate_b"].get("ge3_pct"), "正"),
    ("块长中位", lambda c: c["gate_a"].get("chars_median"), "正"),
]


def spearman_rho(xs: list[float], ys: list[float]) -> float:
    """Spearman ρ = 秩上的 Pearson。并列取平均秩（本表基本不会有并列，但别留坑）。"""
    def ranks(vals: list[float]) -> list[float]:
        order = sorted(range(len(vals)), key=lambda i: vals[i])
        out = [0.0] * len(vals)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and vals[order[j + 1]] == vals[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = avg
            i = j + 1
        return out

    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else 0.0


def permutation_p(xs: list[float], ys: list[float]) -> tuple[float, int]:
    """精确置换检验双尾 p：枚举 y 的全部 n! 种排列，数 |ρ| 不小于观测值的比例。

    n≤8 时全枚举（8!=40320，眨眼跑完）。渐近 p 在这个样本量下没有意义，
    K3 原单里 n=3 的「p 下限 0.333」说的就是 2/3!——这是组合学事实，不是估计。
    """
    obs = abs(spearman_rho(xs, ys))
    perms = list(itertools.permutations(ys))
    hit = sum(1 for p in perms if abs(spearman_rho(xs, list(p))) >= obs - 1e-12)
    return hit / len(perms), len(perms)


def grounding_by_corpus() -> dict[str, tuple[int, int, int]]:
    """B 口径接地率：域 → (有据数, 断言数, 屏数)。剔废判据借 scan，不另写一份。"""
    path = os.path.join(ROOT, "scripts", "audit-grounding-scan.py")
    spec = importlib.util.spec_from_file_location("_grounding_scan", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    agg: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0])
    for r in mod.load_screens():
        if r["unusable"]:
            continue
        cell = agg[r["corpus"]]
        cell[0] += r["grounded"]
        cell[1] += r["n"]
        cell[2] += 1
    return {k: tuple(v) for k, v in agg.items()}


def selfcheck() -> None:
    """先拿两个组合学上算得出答案的输入验置换检验，再拿它下结论。"""
    # n=3 完美排序：6 种排列里只有正序与逆序达到 |ρ|=1 → 2/6
    p3, n3 = permutation_p([1, 2, 3], [10, 20, 30])
    assert n3 == 6 and abs(p3 - 2 / 6) < 1e-9, f"n=3 完美排序应得 p=0.333，得到 {p3}"
    # n=5 完美排序：2/120
    p5, n5 = permutation_p([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    assert n5 == 120 and abs(p5 - 2 / 120) < 1e-9, f"n=5 完美排序应得 p=0.0167，得到 {p5}"
    assert abs(spearman_rho([1, 2, 3], [3, 2, 1]) + 1.0) < 1e-9, "逆序 ρ 应为 −1"
    print("置换检验自证通过：n=3 完美排序 p=0.333（K3 原单记的下限）、n=5 p=0.0167\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true", help="只输出结构化结果")
    args = ap.parse_args()

    if not args.json:
        selfcheck()

    fit = json.load(open(FITNESS, encoding="utf-8"))["corpora"]
    ground = grounding_by_corpus()

    rows = []
    missing = []
    for fkey, skey in FITNESS_TO_SCAN.items():
        if fkey not in fit:
            missing.append(f"{fkey}（fitness.json 里没有）")
            continue
        if skey not in ground:
            missing.append(f"{fkey}（还没有可用的接地率屏，域名 {skey}）")
            continue
        g, n, screens = ground[skey]
        rows.append({
            "corpus": fkey,
            "scan_name": skey,
            "grounding": g / n,
            "claims": n,
            "screens": screens,
            **{name: fn(fit[fkey]) for name, fn, _ in AXES},
        })

    if not args.json:
        print(f"坐标 {len(rows)} 个" + (f"；缺 {len(missing)} 个：{'；'.join(missing)}" if missing else ""))
        print()
        print(f"{'域':12s} {'接地率':>8s} {'断言':>5s} {'屏':>4s} " + " ".join(f"{n:>10s}" for n, _, _ in AXES))
        for r in sorted(rows, key=lambda x: -x["grounding"]):
            vals = " ".join(f"{r[n]:>10}" if r[n] is not None else f"{'—':>10}" for n, _, _ in AXES)
            print(f"{r['corpus']:12s} {r['grounding']:8.3f} {r['claims']:5d} {r['screens']:4d} {vals}")
        print()

    results = []
    for name, _, direction in AXES:
        pts = [(r[name], r["grounding"]) for r in rows if r[name] is not None]
        if len(pts) < 3:
            results.append({"axis": name, "n": len(pts), "rho": None, "p": None,
                            "verdict": "坐标不足，算不了"})
            continue
        xs = [a for a, _ in pts]
        ys = [b for _, b in pts]
        rho = spearman_rho(xs, ys)
        p, perms = permutation_p(xs, ys)
        sep = p < 0.05
        results.append({
            "axis": name, "n": len(pts), "rho": round(rho, 3), "p": round(p, 4),
            "perms": perms, "direction": direction,
            "verdict": "分得开" if sep else "分不开",
        })

    if args.json:
        print(json.dumps({"rows": rows, "axes": results, "missing": missing},
                         ensure_ascii=False, indent=2))
        return

    print("Spearman ρ vs 接地率（精确置换检验双尾 p，α=0.05）")
    for r in results:
        if r["rho"] is None:
            print(f"  {r['axis']:12s} {r['verdict']}（n={r['n']}）")
            continue
        print(f"  {r['axis']:12s} n={r['n']} ρ={r['rho']:+.3f} p={r['p']:.4f}"
              f"（{r['perms']} 种排列）  {r['verdict']}")
    print()

    lo = min((r["p"] for r in results if r["p"] is not None), default=None)
    n = max((r["n"] for r in results), default=0)
    floor = 2 / math.factorial(n) if n >= 3 else None
    top = max((abs(r["rho"]) for r in results if r["rho"] is not None), default=0.0)
    print("预注册结论")
    if floor is not None:
        print(f"  n={n} 时置换 p 的下限是 2/{n}! = {floor:.4f}", end="")
        print("——已低于 0.05。" if floor < 0.05 else "——仍高于 0.05，任何排序都不可能显著。")
    if lo is not None and lo < 0.05:
        print("  → 至少一条轴分得开，可以谈阈值；但阈值画在哪要另拿数据定，别就着这张表画。")
        return
    print("  → 没有一条轴分得开：K3 的画像分**不作判灯依据**，维持「只作画像」的现状。")
    # 「分不开」能推出什么，取决于这个样本量下检验够不够得着。别把两种情况混成一句话：
    #   p 下限 ≥0.05：任何排序都出不了显著，这是**证据不足**，什么都没证到。
    #   p 下限 <0.05：只有**完美单调**（|ρ|=1）才够得着那条线，所以够不着时能证伪的
    #     也只有「画像分能完美排出接地率」这一档强假设；弱相关仍然判不了。
    if floor is None or floor >= 0.05:
        print("     这个样本量下任何排序都不可能显著——属「证据不足」，不是「已被推翻」，两者不许混写。")
    else:
        print(f"     n={n} 的置换检验够得着显著的只有「完美单调」（|ρ|=1）这一档，"
              f"而实测最大 |ρ|={top:.2f}。")
        print("     所以证伪掉的是**「画像分能完美排出接地率」这个强假设**；"
              "「存在弱相关」在这个样本量下仍然判不了，别把它一起写成推翻。")


if __name__ == "__main__":
    main()
