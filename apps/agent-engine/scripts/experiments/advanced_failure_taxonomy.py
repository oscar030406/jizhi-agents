r"""advanced 档适配失败的机械聚类（零 LLM 调用，只读 run 产物）。

    python scripts/experiments/advanced_failure_taxonomy.py
    python scripts/experiments/advanced_failure_taxonomy.py --selftest

A2（`beginner_failure_taxonomy.py`）的同款方法论，换一档。能 import 的一律 import：

- 判词读取 / run 常量 / 判官名        ← `beginner_failure_taxonomy`
- 分离度 sep、AUC、置换检验         ← `advanced_tier_diagnosis`
- 全部机械指标                       ← `calibrate_adaptation_lint`

只有「聚类规则表」是本档新写的——**因为漂移方向是反的**。beginner 的 5 个失败例全部
被判成更高档（判词在数落「太难了」）；advanced 的 7 个失败例全部被判成 transition，
判词在数落「还不够 advanced」：有简短定义、有类比、代码配了块级说明、教材引用当缓冲。
拿 A2 的词表来跑这一档会全表空转，所以规则表重写，做法照旧：先把 110 条判词全部打印
出来读一遍，再把反复出现的说法收成正则。

## 两个家族，不许混在一张表里

读判词会发现一半以上的条目根本不是失败原因。判官投 transition 时，`because` 数组里
同时装着两种论证：

- **降档理由**（DOWN-*）：为什么不是 advanced —— 这才是失败原因。
- **排除 beginner**（EXCL-*）：为什么也不是 beginner —— 「假设读者会编程」「无鼓励语支架」
  「直接讨论生产取舍」。这些是 advanced 档的**正面特征**，把它们算进失败原因会反着修。

所以两张表分开打，覆盖率也分开报。A2 §2.4 已经踩过一次「判词条数 ≠ 缺陷条数」，
这一档上它不是零头，是结构性的。
"""

from __future__ import annotations

import argparse
import collections
import random
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import advanced_tier_diagnosis as D  # noqa: E402
import beginner_failure_taxonomy as B  # noqa: E402
import calibrate_adaptation_lint as L  # noqa: E402

RUN = B.DEFAULT_RUN
JUDGES = B.JUDGES
SEED = 20260815
TIER = "advanced"

#: 降档理由：判官说「这是 transition 不是 advanced」时给的形态依据。
#: 词面全部取自本 run 的 advanced 异议判词。一条判词可命中多个簇，簇之间不互斥。
DOWN: list[tuple[str, str, str]] = [
    ("DOWN-DEF", "术语给了（简短）定义或概念铺垫，不是 advanced 的「直接使用不定义」",
     r"简短定义|简短的定义|简短地?定义|做了定义|给出了?定义|进行了?(?:简短)?定义"
     r"|基础定义|术语适度|定义与类比|有定义|概念铺垫|机制铺垫|基础概念梳理|概念梳理"
     r"|做了简短|简要解释|简短解释|简短说明|语境解释"),
    ("DOWN-ANALOGY", "生活化类比 / 工程直觉类比在场",
     r"类比|生活化|就像|好比|比作|具象化|直觉解释|建立直觉|工程直觉|降低了?理解门槛"),
    ("DOWN-BLOCKNOTE", "代码配了块级说明，不是 advanced 的无注释生产代码",
     r"块级说明|块级注释|块级功能说明|配块级|函数级说明|一段块级|块级"),
    ("DOWN-EXCERPT", "教材引用/原文在场，当了背景缓冲",
     r"教材|引用原文|原文引用|大段引用|摘自|引用了?《|引用段落|引用的?段落"),
    ("DOWN-BUILDUP", "仍在做基础讲解 / 公式逐步展开，没进到机制取舍",
     r"逐步(?:展开|扩展|递进)|从标量到|基础公式|基础讲解|仍在为读者|仍保留"
     r"|未深入|而非深入|未达到|未完全达到|未直接进入|未进入|没有?深入|不属 advanced"
     r"|非生产级|而非 advanced|排除了 ['‘]?advanced|先.{0,6}直觉|先建立"),
]

