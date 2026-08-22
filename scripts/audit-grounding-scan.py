"""扫全部体检 run 的逐屏判官记录，算有据支持率并标出不可用的屏。

结论与解读见 docs/05-evidence/audit-grounding-caveats-20260817.md。

有据支持率 = supported ∧ 有 sourceIds / 断言总数，即 ALCE 的 citation recall
（arXiv:2305.14627 §3.3）。这里只做统计，不改判官、不写盘。

用法（项目根目录下）：

    python scripts/audit-grounding-scan.py

加 --detail 打印逐屏明细。
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base", "intake_runs")


def load_screens() -> list[dict]:
    """把每个 run 的每一屏摊平成一行。没有断言记录的屏直接跳过。"""
    rows: list[dict] = []
    for run_dir in sorted(glob.glob(os.path.join(RUNS, "*"))):
        if not os.path.isdir(run_dir):
            continue
        try:
            run = json.load(open(os.path.join(run_dir, "run.json"), encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for path in glob.glob(os.path.join(run_dir, "trial_courses", "*.json")):
            if "kc_misses" in path:
                continue
            try:
                course = json.load(open(path, encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            tier = os.path.basename(path).replace(".json", "")
            for i, scene in enumerate(course.get("scenes", [])):
                audit = scene.get("audit", {})
                claims = audit.get("claims") or []
                if not claims:
                    continue
                # 证据检索桥挂了的屏：模型手里根本没有摘录，只能凭记忆写，
                # 有据支持率天然趋零。这是管道故障，不是领域泛化的证据。
                # 判据比 audit.corpus 更靠前——这类屏的 audit.corpus 和
                # evidenceCount 都正常，光看审核那一层看不出来。
                pipeline = scene.get("pipeline") or {}
                bridge_down = (not pipeline.get("assembly")) or bool(pipeline.get("bridgeWarnings"))
                rid = os.path.basename(run_dir)
                corpus = run.get("corpus", "?")
                # odoo 在 08-17 凌晨被从 rst 原件整个重建过（工单 K1），两版语料并池
                # 会把改造前后的成绩平均掉，所以按 run 日期切成两个域来统计。
                if corpus == "odoo":
                    corpus = "odoo(rst)" if rid >= "20260817" else "odoo(po旧)"
                rows.append({
                    "run": rid,
                    "corpus": corpus,
                    "tier": tier,
                    "scene": i + 1,
                    "rounds": audit.get("rounds"),
                    "verdict": audit.get("verdict"),
                    "n": len(claims),
                    # 有据 = 判 supported 且真填了 sourceIds
                    "grounded": sum(1 for c in claims
                                    if c.get("verdict") == "supported" and (c.get("sourceIds") or [])),
                    "nosrc": sum(1 for c in claims if not (c.get("sourceIds") or [])),
                    # 审核没挂上语料的屏：判官手里没摘录池，这一屏的有据支持率是废数
                    "no_judge_corpus": (not audit.get("corpus")) or not audit.get("evidenceCount"),
                    "bridge_down": bridge_down,
                    "unusable": bridge_down or (not audit.get("corpus"))
                                or not audit.get("evidenceCount"),
                    "evidence": audit.get("evidenceCount"),
                })
    return rows


def table(rows: list[dict], key: str, title: str) -> None:
    agg: dict[str, list[int]] = collections.defaultdict(lambda: [0, 0, 0, 0])
    for r in rows:
        cell = agg[str(r[key])]
        cell[0] += r["n"]
        cell[1] += r["grounded"]
        cell[2] += r["nosrc"]
        cell[3] += 1
    print(title)
    for k in sorted(agg):
        n, g, ns, screens = agg[k]
        print(f"  {k:16s} 屏{screens:3d} 断言{n:4d} 有据支持率 {g / n:.3f} 无源率 {ns / n:.3f}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detail", action="store_true", help="打印逐屏明细")
    args = ap.parse_args()

    rows = load_screens()
    runs = len({r["run"] for r in rows})
    print(f"{len(rows)} 屏带断言记录，来自 {runs} 个 run，共 {sum(r['n'] for r in rows)} 条断言\n")

    for flag, title in (("bridge_down", "证据检索桥挂了的屏（模型没拿到摘录，只能凭记忆写）"),
                        ("no_judge_corpus", "审核未挂语料的屏（判官没有摘录池可比对）")):
        bad = [r for r in rows if r[flag]]
        print(f"{title}：{len(bad)} 屏")
        for r in bad:
            print(f"  {r['corpus']:14s} {r['tier']:9s} 屏{r['scene']} n={r['n']:2d} "
                  f"有据={r['grounded']:2d} evidenceCount={r['evidence']} {r['run']}")
        print()

    table(rows, "corpus", "按域（全部屏——含废数，只供对照，别引用）")
    table([r for r in rows if not r["unusable"]], "corpus", "按域（剔除两类废数屏后，这才是可引用的）")
    table(rows, "rounds", "按审核轮数——注意这条在分域后就不成立，别当结论")

    if args.detail:
        print("逐屏明细（有据支持率升序）")
        for r in sorted(rows, key=lambda x: x["grounded"] / x["n"]):
            flag = " [未挂语料]" if r["unusable"] else ""
            print(f"  {r['corpus']:14s} {r['tier']:9s} r={r['rounds']} {str(r['verdict']):9s} "
                  f"n={r['n']:2d} 有据={r['grounded'] / r['n']:.3f} "
                  f"无源={r['nosrc'] / r['n']:.3f} {r['run']}{flag}")


if __name__ == "__main__":
    main()
