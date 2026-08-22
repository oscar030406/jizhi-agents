"""核心知识点覆盖率第二级：判官复核（口径 metric-calibers-v1 指标三）。

第一级机械匹配（compute_kc_coverage.py --emit-misses）漏掉换说法的概念，
本脚本把 misses+mentions 逐条交判官：这门课是否**实质讲解**了该知识成分。

防幻觉铁律：判官必须引用课内原文连续片段作证据；脚本对引文做机械核验
（归一化后子串匹配课程全文），引文核不上的判定一律不采信，维持 miss。
默认保守：拿不准=miss。borderline 送判官 B 独立复核，两判不一致维持 miss。

判官姿势照抄 judge_adaptation_probe.py：MiniMax-M2.5 主判，Qwen3.6-35B
仅 borderline 复核（Qwen 系必须 enable_thinking=False），GLM 系禁用，
硅基流动直连（session.trust_env=False）。

最终覆盖率 =（机械命中 + 判官确认）/ 金标总数。
产出 data/eval/kc_coverage/runs/<ts>-<topic>/：verdicts.jsonl + summary.json。

用法：
  python scripts/judge_kc_coverage.py --gold data/eval/kc_gold/attention.json \
      --course ../classroom/data/classrooms/h9BW5iQ-9D.json \
      --misses data/eval/kc_coverage/l1/attention.misses.json [--dry]
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
from compute_kc_coverage import scene_text  # noqa: E402 —— 同一取文口径，不许两套

JUDGE_A = "MiniMaxAI/MiniMax-M2.5"
JUDGE_B = "Qwen/Qwen3.6-35B-A3B"
API = "https://api.siliconflow.cn/v1/chat/completions"
OUT_BASE = ROOT / "data/eval/kc_coverage/runs"

MIN_QUOTE = 10  # 归一化后引文最短长度，防「RAG」三个字母也算证据

SYSTEM = """你是课程内容审查员。给你一门课的全文和一个知识成分（KC），判定这门课是否**实质讲解**了该知识成分。

判定标准（严格口径）：
- 实质讲解 = 课程用自己的话解释了该概念的含义/原理/作用，学习者读完能理解它。可能换了说法（不用金标里的词），要按概念实质判。
- 以下都**不算**：仅在标题/列表里出现词语；一句话带过没有解释；只讲了相邻概念但没讲这个。
- 拿不准一律判未覆盖（covered=false）。

只输出 JSON：
{"covered": true|false, "quote": "课内原文的连续片段（逐字照抄，勿改写，20-100字，是讲解该KC的核心句）", "reason": "一句话：为什么算/不算实质讲解", "borderline": true|false}