#: 排除 beginner 的理由：advanced 档的正面特征，**不是失败原因**。
EXCL: list[tuple[str, str, str]] = [
    ("EXCL-CODING", "假设读者具备编程基础 / 代码不做新手拆解",
     r"假设读者|具备编程基础|已具备编程|会编程|编程基础|前置知识|前置假设"
     r"|不符合 beginner|超出了? ?['‘]?beginner|排除了? ?['‘]?beginner"
     r"|而非(?:完全)?零基础|非零基础|不会编程的人|新手式|初学者"),
    ("EXCL-NOSCAFFOLD", "无 beginner 支架（步骤拆解 / 检查点 / 鼓励语）",
     r"支架|检查点|步骤拆解|鼓励语|鼓励性|手把手|引导型|密集引导"),
    ("EXCL-PROD", "直接讨论生产场景 / 工程取舍 / 架构",
     r"生产环境|生产级|生产场景|生产实现|工程取舍|工程权衡|权衡|取舍|架构"
     r"|工程实践|工程细节|工程实现|工程化|工程指标|系统设计|参数调优|SLA|吞吐|显存"),
    ("EXCL-TERMRAW", "部分术语直接使用不定义（advanced 的正面特征）",
     r"直接使用|未定义|无定义|未做任何定义|未加解释|未再解释|不做基础科普"
     r"|未展开定义|未对.{0,12}(?:定义|解释)|无(?:任何)?铺垫"),
]
CD = [(k, lab, re.compile(p)) for k, lab, p in DOWN]
CE = [(k, lab, re.compile(p)) for k, lab, p in EXCL]

#: 否定守卫。判官频繁写「全文**无**生活化类比」「**未**做通俗类比或定义」——词面命中、
#: 语义相反。不加这道守卫，DOWN-ANALOGY 会把 15 条「没有类比」误收成「有类比」（实测）。
#: 只对「有没有」二值的两簇生效：DOWN-BUILDUP / EXCL-TERMRAW / EXCL-NOSCAFFOLD 的词面
#: 本身就带否定（未深入 / 未定义 / 无支架），套上守卫会把它们清空。
NEG_GUARDED = {"DOWN-DEF", "DOWN-ANALOGY"}
CLAUSE_RE = re.compile(r"[，,。；;、：:（）()]")
NEG_RE = re.compile(r"无|未|没有|非|缺乏|缺少|不是|不做|不提供|不再")

#: 与 A2 同一批指标 + 本档判词点名的三个（定义数 / 类比密度 / 生产域偏置）。
#: 全部报出来，不许只报分得开的那几个——Bonferroni 上界按这张表的长度算。
FEATURES = [
    "domain_skew", "excerpt_share", "define_n", "analogy_per1k",
    "undef_term_n", "undef_term_rate", "uniq_term_per100",
    "code_lines", "code_max_block", "code_min_comment_ratio", "bare_symbol_n",
]


def _hit(rx: re.Pattern, text: str, guarded: bool) -> bool:
    if not guarded:
        return bool(rx.search(text))
    # 逐个子句判：子句里有命中，且命中位置**之前**没有否定词，才算真的「在场」。
    for clause in CLAUSE_RE.split(text):
        m = rx.search(clause)
        if m and not NEG_RE.search(clause[: m.start()]):
            return True
    return False


def tag(text: str, table=CD) -> list[str]:
    return [k for k, _, rx in table if _hit(rx, text, k in NEG_GUARDED)]


def topic_of(case: str) -> str:
    return case.split("-", 1)[1]


