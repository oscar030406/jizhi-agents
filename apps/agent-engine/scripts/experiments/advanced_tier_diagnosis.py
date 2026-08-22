r"""advanced 档失分的性质判定：写浅了，还是 t|a 边界本身糊？零 API 调用。

    python scripts/experiments/advanced_tier_diagnosis.py

## 要回答的问题

v5 规则下 advanced 档 18 例里失败 5 例，全部被判成 transition，方向一致，零例被判成
beginner。有两种解释，处置完全不同：

- **写浅了**：我们的 advanced 资源形态上确实不够 advanced -> 改生成指令有效
- **边界糊**：transition|advanced 的判据本身分不开 -> 改生成指令白费，得改口径

判据：如果形态指标能把失败样本与命中样本分开（sep 显著），那是写浅了；分不开就是边界糊。

## 为什么要主题内配对

M5 `domain_skew` 有强主题效应——kv-cache 主题天生 33-45（显存/吞吐是它的正文词汇），
rag 主题天生 0-10。跨主题直接比中位数会把主题效应读成档位效应。所以除了整体分离度，
再看同主题的 advanced 减 transition。

指标实现复用 `scripts/calibrate_adaptation_lint.py`，不另写一份——否则测出来的是
两份实现的差，不是资源的差。
"""

from __future__ import annotations

import argparse
import random
import statistics as st
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE))
sys.path.insert(0, str(ENGINE / "scripts"))

import calibrate_adaptation_lint as lint  # noqa: E402

#: v5 规则（三轮众数 + 三判官多数决，算在 20260811-retest 判词上）下失分的 advanced 用例。
#: 由 scripts/experiments/adaptation_noise_band.py 的逐例命中表得出。
FAIL_CASES = {"a1-attention", "a2-rag", "a2-softmax-temp", "a3-rag", "a3-softmax-temp"}
METRICS = ["domain_skew", "uniq_term_per100", "code_lines", "bare_symbol_n"]
PERM_N = 2000
SEED = 20260812


def m(row: dict, key: str):
    return (row.get("m") or {}).get(key)


def topic_of(case_id: str) -> str:
    return case_id.split("-", 1)[1]


def auc(hi: list[float], lo: list[float]) -> float | None:
    if not hi or not lo:
        return None
    wins = sum((1 if a > b else 0.5 if a == b else 0) for a in hi for b in lo)
    return wins / (len(hi) * len(lo))


def sep(a: float | None) -> float:
    """方向无关的分离度：0 = 完全分不开，1 = 完全分开。与 lint 规格 §2 同定义。"""
    return 0.0 if a is None else abs(a - 0.5) * 2


def perm_p(hi: list[float], lo: list[float], observed: float, rng: random.Random) -> float:
    """置换检验：打乱分组标签，看 sep ≥ 实测值的比例。n 小的时候 0.4 和 0.5 的差
    可能纯是抽样噪声，砍规则得有噪声地板。"""
    pool = hi + lo
    ge = 0
    for _ in range(PERM_N):
        rng.shuffle(pool)
        if sep(auc(pool[: len(hi)], pool[len(hi):])) >= observed:
            ge += 1
    return ge / PERM_N


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="20260811-010557", help="取哪个 run 的资源快照")
    args = ap.parse_args()

    rows = lint.load(args.run, zone="own")
    adv = [r for r in rows if r["target"] == "advanced"]
    tra = {f"{topic_of(r['case'])}|{r['case'][:2]}": r for r in rows if r["target"] == "transition"}
    fail = [r for r in adv if r["case"] in FAIL_CASES]
    hit = [r for r in adv if r["case"] not in FAIL_CASES]
    print(f"run {args.run}｜自撰区口径｜advanced {len(adv)} 例：失败 {len(fail)}、命中 {len(hit)}")

    rng = random.Random(SEED)
    print(f"\n=== advanced 内部：失败 vs 命中的分离度（置换 {PERM_N} 次） ===")
    verdicts = []
    for key in METRICS:
        h = [m(r, key) for r in hit if m(r, key) is not None]
        f = [m(r, key) for r in fail if m(r, key) is not None]
        if not h or not f:
            print(f"  {key:<22} 数据不足")
            continue
        s = sep(auc(h, f))
        p = perm_p(h, f, s, rng)
        verdicts.append(p)
        print(f"  {key:<22} sep={s:.2f}  置换p={p:.3f}   命中中位 {st.median(h):.2f} / 失败中位 {st.median(f):.2f}")

    print("\n=== 主题内配对：同主题 advanced 减 transition 的 domain_skew ===")
    for r in sorted(adv, key=lambda x: x["case"]):
        peer = tra.get(f"{topic_of(r['case'])}|t{r['case'][1]}")
        if not peer:
            continue
        da, dt = m(r, "domain_skew"), m(peer, "domain_skew")
        if da is None or dt is None:
            continue
        mark = "✗失败" if r["case"] in FAIL_CASES else "  命中"
        print(f"  {mark} {r['case']:<18} adv={da:>6.2f}  同主题transition={dt:>6.2f}  差={da - dt:>+7.2f}")

    print("\n=== 个体缺陷（不是统计结论，是逐例事实） ===")
    found = False
    for r in adv:
        if (m(r, "code_lines") or 0) == 0:
            print(f"  {r['case']}: code_lines=0 —— advanced 档资源一行代码没有")
            found = True
    if not found:
        print("  无")

    print("\n=== 判读 ===")
    if verdicts and min(verdicts) > 0.05:
        print("  形态指标全部分不开失败与命中（最小 p = "
              f"{min(verdicts):.3f}）-> 支持「t|a 边界糊」，不支持「写浅了」。")
        print("  推论：改 advanced 生成指令去推高这些指标，没有证据说能翻转判官。")
    else:
        print("  至少一个指标分得开 -> 支持「写浅了」，改生成指令有依据。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