quote 必须逐字来自课程全文，脚本会机械核验，抄不准判定作废。covered=false 时 quote 可为空字符串。拿不准两可之间时 borderline 设 true。"""


def load_key() -> str:
    for line in open(ROOT / ".env", encoding="utf-8"):
        if line.startswith("SILICONFLOW_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("SILICONFLOW_API_KEY 不在 engine .env")


# 归一化：去空白+常见标点+小写。引文核验与课程全文用同一函数。
_NORM_RE = re.compile(r"[\s，。、；：''\"\"（）()\[\]【】《》,.;:'\"?!？！\-—·…「」『』*]+")


def norm(s: str) -> str:
    return _NORM_RE.sub("", s).lower()


def judge(session: requests.Session, key: str, model: str, course_text: str, kc: dict) -> dict | None:
    user = (
        f"知识成分：{kc['name']}\n"
        f"可能的说法：{', '.join(kc.get('synonyms', []))}\n\n"
        f"课程全文：\n\n{course_text}"
    )
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": user},
        ],
        "max_tokens": 800,
        "temperature": 0.1,
    }
    if "qwen" in model.lower():
        body["enable_thinking"] = False  # 思考模型不关思考=没 JSON（判官 B 首跑事故）
    for attempt in range(3):
        try:
            r = session.post(API, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=120)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            m = re.search(r"\{[\s\S]*\}", content)
            if not m:
                continue
            parsed = json.loads(m.group(0))
            if isinstance(parsed.get("covered"), bool):
                return parsed
        except Exception as exc:  # noqa: BLE001 —— 重试后如实记失败
            if attempt == 2:
                print(f"  judge {model} 三试皆败：{exc}")
            time.sleep(2 * (attempt + 1))
    return None


def verify_quote(verdict: dict | None, corpus_norm: str) -> bool:
    if not verdict or not verdict.get("covered"):
        return False
    q = norm(str(verdict.get("quote", "")))
    return len(q) >= MIN_QUOTE and q in corpus_norm


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    ap.add_argument("--course", required=True)
    ap.add_argument("--misses", required=True, help="compute_kc_coverage.py --emit-misses 的输出")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    def rd(p: str) -> dict:
        path = pathlib.Path(p)
        return json.load(open(path if path.is_absolute() else ROOT / p, encoding="utf-8"))

    gold, course, l1 = rd(args.gold), rd(args.course), rd(args.misses)

    kc_by_id = {kc["id"]: kc for kc in gold["knowledge_components"]}
    total = len(kc_by_id)
    items = [{"kc": m["kc"], "l1": "miss"} for m in l1.get("misses", [])] + [
        {"kc": m["kc"], "l1": "mention"} for m in l1.get("mentions", [])
    ]
    mech_hits = total - len(items)

    scenes = course.get("scenes", [])
    corpus = "\n\n".join(
        f"【场景：{s.get('title', f'scene{i}')}】\n{scene_text(s)}" for i, s in enumerate(scenes)
    )
    corpus_norm = norm(corpus)

    course_name = course.get("stage", {}).get("name", args.course)
    print(f"课程：{course_name}｜金标：{gold['topic']}（{gold.get('status')}）")
    print(f"机械命中 {mech_hits}/{total}，待判官复核 {len(items)} 条：{[it['kc'] for it in items]}")
    if str(gold.get("status", "")).startswith("draft"):
        print("⚠ 金标为草稿——本数字禁入 metrics。")
    if args.dry:
        return

    ts = time.strftime("%Y%m%d-%H%M%S")
    run_dir = OUT_BASE / f"{ts}-{gold['topic']}"
    run_dir.mkdir(parents=True)

    confirmed = 0
    records = []
    if items:
        key = load_key()
        session = requests.Session()
        session.trust_env = False  # 剥代理直连（siliconflow-clash-bypass 纪律）

    with open(run_dir / "verdicts.jsonl", "w", encoding="utf-8") as out:
        for it in items:
            kc = kc_by_id[it["kc"]]
            va = judge(session, key, JUDGE_A, corpus, kc)
            a_ok = verify_quote(va, corpus_norm)
            rec = {"kc": kc["id"], "name": kc["name"], "l1": it["l1"], "judgeA": va, "judgeA_quote_verified": a_ok}
            final = "miss"
            if a_ok:
                if va.get("borderline"):
                    vb = judge(session, key, JUDGE_B, corpus, kc)
                    b_ok = verify_quote(vb, corpus_norm)
                    rec["judgeB"] = vb
                    rec["judgeB_quote_verified"] = b_ok
                    final = "covered" if b_ok else "miss"  # 两判不一致维持 miss
                else:
                    final = "covered"
            elif va and va.get("covered"):
                rec["note"] = "判官称覆盖但引文机械核验失败——不采信"
            rec["final"] = final
            confirmed += final == "covered"
            records.append(rec)
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(f"  {kc['id']}: judgeA covered={(va or {}).get('covered')} "
                  f"quote_ok={a_ok} final={final}")

    coverage = (mech_hits + confirmed) / total
    summary = {
        "course": args.course,
        "course_name": course_name,
        "gold": args.gold,
        "gold_topic": gold["topic"],
        "gold_status": gold.get("status"),
        "total": total,
        "mech_hits": mech_hits,
        "judged": len(items),
        "judge_confirmed": confirmed,
        "coverage": coverage,
        "judges": {"A": JUDGE_A, "B": JUDGE_B},
        "missing_kcs": [r["kc"] for r in records if r["final"] == "miss"],
        "caliber": "metric-calibers-v1 指标三（两级判定：机械匹配+判官复核；判官引文机械核验，核不上不采信；borderline 双判一致制）",
    }
    json.dump(summary, open(run_dir / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"覆盖率 =（机械 {mech_hits} + 判官确认 {confirmed}）/{total} = {coverage:.1%}")
    print(f"落盘 {run_dir}")


if __name__ == "__main__":
    main()
