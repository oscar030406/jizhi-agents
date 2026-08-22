"""实操指南质量评测首轮（调研台账 docs/04-research/howto_eval_research_20260810.md
方案 A：三维 checklist judge + 方案 C：结构 lint 层）。

样本判定口径（与 classroom UI 徽标同源，scene-sidebar.tsx formBadge）：
- content.widgetType == 'procedural-skill' 的 interactive 场景（导出实操指南的正源，
  practice-guide.ts isProceduralScene）——当前全库为 0，分支保留；
- 非 quiz/interactive/pbl 且标题命中 /实操|实践|动手|上手|操作步骤|代码演示|运行/
  的场景（UI 上实际打「实操指南」徽标的就是这批）。
取文口径 = compute_kc_coverage.scene_text（画布正文+测验，不许两套）+ 讲解词。

lint 层（零 API，规则先跑真数据校准再冻结，宁漏不冤）：
  L1 no_step_sequence   指南无可辨识的步骤序列（编号行/第X步/①…）
  L2 step_numbering_gap 有编号步骤但编号不连续
  L3 code_without_env   出现命令/代码但全文无环境或版本声明
  L4 no_troubleshooting 无任何注意事项/常见错误/排错内容（PARADISE warning 维度）
  L5 no_expected_result 无任何预期结果/验收点描述

judge 层（3 维 × 双家族判官，绝对 checklist 逐项判，不给整体分——TOWER/
ContextualJudgeBench 教训；一次调用只问一个维度）：
  correctness   步骤正确性：可操作断言逐条核（编造命令/参数/菜单=幻觉子类）
  completeness  缺步完整性：判官先只看目标独立列必需步骤集（单独一问，不见
                指南全文，防锚定），再对照指南判缺失——essentiality 免标注近似
  executability 可执行性：每步所需前置是否已在前文交代
判官 A=MiniMaxAI/MiniMax-M2.5 主判，B=Qwen/Qwen3.6-35B-A3B 复核（双家族，
GLM 禁用，Qwen 必须 enable_thinking=False）。宽容偏置对策=逐项二元判定；
引文机械核验（norm 后子串匹配，核不上不采信）。两判官维度结论不一致记
disputed 单列，不硬合。

产出 data/eval/howto_quality/runs/<ts>/：verdicts.jsonl + summary.json。

用法：python scripts/eval_howto_quality.py [--lint-only] [--limit N] [--dry]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from compute_kc_coverage import scene_text  # noqa: E402 —— 同一取文口径
from judge_kc_coverage import norm  # noqa: E402 —— 同一引文归一化

CLASSROOMS = ROOT.parent / "classroom" / "data" / "classrooms"  # 只读
OUT_BASE = ROOT / "data/eval/howto_quality/runs"

JUDGE_A = "MiniMaxAI/MiniMax-M2.5"
JUDGE_B = "Qwen/Qwen3.6-35B-A3B"
API = "https://api.siliconflow.cn/v1/chat/completions"
MIN_QUOTE = 10  # norm 后引文最短长度，同 judge_kc_coverage

# UI 徽标同源正则（scene-sidebar.tsx L113）
BADGE_RE = re.compile(r"实操|实践|动手|上手|操作步骤|代码演示|运行")

# 估算单价（¥/M token）。仅供 summary 粗算，非官方价目；历史实测口径：
# 这两档判官 ~¥1-2 / 百次调用（judge_cost_compare.py 实测）。
PRICE = {JUDGE_A: (2.1, 8.4), JUDGE_B: (0.7, 2.8)}

# ---------------------------------------------------------------- 样本收集


def collect_samples(form: str = "all") -> list[dict]:
    """form='source' 只收正源 procedural-skill；'badge' 只收标题正则命中的散文；
    'all' 两种都收（默认，与 08-10 首轮同口径）。

    **两种形态不该混在一个分母里**。08-10 首轮 7 个样本全是 badge-title
    （正源全库 0 实例），completeness 判出 0/6 通过——那不是内容质量结论，
    是拿「最佳实践总结」这类散文去量「实操指南」的结果，见
    `docs/05-evidence/defect-ledger-20260810.md` N1。
    前端徽标已经改成两档（正源才叫「实操指南」，标题命中的降级成「实践建议」），
    这里跟上：默认仍两种都收但分开统计，要单看正源就 `--form source`。
    """
    samples = []
    for f in sorted(CLASSROOMS.glob("*.json")):
        d = json.load(open(f, encoding="utf-8"))
        stage_name = d.get("stage", {}).get("name", "?")
        for s in d.get("scenes", []):
            c = s.get("content") or {}
            is_ps = c.get("type") == "interactive" and c.get("widgetType") == "procedural-skill"
            is_badge = s.get("type") not in ("quiz", "interactive", "pbl") and BADGE_RE.search(
                s.get("title", "")
            )
            if not (is_ps or is_badge):
                continue
            if form == "source" and not is_ps:
                continue
            if form == "badge" and is_ps:
                continue
            speech = "\n".join(
                a.get("text", "")
                for a in s.get("actions", [])
                if isinstance(a, dict) and a.get("type") == "speech"
            )
            text = scene_text(s)
            if speech:
                text = text + "\n\n【讲解词】\n" + speech
            samples.append(
                {
                    "courseId": d["id"],
                    "courseName": stage_name,
                    "sceneId": s["id"],
                    "sceneTitle": s.get("title", ""),
                    "form": "procedural-skill" if is_ps else "badge-title",
                    "text": text.strip(),
                }
            )
    return samples


# ---------------------------------------------------------------- lint 层

STEP_LINE_RE = re.compile(r"(?m)^\s*(\d{1,2})[\.、．)）]\s*\S")
STEP_WORD_RE = re.compile(r"第\s*[一二三四五六七八九十\d]+\s*步|步骤\s*[一二三四五六七八九十\d]+|[①②③④⑤⑥⑦⑧⑨⑩]")
CODE_RE = re.compile(
    r"pip install|pip3 |python3? |import \w|git (clone|pull|push|checkout)|docker |npm |conda "
    r"|def \w+\(|print\(|```|\$\s?\w+|curl |CUDA|nvidia-smi"
)
ENV_RE = re.compile(
    r"版本|环境(要求|准备|配置|声明)|Python\s*3|v?\d+\.\d+\.\d+|依赖|前置(条件|要求)|预先安装|需先安装|requirements"
)
TROUBLE_RE = re.compile(
    r"注意|警告|常见(错误|问题|坑)|报错|排查|排错|踩坑|避坑|若(失败|报错|出错)|如果(失败|报错|出错)|错误处理|troubleshoot",
    re.I,
)
EXPECT_RE = re.compile(r"预期|应(看到|显示|输出|得到|返回)|输出(为|应)|结果(为|应)|成功(标志|的话)|验收|检查点")


def lint(text: str) -> list[str]:
    """返回违规代码列表。规则按 2026-08-10 首轮真数据校准冻结（校准记录见 summary）。"""
    v = []
    nums = [int(m.group(1)) for m in STEP_LINE_RE.finditer(text)]
    has_steps = bool(nums) or bool(STEP_WORD_RE.search(text))
    if not has_steps:
        v.append("L1_no_step_sequence")
    if nums:
        # 只在存在 ≥2 个编号行时查连续性；从任意起点允许（可能是节选），查断档
        uniq = sorted(set(nums))
        if len(uniq) >= 2 and any(b - a > 1 for a, b in zip(uniq, uniq[1:])):
            v.append("L2_step_numbering_gap")
    if CODE_RE.search(text) and not ENV_RE.search(text):
        v.append("L3_code_without_env")
    if not TROUBLE_RE.search(text):
        v.append("L4_no_troubleshooting")
    if not EXPECT_RE.search(text):
        v.append("L5_no_expected_result")
    return v


# ---------------------------------------------------------------- judge 层

SYS_CORRECTNESS = """你是实操指南事实审查员。给你一份中文教学实操内容全文，只做一件事：抽出其中全部「可操作断言」——具体命令、参数、函数/API 名、菜单或工具名、数值配置、以及「做了 X 会得到 Y」的因果陈述——逐条判定正确性。