# ---------------------------------------------------------------- 1. 清点
def census(rows: list[dict]) -> list[dict]:
    adv = [r for r in rows if r["target"] == TIER]
    miss = [r for r in adv if r["hit"] != 1]
    hit = [r for r in adv if r["hit"] == 1]
    print("### 1. 清点｜目标档 advanced\n")
    print(f"命中 {len(hit)}/{len(adv)}，失败 {len(miss)}/{len(adv)}")
    for t in ("beginner", "transition", "advanced"):
        sub = [r for r in rows if r["target"] == t]
        print(f"  对照 {t:<11} {sum(1 for r in sub if r['hit'] == 1)}/{len(sub)}")

    votes = collections.Counter(r[j]["tier"] for r in adv for j in JUDGES)
    print(f"\n{len(adv) * 3} 张票的去向：{dict(votes)}")
    print("  —— 一张 beginner 票都没有：advanced 的失分全部是**向下漂到 transition**，"
          "与 beginner 档全部向上漂正好对称。")

    print("\n失败例逐条（判官票 / 最终判定）：")
    for r in sorted(miss, key=lambda x: x["caseId"]):
        v = " ".join(f"{j[-1]}={r[j]['tier']}" for j in JUDGES)
        print(f"  {r['caseId']:<18} final={str(r['final']):<12} status={r['status']:<12} {v}")
    still = sum(1 for r in miss for j in JUDGES if r[j]["tier"] == TIER)
    print(f"  7 例 × 3 = {len(miss) * 3} 张票里，仍有 {still} 张投了 advanced"
          f"（只有 {sum(1 for r in miss if all(r[j]['tier'] != TIER for j in JUDGES))} 例是三票全反）")

    print("\n按主题的失败分布（12 主题 × 3 画像）：")
    per = collections.Counter(topic_of(r["caseId"]) for r in miss)
    for t in sorted(per, key=lambda x: (-per[x], x)):
        print(f"  {t:<22} {per[t]}/3")
    print(f"  失败集中在 {len(per)} 个主题上，其余 {12 - len(per)} 个主题 0/3。")
    return miss


# ---------------------------------------------------------------- 2. 聚类
def dissent(rows: list[dict]) -> list[tuple[str, str, int, str]]:
    """(caseId, judge, hit, because) —— 目标 advanced 但该判官投了非 advanced。"""
    return [
        (r["caseId"], j, r["hit"], b)
        for r in rows
        if r["target"] == TIER
        for j in JUDGES
        if r[j]["tier"] != TIER
        for b in r[j]["because"]
    ]


def _table(items, table, title) -> set[int]:
    fail_ids = {c for c, _, h, _ in items if h != 1}
    print(f"\n{title}")
    print(f"{'簇':<18}{'判词':>6}{'涉及用例':>10}{'其中失败例':>12}  失败例")
    print("-" * 96)
    covered = set()
    for k, label, _ in table:
        sub = [x for x in items if k in tag(x[3], table)]
        covered |= {id(x) for x in sub}
        cases = {x[0] for x in sub}
        print(f"{k:<18}{len(sub):>6}{len(cases):>10}{len(cases & fail_ids):>12}  "
              f"{'、'.join(sorted(cases & fail_ids)) or '—'}")
        print(f"{'':<18}{label}")
    return covered


