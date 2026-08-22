"""双判官交叉验证消融：判定准确率分析。

输入  data/experiments/claim_truth_set.json + cross_validation_runs.json
输出  data/experiments/cross_validation_metrics.json（含逐条匹配留档）

跑法：python scripts/experiments/analyze_cross_validation.py [runs.json] [--arms A]
（08-03：支持指定 runs 文件与单臂——判官候选换型对比复用同一套匹配与指标。）
"""

import json
import itertools
import random
import sys
from pathlib import Path
from collections import Counter

DATA = Path(r"D:/UserData/Desktop/挑战杯/apps/agent-engine/data/experiments")
TRUTH = DATA / "claim_truth_set.json"
_args = [a for a in sys.argv[1:] if not a.startswith("--")]
RUNS = Path(_args[0]) if _args else DATA / "cross_validation_runs.json"
OUT = (
    RUNS.with_name(RUNS.stem + "_metrics.json")
    if _args
    else DATA / "cross_validation_metrics.json"
)

MATCH_THRESHOLD = 0.60  # 字符 bigram 包含度下限；低于此视为“判官未提及”
ARMS = ("A",) if "--arms" in sys.argv and "A" in sys.argv else ("A", "B")
CLASSES = ("supported_by_corpus", "planted_false", "true_beyond_corpus")
VERDICTS = ("supported", "uncertain", "incorrect", "unmatched")
random.seed(20260729)


# ---------- 匹配 ----------

def bigrams(s: str) -> set:
    """字符 bigram 集合。去空白与常见标点后取相邻二元组。"""
    t = "".join(ch for ch in s if not ch.isspace() and ch not in "，。、；：（）()[]【】“”\"'`*_—-…！？!?,.:;")
    return {t[i:i + 2] for i in range(len(t) - 1)} or {t}


def containment(judge_text: str, truth_text: str) -> float:
    """非对称包含度：判官文本的 bigram 有多少落在真值断言里。

    判官会截断/改写断言（观察到的最短一条只保留前半句），所以用
    |B(judge) ∩ B(truth)| / |B(judge)| 而非对称 Dice——截断不该被惩罚，
    但判官凭空加词会被惩罚。
    """
    j, t = bigrams(judge_text), bigrams(truth_text)
    return len(j & t) / len(j) if j else 0.0


def best_assignment(judge_claims, truth_claims):
    """场景内一对一最优指派。4×4 全排列穷举（24 种），精确解，不用贪心。"""
    n_j, n_t = len(judge_claims), len(truth_claims)
    score = [[containment(jc.get("claim", ""), tc["text"]) for tc in truth_claims] for jc in judge_claims]
    size = max(n_j, n_t)
    best, best_sum = None, -1.0
    for perm in itertools.permutations(range(size)):
        s = sum(score[i][perm[i]] for i in range(n_j) if perm[i] < n_t)
        if s > best_sum:
            best_sum, best = s, perm
    pairs = []
    for i in range(n_j):
        k = best[i]
        pairs.append((i, k if k < n_t else None, score[i][k] if k < n_t else 0.0))
    return pairs


# ---------- 载入 ----------

truth = json.loads(TRUTH.read_text(encoding="utf-8"))
runs = json.loads(RUNS.read_text(encoding="utf-8"))
truth_scenes = {s["id"]: s for s in truth["scenes"]}

# claim_id -> {arm: verdict}；verdict ∈ supported/uncertain/incorrect/unmatched
table = {}
match_log = []
spurious = []  # 判官抽出但对不上任何真值断言的“多余断言”

