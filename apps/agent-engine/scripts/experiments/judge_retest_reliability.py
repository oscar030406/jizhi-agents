"""判官重测信度（test-retest）实验。设计预注册于
data/eval/adaptation_probe/blind_rubric.md §判官重测信度实验，跑之前已写死。

测的不是产品分数，是尺子本身晃多厉害：同一份资源、同一 SYSTEM、同一 temperature，
喂给同一个判官 3 次，看它给不给同一个档。唯一的自变量是采样噪声。

判官调用**复用** scripts/judge_adaptation_probe.py 的 judge()/SYSTEM/解析重试，
不另写一份——否则测出来的是两份代码的差，不是判官的抖动。

跑法（剥代理由 judge() 内部的 session.trust_env=False 保证）：
  python scripts/experiments/judge_retest_reliability.py            # 跑满 486 次，断点续跑
  python scripts/experiments/judge_retest_reliability.py --resume <ts>   # 续某一批
  python scripts/experiments/judge_retest_reliability.py --analyze <ts>  # 只重算统计
  python scripts/experiments/judge_retest_reliability.py --selftest      # 统计口径自检
产物 data/eval/adaptation_probe/reliability/<ts>/{calls.jsonl,reliability_report.json,REPORT.md}
"""

from __future__ import annotations

import argparse
import json
import pathlib
import statistics
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))

from judge_adaptation_probe import (  # noqa: E402
    JUDGE_A,
    JUDGE_B,
    JUDGE_C,
    PROBE,
    TIERS,
    USAGE,
    fleiss_kappa,
    judge,
    load_key,
)

JUDGES = {"A": JUDGE_A, "B": JUDGE_B, "C": JUDGE_C}
ROUNDS = (1, 2, 3)
OUT_ROOT = PROBE / "reliability"
BASELINE_RUN = "20260811-010557"   # 主口径 v2 那一批，用来把它的 miss 落进四分类

_local = threading.local()
_write_lock = threading.Lock()


def session() -> requests.Session:
    """每线程一个 Session。requests.Session 不保证线程安全，共用会串 header/连接池。"""
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.trust_env = False   # 剥代理直连（siliconflow-clash-bypass 纪律）
        _local.s = s
    return s


# ---------------------------------------------------------------- 采集


def collect(run_dir: pathlib.Path, workers: int, limit: int) -> None:
    cases = sorted((PROBE / "resources").glob("*.json"))
    if limit:
        cases = cases[:limit]
    if not cases:
        raise SystemExit("resources/ 为空")

    path = run_dir / "calls.jsonl"
    done: set[tuple[str, str, int]] = set()
    if path.exists():
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            if r.get("tier"):          # 只认拿到合法档位的；失败的下次重跑
                done.add((r["caseId"], r["judge"], r["round"]))
        print(f"续跑：已有 {len(done)} 条有效判词")

    tasks = [
        (json.load(open(f, encoding="utf-8")), jk, rd)
        for rd in ROUNDS
        for jk in JUDGES
        for f in cases
        if (f.stem, jk, rd) not in done
    ]
    print(f"{len(cases)} 例 × {len(JUDGES)} 判官 × {len(ROUNDS)} 轮 → 待跑 {len(tasks)} 次调用")
    if not tasks:
        return

    key = load_key()
    out = open(path, "a", encoding="utf-8")
    counter = {"n": 0}
    t0 = time.time()

    def work(task):
        case, jk, rd = task
        v, err = judge(session(), key, JUDGES[jk], case["text"], attempts=3)
        rec = {
            "caseId": case["caseId"],
            "target": case["tier"],
            "judge": jk,
            "model": JUDGES[jk],
            "round": rd,
            "tier": (v or {}).get("tier"),
            "borderline": (v or {}).get("borderline"),
            "parse_mode": (v or {}).get("parse_mode", "direct" if v else None),
            "error": err,
            "ts": time.strftime("%H:%M:%S"),
        }
        with _write_lock:                      # 即时落盘：断了不丢已花的钱
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            counter["n"] += 1
            n = counter["n"]
        if n % 20 == 0 or n == len(tasks):
            el = time.time() - t0
            print(f"  {n}/{len(tasks)} 用时 {el/60:.1f} 分，预计还需 "
                  f"{el / n * (len(tasks) - n) / 60:.1f} 分，token {USAGE['calls']} 次计入")
        return rec

    with ThreadPoolExecutor(max_workers=workers) as ex:
        list(ex.map(work, tasks))
    out.close()
    print(f"采集完成：{USAGE['calls']} 次成功计费调用，"
          f"prompt {USAGE['prompt_tokens']}，completion {USAGE['completion_tokens']}")