def cluster(items: list[tuple[str, str, int, str]]) -> None:
    n_votes = len({(c, j) for c, j, _, _ in items})
    print(f"\n### 2. 判词机械聚类｜{n_votes} 张异议票、{len(items)} 条判词\n")
    cov_d = _table(items, CD, "2.1 降档理由（为什么不是 advanced）—— 这才是失败原因")
    cov_e = _table(items, CE, "2.2 排除 beginner 的理由 —— advanced 的正面特征，不是失败原因")

    only_e = [x for x in items if id(x) not in cov_d]
    none = [x for x in items if id(x) not in cov_d and id(x) not in cov_e]
    print(f"\n覆盖率：降档理由 {len(cov_d)}/{len(items)} = {len(cov_d) / len(items):.1%}；"
          f"两张表合计 {len(items) - len(none)}/{len(items)} = {1 - len(none) / len(items):.1%}")
    print(f"  只命中「排除 beginner」而不含任何降档理由的判词 {len(only_e) - len(none)} 条 —— "
          f"这些条目按字面根本不是在解释失败。")
    print(f"  两张表都不命中的 {len(none)} 条，逐条列出：")
    for cid, j, hit, b in none:
        print(f"    [{cid} {j[-1]} hit={hit}] {b}")

    fail = [x for x in items if x[2] != 1]
    fv = len({(x[0], x[1]) for x in fail})
    n_case = len({x[0] for x in fail})
    print(f"\n只算失败例（工单口径）：{n_case} 例、{fv} 张异议票"
          f"（{n_case * 3} 张票里 {n_case * 3 - fv} 张仍投 advanced）、{len(fail)} 条判词")
    print(f"{'簇':<18}{'判词':>6}{'用例':>6}  用例")
    print("-" * 78)
    for k, _, _ in CD + CE:
        sub = [x for x in fail if k in tag(x[3], CD + CE)]
        if not sub:
            continue
        print(f"{k:<18}{len(sub):>6}{len({x[0] for x in sub}):>6}  {'、'.join(sorted({x[0] for x in sub}))}")


def quotes(items: list[tuple[str, str, int, str]], limit: int = 2) -> None:
    print(f"\n### 2b. 每簇代表性判词原文（各 {limit} 条，失败例优先，可 grep verdicts.jsonl 核对）\n")
    for k, label, _ in CD + CE:
        hits = sorted([x for x in items if k in tag(x[3], CD + CE)], key=lambda x: (x[2], x[0]))
        print(f"[{k}] {label}")
        for cid, j, hit, b in hits[:limit]:
            print(f"  · {cid}／{j[-1]}／hit={hit}：{b}")
        print()


# ---------------------------------------------------------------- 3. 机械佐证
def feats(run: str, zone: str) -> dict[str, dict]:
    out = {}
    for r in L.load(run, zone=zone):
        m = L.metrics(r["full"] if zone == "full" else r["text"])
        m["excerpt_share"] = m["_excerpt_chars"] / max(m["chars"], 1)
        m["_hit"], m["_target"] = r["hit"], r["target"]
        out[r["case"]] = m
    return out


def _sep_p(miss: list[float], hit: list[float], rng: random.Random) -> tuple[float, float]:
    s = D.sep(D.auc(miss, hit))
    return s, D.perm_p(miss, hit, s, rng)


