"""适配评测 2A 盲评（口径 metric-calibers-v1 §2A，rubric 预注册于
data/eval/adaptation_probe/blind_rubric.md）。

铁律：判官只吃 resources/<case>.json 的 text 字段——画像/目标档位在 meta 里，
物理上不进提示词。判官 A 主评；borderline 送判官 B 独立复核。

口径三套（预注册于 blind_rubric.md，互不可直比）：
  v2（默认，主数字）：borderline 且 A/B 不一致 → 记 0（严格口径）。
  v3（--arbiter，须重跑全量后单列）：borderline 且 A/B 不一致 → 判官 C 仲裁，
     2-of-3 多数决；三判官各执一词无多数 → 仍记 0。
  v4（--panel，对称口径）：**每一例都由三判官独立盲评**，2-of-3 多数决；
     三方全不同记 0；任一判官 invalid 用剩余两方，两方不一致记 0。
     v2/v3 只在 A 自报 borderline 时才叫第二判官，指标因此依赖 A 的自报置信度
     （A 自信判错就无人复核）；v4 拆掉这个依赖，代价是每批 3n 次调用。

判官：A=MiniMaxAI/MiniMax-M2.5（主评，约 1/4 价——难度档判定是轻任务，
性价比优先，用户 08-09 指示），B=Qwen/Qwen3.6-35B-A3B（仅 borderline 复核），
C=Pro/moonshotai/Kimi-K2.6（仅 v3 仲裁，选型理由见 blind_rubric.md §v3）。
三家族互不重叠，且都与生成侧（strong=DeepSeek-V3.2 / fast=Qwen3-30B）
异厂——B 与 fast 线同厂不同型，家族重叠已声明。GLM 系一律禁用（用户明令）。

调用失败与判偏是两回事：任一判官三试皆败记 status=invalid_judgeX 单列，
不混进「不一致记 0」。主准确率仍把 invalid 计入分母记 0（口径连续性），
另出 accuracy_excl_invalid 供读者看敏感性。

产出 data/eval/adaptation_probe/runs/<ts>/：verdicts.jsonl（逐条判词）+
summary.json（总准确率/分档准确率/判定分布/判官信度）。判定分布退化
（某档占比 >70%）= 判官在顺撇，全批作废。

用法：python scripts/judge_adaptation_probe.py [--limit N] [--dry] [--arbiter|--panel]
      python scripts/judge_adaptation_probe.py --reliability-only runs/<ts>
      python scripts/judge_adaptation_probe.py --selftest
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import threading
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = ROOT / "data/eval/adaptation_probe"

JUDGE_A = "MiniMaxAI/MiniMax-M2.5"      # 主评：轻任务用低价档（≈1/4 价）
JUDGE_B = "Qwen/Qwen3.6-35B-A3B"        # borderline 复核
JUDGE_C = "Pro/moonshotai/Kimi-K2.6"    # v3 仲裁（--arbiter），仅 A/B 分歧时触发
API = "https://api.siliconflow.cn/v1/chat/completions"
TIERS = ("beginner", "transition", "advanced")

# 真实 token 计数（含失败重试，因为失败也要付钱）——用于事后核对成本估算。
# 加锁：本文件的 main 是串行的用不上，但 scripts/experiments/judge_retest_reliability.py
# 并发复用 judge()，`d[k] += n` 在 CPython 下是 load/add/store 三步，不加锁会丢计数。
USAGE = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0}
USAGE_LOCK = threading.Lock()

# rubric v2（2026-08-10 重新预注册，变更记录见 data/eval/adaptation_probe/blind_rubric.md）：
# v1 把「出现代码」当 transition 强判据，与「适龄代码」教育常识冲突——判据改为
# 看前置假设与讲解姿态。v1/v2 数据不可直比。
SYSTEM = """你是教学资源难度评审。判定给出的教学资源面向的学习者难度档，三选一：

- beginner（引导型初学者）：术语首次出现必有定义或类比，单段新术语不超过 2 个；例子生活化非技术域；代码若出现必须极短（≤5 行）、逐行配大白话注释、不引入文中未讲过的语法或库——满足这三条的代码不构成升档理由；公式出现前有无公式的直觉解释；支架元素密集（步骤拆解、检查点、鼓励语）。
- transition（有基础转行者）：假设会编程但不假设 AI 背景；代码可以常规出现（多行/带库调用），配块级说明而非逐行注释；AI 术语适度并简短定义；用工程直觉类比。
- advanced（进阶工程师）：术语直接使用不定义；直接进机制、公式与取舍讨论；代码贴生产形态（完整实现/无手把手注释）；例子贴生产场景；无鼓励性支架。