for rec in runs["scenes"]:
    sid = rec["id"]
    tsc = truth_scenes[sid]
    for arm in ARMS:
        run = rec["runs"].get(arm) or {}
        audit = run.get("audit")
        jc = (audit or {}).get("claims", []) or []
        pairs = best_assignment(jc, tsc["claims"])
        used = set()
        for i, k, sc in pairs:
            jtext = jc[i].get("claim", "")
            jverd = jc[i].get("verdict", "")
            if k is not None and sc >= MATCH_THRESHOLD:
                cid = tsc["claims"][k]["id"]
                used.add(cid)
                table.setdefault(cid, {})[arm] = jverd
                match_log.append({
                    "scene": sid, "arm": arm, "claim_id": cid, "score": round(sc, 3),
                    "matched": True, "truth": tsc["claims"][k]["truth"], "judge_verdict": jverd,
                    "judge_text": jtext, "truth_text": tsc["claims"][k]["text"],
                    "decidedBy": jc[i].get("decidedBy"),
                })
            else:
                spurious.append({
                    "scene": sid, "arm": arm, "judge_text": jtext, "judge_verdict": jverd,
                    "best_score": round(sc, 3),
                    "best_truth_text": tsc["claims"][k]["text"] if k is not None else None,
                })
                match_log.append({
                    "scene": sid, "arm": arm, "claim_id": None, "score": round(sc, 3),
                    "matched": False, "judge_text": jtext, "judge_verdict": jverd,
                })
        # 真值里没被任何判官断言匹配上的 → 判官未提及
        for tc in tsc["claims"]:
            if tc["id"] not in used:
                table.setdefault(tc["id"], {})[arm] = "unmatched"
                match_log.append({
                    "scene": sid, "arm": arm, "claim_id": tc["id"], "matched": False,
                    "truth": tc["truth"], "judge_verdict": "unmatched",
                    "truth_text": tc["text"], "note": "judge never mentioned this claim",
                })

truth_of = {c["id"]: c["truth"] for s in truth["scenes"] for c in s["claims"]}
scene_of = {c["id"]: s["id"] for s in truth["scenes"] for c in s["claims"]}
all_ids = sorted(truth_of)

# ---------- 指标 ----------

def dist(arm, cls):
    c = Counter(table[i][arm] for i in all_ids if truth_of[i] == cls)
    n = sum(c.values())
    return {"n": n, **{v: c.get(v, 0) for v in VERDICTS}}


def correct(cid, arm):
    """正确判定：语料支持→supported；植入错误→incorrect。unmatched 一律算错。"""
    t, v = truth_of[cid], table[cid][arm]
    if t == "supported_by_corpus":
        return v == "supported"
    if t == "planted_false":
        return v == "incorrect"
    return v in ("supported", "uncertain")  # true_beyond_corpus 宽松口径


metrics = {}
for arm in ARMS:
    d = {cls: dist(arm, cls) for cls in CLASSES}
    pf, sc_, tb = d["planted_false"], d["supported_by_corpus"], d["true_beyond_corpus"]
    metrics[arm] = {
        "distributions": d,
        "false_negative_rate": (pf["supported"] + pf["unmatched"]) / pf["n"],   # 假的被放行
        "fn_supported": pf["supported"] / pf["n"],
        "fn_unmentioned": pf["unmatched"] / pf["n"],
        "half_miss_rate": pf["uncertain"] / pf["n"],
        "planted_false_caught": pf["incorrect"] / pf["n"],
        "false_positive_rate": sc_["incorrect"] / sc_["n"],                     # 真的被判错
        "over_strict_rate": sc_["uncertain"] / sc_["n"],
        "supported_correct": sc_["supported"] / sc_["n"],
        "tbc_incorrect_rate": tb["incorrect"] / tb["n"],
        "overall_accuracy_core": sum(correct(i, arm) for i in all_ids if truth_of[i] != "true_beyond_corpus") / 24,
        "overall_accuracy_all": sum(correct(i, arm) for i in all_ids) / 36,
    }

# 门禁裁决
gate = {}
for arm in ARMS:
    blocked, should, false_block = [], [], []
    for rec in runs["scenes"]:
        au = (rec["runs"].get(arm) or {}).get("audit") or {}
        has_pf = any(c["truth"] == "planted_false" for c in truth_scenes[rec["id"]]["claims"])
        if au.get("decision") == "block_pending_review":
            blocked.append(rec["id"])
            (should if has_pf else false_block).append(rec["id"])
    gate[arm] = {
        "scenes": len(runs["scenes"]), "blocked": len(blocked),
        "should_block": len(should), "false_block": len(false_block),
        "blocked_ids": blocked,
        "decisions": Counter((rec["runs"].get(arm) or {}).get("audit", {}).get("decision")
                             for rec in runs["scenes"]),
    }
    gate[arm]["decisions"] = dict(gate[arm]["decisions"])