# ---------------------------------------------------------------- 统计


def modal(votes: list[str]) -> tuple[str | None, int]:
    """众数与其票数。平局（如 3 轮全不同）返回 (None, 1)——不许随便挑一个当代表。"""
    if not votes:
        return None, 0
    c = Counter(votes).most_common()
    if len(c) > 1 and c[0][1] == c[1][1]:
        return None, c[0][1]
    return c[0][0], c[0][1]


def per_judge_stats(rows: list[dict], jk: str, cases: dict[str, str]) -> dict:
    """统计量 1–5：重测一致率、众数稳定性、轮间准确率极差、组内 Fleiss、不稳定用例。"""
    mine = [r for r in rows if r["judge"] == jk]
    by_case: dict[str, dict[int, dict]] = {}
    for r in mine:
        if r["tier"]:
            by_case.setdefault(r["caseId"], {})[r["round"]] = r

    complete = {c: v for c, v in by_case.items() if len(v) == len(ROUNDS)}
    votes = {c: [v[rd]["tier"] for rd in ROUNDS] for c, v in complete.items()}

    unanimous = [c for c, vs in votes.items() if len(set(vs)) == 1]
    flips = sorted(c for c, vs in votes.items() if len(set(vs)) > 1)
    modal_counts = Counter(modal(vs)[1] for vs in votes.values())

    per_round = {}
    for rd in ROUNDS:
        got = [r for r in mine if r["round"] == rd and r["tier"]]
        hit = sum(1 for r in got if r["tier"] == r["target"])
        per_round[rd] = {
            "n_valid": len(got),
            # 分母是全体 54（invalid 记 0），与主准确率同口径
            "accuracy": hit / len(cases) if cases else None,
            "hits": hit,
        }
    accs = [per_round[rd]["accuracy"] for rd in ROUNDS]

    # 「翻档的例子里判官自称有把握的占多少」——检验 borderline 自评是否可信
    flip_conf = [c for c in flips
                 if not any(complete[c][rd].get("borderline") for rd in ROUNDS)]
    border_any = [c for c in complete if any(complete[c][rd].get("borderline") for rd in ROUNDS)]
    border_flip = [c for c in border_any if c in flips]

    return {
        "model": JUDGES[jk],
        "n_cases_complete": len(complete),
        "n_cases_incomplete": len(cases) - len(complete),
        "retest_unanimous_n": len(unanimous),
        "retest_unanimous_rate": len(unanimous) / len(complete) if complete else None,
        "modal_vote_distribution": {f"{k}/3": v for k, v in sorted(modal_counts.items(), reverse=True)},
        "mean_modal_share": (sum(modal(vs)[1] for vs in votes.values()) / (3 * len(votes)))
        if votes else None,
        "per_round_accuracy": {str(rd): per_round[rd] for rd in ROUNDS},
        "accuracy_range_pp": (max(accs) - min(accs)) * 100 if all(a is not None for a in accs) else None,
        "accuracy_mean": statistics.fmean(accs) if all(a is not None for a in accs) else None,
        "intra_rater_fleiss": fleiss_kappa([votes[c] for c in sorted(votes)]),
        "unstable_cases": flips,
        "unstable_cases_self_confident": flip_conf,
        "unstable_confident_rate": len(flip_conf) / len(flips) if flips else None,
        "borderline_any_round_n": len(border_any),
        "borderline_flip_rate": len(border_flip) / len(border_any) if border_any else None,
        "nonborderline_flip_rate": (len(flip_conf) / (len(complete) - len(border_any)))
        if len(complete) > len(border_any) else None,
        "call_failures": sum(1 for r in mine if not r["tier"]),
    }