def evidence(run: str) -> None:
    print(f"\n### 3. 生成物侧的机械佐证（置换 {D.PERM_N} 次，指标实现全部复用 "
          f"calibrate_adaptation_lint）\n")
    for zone, why in (("full", "判官读到的注入后成品"), ("own", "剥掉摘录的自撰区 = lint 真看得见的输入")):
        f = feats(run, zone)
        adv = [c for c, m in f.items() if m["_target"] == TIER]
        hit = [c for c in adv if f[c]["_hit"] == 1]
        miss = [c for c in adv if f[c]["_hit"] != 1]
        print(f"3.{'ab'[zone == 'own']} zone={zone}（{why}）｜miss {len(miss)} vs hit {len(hit)}")
        print(f"  {'指标':<24}{'sep':>6}{'置换p':>8}{'Bonf上界':>10}{'hit中位':>10}{'miss中位':>10}")
        print("  " + "-" * 68)
        for k in FEATURES:
            h = [f[c][k] for c in hit if f[c][k] is not None]
            m_ = [f[c][k] for c in miss if f[c][k] is not None]
            if not h or not m_:
                print(f"  {k:<24} 数据不足")
                continue
            # 每个指标用同一颗新种子，保证同一个数字在别处重算得到同一个 p
            s, p = _sep_p(m_, h, random.Random(SEED))
            print(f"  {k:<24}{s:>6.2f}{p:>8.3f}{min(p * len(FEATURES), 1.0):>10.3f}"
                  f"{statistics.median(h):>10.2f}{statistics.median(m_):>10.2f}")
        print(f"  注：一次看了 {len(FEATURES)} 个指标，Bonferroni 上界 = p×{len(FEATURES)}。\n")

    # 主题效应必须扣掉：失败例集中在 attention/rag 这些天生低生产域词的主题上
    print("3.c domain_skew 的主题效应控制（zone=full）")
    f = feats(run, "full")
    bytopic: dict[str, list[float]] = collections.defaultdict(list)
    for c, m in f.items():
        bytopic[topic_of(c)].append(m["domain_skew"])
    tmean = {k: statistics.fmean(v) for k, v in bytopic.items()}
    print("  各主题 domain_skew 均值（全 9 例）："
          + "、".join(f"{k} {v:.1f}" for k, v in sorted(tmean.items(), key=lambda x: -x[1])))
    adv = [c for c, m in f.items() if m["_target"] == TIER]
    rh = [f[c]["domain_skew"] - tmean[topic_of(c)] for c in adv if f[c]["_hit"] == 1]
    rm = [f[c]["domain_skew"] - tmean[topic_of(c)] for c in adv if f[c]["_hit"] != 1]
    s, p = _sep_p(rm, rh, random.Random(SEED))
    print(f"  去掉主题均值后的残差：sep={s:.2f} 置换p={p:.3f}"
          f"  hit中位 {statistics.median(rh):.2f} / miss中位 {statistics.median(rm):.2f}")
    # 同主题配对（advanced 减同画像 transition），沿用 advanced_tier_diagnosis 的做法
    pair = {(topic_of(c), c[:2]): c for c in f if f[c]["_target"] == "transition"}
    dh, dm = [], []
    for c in adv:
        peer = pair.get((topic_of(c), "t" + c[1]))
        if not peer:
            continue
        (dh if f[c]["_hit"] == 1 else dm).append(f[c]["domain_skew"] - f[peer]["domain_skew"])
    s2, p2 = _sep_p(dm, dh, random.Random(SEED))
    print(f"  同主题配对差（adv 减同画像 transition）：sep={s2:.2f} 置换p={p2:.3f}"
          f"  hit中位 {statistics.median(dh):.2f} / miss中位 {statistics.median(dm):.2f}")
    print("  读法：两种扣主题的做法都还分得开 → 不是纯主题效应。但 attention 的 3 例 advanced"
          " 全是失败例，该主题内无 advanced 命中对照，那 3 例的主题效应与档位效应分不开。")


def where_defs(run: str) -> None:
    """判官点名的「有定义 / 有类比」，落在教材摘录区还是模型自撰区？

    这决定 top-3 建议改哪一侧：落在摘录区 = 检索/素材问题，改提示词无效
    （self_refine 台账 2.1：自查环 prompt 明令摘录占位符原样保留）。
    区的划分复用 `calibrate_adaptation_lint.segment`，词面复用它的 DEFINE_RE / ANALOGY_RE。
    """
    rows = [r for r in L.load(run, zone="full") if r["target"] == TIER]
    stat: dict[str, tuple[int, int]] = {}
    for r in rows:
        seg = L.segment(r["full"])
        own = "\n".join(x["raw"] for x in seg if not x["excerpt"])
        ex = "\n".join(x["raw"] for x in seg if x["excerpt"])
        cnt = lambda t: len(L.DEFINE_RE.findall(t)) + len(L.ANALOGY_RE.findall(t))  # noqa: E731
        stat[r["case"]] = (cnt(own), cnt(ex))
    hit = [r["case"] for r in rows if r["hit"] == 1]
    miss = [r["case"] for r in rows if r["hit"] != 1]
    print(f"  {'区':<10}{'sep':>6}{'置换p':>8}{'hit中位':>10}{'miss中位':>10}")
    for i, zone in ((0, "自撰区"), (1, "摘录区")):
        h = [stat[c][i] for c in hit]
        m_ = [stat[c][i] for c in miss]
        s, p = _sep_p(m_, h, random.Random(SEED))
        print(f"  {zone:<10}{s:>6.2f}{p:>8.3f}{statistics.median(h):>10.1f}{statistics.median(m_):>10.1f}")
    print("\n  7 个失败例的定义/类比词面落点（自撰 / 摘录）：")
    for c in sorted(miss):
        print(f"    {c:<20} 自撰 {stat[c][0]:>3} / 摘录 {stat[c][1]:>3}")
    tot_own = sum(stat[c][0] for c in miss)
    tot_ex = sum(stat[c][1] for c in miss)
    print(f"    合计 自撰 {tot_own} / 摘录 {tot_ex} —— 摘录侧占 "
          f"{tot_ex / max(tot_own + tot_ex, 1):.0%}")