判定基准：看资源对读者的前置假设与讲解姿态，不看单一特征的有无。拿不准时问：「一个完全不会编程、不会高数的人能跟上这份材料吗？」能跟上就是 beginner。

只输出 JSON：{"tier": "beginner|transition|advanced", "because": ["逐条：资源里哪个具体表述指向该档"], "borderline": true|false}
because 必须引用资源中的具体表述。拿不准两档之间时 borderline 设 true。"""


def load_key() -> str:
    for line in open(ROOT / ".env", encoding="utf-8"):
        if line.startswith("SILICONFLOW_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("SILICONFLOW_API_KEY 不在 engine .env")


def parse_verdict(content: str) -> tuple[dict | None, str]:
    """从判官原文抠出判词。返回 (判词, 解析路径)。

    为什么要修 JSON：判官会在 because 里写 LaTeX（`\\sqrt{d_k}`、`\\cdot`），
    `\\s`/`\\c` 不是合法 JSON 转义，json.loads 直接抛。旧版把这个异常吞成
    None，调用侧再把 None 当成「两判官不一致」记 0——run 20260810-172357 的
    t1-gradient 就是这么丢的，且失败与「话题带公式」相关，不是随机缺失。
    修的是解析，不是判据：判官说了什么原样还原，SYSTEM 提示词一个字没动。
    """
    m = re.search(r"\{[\s\S]*\}", content)
    if m:
        try:
            return json.loads(m.group(0)), "direct"
        except json.JSONDecodeError:
            pass
        # 把非法转义的反斜杠打成字面量（合法转义 " \ / b f n r t u 不动）
        try:
            return json.loads(re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", m.group(0))), "escape_repaired"
        except json.JSONDecodeError:
            pass
    # 兜底：结构坏了/被 max_tokens 截断（没有右花括号）也别丢数据点——
    # tier 和 borderline 是判定唯一要用的两个字段，扫得到就算数。
    raw = m.group(0) if m else content
    t = re.search(r'"tier"\s*:\s*"(beginner|transition|advanced)"', raw)
    if not t:
        return None, "unparseable"
    b = re.search(r'"borderline"\s*:\s*(true|false)', raw)
    return {"tier": t.group(1), "borderline": bool(b) and b.group(1) == "true",
            "because": ["<JSON 损坏或被截断，判官原文见 raw>"], "raw": raw}, "field_scrape"


def judge(
    session: requests.Session, key: str, model: str, text: str, attempts: int = 3
) -> tuple[dict | None, str | None]:
    """返回 (判词, 失败原因)。判词为 None 时失败原因必非空——调用侧据此把
    「调用失败」记成 invalid，而不是当成一次判偏。"""
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"教学资源全文：\n\n{text[:6000]}"},
        ],
        "max_tokens": 900,
        "temperature": 0.1,
    }
    # 思考模型（Qwen3 系）必须关思考：500 token 预算被思考吃光就没 JSON 了
    # ——首跑判官 B 18/18 三试皆败的真凶（20260809-141631 批）。
    if "qwen" in model.lower():
        body["enable_thinking"] = False
    last = "unknown"
    for attempt in range(attempts):
        try:
            r = session.post(API, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=120)
            r.raise_for_status()
            data = r.json()
            choice = data["choices"][0]
            u = data.get("usage") or {}
            with USAGE_LOCK:
                USAGE["calls"] += 1
                USAGE["prompt_tokens"] += u.get("prompt_tokens") or 0
                USAGE["completion_tokens"] += u.get("completion_tokens") or 0
            content = choice["message"]["content"]
            parsed, mode = parse_verdict(content)
            # 旧版这里遇到解析失败就 continue 且不记不睡——三试全走这条就静默
            # 返回 None，t1-gradient（run 20260810-172357）正是这样变成「判偏」的。
            if parsed is None:
                last = f"{mode}(finish={choice.get('finish_reason')}, head={content[:80]!r})"
            elif parsed.get("tier") in TIERS:
                if mode != "direct":
                    parsed["parse_mode"] = mode   # 解析路径留痕，判词可审计
                    print(f"  judge {model} 判词 JSON 不合法，已按 {mode} 还原")
                if attempt:
                    print(f"  judge {model} 第 {attempt + 1} 试成功（前次：{last}）")
                return parsed, None
            else:
                last = f"bad_tier({parsed.get('tier')!r})"
        except Exception as exc:  # noqa: BLE001 —— 重试后如实记失败
            last = f"{type(exc).__name__}: {exc}"
        print(f"  judge {model} 第 {attempt + 1}/{attempts} 试失败：{last}")
        time.sleep(2 * (attempt + 1))
    print(f"  judge {model} {attempts} 试皆败 → 记 invalid（不计作判偏）")
    return None, last


def kappa(pairs: list[tuple[str, str]]) -> dict:
    """Cohen's kappa（无权重，三类别）。pairs=[(A判, B判), ...]。不引新依赖。"""
    n = len(pairs)
    if not n:
        return {"n": 0, "po": None, "pe": None, "kappa": None}
    po = sum(a == b for a, b in pairs) / n
    ma = {t: sum(a == t for a, _ in pairs) / n for t in TIERS}
    mb = {t: sum(b == t for _, b in pairs) / n for t in TIERS}
    pe = sum(ma[t] * mb[t] for t in TIERS)
    return {
        "n": n,
        "po": po,
        "pe": pe,
        "kappa": None if pe >= 1 else (po - pe) / (1 - pe),
        "marginal_A": {t: round(ma[t], 4) for t in TIERS},
        "marginal_B": {t: round(mb[t], 4) for t in TIERS},
    }