def analyze(run_dir: pathlib.Path) -> dict:
    rows = [json.loads(l) for l in open(run_dir / "calls.jsonl", encoding="utf-8")]
    # 同一 (case, judge, round) 若因续跑重复出现，取最后一条成功的
    dedup: dict[tuple, dict] = {}
    for r in rows:
        k = (r["caseId"], r["judge"], r["round"])
        if r["tier"] or k not in dedup:
            dedup[k] = r
    rows = list(dedup.values())
    cases = {r["caseId"]: r["target"] for r in rows}

    per_judge = {jk: per_judge_stats(rows, jk, cases) for jk in JUDGES}

    # 每位判官的去噪一票 = 3 轮众数（三轮全不同 → None）
    denoised: dict[str, dict[str, str | None]] = {}
    for jk in JUDGES:
        vs: dict[str, list[str]] = {}
        for r in rows:
            if r["judge"] == jk and r["tier"]:
                vs.setdefault(r["caseId"], []).append(r["tier"])
        denoised[jk] = {c: (modal(v)[0] if len(v) == len(ROUNDS) else None) for c, v in vs.items()}

    pairwise = {}
    for x, y in (("A", "B"), ("A", "C"), ("B", "C")):
        both = [c for c in cases if denoised[x].get(c) and denoised[y].get(c)]
        pairwise[x + y] = {
            "n": len(both),
            "raw_agreement": sum(denoised[x][c] == denoised[y][c] for c in both) / len(both)
            if both else None,
        }
    tri = [c for c in sorted(cases) if all(denoised[j].get(c) for j in JUDGES)]
    cross_fleiss = fleiss_kappa([[denoised[j][c] for j in JUDGES] for c in tri])

    # 统计量 7：四分类。judge-unstable 优先——判官自己都晃，谈不上产品证据。
    buckets: dict[str, list[str]] = {k: [] for k in
                                     ("judge_unstable", "stable_wrong", "stable_right",
                                      "cross_judge_split", "incomplete")}
    detail = {}
    for c in sorted(cases):
        unstable = [j for j in JUDGES if c in per_judge[j]["unstable_cases"]]
        miss_data = [j for j in JUDGES if per_judge[j]["n_cases_complete"] and not denoised[j].get(c)
                     and c not in per_judge[j]["unstable_cases"]]
        tiers = {j: denoised[j].get(c) for j in JUDGES}
        if unstable:
            b = "judge_unstable"
        elif miss_data:
            b = "incomplete"
        elif len(set(tiers.values())) > 1:
            b = "cross_judge_split"
        elif next(iter(tiers.values())) == cases[c]:
            b = "stable_right"
        else:
            b = "stable_wrong"
        buckets[b].append(c)
        detail[c] = {"target": cases[c], "bucket": b, "unstable_judges": unstable, "modal": tiers}

    out = {
        "run": run_dir.name,
        "computed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "design": "blind_rubric.md §判官重测信度实验（预注册）",
        "n_cases": len(cases),
        "rounds": len(ROUNDS),
        "n_calls_recorded": len(rows),
        "per_judge": per_judge,
        "cross_judge_on_denoised_modal": {
            "pairwise_raw_agreement": pairwise,
            "fleiss_kappa": cross_fleiss,
            "n_all_three_denoised": len(tri),
        },
        "case_buckets": {k: {"n": len(v), "cases": v} for k, v in buckets.items()},
        "case_detail": detail,
        "token_usage": dict(USAGE),
    }

    base = PROBE / "runs" / BASELINE_RUN / "verdicts.jsonl"
    if base.exists():
        misses = [json.loads(l) for l in open(base, encoding="utf-8")]
        miss_ids = [r["caseId"] for r in misses if not r.get("hit")]
        out["baseline_miss_breakdown"] = {
            "run": BASELINE_RUN,
            "miss_n": len(miss_ids),
            "by_bucket": {b: [c for c in miss_ids if detail.get(c, {}).get("bucket") == b]
                          for b in buckets},
        }
    return out