逐条三选一：
- correct：与你掌握的事实一致
- incorrect：断言对象不存在（编造的命令/参数/函数/菜单项）或陈述与事实相悖
- unverifiable：无法从常识或公开知识判定

只输出 JSON：
{"items":[{"quote":"原文连续片段（逐字照抄，10-80字）","verdict":"correct|incorrect|unverifiable","why":"一句话"}],"no_actionable_claims":true|false}

quote 会被脚本机械核验，抄不准该条作废。宁可少列，不许编造原文。没有可操作断言时 items 为空且 no_actionable_claims=true。"""

SYS_COMPLETENESS_LIST = """你是实操教学设计专家。给你一个实操任务的标题与主题背景（不给正文），列出学习者要真正完成该任务所必需的操作步骤集，5-9 条，每条一句话，按执行顺序。

只输出 JSON：{"essential_steps":["...","..."]}"""

SYS_COMPLETENESS_CHECK = """你是实操指南完整性审查员。给你：(1) 一份必需步骤清单（独立拟定），(2) 指南全文。逐条判定每个必需步骤是否在指南中被实质覆盖（换说法也算，但仅标题提及或一笔带过不算）。

只输出 JSON：
{"items":[{"step":"清单原文","present":true|false,"evidence":"present 时引指南原文连续片段（逐字，10-80字），否则空串"}]}