# 成本
cost = {arm: {
    "total_ms": sum(rec["runs"][arm]["durationMs"] for rec in runs["scenes"]),
    "mean_ms": sum(rec["runs"][arm]["durationMs"] for rec in runs["scenes"]) / len(runs["scenes"]),
    "llm_calls": sum(len(rec["runs"][arm]["calls"]) for rec in runs["scenes"]),
    "prompt_tokens": sum(c.get("usage", {}).get("prompt_tokens", 0)
                         for rec in runs["scenes"] for c in rec["runs"][arm]["calls"]
                         if c.get("usage")),
    "completion_tokens": sum(c.get("usage", {}).get("completion_tokens", 0)
                             for rec in runs["scenes"] for c in rec["runs"][arm]["calls"]
                             if c.get("usage")),
    "by_tag": {t: {
        "calls": sum(1 for rec in runs["scenes"] for c in rec["runs"][arm]["calls"] if c.get("tag") == t),
        "prompt_tokens": sum(c.get("usage", {}).get("prompt_tokens", 0)
                             for rec in runs["scenes"] for c in rec["runs"][arm]["calls"]
                             if c.get("tag") == t and c.get("usage")),
        "completion_tokens": sum(c.get("usage", {}).get("completion_tokens", 0)
                                 for rec in runs["scenes"] for c in rec["runs"][arm]["calls"]
                                 if c.get("tag") == t and c.get("usage")),
    } for t in ("judge1", "judge2", "defense", "arbiter")
        if any(c.get("tag") == t for rec in runs["scenes"] for c in rec["runs"][arm]["calls"])},
} for arm in ARMS}


# ---------- 显著性 ----------

def mcnemar_exact(ids):
    """精确 McNemar（二项检验，双侧）。返回 b/c 与 p。"""
    b = sum(1 for i in ids if correct(i, "A") and not correct(i, "B"))   # A对B错
    c = sum(1 for i in ids if not correct(i, "A") and correct(i, "B"))   # A错B对
    n = b + c
    if n == 0:
        return {"b_A_only": 0, "c_B_only": 0, "discordant": 0, "p": 1.0,
                "note": "零不一致对：两臂逐条判定完全相同"}
    k = min(b, c)
    from math import comb
    p = min(1.0, 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n)
    return {"b_A_only": b, "c_B_only": c, "discordant": n, "p": round(p, 5)}


def paired_diff_ci(ids, conf=0.95):
    """配对准确率差 (B−A) 的精确 95% CI。

    条件在不一致对总数 n=b+c 上，对 π=P(不一致偏向B) 做 Clopper-Pearson，
    再映射回准确率差 (2π−1)·n/N。n=0 时退化为三倍法则给出的界。
    """
    from scipy.stats import beta
    N = len(ids)
    b = sum(1 for i in ids if correct(i, "A") and not correct(i, "B"))
    c = sum(1 for i in ids if not correct(i, "A") and correct(i, "B"))
    n = b + c
    point = (c - b) / N
    if n == 0:
        bound = 3 / N  # rule of three
        return {"point_diff": 0.0, "ci95": [-round(bound, 4), round(bound, 4)],
                "method": "rule of three (零不一致对)"}
    a = 1 - conf
    lo = 0.0 if c == 0 else beta.ppf(a / 2, c, n - c + 1)
    hi = 1.0 if c == n else beta.ppf(1 - a / 2, c + 1, n - c)
    return {"point_diff": round(point, 4),
            "ci95": [round((2 * lo - 1) * n / N, 4), round((2 * hi - 1) * n / N, 4)],
            "discordant": n, "method": "Clopper-Pearson on discordant pairs"}


def detection_floor(n_pairs):
    """本设计的检出下限：需要多少不一致对(全同方向)才能 p<0.05，折算成百分点。"""
    from math import comb
    for d in range(1, n_pairs + 1):
        if 2 * (0.5 ** d) < 0.05:
            return {"min_discordant": d, "min_abs_diff_pp": round(100 * d / n_pairs, 1),
                    "p_at_min": round(2 * 0.5 ** d, 4)}
    return {"min_discordant": None, "min_abs_diff_pp": None}


