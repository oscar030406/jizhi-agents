"""修复性重跑：只重判「judgeB 技术性失败」的 borderline 案例。

首跑（runs/20260809-141631）判官 B 18/18 三试皆败——Qwen3.6 思考模型未关
thinking，token 预算被吃光无 JSON。这是工具故障不是评测结论；本脚本用修好的
judge()（enable_thinking=false）只重判这些案例的 judgeB，主判 judgeA 结果
原样保留，预注册口径（borderline 需两判官一致，分歧记 0）不变。

产出新 run 目录（后缀 -fixed），原始目录原样留档。
用法：python scripts/rejudge_borderline.py <run_dir_name>
"""

from __future__ import annotations

import json
import pathlib
import sys
import time

import requests

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from judge_adaptation_probe import JUDGE_B, PROBE, judge, load_key  # noqa: E402

run_name = sys.argv[1] if len(sys.argv) > 1 else sorted(p.name for p in (PROBE / "runs").iterdir())[-1]
src = PROBE / "runs" / run_name
recs = [json.loads(l) for l in open(src / "verdicts.jsonl", encoding="utf-8")]

key = load_key()
session = requests.Session()
session.trust_env = False

fixed = 0
for r in recs:
    va = r.get("judgeA")
    if r["final"] is not None or not va or not va.get("borderline"):
        continue
    case = json.load(open(PROBE / "resources" / f"{r['caseId']}.json", encoding="utf-8"))
    vb = judge(session, key, JUDGE_B, case["text"])
    r["judgeB"] = vb
    verdict_tier = va["tier"] if (vb and vb.get("tier") == va.get("tier")) else None
    r["final"] = verdict_tier
    r["hit"] = 1 if verdict_tier == r["target"] else 0
    fixed += 1
    print(f"{r['caseId']} A={va.get('tier')} B={(vb or {}).get('tier')} final={verdict_tier} hit={r['hit']}")
    time.sleep(0.3)

out = PROBE / "runs" / f"{run_name}-fixed"
out.mkdir(exist_ok=True)
with open(out / "verdicts.jsonl", "w", encoding="utf-8") as f:
    for r in recs:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

n = len(recs)
hits = sum(r["hit"] for r in recs)
per_tier: dict[str, list[int]] = {}
dist: dict[str, int] = {}
for r in recs:
    per_tier.setdefault(r["target"], []).append(r["hit"])
    if r["final"]:
        dist[r["final"]] = dist.get(r["final"], 0) + 1
summary = {
    "n": n,
    "accuracy": hits / n,
    "per_tier": {t: {"n": len(v), "acc": sum(v) / len(v)} for t, v in per_tier.items()},
    "judged_distribution": dist,
    "rejudged_b_cases": fixed,
    "base_run": run_name,
    "caliber": "metric-calibers-v1 §2A；judgeB 技术故障修复后重判 borderline，主判与口径未动",
}
json.dump(summary, open(out / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print(f"\n修复重判 {fixed} 例；准确率 {hits}/{n} = {hits/n:.1%}")
per = ", ".join(f"{t}={d['acc']:.0%}" for t, d in summary["per_tier"].items())
print(f"分档：{per}\n落盘 {out}")
