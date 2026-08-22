"""把存量 intake run 里的绝对路径 license evidence 换成重算后的相对写法。

不是手编字符串：对每个 run 的 docs 目录重跑 `detect_license`，拿新结果替换。
spdx 判定必须与存量一致，不一致就报错停手（说明重算的不是同一件事）。
已经是相对写法的 run 会跳过，所以重复跑是安全的。

用法（任意工作目录）：
    python apps/agent-engine/scripts/experiments/scrub_intake_run_paths.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE))

from backend.rag.intake import detect_license  # noqa: E402

RUNS = ENGINE / "data" / "knowledge_base" / "intake_runs"


def main() -> int:
    for d in sorted(RUNS.iterdir()):
        run_json = d / "run.json"
        events = d / "events.jsonl"
        if not run_json.is_file():
            continue
        record = json.loads(run_json.read_text(encoding="utf-8"))
        old = record["stages"]["receive"].get("detail", {}).get("license")
        if not old:
            print(f"{d.name}: 没有 license 明细，跳过")
            continue
        fresh = detect_license(d / "docs")
        if fresh.spdx != old["spdx"]:
            raise SystemExit(f"{d.name}: 重算 spdx {fresh.spdx} != 存量 {old['spdx']}，停手")
        if old["evidence"] == fresh.evidence:
            print(f"{d.name}: 已是相对写法，跳过")
            continue
        # run.json 与 events.jsonl 里是同一串，整串替换，别的字段一个不动
        for path in (run_json, events):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            # 两个文件都是 JSON 文本，串在里面是转义过的
            needle = json.dumps(old["evidence"], ensure_ascii=False)[1:-1]
            repl = json.dumps(fresh.evidence, ensure_ascii=False)[1:-1]
            hits = text.count(needle)
            path.write_text(text.replace(needle, repl), encoding="utf-8")
            print(f"{d.name}/{path.name}: 换掉 {hits} 处")
        print(f"  新串：{fresh.evidence}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
