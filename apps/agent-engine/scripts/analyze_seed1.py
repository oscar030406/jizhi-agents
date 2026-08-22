r"""seed1 深度分析（零 API）：配对比较 + 置换检验 + 胜率 + 降级解剖。

配对口径：同一 case 下两档都未降级（fallback=0）才入配对——排除"比谁更少崩"的噪声，
只比"都正常生成时谁更忠实"。置换检验 10000 次（固定种子，可复现）。
用法：python scripts\analyze_seed1.py --root data\eval\full_s1_local
"""
from __future__ import annotations

import argparse
import csv
import random
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PAIRS = [
    ("rag", "rag_audit", "审核层增益"),
    ("rag_audit", "rag_audit_debate", "同族辩论增益"),
    ("self_refine", "rag_audit_debate", "自反思 vs 同族辩论"),
    ("self_refine", "hetero_debate", "自反思 vs 异族辩论（论文核心对照）⚠hetero判官同族待尸检"),
    ("rag_audit_debate", "hetero_debate", "同族辩论 vs 异族辩论 ⚠同上"),
    ("cot_single", "self_consistency", "CoT vs 自洽投票"),
    ("self_consistency", "rag_audit_debate", "最强单模型基线 vs 多智能体"),
]


def paired_permutation(diffs: list[float], n: int = 10000) -> float:
    """双侧配对置换检验：随机翻转差值符号。返回 p 值。"""
    rng = random.Random(20260723)
    observed = abs(sum(diffs))
    hits = 0
    for _ in range(n):
        s = sum(d if rng.random() < 0.5 else -d for d in diffs)
        if abs(s) >= observed:
            hits += 1
    return hits / n


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT / "data" / "eval" / "full_s1_local")
    parser.add_argument("--output", type=Path, default=ROOT.parent.parent / "docs" / "05-evidence" / "ablation_seed1_analysis.md")
    args = parser.parse_args()

    rows = []
    for csv_path in sorted(args.root.glob("shard_*/ablation_results.csv")):
        with open(csv_path, encoding="utf-8") as f:
            rows += list(csv.DictReader(f))

    by_case_mode = {}
    for r in rows:
        r["faith"] = float(r["faithfulness"])
        r["halluc"] = float(r["hallucination_rate"])
        r["fb"] = float(r["fallback_rate"])
        by_case_mode[(r["case_id"], r["mode"])] = r

    lines = ["# seed1 深度分析（60 例 × 9 档，单 seed——s2/s3 补跑后更新）", ""]

    # 1) 配对比较
    lines += ["## 配对比较（双档均未降级的 case 子集；置换检验 n=10000）", "",
              "| 对照 | 配对n | faith 差（B−A） | p | B 胜率 |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for a, b, label in PAIRS:
        diffs, wins, ties = [], 0, 0
        for case in {c for c, _ in by_case_mode}:
            ra, rb = by_case_mode.get((case, a)), by_case_mode.get((case, b))
            if not ra or not rb or ra["fb"] > 0 or rb["fb"] > 0:
                continue
            d = rb["faith"] - ra["faith"]
            diffs.append(d)
            wins += d > 0
            ties += d == 0
        if len(diffs) < 5:
            lines.append(f"| {label}（{a}→{b}） | {len(diffs)} | 样本不足 | - | - |")
            continue
        p = paired_permutation(diffs)
        mean_d = st.mean(diffs)
        win_rate = wins / len(diffs)
        lines.append(f"| {label}（{a}→{b}） | {len(diffs)} | {mean_d:+.3f} | {p:.4f} | {win_rate:.0%} |")
    lines.append("")

    # 2) 降级解剖
    lines += ["## 生成端降级率（fallback>0 行占比，按档）", "",
              "| 档 | 降级率 | 说明 |", "| --- | ---: | --- |"]
    fb_by_mode = defaultdict(list)
    for r in rows:
        fb_by_mode[r["mode"]].append(r["fb"] > 0)
    for mode, flags in sorted(fb_by_mode.items(), key=lambda kv: sum(kv[1]) / len(kv[1])):
        rate = sum(flags) / len(flags)
        note = "机制越长链失败面越大" if rate > 0.4 else ""
        lines.append(f"| {mode} | {rate:.0%} | {note} |")
    lines += ["", "降级行的钱照花（失败调用+重试），这是成本表里最该省的一块——",
              "解析容错与 max_tokens=4800 已在 s2/s3 部署，预期显著下降。", ""]

    # 3) 辩论轮次
    rounds = defaultdict(list)
    for r in rows:
        rounds[r["mode"]].append(int(float(r.get("debate_rounds", 0))))
    lines += ["## 辩论轮次分布", ""]
    for mode in ("rag_audit_debate", "hetero_debate", "full_personalized"):
        rs = rounds.get(mode, [])
        if rs:
            trig = sum(1 for x in rs if x > 0)
            lines.append(f"- {mode}：触发辩论 {trig}/{len(rs)} 例，轮次均值 {st.mean(rs):.2f}")
    lines += ["", "## 结论草稿（待 s2/s3 与 hetero 尸检确认）", "",
              "1. 审核/辩论各档与基线在'都正常生成'的子集上差距是小步幅（与文献一致）；",
              "2. hetero_debate 大幅领先但判官同族（GLM 写 GLM 判），尸检（第三家判官复判）前不得引用；",
              "3. 降级率随机制链长上升——工程稳定性本身就是多智能体的成本，论文如实报告。"]

    args.output.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines[:28]))
    print(f"→ {args.output}")


if __name__ == "__main__":
    main()
