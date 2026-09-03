# -*- coding: utf-8 -*-
"""RAGTruth QA 测试集全量（900 条）上，比较三种审核配置的响应级幻觉检测：

1. deterministic        确定性词汇接地层单独判（bench_ragtruth.py 的口径）
2. two_level            确定性初筛 + LLM 判官只复核存疑句（bench_ragtruth.py --judge 的口径，但跑全量不抽样）
3. judge_all            LLM 判官审全部句子（生产里判官看的是全部断言，这才是"判官层"的检测能力）

与 bench_ragtruth.py 的差别：不抽平衡样本、判官看全部句子、判官看完整 passage（原脚本每段截 400 字符）、并发调用、逐条落盘可续跑。
v1 产物（截 400 字符）保留为 ragtruth_judge_full.jsonl/.csv，本版写 *_v2。
不改 bench_ragtruth.py，只 import 它的函数。

用法：
    cd apps/agent-engine
    python scripts/bench_ragtruth_judge_full.py --concurrency 6
产物：
    data/eval/ragtruth_judge_full_v2.jsonl 每条回答的 gold / 三种口径的无据句占比
    data/eval/ragtruth_judge_full_v2.csv   三种口径在 τ 扫描下的 P/R/F1，含最优操作点
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import bench_ragtruth as B  # noqa: E402
from backend.schemas.resources import ClaimVerdict, KnowledgeChunk  # noqa: E402

TAUS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]
OUT_JSONL = ROOT / "data" / "eval" / "ragtruth_judge_full_v2.jsonl"
OUT_CSV = ROOT / "data" / "eval" / "ragtruth_judge_full_v2.csv"


EVIDENCE_CHARS = 6000  # RAGTruth QA 的 passage 常有几百词；原脚本每段截 400 字符，证据被截掉会把有据句判成无据


def judge_disputed(verdicts: list[ClaimVerdict], chunks: list[KnowledgeChunk], gateway) -> list[ClaimVerdict]:
    """两级审核：只把确定性初筛判为非 supported 的句子交判官，判官看完整证据。"""
    disputed = [(i, v) for i, v in enumerate(verdicts) if v.verdict != "supported"]
    if not disputed:
        return verdicts
    batch = disputed[:24]
    claim_lines = "\n".join(f"{k + 1}. {v.claim}" for k, (_, v) in enumerate(batch))
    evidence_lines = "\n".join(f"[{c.source_id}] {c.content[:EVIDENCE_CHARS]}" for c in chunks)
    parsed = gateway.structured_chat(
        "EvaluationJudge", B.JUDGE_SYSTEM,
        f"Claims:\n{claim_lines}\n\nEvidence:\n{evidence_lines}", temperature=0.0, max_tokens=1200,
    )
    if not parsed or not isinstance(parsed.get("verdicts"), list):
        return verdicts
    merged = [v.model_copy() for v in verdicts]
    allowed = {"supported", "weak", "unsupported"}
    for item in parsed["verdicts"]:
        if isinstance(item, dict):
            k, verdict = item.get("index"), str(item.get("verdict", "")).lower()
            if isinstance(k, int) and 1 <= k <= len(batch) and verdict in allowed:
                merged[batch[k - 1][0]] = merged[batch[k - 1][0]].model_copy(update={"verdict": verdict})
    return merged


def judge_all(verdicts: list[ClaimVerdict], chunks: list[KnowledgeChunk], gateway) -> list[ClaimVerdict] | None:
    """判官审全部句子，最多 24 句一批（RAGTruth QA 回答很少超过）。返回 None 表示判官没给出可解析结果。"""
    if not verdicts:
        return verdicts
    batch = verdicts[:24]
    claim_lines = "\n".join(f"{k + 1}. {v.claim}" for k, v in enumerate(batch))
    evidence_lines = "\n".join(f"[{c.source_id}] {c.content[:EVIDENCE_CHARS]}" for c in chunks)
    parsed = gateway.structured_chat(
        "EvaluationJudge", B.JUDGE_SYSTEM,
        f"Claims:\n{claim_lines}\n\nEvidence:\n{evidence_lines}", temperature=0.0, max_tokens=1200,
    )
    if not parsed or not isinstance(parsed.get("verdicts"), list):
        return None
    merged = [v.model_copy() for v in verdicts]
    allowed = {"supported", "weak", "unsupported"}
    for item in parsed["verdicts"]:
        if isinstance(item, dict):
            k, verdict = item.get("index"), str(item.get("verdict", "")).lower()
            if isinstance(k, int) and 1 <= k <= len(batch) and verdict in allowed:
                merged[k - 1] = merged[k - 1].model_copy(update={"verdict": verdict})
    return merged


def load_records(dataset_dir: Path, task: str, split: str) -> list[dict]:
    source_info = B.load_source_info(dataset_dir)
    allowed = {sid for sid, obj in source_info.items() if obj.get("task_type") == task}
    records = []
    with (dataset_dir / "response.jsonl").open("r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            resp = json.loads(line)
            if resp.get("split") != split or resp["source_id"] not in allowed:
                continue
            chunks = B.passages_to_chunks(source_info[resp["source_id"]])
            verdicts = B.response_verdicts(resp["response"], chunks)
            records.append({
                "id": resp.get("id"), "source_id": resp["source_id"],
                "gold": len(resp.get("labels", [])) > 0,
                "verdicts": verdicts, "chunks": chunks,
                "det_ratio": B.unsupported_ratio_from(verdicts), "n_claims": len(verdicts),
            })
    return records


def sweep(rows: list[dict], key: str) -> tuple[list[dict], dict]:
    out = []
    best = None
    for tau in TAUS:
        preds = [r[key] > tau for r in rows]
        golds = [r["gold"] for r in rows]
        s = B._score_at(preds, golds)
        s["tau"] = tau
        out.append(s)
        if best is None or s["f1"] > best["f1"]:
            best = s
    return out, best


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(B.DEFAULT_DATASET))
    ap.add_argument("--task", default="QA")
    ap.add_argument("--split", default="test")
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()

    from backend.services.llm_gateway import llm_gateway
    if not llm_gateway.is_enabled("EvaluationJudge"):
        print("判官未启用（缺模型 key）")
        return 1

    records = load_records(Path(a.dataset), a.task, a.split)
    if a.limit:
        records = records[: a.limit]
    print(f"样本 {len(records)}，含幻觉 {sum(r['gold'] for r in records)}；判官 {llm_gateway.describe('EvaluationJudge') if hasattr(llm_gateway, 'describe') else 'EvaluationJudge 路由'}", flush=True)

    # 续跑：已落盘的条目不再调判官
    done: dict[str, dict] = {}
    if OUT_JSONL.exists():
        for line in OUT_JSONL.read_text(encoding="utf-8").splitlines():
            if line.strip():
                j = json.loads(line)
                done[j["id"]] = j
    todo = [r for r in records if r["id"] not in done]
    print(f"已完成 {len(done)}，待跑 {len(todo)}", flush=True)

    def work(r: dict) -> dict:
        two = judge_disputed(r["verdicts"], r["chunks"], llm_gateway)
        full = judge_all(r["verdicts"], r["chunks"], llm_gateway)
        return {
            "id": r["id"], "source_id": r["source_id"], "gold": r["gold"], "n_claims": r["n_claims"],
            "det_ratio": r["det_ratio"],
            "two_ratio": B.unsupported_ratio_from(two),
            "judge_ratio": (B.unsupported_ratio_from(full) if full is not None else None),
            "judge_failed": full is None,
        }

    t0 = time.time()
    n_ok = 0
    with OUT_JSONL.open("a", encoding="utf-8") as fp, ThreadPoolExecutor(max_workers=a.concurrency) as ex:
        futs = {ex.submit(work, r): r for r in todo}
        for i, fut in enumerate(as_completed(futs), start=1):
            r = futs[fut]
            try:
                row = fut.result()
            except Exception as e:  # noqa: BLE001
                row = {"id": r["id"], "source_id": r["source_id"], "gold": r["gold"], "n_claims": r["n_claims"],
                       "det_ratio": r["det_ratio"], "two_ratio": None, "judge_ratio": None, "judge_failed": True,
                       "error": f"{type(e).__name__}: {str(e)[:120]}"}
            fp.write(json.dumps(row, ensure_ascii=False) + "\n")
            fp.flush()
            done[row["id"]] = row
            n_ok += int(not row.get("judge_failed"))
            if i % 25 == 0 or i == len(todo):
                el = time.time() - t0
                print(f"  {i}/{len(todo)}  判官有效 {n_ok}  {el:.0f}s  预计剩余 {el / i * (len(todo) - i):.0f}s", flush=True)

    rows = [done[r["id"]] for r in records if r["id"] in done]
    failed = [r for r in rows if r.get("judge_failed")]
    usable = [r for r in rows if not r.get("judge_failed")]
    print(f"\n判官失败 {len(failed)} 条（不计入 judge_all，计入 deterministic 与 two_level 时按确定性结果）")
    for r in rows:
        if r.get("two_ratio") is None:
            r["two_ratio"] = r["det_ratio"]

    det_sw, det_best = sweep(rows, "det_ratio")
    two_sw, two_best = sweep(rows, "two_ratio")
    ja_sw, ja_best = sweep(usable, "judge_ratio")
    print(f"\n{'方案':<18}{'n':>5}{'τ':>6}{'Prec':>7}{'Recall':>8}{'F1':>7}{'Acc':>7}")
    for name, n, b in [("deterministic", len(rows), det_best), ("two_level", len(rows), two_best), ("judge_all", len(usable), ja_best)]:
        print(f"{name:<18}{n:>5}{b['tau']:>6.2f}{b['precision']:>7}{b['recall']:>8}{b['f1']:>7}{b['accuracy']:>7}")

    with OUT_CSV.open("w", encoding="utf-8", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=["method", "n", "tau", "tp", "fp", "fn", "tn", "precision", "recall", "f1", "accuracy"])
        w.writeheader()
        for name, n, sw in [("deterministic", len(rows), det_sw), ("two_level", len(rows), two_sw), ("judge_all", len(usable), ja_sw)]:
            for s in sw:
                w.writerow({"method": name, "n": n, **s})
    print(f"结果：{OUT_CSV}；逐条：{OUT_JSONL}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