def perm_test_scene(metric_fn, iters=10000):
    """配对置换检验（与上一轮消融同口径）：按场景交换 A/B 标签。"""
    diffs = [metric_fn(rec["id"], "B") - metric_fn(rec["id"], "A") for rec in runs["scenes"]]
    obs = sum(diffs) / len(diffs)
    hits = 0
    for _ in range(iters):
        s = sum(d * random.choice((1, -1)) for d in diffs) / len(diffs)
        if abs(s) >= abs(obs) - 1e-12:
            hits += 1
    return {"observed_diff": round(obs, 4), "p": round((hits + 1) / (iters + 1), 4), "iters": iters}


def scene_acc(sid, arm, cls=None):
    ids = [i for i in all_ids if scene_of[i] == sid and (cls is None or truth_of[i] == cls)]
    return sum(correct(i, arm) for i in ids) / len(ids) if ids else 0.0


# 单臂模式（判官候选对比）没有 A/B 配对——显著性段整个跳过
sig = {} if len(ARMS) < 2 else {
    "mcnemar_planted_false": mcnemar_exact([i for i in all_ids if truth_of[i] == "planted_false"]),
    "mcnemar_supported_by_corpus": mcnemar_exact([i for i in all_ids if truth_of[i] == "supported_by_corpus"]),
    "mcnemar_core_24": mcnemar_exact([i for i in all_ids if truth_of[i] != "true_beyond_corpus"]),
    "mcnemar_all_36": mcnemar_exact(all_ids),
    "ci_planted_false": paired_diff_ci([i for i in all_ids if truth_of[i] == "planted_false"]),
    "ci_core_24": paired_diff_ci([i for i in all_ids if truth_of[i] != "true_beyond_corpus"]),
    "ci_all_36": paired_diff_ci(all_ids),
    "detection_floor": {
        "per_class_n12": detection_floor(12),
        "core_n24": detection_floor(24),
        "all_n36": detection_floor(36),
    },
    "permutation_scene_core": perm_test_scene(
        lambda sid, arm: sum(correct(i, arm) for i in all_ids
                             if scene_of[i] == sid and truth_of[i] != "true_beyond_corpus")
        / max(1, len([i for i in all_ids if scene_of[i] == sid and truth_of[i] != "true_beyond_corpus"]))),
    "permutation_scene_all": perm_test_scene(lambda sid, arm: scene_acc(sid, arm)),
}

# ---------- 噪声地板：同一个判官(GLM-5.2)在两臂里跑同一份 prompt 的自一致性 ----------
# 两臂的 judge1 调用逐字同模型同 prompt、temperature=0，理论上应完全一致。
# 实测不一致的条数 = 单判官重跑噪声，是判断"机制效应"是否可信的地板。

def parse_raw(raw: str):
    try:
        t = raw.strip()
        if t.startswith("```"):
            t = t.split("```")[1].removeprefix("json").strip()
        return json.loads(t).get("claims", []) or []
    except Exception:
        return []


judge1_by_arm = {}
for rec in runs["scenes"]:
    tsc = truth_scenes[rec["id"]]
    for arm in ARMS:
        calls = [c for c in rec["runs"][arm]["calls"] if c.get("tag") == "judge1" and c.get("raw")]
        jc = parse_raw(calls[-1]["raw"]) if calls else []
        for i, k, sc_ in best_assignment(jc, tsc["claims"]):
            if k is not None and sc_ >= MATCH_THRESHOLD:
                judge1_by_arm.setdefault(tsc["claims"][k]["id"], {})[arm] = jc[i].get("verdict")

if len(ARMS) == 2:
    judge1_flips = [{"claim_id": cid, "truth": truth_of[cid],
                     "judge1_in_A": v.get("A"), "judge1_in_B": v.get("B")}
                    for cid, v in sorted(judge1_by_arm.items()) if v.get("A") != v.get("B")]
    noise = {
        "note": "同模型(GLM-5.2)、同 prompt、temperature=0，两臂各跑一次；不一致即重跑噪声",
        "claims_compared": len(judge1_by_arm),
        "self_inconsistent": len(judge1_flips),
        "rate": round(len(judge1_flips) / max(1, len(judge1_by_arm)), 4),
        "flips": judge1_flips,
    }
    # 逐条不一致清单
    disagreements = [{
        "claim_id": i, "scene": scene_of[i], "truth": truth_of[i],
        "A": table[i]["A"], "B": table[i]["B"],
    } for i in all_ids if table[i]["A"] != table[i]["B"]]
    # 交叉验证内部行为：多少条走了 consensus / arbiter
    decided_by = Counter(m.get("decidedBy") for m in match_log
                         if m["arm"] == "B" and m.get("matched"))
    debates = [{"scene": rec["id"], **dbt}
               for rec in runs["scenes"]
               for dbt in ((rec["runs"]["B"].get("audit") or {}).get("debate") or [])]
