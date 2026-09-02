r"""判官效度采样与评分（评测协议 §五）。

两个子命令：
  采样：python scripts\sample_judge_validity.py sample --cases 10 --mode api
    → data/eval/judge_validity/annotation_sheet.csv
      （每行一条 claim：判官判定 + 证据摘录 + 空白人工列 human_verdict）
  评分：python scripts\sample_judge_validity.py score --sheet <填完的csv>
    → 一致率 + Cohen's Kappa（三态 supported/weak/unsupported）

人工标注口径：只看 claim 与证据摘录，判 supported（证据充分）/ weak（沾边不足）/
unsupported（无据或矛盾）。标注人不看判官列（csv 里判官列放在最后，打印说明提醒遮挡）。
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OUT_DIR = ROOT / "data" / "eval" / "judge_validity"


def cmd_sample(args) -> None:
    if args.mode != "env":
        if getattr(args, "mode", "api") == "deterministic":
            raise SystemExit("确定性引擎已于 2026-08-28 移除；该口径需检出历史版本复算。")
    from backend.agents.content_audit_agent import ContentAuditAgent
    from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
    from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
    from backend.agents.resource_generation_agent import ResourceGenerationAgent
    from backend.services.data_loader import (
        get_learner_profile, load_e2e_cases, load_pretest_questions)
    from backend.services.quiz_service import estimate_pretest_from_profile

    cases = load_e2e_cases(gold="v2")[: args.cases]
    rows = []
    for case in cases:
        profile = get_learner_profile(case.learner_profile_id)
        diagnosis = LearnerDiagnosisAgent().run(
            profile, estimate_pretest_from_profile(profile, load_pretest_questions()),
            learning_goal=case.learning_goal)
        retrieval = KnowledgeRetrievalAgent().run(case.learning_goal, diagnosis)
        resources = ResourceGenerationAgent().run(profile, case.learning_goal, diagnosis, retrieval)
        audit = ContentAuditAgent().run(resources, diagnosis, retrieval)
        chunk_by_id = {c.source_id: c for c in retrieval.retrieved_chunks}
        for vi, v in enumerate(audit.claim_verdicts):
            evidence = " / ".join(
                chunk_by_id[sid].content[:150] for sid in v.source_ids if sid in chunk_by_id) or "（无引用）"
            rows.append({
                "sample_id": f"{case.id}#c{vi}",
                "claim": v.claim,
                "evidence_excerpt": evidence,
                "human_verdict": "",           # 标注人填：supported / weak / unsupported
                "judge_verdict": v.verdict,    # 标注时请遮挡此列
            })
        print(f"{case.id}: {len(audit.claim_verdicts)} claims (auditor={audit.auditor_engine})")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet = OUT_DIR / "annotation_sheet.csv"
    with open(sheet, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f"\n共 {len(rows)} 条 claim → {sheet}")
    print("标注说明：只看 claim 与 evidence_excerpt 填 human_verdict；judge_verdict 列请先遮挡。")


def cmd_score(args) -> None:
    with open(args.sheet, encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if r.get("human_verdict", "").strip()]
    if not rows:
        raise SystemExit("表中没有已标注的行")
    labels = ("supported", "weak", "unsupported")
    pairs = [(r["human_verdict"].strip(), r["judge_verdict"].strip()) for r in rows]
    bad = [p for p in pairs if p[0] not in labels or p[1] not in labels]
    if bad:
        raise SystemExit(f"存在非法标注值：{bad[:3]}")

    n = len(pairs)
    agree = sum(1 for h, j in pairs if h == j)
    po = agree / n
    h_counts = Counter(h for h, _ in pairs)
    j_counts = Counter(j for _, j in pairs)
    pe = sum((h_counts[c] / n) * (j_counts[c] / n) for c in labels)
    kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
    print(f"n={n} 观测一致率={po:.3f} 期望一致率={pe:.3f} Cohen's Kappa={kappa:.3f}")
    # 混淆矩阵
    print("\n混淆（行=人工，列=判官）：")
    print(f"{'':12s}" + "".join(f"{c:>12s}" for c in labels))
    for h in labels:
        row = Counter(j for hh, j in pairs if hh == h)
        print(f"{h:12s}" + "".join(f"{row[c]:>12d}" for c in labels))


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_sample = sub.add_parser("sample")
    p_sample.add_argument("--cases", type=int, default=10)
    p_sample.add_argument("--mode", choices=["env", "deterministic", "api"], default="env")
    p_score = sub.add_parser("score")
    p_score.add_argument("--sheet", required=True)
    args = parser.parse_args()
    cmd_sample(args) if args.cmd == "sample" else cmd_score(args)


if __name__ == "__main__":
    main()
