"""排雷 C 层：摘录相关性全量判官审计（用户口径「牛头不对马嘴」）。

机械守卫只能抓操作性文本（2/60）；「引文自包含但与当前论点不搭」需要语义判。
对每条摘录取其前文讲义段落做锚，判官judge三档：
  supports  引文直接支撑/例证前文论点
  related   同主题但支撑关系弱（贴着但没咬合）
  unrelated 与前文论点无关（牛头不对马嘴）
判官 MiniMax-M2.5（低价档）。逐条判词落盘 data/eval/excerpt_relevance/。

用法：python scripts/audit_excerpt_relevance.py [--limit N]
"""

from __future__ import annotations

import argparse
import glob
import html as H
import json
import os
import pathlib
import re
import sys
import time

import requests

ROOT = pathlib.Path(__file__).resolve().parents[1]
COURSES = ROOT / "../classroom/data/classrooms"
OUT = ROOT / "data/eval/excerpt_relevance"

MODEL = "MiniMaxAI/MiniMax-M2.5"
API = "https://api.siliconflow.cn/v1/chat/completions"
TAG = re.compile(r"<[^>]+>")
EXC = re.compile(r"📖\s*(.*?)——\s*摘自《([^《》]*)》\s*\[([^\]]+)\]", re.S)

SYSTEM = """你是教材引文审核员。给你一段讲义正文（引文的上文）和一段教材引文，判断引文与讲义论点的贴合度，三选一：
- supports：引文直接支撑、解释或例证上文论点，读者读了引文对理解上文有实质帮助
- related：引文与上文同主题，但支撑关系弱——贴着话题却没咬合论点
- unrelated：引文与上文论点无关，或脱离原书语境后无法理解（如操作步骤、图表解说）
只输出 JSON：{"verdict": "supports|related|unrelated", "because": "一句话理由"}"""


def load_key() -> str:
    for line in open(ROOT / ".env", encoding="utf-8"):
        if line.startswith("SILICONFLOW_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no key")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    cases = []
    for f in sorted(glob.glob(str(COURSES / "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        cname = d.get("stage", {}).get("name", "")
        for sc in d.get("scenes", []):
            c = sc.get("content") or {}
            els = c.get("canvas", {}).get("elements") or c.get("elements") or []
            # 上下文必须跨元素拼（首版只取同元素内前文——摘录注入是独立成块的，
            # 同元素前文必空，判官全判「上文为空」→ 22 条假 unrelated，作废重跑）
            texts = [
                H.unescape(TAG.sub(" ", el["content"]))
                if isinstance(el, dict) and el.get("type") == "text" and isinstance(el.get("content"), str)
                else ""
                for el in els
            ]
            for i, text in enumerate(texts):
                for m in EXC.finditer(text):
                    before = ("\n".join(texts[:i]) + "\n" + text[: m.start()]).strip()[-600:]
                    cases.append({
                        "course": cname, "scene": sc.get("title", ""), "sid": m.group(3),
                        "context": before, "excerpt": m.group(1).strip()[:800],
                    })
    if args.limit:
        cases = cases[: args.limit]
    print(f"{len(cases)} 条摘录待审")

    key = load_key()
    s = requests.Session()
    s.trust_env = False
    OUT.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    outf = open(OUT / f"verdicts-{ts}.jsonl", "w", encoding="utf-8")

    from collections import Counter
    dist: Counter[str] = Counter()
    for i, case in enumerate(cases):
        body = {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": f"讲义上文：\n{case['context']}\n\n教材引文：\n{case['excerpt']}"},
            ],
            "max_tokens": 300, "temperature": 0.1,
        }
        verdict = None
        for attempt in range(3):
            try:
                r = s.post(API, json=body, headers={"Authorization": f"Bearer {key}"}, timeout=90)
                r.raise_for_status()
                mm = re.search(r"\{[\s\S]*\}", r.json()["choices"][0]["message"]["content"])
                parsed = json.loads(mm.group(0)) if mm else None
                if parsed and parsed.get("verdict") in {"supports", "related", "unrelated"}:
                    verdict = parsed
                    break
            except Exception:
                time.sleep(2 * (attempt + 1))
        rec = {**case, "verdict": (verdict or {}).get("verdict"), "because": (verdict or {}).get("because")}
        rec["context"] = rec["context"][-160:]
        rec["excerpt"] = rec["excerpt"][:160]
        outf.write(json.dumps(rec, ensure_ascii=False) + "\n")
        dist[rec["verdict"] or "failed"] += 1
        print(f"[{i+1}/{len(cases)}] {case['course'][:10]}·{case['scene'][:10]} → {rec['verdict']}")
    outf.close()
    print(f"\n分布：{dict(dist)}")
    print(f"落盘 {OUT}")


if __name__ == "__main__":
    main()