def render(rep: dict) -> str:
    L = [f"# 判官重测信度实验 {rep['run']}", "",
         f"设计预注册：{rep['design']}。{rep['n_cases']} 例 × 3 判官 × {rep['rounds']} 轮 "
         f"= {rep['n_calls_recorded']} 次调用。同一输入、同一 SYSTEM、同一 temperature=0.1，"
         "唯一变量是采样噪声。", "",
         "## 1–4 每判官", "",
         "| 判官 | 模型 | 重测一致率 | 众数票数分布 | 轮间准确率（1/2/3） | 极差 | 组内 Fleiss | 调用失败 |",
         "|---|---|---|---|---|---|---|---|"]
    for jk, d in rep["per_judge"].items():
        accs = "/".join(f"{d['per_round_accuracy'][str(r)]['accuracy']:.1%}" for r in ROUNDS)
        fk = d["intra_rater_fleiss"]["kappa"]
        L.append(f"| {jk} | `{d['model']}` | **{d['retest_unanimous_rate']:.1%}** "
                 f"({d['retest_unanimous_n']}/{d['n_cases_complete']}) | "
                 f"{d['modal_vote_distribution']} | {accs} | "
                 f"{d['accuracy_range_pp']:.1f} pp | "
                 f"{'不可定义' if fk is None else f'{fk:.3f}'} | {d['call_failures']} |")
    L += ["", "## 5 不稳定用例（3 轮内部就不一致）", ""]
    for jk, d in rep["per_judge"].items():
        L.append(f"- **判官 {jk}**（{len(d['unstable_cases'])} 例）：{d['unstable_cases']}")
        L.append(f"  其中三轮都自称非 borderline 的 {len(d['unstable_cases_self_confident'])} 例"
                 f"（占翻档例 {d['unstable_confident_rate']:.0%}）"
                 if d["unstable_cases"] else "  —")
    cj = rep["cross_judge_on_denoised_modal"]
    fk = cj["fleiss_kappa"]["kappa"]
    L += ["", "## 6 跨判官（用各自 3 轮众数去噪后的一票）", "",
          "两两原始一致率：" + "、".join(
              f"{k}={v['raw_agreement']:.1%}" for k, v in cj["pairwise_raw_agreement"].items()
              if v["raw_agreement"] is not None),
          "", f"三判官 Fleiss kappa = {'不可定义' if fk is None else f'{fk:.3f}'}"
          f"（{cj['n_all_three_denoised']} 例三方去噪票齐全）", "",
          "## 7 54 例四分类", "",
          "| 类别 | n | 含义 |", "|---|---|---|"]
    meaning = {
        "judge_unstable": "至少一位判官自己跟自己不一致 → **判官抖动，不是产品证据**",
        "stable_wrong": "三判官各自稳定且三方一致，但一致判到非目标档 → **产品真不适配的证据**",
        "stable_right": "三判官稳定且一致命中目标档",
        "cross_judge_split": "各自稳定但三家互不同意 → 判官间系统性偏置（与采样噪声是两回事）",
        "incomplete": "三轮判词不齐（调用失败），不进任何结论",
    }
    for b, d in rep["case_buckets"].items():
        L.append(f"| {b} | {d['n']} | {meaning[b]} |")
    for b, d in rep["case_buckets"].items():
        if d["cases"]:
            L.append(f"\n- `{b}`：{d['cases']}")
    if "baseline_miss_breakdown" in rep:
        bm = rep["baseline_miss_breakdown"]
        L += ["", f"## 8 主口径 run {bm['run']} 的 {bm['miss_n']} 例 miss 落在哪一类", ""]
        for b, cs in bm["by_bucket"].items():
            if cs:
                L.append(f"- **{b}**（{len(cs)}）：{cs}")
    u = rep["token_usage"]
    L += ["", "## 成本实测", "",
          f"{u['calls']} 次成功计费调用，prompt {u['prompt_tokens']:,} + "
          f"completion {u['completion_tokens']:,} = "
          f"{u['prompt_tokens'] + u['completion_tokens']:,} token。"]
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- 自检


