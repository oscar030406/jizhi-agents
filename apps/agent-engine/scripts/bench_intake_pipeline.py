"""领域接入流水线的逐站耗时基准（WO-G7 的基准数据来源）。

为什么要一个独立脚本：`run.json` 里每站有 `duration_ms`，但仓库里现存的 run 用的是
6 个 md 的小语料，全链 44－49ms，量不出任何东西。要看清关键路径得拿有分量的库重测，
而重测不能污染仓库的 `data/`——所以这个脚本把接入链会写盘的四个位置全部指到临时目录
（做法抄 `tests/test_domain_intake.py` 的 sandbox fixture），跑完即删。

费钱的两站不碰：`build_vector`（嵌入 API）与 `extract_concepts`（LLM）保持默认关，
它们的耗时另有实测底数，见 `docs/05-evidence/domain-switch-latency-20260815.md`。

上传路径只剩一条防崩底线（`MAX_EST_CHUNKS`），字节闸已在 2026-08-21 去掉——它拦错了对象
上限；基准要跑真实规模的语料，所以脚本里把它临时调高。这只影响本进程，产品限额一字未改。

用法：
    cd apps/agent-engine
    python scripts/bench_intake_pipeline.py --corpus-dir ../../references/odoo-zh-inventory \
        --label odoo-zh --repeat 3
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("AGENT_GENERATION_MODE", "deterministic")

import backend.rag.retriever as retriever  # noqa: E402
from backend.services import domain_intake  # noqa: E402

#: 只量免费站。⑥试跑课程 / ⑦指标复测要真跑一遍生成再重算指标——那是分钟级、
#: 要花钱的，不能被一句 `--repeat 3` 顺手跑三遍。它们的耗时另行单测。
FREE_STAGES = ("receive", "chunk", "index", "vector", "knowledge", "gold")


def sandbox(tmp: Path) -> None:
    """把接入链会写到的四个位置全指到临时目录。仓库 data/ 一个字节都不写。"""
    kb = tmp / "knowledge_base"
    corpora = kb / "corpora"
    corpora.mkdir(parents=True, exist_ok=True)
    domain_intake.KB = kb
    domain_intake.RUNS_DIR = kb / "intake_runs"
    domain_intake.CORPORA_DIR = corpora
    domain_intake.GOLD_DIR = tmp / "eval" / "kc_gold_derived"
    retriever.CORPORA_DIR = corpora
    domain_intake._ensure_scripts_path()
    import ingest_domain  # type: ignore[import-not-found]

    ingest_domain.KB = kb
    domain_intake.STAGES = {k: v for k, v in domain_intake.STAGES.items() if k in FREE_STAGES}
    retriever.refresh_corpora()


def load_files(src: Path, max_bytes: int) -> list[tuple[str, bytes]]:
    """按上传路径的形态喂进去：文件名会被 `safe_filename` 拍平，这里先拍平一次，
    好让基准跑的就是用户真按「上传」走的那条路（目录结构在上传时本来就没了）。"""
    out: list[tuple[str, bytes]] = []
    seen: set[str] = set()
    for p in sorted(src.rglob("*.md")):
        blob = p.read_bytes()
        if len(blob) > max_bytes:
            continue
        name, i = p.name, 2
        while name in seen:
            name = f"{p.stem}-{i}.md"
            i += 1
        seen.add(name)
        out.append((name, blob))
    return out


def one_run(files: list[tuple[str, bytes]], corpus: str) -> dict:
    run = domain_intake.create_run(files, corpus=corpus, scope="接入流水线耗时基准")
    domain_intake.execute(run)
    return json.loads(run.record_path.read_text(encoding="utf-8"))


def summarize(rows: list[dict], stage_ids: list[str]) -> None:
    print("\n=== 逐站耗时（毫秒，min / 中位 / max，n=%d）===" % len(rows))
    print(f"{'站':<10}{'状态':<10}{'min':>8}{'中位':>8}{'max':>8}")
    for sid in stage_ids:
        vals = [r["stages_ms"][sid] for r in rows if r["stages_ms"].get(sid) is not None]
        if not vals:
            continue
        st = rows[0]["stage_status"][sid]
        print(f"{sid:<10}{st:<10}{min(vals):>8}{round(statistics.median(vals)):>8}{max(vals):>8}")
    tot = [r["total_ms"] for r in rows]
    ser = [sum(v for v in r["stages_ms"].values() if v) for r in rows]
    print(f"{'全链墙钟':<10}{'':<10}{min(tot):>8}{round(statistics.median(tot)):>8}{max(tot):>8}")
    print(f"{'逐站之和':<10}{'':<10}{min(ser):>8}{round(statistics.median(ser)):>8}{max(ser):>8}")
    print(
        "并行折叠比（逐站之和 / 全链墙钟，中位）= "
        f"{statistics.median(ser) / statistics.median(tot):.2f}×"
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus-dir", required=True, help="源 md 目录，递归收 *.md")
    ap.add_argument("--label", required=True, help="库名前缀，只用于临时目录")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--out", default="", help="可选：把逐次原始记录写成 json")
    args = ap.parse_args()

    # 上传限额是产品侧的，不是流水线能力上限；基准要跑真实规模的语料。
    domain_intake.MAX_EST_CHUNKS = 1_000_000

    src = Path(args.corpus_dir)
    files = load_files(src, domain_intake.MAX_FILE_BYTES)
    if not files:
        print(f"{src} 下没有 md", file=sys.stderr)
        return 1
    print(f"源目录 {src}：{len(files)} 个 md，{sum(len(b) for _n, b in files):,} 字节")

    rows: list[dict] = []
    for i in range(args.repeat):
        tmp = Path(tempfile.mkdtemp(prefix=f"bench-intake-{args.label}-"))
        try:
            sandbox(tmp)
            t0 = time.perf_counter()
            rec = one_run(files, f"{args.label}-r{i + 1}")
            wall = round((time.perf_counter() - t0) * 1000)
            detail = {sid: (rec["stages"][sid].get("detail") or {}) for sid in rec["stages"]}
            rows.append({
                "iter": i + 1,
                "status": rec["status"],
                "total_ms": rec["duration_ms"],
                "wall_ms": wall,
                "stages_ms": {s: v.get("duration_ms") for s, v in rec["stages"].items()},
                "stage_status": {s: v.get("status") for s, v in rec["stages"].items()},
                "accepted_files": detail["receive"].get("accepted_files"),
                "accepted_chars": detail["receive"].get("accepted_chars"),
                "chunks": detail["chunk"].get("chunks"),
                "gold_topics": detail["gold"].get("topics"),
                "gold_kcs": detail["gold"].get("knowledge_components"),
                "error": rec.get("error", ""),
            })
            print(json.dumps(rows[-1], ensure_ascii=False))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    summarize(rows, [s for s in rows[0]["stages_ms"]])
    if any(r["status"] != "done" for r in rows):
        print("\n注意：有 run 判失败 —— " + (rows[0]["error"] or "见上"))
    if args.out:
        Path(args.out).write_text(
            json.dumps({"source": str(src), "files": len(files), "rows": rows},
                       ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