def fleiss_kappa(rows: list[list[str]]) -> dict:
    """Fleiss' kappa（多评者一致性）。rows=[[A判, B判, C判], ...]。不引新依赖。

    为什么不是 Cohen：Cohen's kappa 只定义在两个评者上。v4 每例三票，拆成
    三对 Cohen 再平均会把「三方全不同」和「两方一致一方偏」压成同一个数，
    而这两种情况在 2-of-3 多数决下命运相反（后者能定档，前者记 0）。
    Fleiss 要求每例评者数相同，所以只吃三票齐全的完整行（缺票行数另报）。
    """
    N = len(rows)
    if not N:
        return {"N": 0, "raters": 0, "P_bar": None, "P_e": None, "kappa": None}
    m = len(rows[0])
    if m < 2 or any(len(r) != m for r in rows):
        raise ValueError("Fleiss 要求每例评者数一致且 >= 2")
    counts = [{t: r.count(t) for t in TIERS} for r in rows]
    # P_i：第 i 例里「随机抽两位评者意见相同」的比例
    P = [(sum(c[t] ** 2 for t in TIERS) - m) / (m * (m - 1)) for c in counts]
    P_bar = sum(P) / N
    p = {t: sum(c[t] for c in counts) / (N * m) for t in TIERS}
    P_e = sum(p[t] ** 2 for t in TIERS)
    return {
        "N": N,
        "raters": m,
        "P_bar": P_bar,
        "P_e": P_e,
        "kappa": None if P_e >= 1 else (P_bar - P_e) / (1 - P_e),
        "category_marginals": {t: round(p[t], 4) for t in TIERS},
    }


def resolve_panel(record: dict) -> str | None:
    """v4 对称口径：三判官全量独立盲评 → 2-of-3 多数决。返回 None = 不计命中。

    不看 borderline 自评——这正是 v4 要拆掉的依赖。任一判官 invalid 就用剩下
    两票（一致取之、不一致记 0），两票以上缺失整例记 invalid。
    """
    keys = ("judgeA", "judgeB", "judgeC")
    votes = [record[k]["tier"] for k in keys if record.get(k)]
    missing = [k[-1] for k in keys if not record.get(k)]
    if len(votes) < 2:
        record["status"] = "invalid_judge" + "".join(missing)
        return None
    win = next((t for t in TIERS if votes.count(t) >= 2), None)
    partial = "_partial_panel" if missing else ""
    if win:
        record["status"] = "ok" + partial
        return win
    record["status"] = ("split_two_way_partial_panel" if missing else "split_no_majority")
    return None