def selftest() -> None:
    assert modal(["a", "a", "b"]) == ("a", 2)
    assert modal(["a", "a", "a"]) == ("a", 3)
    assert modal(["a", "b", "c"]) == (None, 1)      # 三轮全不同不许挑一个当代表
    assert modal(["a", "a", "b", "b"]) == (None, 2)  # 平局同理
    assert modal([]) == (None, 0)

    cases = {"x": "beginner", "y": "advanced", "z": "transition"}

    def row(c, j, r, t, border=False):
        return {"caseId": c, "target": cases[c], "judge": j, "round": r,
                "tier": t, "borderline": border}

    rows = []
    # 判官 A：x 稳定命中；y 三轮翻档且自称有把握；z 稳定但判错
    for r in ROUNDS:
        rows.append(row("x", "A", r, "beginner"))
        rows.append(row("z", "A", r, "beginner"))
    for r, t in zip(ROUNDS, ("advanced", "transition", "advanced")):
        rows.append(row("y", "A", r, t))
    # 判官 B/C：全稳定，x/z 与 A 同判，y 一致判 advanced
    for j in ("B", "C"):
        for r in ROUNDS:
            rows.append(row("x", j, r, "beginner"))
            rows.append(row("z", j, r, "beginner"))
            rows.append(row("y", j, r, "advanced"))

    sA = per_judge_stats(rows, "A", cases)
    assert sA["retest_unanimous_rate"] == 2 / 3, sA["retest_unanimous_rate"]
    assert sA["unstable_cases"] == ["y"] and sA["unstable_cases_self_confident"] == ["y"]
    assert sA["modal_vote_distribution"] == {"3/3": 2, "2/3": 1}
    # 轮次准确率：r1 x✓y✓z✗=2/3、r2 x✓y✗z✗=1/3、r3 同 r1 → 极差 33.3pp
    assert sA["per_round_accuracy"]["2"]["hits"] == 1, sA["per_round_accuracy"]
    assert abs(sA["accuracy_range_pp"] - 100 / 3) < 1e-9, sA["accuracy_range_pp"]
    sB = per_judge_stats(rows, "B", cases)
    assert sB["retest_unanimous_rate"] == 1.0 and sB["unstable_cases"] == []

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        d = pathlib.Path(td)
        with open(d / "calls.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        rep = analyze(d)
    bk = rep["case_buckets"]
    assert bk["judge_unstable"]["cases"] == ["y"], bk        # A 晃 → y 归判官抖动
    assert bk["stable_right"]["cases"] == ["x"], bk
    assert bk["stable_wrong"]["cases"] == ["z"], bk          # 三家稳定一致判错 → 产品证据
    assert bk["cross_judge_split"]["n"] == 0
    # 去噪后 A 的 y 众数=advanced，与 B/C 相同 → 两两一致率 100%
    assert rep["cross_judge_on_denoised_modal"]["pairwise_raw_agreement"]["AB"]["raw_agreement"] == 1.0
    render(rep)   # 渲染不许炸
    print("selftest ok")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--resume", default="", help="续跑已有批次目录名")
    ap.add_argument("--analyze", default="", help="只重算统计，不调 API")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 例（冒烟用）")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    name = args.analyze or args.resume or time.strftime("%Y%m%d-%H%M%S")
    run_dir = OUT_ROOT / name
    run_dir.mkdir(parents=True, exist_ok=True)

    if not args.analyze:
        collect(run_dir, args.workers, args.limit)

    rep = analyze(run_dir)
    json.dump(rep, open(run_dir / "reliability_report.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    (run_dir / "REPORT.md").write_text(render(rep), encoding="utf-8")
    for jk, d in rep["per_judge"].items():
        print(f"判官 {jk} 重测一致 {d['retest_unanimous_rate']:.1%}"
              f"（{d['retest_unanimous_n']}/{d['n_cases_complete']}），"
              f"轮间准确率极差 {d['accuracy_range_pp']:.1f} pp")
    print({k: v["n"] for k, v in rep["case_buckets"].items()})
    print(f"落盘 {run_dir}")


if __name__ == "__main__":
    main()
