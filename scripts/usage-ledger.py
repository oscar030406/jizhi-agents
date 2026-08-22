#!/usr/bin/env python3
"""用量账本工具（WO-N10）。

两个子命令：

  quarantine  把测试桩写进生产账本的行搬到 data/usage/test/ 下的同名文件。
              判据：modelId == 'mock-model-id'，或 source 以 '-test' 结尾。
              readUsageRecords 只读 data/usage/ 一层里的 *.jsonl，子目录看不见，
              所以搬过去等于对管理端出清，同时不丢证据。可重复跑，幂等。

  report      按课汇总 token / 断言 / 墙钟，输出 markdown 表。
              账本里**没有单价字段**，所以不出金额——见输出末尾的说明。

用法（项目根执行）：
    python scripts/usage-ledger.py quarantine [--dry-run]
    python scripts/usage-ledger.py report
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USAGE_DIR = os.path.join(ROOT, "apps", "classroom", "data", "usage")
TEST_DIR = os.path.join(USAGE_DIR, "test")
CLASSROOM_DIR = os.path.join(ROOT, "apps", "classroom", "data", "classrooms")
JOB_DIR = os.path.join(ROOT, "apps", "classroom", "data", "classroom-jobs")

# 审核链路的 source（scene-audit-revise 是审核判定后的重写，成本由审核引发，计入审核侧）。
AUDIT_SOURCES = {"scene-audit", "scene-audit-2", "scene-audit-arbiter", "scene-audit-revise"}


def is_test_row(row: dict) -> bool:
    return row.get("modelId") == "mock-model-id" or bool(
        re.search(r"-test$", row.get("source", ""))
    )


def read_jsonl(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def cmd_quarantine(dry_run: bool) -> None:
    os.makedirs(TEST_DIR, exist_ok=True)
    for path in sorted(glob.glob(os.path.join(USAGE_DIR, "*.jsonl"))):
        name = os.path.basename(path)
        rows = read_jsonl(path)
        keep = [r for r in rows if not is_test_row(r)]
        moved = [r for r in rows if is_test_row(r)]
        tokens = sum(r.get("inputTokens", 0) + r.get("outputTokens", 0) for r in moved)
        print(
            f"{name}: {len(rows)} 行 → 留 {len(keep)}，搬走 {len(moved)}"
            f"（{len(moved) / len(rows):.1%}，合计 {tokens} token）"
        )
        if dry_run or not moved:
            continue
        shutil.copy2(path, path + ".bak")  # 原地备份，确认无误后可删
        with open(os.path.join(TEST_DIR, name), "a", encoding="utf-8") as fh:
            for r in moved:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        with open(path, "w", encoding="utf-8") as fh:
            for r in keep:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    if not dry_run:
        print(f"\n搬走的行在 {TEST_DIR}；原文件同名 .bak 是搬之前的快照。")


def load_jobs() -> dict:
    """classroomId -> 生成任务（含起止时刻与同期并发的其他任务）。"""
    jobs = []
    for path in glob.glob(os.path.join(JOB_DIR, "*.json")):
        with open(path, encoding="utf-8") as fh:
            job = json.load(fh)
        cid = (job.get("result") or {}).get("classroomId")
        if not (cid and job.get("startedAt") and job.get("completedAt")):
            continue
        parse = lambda s: datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        jobs.append((parse(job["startedAt"]), parse(job["completedAt"]), cid))
    out = {}
    for start, end, cid in jobs:
        concurrent = [c for s, e, c in jobs if c != cid and s < end and e > start]
        out[cid] = {
            "started": start,
            "wall_s": (end - start).total_seconds(),
            "concurrent": concurrent,
        }
    return out


def cmd_report() -> None:
    rows = []
    for path in sorted(glob.glob(os.path.join(USAGE_DIR, "*.jsonl"))):
        rows.extend(read_jsonl(path))
    if any(is_test_row(r) for r in rows):
        print("⚠ 账本里还有测试行，先跑 quarantine。", file=sys.stderr)

    jobs = load_jobs()
    by_course: dict[str, list[dict]] = {}
    for row in rows:
        cid = row.get("classroomId")
        if cid and os.path.exists(os.path.join(CLASSROOM_DIR, f"{cid}.json")):
            by_course.setdefault(cid, []).append(row)

    table = []
    for cid, course_rows in by_course.items():
        with open(os.path.join(CLASSROOM_DIR, f"{cid}.json"), encoding="utf-8") as fh:
            course = json.load(fh)
        scenes = course.get("scenes", [])
        audits = [s.get("audit") or {} for s in scenes]
        gen = [r for r in course_rows if r["source"] not in AUDIT_SOURCES]
        aud = [r for r in course_rows if r["source"] in AUDIT_SOURCES]
        tok = lambda rs, k: sum(r.get(k, 0) for r in rs)
        job = jobs.get(cid, {})
        table.append(
            {
                "id": cid,
                "name": course["stage"]["name"],
                "scenes": len(scenes),
                "claims": sum(a.get("totalClaims", 0) for a in audits),
                "calls": len(course_rows),
                "gen_in": tok(gen, "inputTokens"),
                "gen_out": tok(gen, "outputTokens"),
                "aud_in": tok(aud, "inputTokens"),
                "aud_out": tok(aud, "outputTokens"),
                "prompt": tok(course_rows, "inputTokens"),
                "completion": tok(course_rows, "outputTokens"),
                "job_wall_s": job.get("wall_s"),
                "audit_sum_s": sum(a.get("durationMs", 0) for a in audits) / 1000,
                "concurrent": len(job.get("concurrent", [])),
                "date": (job.get("started").strftime("%m-%d") if job.get("started") else "—"),
                # classroomId 是后加的字段，只对新记录生效。08-04~08-10 那批老课
                # 课程 JSON 里有断言（审核确实跑过），账本里却一行审核侧记录都没有
                # ——归因残缺，token 数不是这门课的全部，不许进任何均值。
                "complete": bool(aud) or not audits,
            }
        )
    table.sort(key=lambda r: -r["scenes"])

    print(
        "| 课程 id | 课名 | 屏数 | 断言数 | LLM 调用 | prompt token | completion token "
        "| 总 token | 生成侧 token | 审核侧 token | 任务墙钟 | 审核耗时之和 | 同期并发 | 归因 |"
    )
    print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in table:
        wall = f"{r['job_wall_s'] / 60:.1f} min" if r["job_wall_s"] else "—"
        print(
            f"| `{r['id']}` | {r['name']} | {r['scenes']} | {r['claims']} | {r['calls']} "
            f"| {r['prompt']:,} | {r['completion']:,} | {r['prompt'] + r['completion']:,} "
            f"| {r['gen_in'] + r['gen_out']:,} | {r['aud_in'] + r['aud_out']:,} "
            f"| {wall} | {r['audit_sum_s'] / 60:.1f} min | {r['concurrent']} "
            f"| {'完整' if r['complete'] else '残缺'} |"
        )

    solo = [r for r in table if r["concurrent"] == 0 and r["job_wall_s"] and r["complete"]]
    partial = [r for r in table if not r["complete"]]
    if partial:
        print(
            "\n归因残缺（老课，classroomId 字段上线前生成，账本只留下零星几行，**不进均值**）："
            + "、".join(f"{r['id']}({r['calls']} 行/{r['scenes']} 屏)" for r in partial)
        )

    if solo:
        print("\n单跑（同期无并发任务 + 归因完整）合计：")
        tot_scene = sum(r["scenes"] for r in solo)
        tot_tok = sum(r["prompt"] + r["completion"] for r in solo)
        print(f"  {len(solo)} 门 / {tot_scene} 屏 / {tot_tok:,} token")
        print(f"  每屏均值 {tot_tok / tot_scene:,.0f} token")
        for r in solo:
            per = (r["prompt"] + r["completion"]) / r["scenes"]
            print(
                f"  - {r['id']} {r['name']}：{r['scenes']} 屏，"
                f"{r['prompt'] + r['completion']:,} token（每屏 {per:,.0f}），"
                f"{r['job_wall_s'] / 60:.1f} min"
            )
    print(
        "\n金额：账本行里没有单价/费用字段（见 lib/server/usage-storage.ts 的 UsageRecord，"
        "注释原文 'pure usage, no cost'），代码里也没有价目表。"
        "\n折算金额需要供应商价目表，本工具不代填。"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("quarantine")
    q.add_argument("--dry-run", action="store_true")
    sub.add_parser("report")
    args = ap.parse_args()
    if args.cmd == "quarantine":
        cmd_quarantine(args.dry_run)
    else:
        cmd_report()


if __name__ == "__main__":
    main()