else:  # 单臂候选对比：A/B 配对量全部不适用
    noise, disagreements, decided_by, debates = {}, [], Counter(), []

result = {
    "meta": {
        "truth_set": str(TRUTH), "runs": str(RUNS),
        "match_rule": "字符 bigram 非对称包含度 |B(judge)∩B(truth)|/|B(judge)|，场景内 4×4 全排列最优一对一指派，阈值 %.2f" % MATCH_THRESHOLD,
        "match_threshold": MATCH_THRESHOLD,
        "n_scenes": len(runs["scenes"]), "n_claims": len(all_ids),
        "class_counts": dict(Counter(truth_of.values())),
    },
    "metrics": metrics,
    "gate": gate,
    "cost": cost,
    "significance": sig,
    "disagreements": disagreements,
    "arm_B_decided_by": dict(decided_by),
    "arm_B_debates": debates,
    "judge1_rerun_noise": noise,
    "spurious_judge_claims": spurious,
    "match_log": match_log,
    "per_claim_table": {i: {"truth": truth_of[i], "scene": scene_of[i], **table[i]} for i in all_ids},
}
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


def demo():
    """最小自检：匹配规则与指标口径。"""
    assert containment("注意力机制有三个核心变量", "注意力机制有三个核心变量：Query、Key 和 Value。") == 1.0
    assert containment("完全不相干的一句话", "注意力机制有三个核心变量") < 0.2
    for arm in ARMS:
        for cls in CLASSES:
            d = metrics[arm]["distributions"][cls]
            assert d["n"] == 12, (arm, cls, d)
            assert sum(d[v] for v in VERDICTS) == 12
    assert set(table) == set(all_ids) and all(set(v) == {"A", "B"} for v in table.values())
    print("self-check ok")


if __name__ == "__main__":
    demo()
    m = metrics
    print(f"匹配阈值 {MATCH_THRESHOLD} | 未匹配(判官未提及) A={sum(1 for i in all_ids if table[i]['A']=='unmatched')} "
          f"B={sum(1 for i in all_ids if table[i]['B']=='unmatched')} | 多余断言 {len(spurious)}")
    print(f"{'指标':<28}{'A 单判官':>12}{'B 交叉验证':>14}")
    for k, lab in [("false_negative_rate", "漏报率(假被放行)"), ("half_miss_rate", "半漏报(判存疑)"),
                   ("planted_false_caught", "植入错误抓获率"), ("false_positive_rate", "硬误报率"),
                   ("over_strict_rate", "过严率"), ("tbc_incorrect_rate", "超纲真断言误判incorrect"),
                   ("overall_accuracy_core", "核心24条准确率"), ("overall_accuracy_all", "全36条准确率")]:
        print(f"{lab:<24}{m['A'][k]:>14.3f}{m['B'][k]:>14.3f}")
    print("\n门禁:", {a: {k: gate[a][k] for k in ('blocked', 'should_block', 'false_block')} for a in ARMS})
    print("成本 mean_ms:", {a: round(cost[a]['mean_ms']) for a in ARMS},
          "calls:", {a: cost[a]['llm_calls'] for a in ARMS},
          "tokens(in/out):", {a: (cost[a]['prompt_tokens'], cost[a]['completion_tokens']) for a in ARMS})
    print("\n显著性:", json.dumps(sig, ensure_ascii=False, indent=1))
    print("\n不一致条目:", json.dumps(disagreements, ensure_ascii=False, indent=1))
    print("arm B decidedBy:", dict(decided_by))
    print("\n判官1重跑噪声:", json.dumps(noise, ensure_ascii=False, indent=1))
    print(f"\nwrote {OUT}")