EXCERPT_TAG = re.compile(r"—— 摘自《[^》]+》\[([^\]]+)\]")


def shared_excerpts(run: str) -> None:
    """advanced 用的摘录，有多少与同主题 beginner 用的是同一条（出处 id 相同）？

    这是「摘录选择随不随档位变」的直接量法：占位符注入回来的 `[sid]` 就是出处 id
    （`evidence-grounding.ts` 的注入格式，`calibrate_adaptation_lint.strip_excerpts`
    的逆运算取的也是它）。同一条摘录同时喂给零基础和进阶，就说明这一维没随档位分化。
    """
    rows = L.load(run, zone="full")
    sids = {r["case"]: set(EXCERPT_TAG.findall(r["full"])) for r in rows}
    beg = collections.defaultdict(set)
    for r in rows:
        if r["target"] == "beginner":
            beg[topic_of(r["case"])] |= sids[r["case"]]
    frac, marks = {}, {}
    for r in rows:
        if r["target"] != TIER:
            continue
        s = sids[r["case"]]
        frac[r["case"]] = len(s & beg[topic_of(r["case"])]) / len(s) if s else 0.0
        marks[r["case"]] = r["hit"]
    h = [v for c, v in frac.items() if marks[c] == 1]
    m_ = [v for c, v in frac.items() if marks[c] != 1]
    s, p = _sep_p(m_, h, random.Random(SEED))
    print(f"  advanced 摘录与同主题 beginner 摘录的出处重合比："
          f"hit 均值 {statistics.fmean(h):.2f} / miss 均值 {statistics.fmean(m_):.2f}"
          f"  sep={s:.2f} 置换p={p:.3f}")
    print("  失败例逐条：" + "、".join(
        f"{c} {frac[c]:.2f}" for c in sorted(frac) if marks[c] != 1))
    print(f"  重合比 =1.00 的 advanced 用例 {sum(1 for v in frac.values() if v == 1.0)}/{len(frac)}，"
          f"其中失败 {sum(1 for c, v in frac.items() if v == 1.0 and marks[c] != 1)}")


def l3_rules(run: str) -> None:
    """现行 L3 三条规则在本 run 上的实际触发面。规则表复用 calibrate_adaptation_lint.RULES
    （与 apps/classroom/lib/generation/adaptation-lint.ts 的 THRESHOLDS 同源）。"""
    rows = [r for r in L.load(run, zone="own") if r["target"] == TIER]
    miss = [r for r in rows if r["hit"] != 1]
    hit = [r for r in rows if r["hit"] == 1]
    for cls, label, fn in L.RULES[TIER]:
        tp = sum(1 for r in miss if fn(r["m"]))
        fp = sum(1 for r in hit if fn(r["m"]))
        print(f"  [{cls}] {label:<62} 触发 miss {tp}/{len(miss)}  触发 hit {fp}/{len(hit)}")
    print(f"  失败例自撰区 domain_skew：{sorted(round(r['m']['domain_skew'], 2) for r in miss)}")
    print(f"  命中例最低五个：        {sorted(round(r['m']['domain_skew'], 2) for r in hit)[:5]}")
    print("  读法：分得最开的 domain_skew 已经有规则，问题是低端完全交叠、切点切不动；"
          "按现行政策「本档命中样本最小观测」重取会得到 0.00，即规则静音。所以不提新阈值。")


