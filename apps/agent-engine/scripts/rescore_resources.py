r"""独立尺子复判（去混杂）：对消融落盘的资源用指定判官重算 faith/halluc。

背景：hetero_debate 的修订器与测量判官同为 GLM（key 无第三家非推理模型），
同族自偏风险。本脚本用两把独立尺子复判落盘资源：
  --judge deterministic  词元重叠打分器（零族偏，免费）
  --judge v4flash        DeepSeek-V4-Flash 判官（第三家；判定输出短，推理型可扛）

用法：python scripts\rescore_resources.py --dir data\eval\autopsy\resources --judge deterministic
输出：终端按 mode 汇总表 + <dir>\rescore_<judge>.csv 逐行结果。
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--judge", required=True,
                        help="deterministic 或任意判官模型 id（如 deepseek-ai/DeepSeek-V3.2、"
                             "tencent/Hunyuan-A13B-Instruct）")
    args = parser.parse_args()

    if args.judge != "deterministic":
        os.environ["AGENT_GENERATION_MODE"] = "api"
        os.environ["LLM_MODEL_JUDGE"] = args.judge
        os.environ.setdefault("LLM_TIMEOUT_SECONDS", "300")
    else:
        os.environ["AGENT_GENERATION_MODE"] = "deterministic"

    from backend.rag.claims import claim_statistics, extract_claims, verify_claims
    from backend.schemas.resources import KnowledgeChunk, LearningResources, RetrievalResult
    from backend.agents.content_audit_agent import ContentAuditAgent

    agent = ContentAuditAgent()  # v4flash 模式下 judge 路由已被环境覆写
    rows = []
    files = sorted(args.dir.glob("*__*.json"))
    if not files:
        raise SystemExit(f"{args.dir} 下没有落盘资源")
    for f in files:
        d = json.loads(f.read_text(encoding="utf-8"))
        resources = LearningResources.model_validate(d["resources"])
        retrieval = RetrievalResult.model_validate(d["retrieval"])
        chunks = [KnowledgeChunk.model_validate(c) for c in d["retrieval"]["retrieved_chunks"]]

        # 与生产审核同构：确定性初筛 → （LLM 判官模式）独立家族 judge 终裁存疑项
        verdicts = verify_claims(extract_claims(resources), chunks)
        if args.judge != "deterministic":
            reviewed = agent._llm_review(verdicts, retrieval)
            if reviewed is None:
                print(f"⚠ {f.name} judge 复核未生效（无存疑项或调用失败），保留初筛结果")
            else:
                verdicts = reviewed
        stats = claim_statistics(verdicts)
        total = stats["claims_total"]
        supported = sum(1 for v in verdicts if v.verdict == "supported")
        rows.append({
            "case_id": d["case_id"], "mode": d["mode"],
            "claims": total,
            "faithfulness": round(supported / total, 3) if total else 1.0,
            "hallucination_rate": stats["hallucination_rate"],
            "fallback_rate": d.get("fallback_rate", 0),
        })

    out_csv = args.dir / f"rescore_{args.judge.replace('/', '__')}.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    by_mode = defaultdict(list)
    for r in rows:
        if float(r["fallback_rate"]) == 0:  # 净化口径
            by_mode[r["mode"]].append(r)
    print(f"判官={args.judge} · 净化口径（fallback=0）")
    print(f"{'mode':22s} {'n':>3s} {'faith':>14s} {'halluc':>14s}")
    for mode, rs in sorted(by_mode.items()):
        fs = [float(r["faithfulness"]) for r in rs]
        hs = [float(r["hallucination_rate"]) for r in rs]
        f_s = st.stdev(fs) if len(fs) > 1 else 0.0
        h_s = st.stdev(hs) if len(hs) > 1 else 0.0
        print(f"{mode:22s} {len(rs):>3d} {st.mean(fs):>7.3f}±{f_s:.3f} {st.mean(hs):>7.3f}±{h_s:.3f}")
    print(f"→ {out_csv}")


if __name__ == "__main__":
    main()
