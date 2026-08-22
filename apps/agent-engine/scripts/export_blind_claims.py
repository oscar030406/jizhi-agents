"""判官效度人工盲标表：从评测逐条判词抽样，抹掉判官结论给人标。

产出三个文件（默认 dist/blind_claims/）：
  盲标表.csv     —— 标注者用：断言 + 证据原文，判定列留空
  answer_key.csv —— 对照表：判官原判，标完前别看
  README.md      —— 标注说明与判定标准

抽样分层：全部 unsupported + 全部 weak + 随机 supported + 随机 not_a_claim，
凑到 --n（默认 120）。判官准确率/Kappa 用 answer_key 对人工列算。

用法：python scripts/export_blind_claims.py [--n 120] [--seed 7]
"""

from __future__ import annotations

import argparse
import csv
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "data" / "eval" / "real_llm_v2" / "real_llm_results.json"
KB_INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"

EVIDENCE_CHARS = 1400  # 与判官看到的窗口一致（content_audit_agent.JUDGE_EVIDENCE_CHARS）


def load_chunks() -> dict[str, dict]:
    chunks = {}
    with KB_INDEX.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                c = json.loads(line)
                chunks[c["source_id"]] = c
    return chunks


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--n", type=int, default=120)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=ROOT.parents[1] / "dist" / "blind_claims")
    args = parser.parse_args()
    random.seed(args.seed)

    data = json.loads(RESULTS.read_text(encoding="utf-8"))
    chunks = load_chunks()

    pool: dict[str, list[dict]] = {"unsupported": [], "weak": [], "supported": [], "not_a_claim": []}
    for row in data["rows"]:
        if row.get("generation_engine") != "llm":
            continue
        for v in row.get("claim_verdicts", []):
            verdict = v.get("verdict")
            if verdict not in pool:
                continue
            sid = v.get("matched") or (v.get("cited") or [None])[0]
            chunk = chunks.get(sid)
            pool[verdict].append({
                "case": row["case_id"],
                "claim": v["claim"],
                "evidence_id": sid or "",
                "evidence": (f"{chunk['title']}：{chunk['content'][:EVIDENCE_CHARS]}" if chunk else "（引用的证据不在知识库索引中）"),
                "judge_verdict": verdict,
            })

    # 分层：少数类全取，多数类随机补齐
    sample = pool["unsupported"] + pool["weak"]
    rest = args.n - len(sample)
    n_na = min(len(pool["not_a_claim"]), rest // 3)
    sample += random.sample(pool["not_a_claim"], n_na)
    sample += random.sample(pool["supported"], min(len(pool["supported"]), rest - n_na))
    random.shuffle(sample)

    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    with (out / "盲标表.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["编号", "断言", "证据原文", "人工判定", "备注"])
        for i, s in enumerate(sample, 1):
            w.writerow([i, s["claim"], s["evidence"], "", ""])
    with (out / "answer_key.csv").open("w", encoding="utf-8-sig", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["编号", "case", "evidence_id", "judge_verdict"])
        for i, s in enumerate(sample, 1):
            w.writerow([i, s["case"], s["evidence_id"], s["judge_verdict"]])
    (out / "README.md").write_text(
        "# 盲标说明\n\n"
        "对每一行，只看「断言」和「证据原文」两列，在「人工判定」填四选一：\n\n"
        "- `supported`：证据原文直接支持该断言（允许改写，意思一致即可）\n"
        "- `weak`：证据只部分沾边，或需要额外推断才能成立\n"
        "- `unsupported`：证据里找不到支持，或断言与证据矛盾\n"
        "- `not_a_claim`：这句根本不是领域事实断言（教学类比、对学习者说的话、\n"
        "  对讲义结构的回指、题目解析、代码）\n\n"
        "纪律：**别看 answer_key.csv**（判官原判，标完才对）；不确定就按自己的判断填，\n"
        "不要跳过；一行 30 秒内定不了就凭第一直觉。\n\n"
        f"共 {len(sample)} 条。标完把表发回，跑 Kappa 出判官-人工一致率。\n",
        encoding="utf-8")
    counts = {k: sum(1 for s in sample if s["judge_verdict"] == k) for k in pool}
    print(f"抽样 {len(sample)} 条：{counts}")
    print(f"输出：{out}")


if __name__ == "__main__":
    main()