# ---------------------------------------------------------------- 4. 交叉对照
def cross_tier(run: str) -> None:
    """两档失败模式同源还是异质：同一指标在三档 miss/hit 上的方向与分离度。"""
    print("\n### 4. 与 beginner 的交叉对照（同一把尺子、三档分别算）\n")
    f = feats(run, "full")
    print(f"  {'指标':<20}{'档':<12}{'hit中位':>10}{'miss中位':>10}{'方向':>6}{'sep':>7}{'置换p':>8}")
    print("  " + "-" * 74)
    for k in ("excerpt_share", "domain_skew", "define_n", "undef_term_n"):
        for t in ("beginner", "transition", "advanced"):
            cs = [c for c, m in f.items() if m["_target"] == t]
            h = [f[c][k] for c in cs if f[c]["_hit"] == 1 and f[c][k] is not None]
            m_ = [f[c][k] for c in cs if f[c]["_hit"] != 1 and f[c][k] is not None]
            if not h or not m_:
                continue
            s, p = _sep_p(m_, h, random.Random(SEED))
            arrow = "miss↑" if statistics.median(m_) > statistics.median(h) else "miss↓"
            print(f"  {k:<20}{t:<12}{statistics.median(h):>10.2f}{statistics.median(m_):>10.2f}"
                  f"{arrow:>6}{s:>7.2f}{p:>8.3f}")
        print()

    print("  簇名对照（同一形态在两档的极性相反）：")
    print("    beginner EXCERPT「教材原文自带高档姿态」 ↔ advanced DOWN-EXCERPT「教材引用当缓冲」")
    print("    beginner TERM-UNDEF「术语首现无定义」   ↔ advanced DOWN-DEF「术语给了简短定义」")
    print("    beginner DOMAIN-ENG「例子落在工程生产域」↔ advanced EXCL-PROD「生产场景」= 正面特征")
    print("  也就是说：两档判词点名的**是同一批形态维度**，但 beginner 嫌它高、advanced 嫌它低。")