evidence 会被机械核验，核不上按未覆盖处理。拿不准判 false。"""

SYS_EXECUTABILITY = """你是实操指南可执行性审查员。给你一份中文教学实操内容全文，对其中每个操作步骤（或可操作指示）逐条问：一个只读过本指南前文的学习者，此刻是否具备执行该步骤所需的全部前置（环境、工具、文件、参数值、前序步骤产物）？

只输出 JSON：
{"items":[{"quote":"该步骤原文连续片段（逐字，10-80字）","executable":true|false,"missing":"不可执行时缺什么，一句话"}],"no_steps":true|false}

quote 会被机械核验，抄不准该条作废。没有可辨识操作步骤时 items 为空且 no_steps=true。"""


def load_key() -> str:
    for line in open(ROOT / ".env", encoding="utf-8"):
        if line.startswith("SILICONFLOW_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("SILICONFLOW_API_KEY 不在 engine .env")


USAGE = {JUDGE_A: [0, 0], JUDGE_B: [0, 0]}  # model -> [prompt_tokens, completion_tokens]


def call(session: requests.Session, key: str, model: str, system: str, user: str) -> dict | None:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": 2000,
        "temperature": 0.1,
    }
    if "qwen" in model.lower():
        body["enable_thinking"] = False  # 思考吃光 token 无 JSON（20260809 事故）
    for attempt in range(3):
        try:
            r = session.post(API, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=180)
            r.raise_for_status()
            data = r.json()
            u = data.get("usage", {})
            USAGE[model][0] += u.get("prompt_tokens", 0)
            USAGE[model][1] += u.get("completion_tokens", 0)
            content = data["choices"][0]["message"]["content"]
            m = re.search(r"\{[\s\S]*\}", content)
            if m:
                return json.loads(m.group(0))
        except Exception as exc:  # noqa: BLE001
            if attempt == 2:
                print(f"  {model} 三试皆败：{exc}")
            time.sleep(2 * (attempt + 1))
    return None


def verify_items(items: list, text_norm: str, quote_key: str) -> tuple[list, int]:
    """引文机械核验：核得上的保留，核不上的丢弃（不采信）。返回 (采信项, 丢弃数)。"""
    kept, dropped = [], 0
    for it in items or []:
        if not isinstance(it, dict):
            dropped += 1
            continue
        q = norm(str(it.get(quote_key, "")))
        if len(q) >= MIN_QUOTE and q in text_norm:
            kept.append(it)
        else:
            dropped += 1
    return kept, dropped


def judge_dims(session, key, model, sample) -> dict:
    """一个判官对一份样本跑 3 维，返回 {dim: {verdict, items, dropped, raw_flags}}。"""
    text = sample["text"][:6000]
    tnorm = norm(text)
    out: dict = {}

    # correctness
    r = call(session, key, model, SYS_CORRECTNESS, f"实操内容全文：\n\n{text}")
    if r is None:
        out["correctness"] = {"verdict": None, "error": "no_response"}
    else:
        kept, dropped = verify_items(r.get("items", []), tnorm, "quote")
        bad = [it for it in kept if it.get("verdict") == "incorrect"]
        out["correctness"] = {
            "verdict": "fail" if bad else "pass",
            "incorrect": bad,
            "n_claims": len(kept),
            "quote_dropped": dropped,
            "no_actionable_claims": bool(r.get("no_actionable_claims")),
        }

    # completeness：两段式，第一问不见指南全文（防锚定）
    r1 = call(
        session,
        key,
        model,
        SYS_COMPLETENESS_LIST,
        f"任务标题：{sample['sceneTitle']}\n所属课程：{sample['courseName']}",
    )
    steps = (r1 or {}).get("essential_steps") or []
    steps = [str(s) for s in steps if str(s).strip()][:9]
    if not steps:
        out["completeness"] = {"verdict": None, "error": "no_essential_steps"}
    else:
        r2 = call(
            session,
            key,
            model,
            SYS_COMPLETENESS_CHECK,
            "必需步骤清单：\n" + "\n".join(f"- {s}" for s in steps) + f"\n\n指南全文：\n\n{text}",
        )
        if r2 is None:
            out["completeness"] = {"verdict": None, "error": "no_response"}
        else:
            items = [it for it in r2.get("items", []) if isinstance(it, dict)]
            # present=true 但引文核不上 → 按未覆盖
            missing = []
            for it in items:
                ok = it.get("present") is True
                if ok:
                    q = norm(str(it.get("evidence", "")))
                    ok = len(q) >= MIN_QUOTE and q in tnorm
                if not ok:
                    missing.append(it.get("step", ""))
            out["completeness"] = {
                "verdict": "fail" if missing else "pass",
                "essential_steps": steps,
                "missing": missing,
                "n_checked": len(items),
            }

    # executability
    r = call(session, key, model, SYS_EXECUTABILITY, f"实操内容全文：\n\n{text}")
    if r is None:
        out["executability"] = {"verdict": None, "error": "no_response"}
    else:
        kept, dropped = verify_items(r.get("items", []), tnorm, "quote")
        blocked = [it for it in kept if it.get("executable") is False]
        out["executability"] = {
            "verdict": "fail" if blocked else "pass",
            "blocked": blocked,
            "n_steps": len(kept),
            "quote_dropped": dropped,
            "no_steps": bool(r.get("no_steps")),
        }
    return out


DIMS = ("correctness", "completeness", "executability")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lint-only", action="store_true", help="只跑 lint 层，零 API（规则校准用）")
    ap.add_argument("--limit", type=int, default=12, help="judge 层样本上限（预算闸）")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument(
        "--form",
        choices=("all", "source", "badge"),
        default="all",
        help="source=只收正源 procedural-skill；badge=只收标题正则命中的散文；all=都收（默认）",
    )
    args = ap.parse_args()

    samples = collect_samples(args.form)
    n_src = sum(1 for s in samples if s["form"] == "procedural-skill")
    print(f"命中样本 {len(samples)} 个（正源 procedural-skill {n_src}，标题正则 {len(samples) - n_src}）：")
    if n_src == 0 and args.form != "badge":
        print("  ⚠ 正源一个都没有。这一轮的数字只能说明标题正则抽到了什么，")
        print("    不能当实操指南的内容质量结论——见 defect-ledger-20260810.md N1。")
    for s in samples:
        print(f"  {s['courseId']} | {s['courseName']} | {s['sceneTitle']} | {s['form']} | {len(s['text'])} 字")
    if args.dry:
        return

    ts = time.strftime("%Y%m%d-%H%M%S")
    run_dir = OUT_BASE / ts
    run_dir.mkdir(parents=True)

    lint_results = {s["sceneId"]: lint(s["text"]) for s in samples}
    if args.lint_only:
        for s in samples:
            print(f"[lint] {s['courseId']}/{s['sceneTitle']}: {lint_results[s['sceneId']] or 'clean'}")
        json.dump(
            {s["sceneId"]: lint_results[s["sceneId"]] for s in samples},
            open(run_dir / "lint_only.json", "w", encoding="utf-8"),
            ensure_ascii=False,
            indent=2,
        )
        print(f"落盘 {run_dir}/lint_only.json")
        return

    key = load_key()
    session = requests.Session()
    session.trust_env = False  # 剥代理直连（siliconflow-clash-bypass 纪律）

    todo = samples[: args.limit]
    out = open(run_dir / "verdicts.jsonl", "w", encoding="utf-8")
    dim_stats = {d: {"pass": 0, "fail": 0, "disputed": 0, "invalid": 0} for d in DIMS}

    for i, s in enumerate(todo):
        print(f"[{i+1}/{len(todo)}] {s['courseId']} | {s['sceneTitle']}")
        va = judge_dims(session, key, JUDGE_A, s)
        vb = judge_dims(session, key, JUDGE_B, s)
        final = {}
        for d in DIMS:
            a, b = va[d].get("verdict"), vb[d].get("verdict")
            if a is None or b is None:
                final[d] = "invalid"
            elif a == b:
                final[d] = a
            else:
                final[d] = "disputed"
            dim_stats[d][final[d] if final[d] in ("pass", "fail", "disputed") else "invalid"] += 1
            print(f"    {d}: A={a} B={b} -> {final[d]}")
        rec = {
            "courseId": s["courseId"],
            "courseName": s["courseName"],
            "sceneId": s["sceneId"],
            "sceneTitle": s["sceneTitle"],
            "form": s["form"],
            "lint": lint_results[s["sceneId"]],
            "judgeA": va,
            "judgeB": vb,
            "final": final,
        }
        out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    out.close()

    lint_dist: dict[str, int] = {}
    for v in lint_results.values():
        for code in v:
            lint_dist[code] = lint_dist.get(code, 0) + 1

    n = len(todo)
    cost = sum(
        USAGE[m][0] / 1e6 * PRICE[m][0] + USAGE[m][1] / 1e6 * PRICE[m][1] for m in USAGE
    )
    summary = {
        "n_total_library": len(samples),
        "n_judged": n,
        "sample_form_dist": {
            f: sum(1 for s in samples if s["form"] == f) for f in {s["form"] for s in samples}
        },
        "lint_violation_dist": lint_dist,
        "lint_n_scenes": len(samples),
        "dims": {
            d: {
                **dim_stats[d],
                "pass_rate_agreed": (
                    dim_stats[d]["pass"] / max(1, dim_stats[d]["pass"] + dim_stats[d]["fail"])
                ),
            }
            for d in DIMS
        },
        "disputed_rate": sum(dim_stats[d]["disputed"] for d in DIMS) / max(1, n * len(DIMS)),
        "judges": {"A": JUDGE_A, "B": JUDGE_B},
        "token_usage": {m: {"prompt": USAGE[m][0], "completion": USAGE[m][1]} for m in USAGE},
        "cost_cny_estimate": round(cost, 3),
        "cost_note": "单价为估算值（PRICE 常量），量级与 judge_cost_compare 历史实测一致",
        "caliber_note": "首轮探索性口径，未预注册；lint 规则本轮校准后冻结于脚本",
    }
    json.dump(summary, open(run_dir / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("\n=== summary ===")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"落盘 {run_dir}")


if __name__ == "__main__":
    main()
