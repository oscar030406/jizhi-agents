# -*- coding: utf-8 -*-
"""scenes-v5.json 的成片前修订：给实录里等待过长的段加「过程加速」，并核对总长不超 600 秒。

06 段（答错改路与导学）实录 163 秒：答题 8–70 秒、教练判分等待 96 秒到片尾。口播 80 秒，
按规则加速段右上角会盖「过程加速 N×」，不冒充实时。加速倍率算到画面刚好比口播长 1 到 2 秒。
用法：python scripts/video/finalize_scenes_v5.py（在 make_scenes_v5.py 之后跑）
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VIDEO = REPO / "docs" / "06-defense" / "video"
SCENES = VIDEO / "scenes-v5.json"

SPEEDUPS = {
    "raw/v5-06-B反馈与导学.mp4": [
        {"start": 8.0, "end": 70.0, "factor": 1.02},
        {"start": 96.0, "end": 96.0, "factor": 1.02},
    ],
}


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def effective(spec: dict) -> float:
    if spec.get("image"):
        return float(spec["duration"])
    raw = duration(VIDEO / spec["video"])
    total = raw
    for sp in spec.get("speedups", []):
        s, e, f = float(sp["start"]), min(float(sp["end"]), raw), float(sp["factor"])
        total -= (e - s) - (e - s) / f
    return total


def main() -> int:
    scenes = json.loads(SCENES.read_text(encoding="utf-8"))
    for spec in scenes:
        if spec.get("video") in SPEEDUPS:
            spec["speedups"] = SPEEDUPS[spec["video"]]
    grand = 0.0
    for spec in scenes:
        if spec.get("video") and not (VIDEO / spec["video"]).exists():
            print(f"{spec['video']:32s} 还没录")
            continue
        nar = duration(VIDEO / spec["narration"]) if spec.get("narration") else 0.0
        eff = effective(spec)
        grand += eff
        flag = "" if eff >= nar + 0.5 else "  <-- 画面短于口播"
        print(f"{(spec.get('video') or spec.get('image')):32s} 画面 {eff:6.1f}  口播 {nar:6.1f}{flag}")
    print(f"合计 {grand:.1f} s（上限 600）")
    SCENES.write_text(json.dumps(scenes, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if grand <= 600 else 1


if __name__ == "__main__":
    raise SystemExit(main())
