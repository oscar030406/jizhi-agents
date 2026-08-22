r"""beginner 档适配失败的机械聚类（零 LLM 调用，只读 run 产物）。

    python scripts/experiments/beginner_failure_taxonomy.py
    python scripts/experiments/beginner_failure_taxonomy.py --selftest

## 为什么不许用 LLM 聚类

判词本身就是判官写的。再叫一个模型去归纳判词，等于在不可复算层上再叠一层——
验收者没法重跑，也没法核对分子分母。所以这里全部用正则规则表，规则写在
`CLUSTERS` 里，命中不了的判词**逐条打印**，覆盖率摆在明面上。

## 三块产出

1. **清点**：目标档 beginner 的用例、命中/失败分子分母、失败例的三判官票。
2. **判词聚类**：口径是「目标 beginner 但某判官投了非 beginner」的那些 because 条目
   （不只是 5 个失败例——24 张异议票里有 13 张来自最终仍命中的用例，
   它们是同一批形态缺陷的更大样本）。
3. **生成物侧的客观佐证**：指标实现直接复用 `scripts/calibrate_adaptation_lint.py`，
   分离度与置换检验复用 `scripts/experiments/advanced_tier_diagnosis.py`——
   不另写一份，否则量到的是两份实现的差。

## 已修/未修的判定方式

本项目不是 git 仓库，时间线只能靠文件 mtime。`timeline()` 打的是
「run 产物落盘时间」对「代码形态两道闸的文件时间」，两者差多少小时是磁盘事实，
不是我们的说法。
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import pathlib
import random
import re
import statistics
import sys

HERE = pathlib.Path(__file__).resolve().parent
ENGINE = HERE.parents[1]
REPO = ENGINE.parents[1]
sys.path.insert(0, str(ENGINE / "scripts"))
sys.path.insert(0, str(HERE))

import advanced_tier_diagnosis as D  # noqa: E402
import calibrate_adaptation_lint as L  # noqa: E402

DEFAULT_RUN = "20260813-001359"
JUDGES = ("judgeA", "judgeB", "judgeC")
SEED = 20260815

#: 判词聚类规则。词面全部取自本 run 的 beginner 异议判词，不是预设分类：
#: 先把 115 条判词打出来读一遍，再把反复出现的说法收成规则（做法与
#: calibrate_adaptation_lint.TERMS 的词表一致——收判官真点过名的那类）。
#: 一条判词可以命中多个簇，簇之间不互斥。
CLUSTERS: list[tuple[str, str, str]] = [
    ("CODE-FORM", "代码结构越纲（import / def / 库调用）",
     r"import|torch|numpy|\bnp\b|pip install|def |函数定义|类定义|列表推导式|库调用"
     r"|使用了\s*[`「'\"]?(?:torch|numpy|PyTorch)|引入了\s*[`「'\"]?(?:torch|numpy)"
     r"|工具包|外部库|未讲过的语法|未在前文介绍|库和函数|import 语句"),
    ("CODE-LEN", "代码长度越界（rubric v2 明文 ≤5 行）",
     r"5\s*行|五行|超出.{0,12}行|超过.{0,12}行|行数|共\s*\d+\s*行|有\s*\d+\s*行|\d+\s*行，|代码.{0,6}\d+\s*行"),
    ("CODE-COMMENT", "注释形态不是逐行大白话（块级说明）",
     r"逐行大白话|逐行注释|逐行配|块级注释|块级说明|注释比|注释为英文|注释不够大白话|教学式逐行"),
    ("TERM-UNDEF", "术语首现无定义、无类比",
     r"无定义|未定义|不定义|没有定义|没有给出定义|未给出定义|未做.{0,8}定义"
     r"|未提供.{0,10}(?:定义|类比)|未解释|不解释|无解释|无任何铺垫|未在.{0,10}定义|直接使用"),
    ("TERM-DENSITY", "术语密度超「单段新术语 ≤2」",
     r"术语.{0,8}(?:较多|密度|过多|多)|单段新术语|不超过\s*2\s*个|术语密集|密集出现.{0,6}术语"),
    ("EXCERPT", "教材摘录原文自带高档姿态，外层类比只是引子",
     r"教材原文|教材引用|引用教材|引用原文|原文引用|内嵌教材|大段引用|引用.{0,6}教材"
     r"|引用的?段落|摘自|教材配套|原文开头|引出教材"),
    ("SCAFFOLD", "缺支架（检查点 / 步骤拆解 / 鼓励语）",
     r"支架|检查点|步骤拆解|鼓励语|鼓励性|手把手|引导语"),
    ("FORMULA", "公式或数学推导直给",
     r"公式|数学推导|数学表达式|推导|手算|数学含义"),
    ("DOMAIN-ENG", "例子/话题落在工程生产域而非生活域",
     r"工程直觉|工程概念|工程术语|工程实践|工程化|生产级|生产环境|非纯生活化|技术场景"
     r"|工程建议|设计权衡|工程权衡|架构|选型|技术细节|专业模块|模块划分"),
    ("PREREQ", "整体前置假设：默认读者会编程 / 有背景",
     r"假设读者|前置知识|前置假设|已具备|需具备|需要读者|暗示读者|假设.{0,6}编程|会编程"
     r"|编程基础|不是完全零基础|超出了.{0,10}边界|背景知识"),
]
COMPILED = [(k, label, re.compile(pat)) for k, label, pat in CLUSTERS]

#: 代码形态两道闸涉及的文件。闸的来源与判据见
#: docs/05-evidence/textbook-code-ladder-20260813.md。
GATE_FILES = [
    ("apps/agent-engine/backend/integration/personalize_api.py", "检索闸 beginner_code_form 入参"),
    ("apps/classroom/lib/generation/evidence-grounding.ts", "classroom 侧把 beginner_code_form 传给引擎"),
    ("apps/classroom/lib/generation/learner-profile.ts", "beginnerCodeFormOnly() 判定谁走这道闸"),
    ("apps/classroom/tests/generation/adaptation-lint-code-form.test.ts", "L1-CODE-FORM 的专属回归"),
    ("docs/05-evidence/textbook-code-ladder-20260813.md", "闸的外部判据（九份教材配套源码）"),
]


def tag(text: str) -> list[str]:
    return [k for k, _, rx in COMPILED if rx.search(text)]


def load_verdicts(run: str) -> list[dict]:
    path = ENGINE / "data/eval/adaptation_probe/runs" / run / "verdicts.jsonl"
    return [json.loads(l) for l in path.open(encoding="utf-8") if l.strip()]


def mtime(p: pathlib.Path) -> dt.datetime:
    return dt.datetime.fromtimestamp(p.stat().st_mtime)


# ---------------------------------------------------------------- 1. 清点
def census(rows: list[dict]) -> list[dict]:
    beg = [r for r in rows if r["target"] == "beginner"]
    hit = [r for r in beg if r["hit"] == 1]
    miss = [r for r in beg if r["hit"] != 1]
    print(f"### 1. 清点｜目标档 beginner\n")
    print(f"命中 {len(hit)}/{len(beg)}，失败 {len(miss)}/{len(beg)}")
    per = collections.Counter(r["target"] for r in rows)
    for t in ("beginner", "transition", "advanced"):
        sub = [r for r in rows if r["target"] == t]
        print(f"  对照 {t:<11} {sum(1 for r in sub if r['hit'] == 1)}/{per[t]}")
    print("\n失败例逐条（判官票 / 最终判定）：")
    for r in sorted(miss, key=lambda x: x["caseId"]):
        votes = " ".join(f"{j[-1]}={r[j]['tier']}" for j in JUDGES)
        print(f"  {r['caseId']:<18} final={str(r['final']):<12} status={r['status']:<18} {votes}")
    return miss


# ---------------------------------------------------------------- 2. 聚类
def dissent(rows: list[dict]) -> list[tuple[str, str, int, str]]:
    """(caseId, judge, hit, because) —— 目标 beginner 但该判官投了非 beginner。"""
    out = []
    for r in rows:
        if r["target"] != "beginner":
            continue
        for j in JUDGES:
            if r[j]["tier"] == "beginner":
                continue
            for b in r[j]["because"]:
                out.append((r["caseId"], j, r["hit"], b))
    return out


def cluster(items: list[tuple[str, str, int, str]]) -> None:
    n_votes = len({(c, j) for c, j, _, _ in items})
    fail_ids = {c for c, _, h, _ in items if h != 1}
    print(f"\n### 2. 判词机械聚类｜{n_votes} 张异议票、{len(items)} 条判词\n")
    print(f"{'簇':<15}{'判词':>6}{'涉及用例':>10}{'其中失败例':>12}  失败例")
    print("-" * 92)
    uncovered: list[tuple[str, str, int, str]] = []
    rows_out = []
    for cid, j, hit, b in items:
        ts = tag(b)
        if not ts:
            uncovered.append((cid, j, hit, b))
        rows_out.append((cid, j, hit, b, ts))
    for k, label, _ in COMPILED:
        sub = [x for x in rows_out if k in x[4]]
        cases = {x[0] for x in sub}
        fails = sorted(cases & fail_ids)
        print(f"{k:<15}{len(sub):>6}{len(cases):>10}{len(fails):>12}  {'、'.join(fails) or '—'}")
        print(f"{'':<15}{label}")
    covered = len(items) - len(uncovered)
    print(f"\n覆盖率 {covered}/{len(items)} = {covered / len(items):.1%}；未归类 {len(uncovered)} 条逐条列出：")
    for cid, j, hit, b in uncovered:
        print(f"  [{cid} {j[-1]} hit={hit}] {b}")

    fail_items = [x for x in rows_out if x[2] != 1]
    fv = len({(x[0], x[1]) for x in fail_items})
    print(f"\n只算失败例的判词（工单口径）：{len(fail_ids)} 例、"
          f"{fv} 张异议票（{len(fail_ids) * 3} 张票里 {len(fail_ids) * 3 - fv} 张投了 beginner）、"
          f"{len(fail_items)} 条判词")
    print(f"{'簇':<15}{'判词':>6}{'用例':>6}  用例")
    print("-" * 70)
    for k, _, _ in COMPILED:
        sub = [x for x in fail_items if k in x[4]]
        cases = sorted({x[0] for x in sub})
        if not sub:
            continue
        print(f"{k:<15}{len(sub):>6}{len(cases):>6}  {'、'.join(cases)}")


def quotes(rows: list[dict], key: str, limit: int = 2) -> None:
    """每簇打两条原文判词，供文档摘引 + grep 回原文件核对。"""
    items = dissent(rows)
    print(f"\n### 2b. 每簇的代表性判词原文（各 {limit} 条，可 grep verdicts.jsonl 核对）\n")
    for k, label, _ in COMPILED:
        hits = [x for x in items if k in tag(x[3])]
        hits.sort(key=lambda x: (x[2], x[0]))  # 失败例优先
        print(f"[{k}] {label}")
        for cid, j, hit, b in hits[:limit]:
            print(f"  · {cid}／{j[-1]}／hit={hit}：{b}")
        print()


# ---------------------------------------------------------------- 3. 生成物佐证
BEYOND_BEGINNER_FORM = re.compile(r"^\s*(?:from\s+\S+\s+import\s|import\s|def\s|class\s|@\w)")
FEATURES = ["excerpt_share", "undef_term_n", "uniq_term_per100", "code_lines", "bare_symbol_n"]


def features(run: str) -> list[dict]:
    rows = L.load(run, zone="full")
    out = []
    for r in rows:
        if r["target"] != "beginner":
            continue
        m = L.metrics(r["full"])
        seg = L.segment(r["full"])
        form = [
            (row["no"], row["raw"].strip(), row["excerpt"])
            for row in seg
            if row["zone"] == "code" and BEYOND_BEGINNER_FORM.search(row["raw"])
        ]
        out.append(
            {
                "case": r["case"],
                "hit": r["hit"],
                "form": form,
                "excerpt_share": m["_excerpt_chars"] / max(m["chars"], 1),
                "undef_term_n": m["undef_term_n"],
                "uniq_term_per100": m["uniq_term_per100"],
                "code_lines": m["code_lines"],
                "bare_symbol_n": m["bare_symbol_n"],
            }
        )
    return out


def evidence(feat: list[dict]) -> None:
    hit = [f for f in feat if f["hit"] == 1]
    miss = [f for f in feat if f["hit"] != 1]
    rng = random.Random(SEED)
    print(f"\n### 3. 生成物侧的机械佐证｜miss {len(miss)} vs hit {len(hit)}（置换 {D.PERM_N} 次）\n")
    print(f"{'指标':<20}{'sep':>6}{'置换p':>8}{'hit中位':>10}{'miss中位':>10}")
    print("-" * 56)
    for k in FEATURES:
        h = [f[k] for f in hit]
        f_ = [f[k] for f in miss]
        s = D.sep(D.auc(f_, h))
        p = D.perm_p(f_, h, s, rng)
        print(f"{k:<20}{s:>6.2f}{p:>8.3f}{statistics.median(h):>10.2f}{statistics.median(f_):>10.2f}")
    print(f"\n  注：同时看了 {len(FEATURES)} 个指标，最小 p 要按这个数打折读（Bonferroni 上界 = p×{len(FEATURES)}）。")

    print("\n代码结构越纲（import / def / class / 装饰器）的逐行定位：")
    for f in sorted(feat, key=lambda x: (x["hit"] == 1, x["case"])):
        if not f["form"]:
            continue
        zone_n = collections.Counter("摘录区" if e else "自撰区" for _, _, e in f["form"])
        mark = "失败" if f["hit"] != 1 else "命中"
        print(f"  [{mark}] {f['case']:<20} {dict(zone_n)}")
        for no, raw, ex in f["form"]:
            print(f"        L{no:<4} {'摘录' if ex else '自撰'}  {raw[:70]}")
    own = [f for f in feat if any(not e for _, _, e in f["form"])]
    print(f"  合计：自撰区出现越纲结构的 {len(own)}/{len(feat)} 例"
          f"（其中失败例 {sum(1 for f in own if f['hit'] != 1)}/{len(miss)}）")
    ex_any = sum(1 for f in feat if any(e for _, _, e in f["form"]))
    print(f"  摘录区出现越纲结构的 {ex_any}/{len(feat)} 例")


# ---------------------------------------------------------------- 4. 时间线
def timeline(run: str) -> None:
    run_dir = ENGINE / "data/eval/adaptation_probe/runs" / run
    res_dir = ENGINE / "data/eval/adaptation_probe/resources"
    verdict_t = mtime(run_dir / "verdicts.jsonl")
    res_t = max(mtime(p) for p in res_dir.glob("*.json"))
    print(f"\n### 4. 时间线｜已修/未修的判据（本项目不是 git 仓库，只能用 mtime）\n")
    print(f"  资源最后落盘  {res_t:%Y-%m-%d %H:%M:%S}  {res_dir.relative_to(REPO)}/*.json")
    print(f"  判词落盘      {verdict_t:%Y-%m-%d %H:%M:%S}  {(run_dir / 'verdicts.jsonl').relative_to(REPO)}")
    print()
    for rel, why in GATE_FILES:
        p = REPO / rel
        if not p.exists():
            print(f"  [缺失] {rel}")
            continue
        t = mtime(p)
        d = (t - res_t).total_seconds() / 3600
        print(f"  {t:%Y-%m-%d %H:%M:%S}  资源落盘后 {d:+6.1f}h  {rel}")
        print(f"  {'':<19}  {why}")
    print("\n  读法：闸文件全部晚于资源落盘 = 主 run 的生成发生在闸上线之前，"
          "CODE-FORM 那一簇的缺陷在当时无人拦。")


# ---------------------------------------------------------------- selftest
def selftest() -> None:
    assert tag("代码部分使用了 `torch` 库") == ["CODE-FORM"] or "CODE-FORM" in tag("代码部分使用了 `torch` 库")
    assert "EXCERPT" in tag("大段引用教材原文直接使用 Agent Loop")
    assert "SCAFFOLD" in tag("无鼓励性支架，直接进入技术内容")
    assert "CODE-COMMENT" in tag("而非 beginner 要求的逐行大白话")
    assert tag("这是一句与任何簇都无关的话") == []
    rows = load_verdicts(DEFAULT_RUN)
    beg = [r for r in rows if r["target"] == "beginner"]
    assert len(beg) == 36, len(beg)
    assert sum(1 for r in beg if r["hit"] == 1) == 31
    items = dissent(rows)
    assert len({(c, j) for c, j, _, _ in items}) == 24, "异议票数变了"
    assert len(items) == 115, len(items)
    cov = sum(1 for x in items if tag(x[3]))
    assert cov / len(items) > 0.9, cov
    fail = [x for x in items if x[2] != 1]
    assert len({(x[0], x[1]) for x in fail}) == 11, "失败例异议票数变了"
    assert len(fail) == 50, len(fail)
    print(f"selftest ok（beginner 31/36、异议票 24 张 115 条、其中失败例 11 张 50 条、"
          f"聚类覆盖 {cov}/{len(items)}）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=DEFAULT_RUN)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return 0
    print(f"run={args.run}｜零 LLM 调用，全部读自 runs/{args.run}/ 与 resources/\n")
    rows = load_verdicts(args.run)
    census(rows)
    cluster(dissent(rows))
    quotes(rows, args.run)
    evidence(features(args.run))
    timeline(args.run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