def panel_stats(records: list[dict]) -> dict:
    """v4 专属统计：单判官准确率、两两一致率、Fleiss kappa、多数决分布、三方全不同。"""
    keys = ("judgeA", "judgeB", "judgeC")
    per_judge = {}
    for k in keys:
        valid = [r for r in records if r.get(k)]
        hits = sum(1 for r in valid if r[k]["tier"] == r["target"])
        per_judge[k] = {
            # 分母是全体（invalid 记 0），与主准确率同口径；另给剔除 invalid 的敏感性
            "accuracy": hits / len(records) if records else None,
            "accuracy_excl_invalid": hits / len(valid) if valid else None,
            "n_valid": len(valid),
            "distribution": {t: sum(1 for r in valid if r[k]["tier"] == t) for t in TIERS},
        }
    pairwise = {}
    for x, y in (("judgeA", "judgeB"), ("judgeA", "judgeC"), ("judgeB", "judgeC")):
        both = [r for r in records if r.get(x) and r.get(y)]
        pairwise[f"{x[-1]}{y[-1]}"] = {
            "n": len(both),
            "raw_agreement": (sum(1 for r in both if r[x]["tier"] == r[y]["tier"]) / len(both))
            if both else None,
            "cohens_kappa": kappa([(r[x]["tier"], r[y]["tier"]) for r in both])["kappa"],
        }
    complete = [r for r in records if all(r.get(k) for k in keys)]
    rows = [[r[k]["tier"] for k in keys] for r in complete]
    unanimous = sum(1 for row in rows if len(set(row)) == 1)
    all_differ = [r["caseId"] for r, row in zip(complete, rows) if len(set(row)) == 3]
    return {
        "per_judge": per_judge,
        "pairwise": pairwise,
        "fleiss_kappa": fleiss_kappa(rows),
        "complete_rows": len(complete),
        "incomplete_rows": len(records) - len(complete),
        "unanimous_n": unanimous,
        "unanimous_rate": unanimous / len(complete) if complete else None,
        "majority_2of3_n": sum(1 for row in rows if len(set(row)) == 2),
        "all_three_differ_n": len(all_differ),
        "all_three_differ_cases": all_differ,
        "majority_distribution": {
            t: sum(1 for r in records if r.get("final") == t) for t in TIERS
        },
        "note": (
            "v4 三判官全量，Fleiss kappa 算在本批全部三票齐全的用例上（不是 v2/v3 那种"
            "「A 自称 borderline」的偏斜子集），故与 runs/*/reliability.json 里的 "
            "Cohen's kappa 不可直比：后者的分母是被 A 挑出来的难例。"
        ),
    }


def reliability(records: list[dict]) -> dict:
    """判官信度：borderline 规模、双判可比子集、原始一致率、kappa、分歧方向。

    只吃 verdicts.jsonl 的记录形状，所以对历史 run 可以事后补算（历史记录没有
    status 字段，靠 judgeB 是否为 null 反推 invalid）。
    """
    border = [r for r in records if (r.get("judgeA") or {}).get("borderline")]
    dual = [r for r in border if r.get("judgeA") and r.get("judgeB")]
    invalid_b = [r["caseId"] for r in border if r.get("judgeB", "missing") is None]
    missing_b = [r["caseId"] for r in border if "judgeB" not in r]

    pairs = [(r["judgeA"]["tier"], r["judgeB"]["tier"]) for r in dual]
    stats = kappa(pairs)

    by_target: dict[str, dict[str, int]] = {}
    disagreements = []
    for r in dual:
        a, b, tgt = r["judgeA"]["tier"], r["judgeB"]["tier"], r["target"]
        slot = by_target.setdefault(
            tgt, {"borderline": 0, "agree": 0, "disagree": 0,
                  "only_A_on_target": 0, "only_B_on_target": 0, "neither_on_target": 0}
        )
        slot["borderline"] += 1
        if a == b:
            slot["agree"] += 1
            continue
        slot["disagree"] += 1
        who = "only_A_on_target" if a == tgt else "only_B_on_target" if b == tgt else "neither_on_target"
        slot[who] += 1
        disagreements.append({"caseId": r["caseId"], "target": tgt, "A": a, "B": b, "who_on_target": who})

    a_alone = sum(1 for r in records if (r.get("judgeA") or {}).get("tier") == r["target"])
    scored = sum(r.get("hit", 0) for r in records)
    n = len(records)
    # 有 status 就用 status（含 invalid_judgeC）；历史 run 没有，退回按判词反推
    invalid = [r["caseId"] for r in records if r.get("status", "").startswith("invalid_")] or \
        (invalid_b + [r["caseId"] for r in records if not r.get("judgeA")])
    n_valid = n - len(invalid)
    return {
        "n": n,
        "borderline_n": len(border),
        "borderline_rate": len(border) / n if n else None,
        "dual_judged_n": len(dual),
        "invalid_judgeB_cases": invalid_b,
        "invalid_cases": invalid,
        "borderline_without_judgeB_call": missing_b,
        "raw_agreement": stats["po"],
        "cohens_kappa": stats["kappa"],
        "kappa_detail": stats,
        "disagreement_by_target_tier": by_target,
        "disagreements": disagreements,
        "judgeA_alone_accuracy": a_alone / n if n else None,
        "scored_accuracy": scored / n if n else None,
        "accuracy_excl_invalid": scored / n_valid if n_valid else None,
        "n_excl_invalid": n_valid,
        "note": (
            "kappa 只在 borderline 子集上算（判官 B 按设计只跑 borderline），"
            "不是全 54 例的判官一致性；子集由「A 自称拿不准」筛出，边缘分布高度偏斜"
            "（A 压倒性选中间档），kappa 在偏斜边缘下会被系统性压低（kappa 悖论），"
            "故 raw_agreement 与 kappa 要一起读。样本量小，区间宽，只作定性证据。"
        ),
    }


