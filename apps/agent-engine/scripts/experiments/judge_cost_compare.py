"""判官性价比对比（用户 08-03 采购原则：质量第一，同质取廉）。

测试集：data/experiments/claim_truth_set.json——36 条已知真值断言
（语料支持 12 / 植入假 12 / 超语料真 12），带每场景 evidence_query。
任务：候选判官拿 claim+检索证据做三态判定，与真值算准确率与逐类召回。
三态映射：supported_by_corpus→supported；planted_false→incorrect；
true_beyond_corpus→uncertain（超出资料覆盖，正确行为是不判对错）。

候选（全部与生成方 DeepSeek 异厂商，保住交叉验证约束）：
  zai-org/GLM-5.2          现任（账单 62% 的大头）
  Qwen/Qwen3.5-122B-A10B   候选 A（约 1/4 价）
  MiniMaxAI/MiniMax-M2.5   候选 B（约 1/4 价）

裁决规则（质量第一）：候选总准确率 ≥ 现任 −2 个点才有换的资格；
planted_false 召回（漏放假断言=最危险错误）单独看，掉了一票否决。

跑法（剥代理+key）：python scripts/experiments/judge_cost_compare.py
成本：36×3 调用 ≈ ¥1-2。结果落 data/experiments/judge_cost_compare_result.json
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

MODELS = [
    "zai-org/GLM-5.2",
    "Qwen/Qwen3.5-122B-A10B",
    "MiniMaxAI/MiniMax-M2.5",
]

TRUTH_TO_VERDICT = {
    "supported_by_corpus": "supported",
    "planted_false": "incorrect",
    "true_beyond_corpus": "uncertain",
}

SYSTEM = """你是教学内容的事实审核判官。给你一条断言和一组教材资料，做三态判定：
- supported：断言的内容能在资料中找到直接依据；
- incorrect：断言与资料内容矛盾，或者包含资料明确否定的说法；
- uncertain：资料没有覆盖这条断言（既不能证实也不能证伪）。注意：资料没讲到不等于错。

只输出 JSON：{"verdict": "supported|incorrect|uncertain", "because": "一句话依据"}"""


def fetch_evidence(query: str) -> str:
    qs = urllib.parse.urlencode({"query": query, "top_k": "6", "corpus": "ai"})
    req = urllib.request.Request(
        f"http://127.0.0.1:8001/internal/v1/personalize/evidence?{qs}",
        headers={"x-internal-token": "demo-internal-token"},
    )
    data = json.load(urllib.request.urlopen(req, timeout=30)).get("data") or {}
    chunks = data.get("chunks") or []
    return "\n\n".join(f"[{c['source_id']}] {c['title']}\n{c['content'][:1200]}" for c in chunks)


def call(model: str, key: str, system: str, user: str) -> str:
    resp = requests.post(
        "https://api.siliconflow.cn/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json={
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
            "max_tokens": 200,
            "response_format": {"type": "json_object"},
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def main() -> None:
    key = os.environ.get("SILICONFLOW_API_KEY", "")
    if not key:
        raise SystemExit("缺 SILICONFLOW_API_KEY")
    data = json.load(open(ROOT / "data/experiments/claim_truth_set.json", encoding="utf-8"))

    evidence_cache: dict[str, str] = {}
    rows = []
    for scene in data["scenes"]:
        q = scene["evidence_query"]
        if q not in evidence_cache:
            evidence_cache[q] = fetch_evidence(q)
        for claim in scene["claims"]:
            rows.append((claim, evidence_cache[q]))
    print(f"{len(rows)} 条断言 × {len(MODELS)} 判官")

    results: dict[str, dict] = {}
    for model in MODELS:
        preds = []
        for i, (claim, evidence) in enumerate(rows):
            user = f"【资料】\n{evidence}\n\n【断言】{claim['text']}\n请判定。"
            try:
                out = call(model, key, SYSTEM, user)
                verdict = json.loads(out).get("verdict", "parse_error")
            except Exception as exc:  # 单条失败记 error，不炸整轮
                verdict = f"error:{type(exc).__name__}"
            preds.append(verdict)
            print(f"\r  {model} {i + 1}/{len(rows)}", end="")
        print()
        gold = [TRUTH_TO_VERDICT[c["truth"]] for c, _ in rows]
        acc = sum(p == g for p, g in zip(preds, gold)) / len(gold)
        per_class = {}
        for cls in ("supported", "incorrect", "uncertain"):
            idx = [i for i, g in enumerate(gold) if g == cls]
            per_class[cls] = round(sum(preds[i] == cls for i in idx) / len(idx), 3)
        confusion = Counter(zip(gold, preds))
        results[model] = {
            "accuracy": round(acc, 3),
            "recall_per_class": per_class,
            "confusion": {f"{g}->{p}": n for (g, p), n in sorted(confusion.items())},
        }
        print(f"  acc={acc:.3f} 逐类召回={per_class}")

    out_path = ROOT / "data/experiments/judge_cost_compare_result.json"
    out_path.write_text(
        json.dumps({"n": len(rows), "models": results}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"\n→ {out_path}")


if __name__ == "__main__":
    main()
