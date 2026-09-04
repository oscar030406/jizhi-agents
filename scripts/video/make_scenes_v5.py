# -*- coding: utf-8 -*-
"""由 scenes-v4.json + audio/v5/{durations,speakers}.json 生成 scenes-v5.json。

只做三件事：口播路径换到 v5、录屏文件名换成 v5 前缀、把每段的 speakers 填进去。
镜头顺序、字幕、加速段与 v4 一致——v5 只换了讲的人，没换画面。
用法：python scripts/video/make_scenes_v5.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VIDEO = REPO / "docs" / "06-defense" / "video"
AUDIO = REPO / "docs" / "06-defense" / "audio" / "v5"


def main() -> int:
    scenes = json.loads((VIDEO / "scenes-v4.json").read_text(encoding="utf-8"))
    speakers = json.loads((AUDIO / "speakers.json").read_text(encoding="utf-8"))
    durations = json.loads((AUDIO / "durations.json").read_text(encoding="utf-8"))
    out = []
    for spec in scenes:
        s = dict(spec)
        nar = s.get("narration", "")
        m = re.search(r"/(\d{2})\.mp3$", nar)
        sid = m.group(1) if m else None
        if nar:
            s["narration"] = nar.replace("/audio/v4/", "/audio/v5/")
        if s.get("video"):
            s["video"] = s["video"].replace("raw/v4-", "raw/v5-")
        if sid and sid in speakers:
            s["speakers"] = speakers[sid]
        if sid and s.get("image") and sid in durations:
            # 图卡时长至少要盖住口播（片头/落版）
            s["duration"] = max(float(s.get("duration", 0)), round(durations[sid] + 0.5, 1))
        out.append(s)
    target = VIDEO / "scenes-v5.json"
    target.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    total_nar = sum(v for v in durations.values() if v > 0)
    print(f"写出 {target}（{len(out)} 镜）；口播合计 {total_nar:.0f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