def resolve(record: dict, arbiter: bool) -> str | None:
    """把 A/B/C 判词折成最终档位，并在 record 上盖 status。返回 None = 不计命中。

    status：ok / invalid_judgeX（调用失败，与判偏区分）/ split_no_arbiter（v2 严格
    口径下的双判分歧）/ split_no_majority（v3 三判各执一词）。
    """
    va, vb, vc = record.get("judgeA"), record.get("judgeB"), record.get("judgeC")
    if not va:
        record["status"] = "invalid_judgeA"
        return None
    if not va.get("borderline"):
        record["status"] = "ok"
        return va["tier"]
    if vb is None:
        record["status"] = "invalid_judgeB"
        return None
    if vb["tier"] == va["tier"]:
        record["status"] = "ok"
        return va["tier"]
    if not arbiter:
        record["status"] = "split_no_arbiter"   # v2 预注册：不一致记 0
        return None
    if vc is None:
        record["status"] = "invalid_judgeC"
        return None
    votes = [va["tier"], vb["tier"], vc["tier"]]
    win = next((t for t in TIERS if votes.count(t) >= 2), None)
    record["status"] = "ok" if win else "split_no_majority"
    return win


def selftest() -> None:
    # 解析：真实翻车样本（判官 B 在 b2-attention 上稳定复现的 \sqrt / \frac）
    latex = '{"tier": "beginner", "because": ["公式 softmax(QK^T/\\sqrt{d_k})V 前有直觉解释"], "borderline": false}'
    v, mode = parse_verdict(latex)
    assert mode == "escape_repaired" and v["tier"] == "beginner" and v["borderline"] is False, (mode, v)
    assert "sqrt" in v["because"][0]
    v, mode = parse_verdict('```json\n{"tier": "advanced", "borderline": true}\n```')
    assert mode == "direct" and v["tier"] == "advanced"
    # 被 max_tokens 截断：没有右花括号，仍应抢救出 tier（思考型判官 C 的现实风险）
    v, mode = parse_verdict('{"tier": "transition", "borderline": true, "because": ["写到一半没了')
    assert mode == "field_scrape" and v["tier"] == "transition" and v["borderline"] is True, (mode, v)
    assert parse_verdict('{"tier": "beginner"')[0]["borderline"] is False  # 缺字段按 false
    assert parse_verdict("模型摆烂了，没有 JSON") == (None, "unparseable")
    assert parse_verdict('{"verdict": "不知道"}')[0].get("tier") is None  # 合法 JSON 但没档位→调用侧判 bad_tier

    # kappa：2x2 手算值 po=.7 pe=.5 → .4
    p = [("beginner", "beginner")] * 4 + [("transition", "transition")] * 3 + \
        [("beginner", "transition")] * 2 + [("transition", "beginner")]
    k = kappa(p)
    assert abs(k["po"] - 0.7) < 1e-9 and abs(k["pe"] - 0.5) < 1e-9, k
    assert abs(k["kappa"] - 0.4) < 1e-9, k
    assert kappa([])["kappa"] is None
    assert kappa([("beginner", "beginner")])["kappa"] is None  # pe==1 不可定义

    A = {"tier": "beginner", "borderline": True}
    assert resolve({"judgeA": A, "judgeB": {"tier": "beginner"}}, False) == "beginner"
    assert resolve({"judgeA": A, "judgeB": None}, True) is None            # invalid≠分歧
    r = {"judgeA": A, "judgeB": None}; resolve(r, True); assert r["status"] == "invalid_judgeB"
    r = {"judgeA": A, "judgeB": {"tier": "transition"}}
    assert resolve(r, False) is None and r["status"] == "split_no_arbiter"
    r["judgeC"] = {"tier": "beginner"}
    assert resolve(r, True) == "beginner" and r["status"] == "ok"          # 2-of-3
    r["judgeC"] = {"tier": "advanced"}
    assert resolve(r, True) is None and r["status"] == "split_no_majority"  # 三分天下
    assert resolve({"judgeA": {"tier": "advanced", "borderline": False}}, True) == "advanced"
    assert resolve({"judgeA": None}, True) is None

    # Fleiss：3 例 × 3 评者手算例（全 beginner / 2b+1t / 全 transition）
    #   P_i = (Σ n_ij² − m)/(m(m−1)) → 1, 1/3, 1；P̄ = 7/9
    #   边缘 p_b = 5/9, p_t = 4/9 → P_e = 41/81
    #   kappa = (7/9 − 41/81)/(1 − 41/81) = 22/40 = 0.55
    hand = [["beginner"] * 3, ["beginner", "beginner", "transition"], ["transition"] * 3]
    fk = fleiss_kappa(hand)
    assert abs(fk["P_bar"] - 7 / 9) < 1e-12 and abs(fk["P_e"] - 41 / 81) < 1e-12, fk
    assert abs(fk["kappa"] - 0.55) < 1e-12, fk
    # 全体一致 → P̄=1、P_e=1 → kappa 不可定义（不是 1.0，别报个假满分）
    assert fleiss_kappa([["beginner"] * 3] * 4)["kappa"] is None
    # 三方全不同：P_i=0，两例的 P̄=0，kappa 应为负（比随机还差）
    fk3 = fleiss_kappa([list(TIERS), list(TIERS)])
    assert fk3["P_bar"] == 0 and abs(fk3["kappa"] + 0.5) < 1e-12, fk3
    assert fleiss_kappa([])["kappa"] is None
    try:
        fleiss_kappa([["beginner"] * 3, ["beginner"] * 2])
    except ValueError:
        pass
    else:
        raise AssertionError("评者数不齐应当报错而不是偷偷算")

    # v4 多数决
    def pr(a, b, c):
        r = {"judgeA": a and {"tier": a}, "judgeB": b and {"tier": b}, "judgeC": c and {"tier": c}}
        return resolve_panel(r), r["status"]
    assert pr("beginner", "beginner", "advanced") == ("beginner", "ok")           # 2-of-3
    assert pr("beginner", "beginner", "beginner") == ("beginner", "ok")
    assert pr("beginner", "transition", "advanced") == (None, "split_no_majority")  # 三分天下
    assert pr("beginner", "beginner", None) == ("beginner", "ok_partial_panel")     # C 挂，两方一致
    assert pr("beginner", "transition", None) == (None, "split_two_way_partial_panel")
    assert pr("beginner", None, None) == (None, "invalid_judgeBC")                  # 只剩一票
    assert pr(None, None, None)[1].startswith("invalid_")
    # v4 不看 borderline：A 自信判错也照样被 B/C 挑战（现行设计的 6 例盲区）
    r = {"judgeA": {"tier": "advanced", "borderline": False},
         "judgeB": {"tier": "transition"}, "judgeC": {"tier": "transition"}}
    assert resolve_panel(r) == "transition" and r["status"] == "ok"
    # 反向也成立：A 判对而 B/C 一致判错 → v4 把原本命中的例子翻掉（方向未知的证据）
    r = {"judgeA": {"tier": "beginner", "borderline": False},
         "judgeB": {"tier": "transition"}, "judgeC": {"tier": "transition"}}
    assert resolve_panel(r) == "transition"

    st = panel_stats([
        {"caseId": "x", "target": "beginner", "final": "beginner",
         "judgeA": {"tier": "beginner"}, "judgeB": {"tier": "beginner"}, "judgeC": {"tier": "advanced"}},
        {"caseId": "y", "target": "advanced", "final": None,
         "judgeA": {"tier": "beginner"}, "judgeB": {"tier": "transition"}, "judgeC": {"tier": "advanced"}},
    ])
    assert st["per_judge"]["judgeA"]["accuracy"] == 0.5, st["per_judge"]
    assert st["per_judge"]["judgeC"]["accuracy"] == 0.5      # C: advanced/advanced → 命中 y 不命中 x
    assert st["all_three_differ_n"] == 1 and st["all_three_differ_cases"] == ["y"]
    assert st["majority_2of3_n"] == 1 and st["unanimous_n"] == 0
    assert st["pairwise"]["AB"]["raw_agreement"] == 0.5 and st["pairwise"]["AB"]["n"] == 2
    assert st["majority_distribution"]["beginner"] == 1
    print("selftest ok")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry", action="store_true")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--arbiter", action="store_true",
                   help="口径 v3：borderline 且 A/B 分歧时触发判官 C，2-of-3 多数决（默认关）")
    g.add_argument("--panel", action="store_true",
                   help="口径 v4：每例都由 A/B/C 三判官独立盲评，2-of-3 多数决（3n 次调用）")
    ap.add_argument("--cases", default="", help="只跑指定 caseId（逗号分隔），小样本验证用")
    ap.add_argument("--resources", default="",
                    help="资源目录（默认 data/eval/adaptation_probe/resources）。错配对照批用")
    ap.add_argument("--out", default="",
                    help="产物目录（默认 runs/<ts>）。错配对照批产物不进 runs/，单列")
    ap.add_argument("--reliability-only", default="",
                    help="不调 API：读已有 run 的 verdicts.jsonl 补算 reliability.json")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if args.reliability_only:
        rd = pathlib.Path(args.reliability_only)
        if not rd.is_absolute():
            rd = PROBE / "runs" / rd.name
        records = [json.loads(l) for l in open(rd / "verdicts.jsonl", encoding="utf-8")]
        rel = reliability(records)
        rel["source_run"] = rd.name
        rel["computed_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
        json.dump(rel, open(rd / "reliability.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(json.dumps(rel, ensure_ascii=False, indent=2))
        print(f"落盘 {rd / 'reliability.json'}（verdicts.jsonl 未改动）")
        return

    res_dir = pathlib.Path(args.resources) if args.resources else PROBE / "resources"
    files = sorted(res_dir.glob("*.json"))
    if args.cases:
        want = {c.strip() for c in args.cases.split(",") if c.strip()}
        files = [f for f in files if f.stem in want]
    if args.limit:
        files = files[: args.limit]
    if not files:
        raise SystemExit(f"{res_dir} 为空——先跑 scripts/run-adaptation-probe.mjs 生成资源")
    if args.dry:
        print(f"{len(files)} 个资源待评")
        return

    key = load_key()
    session = requests.Session()
    session.trust_env = False  # 剥代理直连（siliconflow-clash-bypass 纪律）

    ts = time.strftime("%Y%m%d-%H%M%S")
    run_dir = pathlib.Path(args.out) if args.out else PROBE / "runs" / ts
    run_dir.mkdir(parents=True, exist_ok=True)
    out = open(run_dir / "verdicts.jsonl", "w", encoding="utf-8")

    hits = 0
    records: list[dict] = []
    per_tier: dict[str, list[int]] = {}
    dist: dict[str, int] = {}
    for i, f in enumerate(files):
        case = json.load(open(f, encoding="utf-8"))
        va, err_a = judge(session, key, JUDGE_A, case["text"])
        record = {"caseId": case["caseId"], "target": case["tier"], "judgeA": va}
        if err_a:
            record["error_judgeA"] = err_a
        if args.panel:
            # v4：B/C 无条件跑，且不看 A 的 borderline 自评——指标不再依赖判官 A
            # 的自报置信度（A 自信判错时旧口径根本不叫第二判官）。
            for name, model in (("judgeB", JUDGE_B), ("judgeC", JUDGE_C)):
                v, err = judge(session, key, model, case["text"], attempts=5)
                record[name] = v
                if err:
                    record[f"error_{name}"] = err
            verdict_tier = resolve_panel(record)
        else:
            if va and va.get("borderline"):
                # borderline 判官只在少数用例上跑，重试成本可忽略；而它一次静默失败
                # 就污染一个数据点（run 20260810-172357 的 t1-gradient），所以多试两轮。
                vb, err_b = judge(session, key, JUDGE_B, case["text"], attempts=5)
                record["judgeB"] = vb
                if err_b:
                    record["error_judgeB"] = err_b
                if args.arbiter and vb and vb["tier"] != va["tier"]:
                    vc, err_c = judge(session, key, JUDGE_C, case["text"], attempts=5)
                    record["judgeC"] = vc
                    if err_c:
                        record["error_judgeC"] = err_c
            verdict_tier = resolve(record, args.arbiter)
        hit = 1 if verdict_tier == case["tier"] else 0
        record["final"] = verdict_tier
        record["hit"] = hit
        hits += hit
        records.append(record)
        per_tier.setdefault(case["tier"], []).append(hit)
        if verdict_tier:
            dist[verdict_tier] = dist.get(verdict_tier, 0) + 1
        out.write(json.dumps(record, ensure_ascii=False) + "\n")
        out.flush()
        print(f"[{i+1}/{len(files)}] {case['caseId']} target={case['tier']} "
              f"judged={verdict_tier} hit={hit} status={record['status']}")
    out.close()

    n = len(files)
    invalid = [r["caseId"] for r in records if r["status"].startswith("invalid_")]
    rel = reliability(records)
    summary = {
        "n": n,
        "accuracy": hits / n,   # invalid 仍进分母记 0，保口径连续性
        "per_tier": {t: {"n": len(v), "acc": sum(v) / len(v)} for t, v in per_tier.items()},
        "judged_distribution": dist,
        "status_distribution": {s: sum(1 for r in records if r["status"] == s)
                                for s in sorted({r["status"] for r in records})},
        "invalid_cases": invalid,
        "accuracy_excl_invalid": hits / (n - len(invalid)) if n > len(invalid) else None,
        "judges": {"A": JUDGE_A, "B": JUDGE_B,
                   **({"C": JUDGE_C} if args.arbiter or args.panel else {})},
        "degenerate": any(c / max(1, sum(dist.values())) > 0.7 for c in dist.values()),
        "caliber": (
            "metric-calibers-v1 §2A rubric-v4（三判官全量独立盲评，2-of-3 多数决，对称口径）"
            if args.panel else
            "metric-calibers-v1 §2A rubric-v3（borderline 双判分歧送判官 C，2-of-3 多数决）"
            if args.arbiter else
            "metric-calibers-v1 §2A rubric-v2（判官盲评，borderline 双判官一致制，严格记 0）"
        ),
        "token_usage": dict(USAGE),
        "reliability": rel,
        **({"panel": panel_stats(records)} if args.panel else {}),
    }
    json.dump(summary, open(run_dir / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    json.dump(rel, open(run_dir / "reliability.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"\n准确率 {hits}/{n} = {hits/n:.1%}")
    per = ", ".join(f"{t}={d['acc']:.0%}({d['n']})" for t, d in summary["per_tier"].items())
    print(f"分档：{per}")
    if invalid:
        print(f"⚠ invalid（判官调用失败，非判偏）{len(invalid)} 例：{invalid}"
              f"；剔除后 {hits}/{n - len(invalid)} = {summary['accuracy_excl_invalid']:.1%}")
    k = rel["cohens_kappa"]
    print(f"判官信度：borderline {rel['borderline_n']}/{n}，双判可比 {rel['dual_judged_n']}，"
          f"原始一致 {rel['raw_agreement']:.1%}，kappa {k:.3f}" if k is not None else
          f"判官信度：borderline {rel['borderline_n']}/{n}，双判可比 {rel['dual_judged_n']}")
    if args.panel:
        p = summary["panel"]
        for jk, d in p["per_judge"].items():
            print(f"单判 {jk}={d['accuracy']:.1%}（valid {d['n_valid']}/{n}）")
        print("两两一致：" + "、".join(
            f"{k}={v['raw_agreement']:.1%}" for k, v in p["pairwise"].items()
            if v["raw_agreement"] is not None))
        fk = p["fleiss_kappa"]["kappa"]
        print(f"Fleiss kappa={fk:.3f}（完整三票 {p['complete_rows']}/{n}）" if fk is not None
              else f"Fleiss kappa 不可定义（完整三票 {p['complete_rows']}/{n}）")
        print(f"三票一致 {p['unanimous_n']}，2-of-3 {p['majority_2of3_n']}，"
              f"三方全不同 {p['all_three_differ_n']} {p['all_three_differ_cases']}")
    if summary["degenerate"]:
        print("⚠ 判定分布退化（某档 >70%）——判官疑似顺撇，本批作废")
    print(f"token 用量：{USAGE['calls']} 次调用，prompt {USAGE['prompt_tokens']}，"
          f"completion {USAGE['completion_tokens']}")
    print(f"落盘 {run_dir}")


if __name__ == "__main__":
    main()