# ---------------------------------------------------------------- selftest
def selftest() -> None:
    assert "DOWN-DEF" in tag("资源对基础术语进行简短定义")
    assert "DOWN-EXCERPT" in tag("资源大段引用教材原文")
    assert "DOWN-BLOCKNOTE" in tag("仅配块级说明，而非逐行大白话注释")
    assert tag("这是一句与任何簇都无关的话") == []
    # 否定守卫：这三句词面都有「类比 / 定义」，语义是「没有」，不许收进降档理由
    assert tag("全文无生活化类比、无步骤拆解") == [], tag("全文无生活化类比、无步骤拆解")
    assert "DOWN-ANALOGY" not in tag("等术语直接使用，未提供定义或类比")
    assert "DOWN-ANALOGY" not in tag("内容涉及工程化概念，而非生活化类比")
    # 但同一条判词里前半句真的给了定义时，仍要收
    assert "DOWN-DEF" in tag("虽然对 RAG 做了简短定义，但对 TF-IDF 未做通俗类比")
    assert "EXCL-CODING" in tag("资源假设读者具备编程基础", CE)
    assert "EXCL-NOSCAFFOLD" in tag("缺乏 beginner 所需的密集支架元素", CE)

    rows = B.load_verdicts(RUN)
    assert len(rows) == 108, len(rows)
    adv = [r for r in rows if r["target"] == TIER]
    assert len(adv) == 36, len(adv)
    assert sum(1 for r in adv if r["hit"] == 1) == 29
    votes = collections.Counter(r[j]["tier"] for r in adv for j in JUDGES)
    assert votes["beginner"] == 0, votes            # 一张 beginner 票都没有
    assert votes["transition"] == 26 and votes["advanced"] == 82, votes
    items = dissent(rows)
    assert len({(c, j) for c, j, _, _ in items}) == 26, "异议票数变了"
    assert len(items) == 110, len(items)
    fail = [x for x in items if x[2] != 1]
    assert len({x[0] for x in fail}) == 7
    assert len({(x[0], x[1]) for x in fail}) == 15, "失败例异议票数变了"
    assert len(fail) == 62, len(fail)
    cov = sum(1 for x in items if tag(x[3]) or tag(x[3], CE))
    assert cov / len(items) > 0.95, cov

    # 否定守卫拦掉多少条：文档 §2.2 / §6 引的就是这几个数，此前没有任何断言钉住它们，
    # 结果漂过一次（写成 15，实测 19）。守卫是词面判断，改一个词就会变，所以钉死。
    def _raw(text: str) -> set[str]:
        return {k for k, _, rx in CD if rx.search(text)}

    blocked = {k: sum(1 for x in items if k in _raw(x[3]) and k not in tag(x[3]))
               for k in NEG_GUARDED}
    assert blocked == {"DOWN-ANALOGY": 19, "DOWN-DEF": 2}, blocked
    n_blocked = sum(1 for x in items if (_raw(x[3]) & NEG_GUARDED) - set(tag(x[3])))
    assert n_blocked == 20, n_blocked          # 19+2 里有一条两簇同时被拦
    assert sum(1 for x in items if "DOWN-ANALOGY" in tag(x[3])) == 31
    assert sum(1 for x in items if "DOWN-DEF" in tag(x[3])) == 18

    # 3.d/3.e 的两个关键计数也钉住：定义/类比 95% 落摘录区、失败例摘录与 beginner 高度同源
    rows_f = [r for r in L.load(RUN, zone="full") if r["target"] == TIER]
    ex_hits = own_hits = 0
    for r in rows_f:
        if r["hit"] == 1:
            continue
        seg = L.segment(r["full"])
        for zone_flag, add in ((True, "ex"), (False, "own")):
            t = "\n".join(x["raw"] for x in seg if x["excerpt"] == zone_flag)
            n = len(L.DEFINE_RE.findall(t)) + len(L.ANALOGY_RE.findall(t))
            if add == "ex":
                ex_hits += n
            else:
                own_hits += n
    assert (own_hits, ex_hits) == (1, 21), (own_hits, ex_hits)

    f = feats(RUN, "full")
    hit = [f[c]["domain_skew"] for c, m in f.items() if m["_target"] == TIER and m["_hit"] == 1]
    miss = [f[c]["domain_skew"] for c, m in f.items() if m["_target"] == TIER and m["_hit"] != 1]
    s, p = _sep_p(miss, hit, random.Random(SEED))
    assert abs(s - 0.82) < 0.01 and p < 0.01, (s, p)
    print(f"selftest ok（advanced 29/36、108 张票里 beginner 0 张、异议票 26 张 110 条、"
          f"失败例 15 张 62 条、聚类覆盖 {cov}/{len(items)}、否定守卫拦掉 {n_blocked} 条"
          f"（ANALOGY {blocked['DOWN-ANALOGY']} + DEF {blocked['DOWN-DEF']}）、"
          f"domain_skew sep={s:.2f} p={p:.3f}）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=RUN)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return 0
    print(f"run={args.run}｜零 LLM 调用，全部读自 runs/{args.run}/ 与 resources/\n")
    rows = B.load_verdicts(args.run)
    census(rows)
    items = dissent(rows)
    cluster(items)
    quotes(items)
    evidence(args.run)
    print("\n3.d 判官点名的「定义 / 类比」落在哪个区（决定改提示词还是改检索）")
    where_defs(args.run)
    print("\n3.e 摘录选择随不随档位变（出处 id 与同主题 beginner 的重合比）")
    shared_excerpts(args.run)
    print("\n3.f 现行 L3 三条 lint 规则在这批数据上的触发面（自撰区口径）")
    l3_rules(args.run)
    cross_tier(args.run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
