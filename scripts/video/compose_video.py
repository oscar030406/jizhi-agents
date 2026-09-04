# -*- coding: utf-8 -*-
"""演示视频装配器：分镜清单(JSON) + 录屏 + 口播 mp3 → 一条成片。

用法：
    python scripts/video/compose_video.py docs/06-defense/video/scenes.json -o dist/demo.mp4

清单格式（数组，每镜一项）：
    {
      "video": "raw/A1.mp4",            # 录屏文件（相对清单所在目录）
      "narration": "audio/lively/scene1.mp3",   # 口播；可省略（无旁白段）
      "system_audio": 0.25,              # 录屏原声保留音量（产品 TTS 原声段可调高）
      "speedups": [{"start": 12.0, "end": 95.0, "factor": 8}],  # 生成等待段加速
      "label": "画像输入 · 每字段附抽取依据",   # 左下角小字幕（可省略）
      "speakers": [{"role": "阿诊", "start": 0, "end": 21.3}]  # 说话的小人（可省略；tts_narration 的 speakers.json 原样填）
    }

工艺规则（继承灵山视频手艺）：
- 加速段右上角自动盖「过程加速 N×」标注——加速如实标注，不冒充实时；
- 旁白全音量、录屏原声压到 system_audio（默认 0.2）；
- 画面必须比旁白长，短了直接报错（宁可画面等音频，不可音频赶画面）；
- 统一 1920x1080 / 30fps / H.264+AAC 输出。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from moviepy import (
    AudioFileClip,
    CompositeAudioClip,
    CompositeVideoClip,
    ImageClip,
    TextClip,
    VideoFileClip,
    concatenate_videoclips,
    vfx,
)

FONT = r"C:\Windows\Fonts\msyh.ttc"  # 微软雅黑，标注与小字幕用
W, H, FPS = 1920, 1080, 30
# 说话的小人：立绘在课堂端 public/agents/，头像随旁白块切换，右下角，不压左下角字幕
AGENTS_DIR = Path(__file__).resolve().parents[2] / "apps" / "classroom" / "public" / "agents"
AGENT_ART = {
    "阿诊": ("azhen-bust.png", "学情诊断"),
    "阿检": ("ajian-bust.png", "知识检索"),
    "阿讲": ("ajiang-bust.png", "内容生成"),
    "阿审": ("ashen-a-bust.png", "审核"),
    "阿裁": ("acai-bust.png", "仲裁"),
    "阿路": ("alu-bust.png", "反馈决策"),
    "阿问": ("awen-bust.png", "导学"),
}
BUST = 168


def speaker_overlays(spans: list[dict], total: float):
    """每个旁白块一张头像 + 名字/职责小牌，只在该块说话的时段出现。"""
    out = []
    for sp in spans:
        art = AGENT_ART.get(sp.get("role", ""))
        if not art:
            continue
        ipath = AGENTS_DIR / art[0]
        if not ipath.exists():
            continue
        start = float(sp["start"])
        end = min(float(sp["end"]) + 0.3, total)
        if end <= start:
            continue
        bust = (ImageClip(str(ipath)).resized(height=BUST)
                .with_start(start).with_duration(end - start)
                .with_position((W - BUST - 36, H - BUST - 120)))
        tag = (TextClip(font=FONT, text=f"{sp['role']} · {art[1]}", font_size=28,
                        color="white", bg_color="#00000088", margin=(12, 6))
               .with_start(start).with_duration(end - start)
               .with_position((W - BUST - 36, H - 108)))
        out += [bust, tag]
    return out


def build_scene(base: Path, spec: dict, idx: int):
    # ---- 静态图卡（片头/落版）：image + duration，秒数字段必填 ----
    if spec.get("image"):
        ipath = base / spec["image"]
        if not ipath.exists():
            raise SystemExit(f"镜 {idx}: 图卡不存在 {ipath}")
        card = ImageClip(str(ipath)).with_duration(float(spec["duration"])).resized((W, H))
        overlays = speaker_overlays(spec.get("speakers", []), card.duration)
        if overlays:
            card = CompositeVideoClip([card, *overlays], size=(W, H))
        if spec.get("narration"):
            npath = base / spec["narration"]
            if not npath.exists():
                raise SystemExit(f"镜 {idx}: 口播不存在 {npath}")
            card = card.with_audio(AudioFileClip(str(npath)))
        return card

    vpath = base / spec["video"]
    if not vpath.exists():
        raise SystemExit(f"镜 {idx}: 录屏不存在 {vpath}")
    clip = VideoFileClip(str(vpath))

    # ---- 加速段：切三明治，中段提速并盖标注 ----
    speedups = sorted(spec.get("speedups", []), key=lambda s: s["start"])
    if speedups:
        parts = []
        cursor = 0.0
        for sp in speedups:
            s, e, f = float(sp["start"]), float(sp["end"]), float(sp["factor"])
            if s > cursor:
                parts.append(clip.subclipped(cursor, s))
            fast = clip.subclipped(s, min(e, clip.duration)).with_effects([vfx.MultiplySpeed(f)])
            badge = (
                TextClip(font=FONT, text=f"过程加速 {int(f)}×", font_size=34,
                         color="white", bg_color="#00000088", margin=(14, 8))
                .with_duration(fast.duration)
                .with_position((W - 300, 28))
            )
            parts.append(CompositeVideoClip([fast, badge], size=(W, H)))
            cursor = min(e, clip.duration)
        if cursor < clip.duration:
            parts.append(clip.subclipped(cursor, clip.duration))
        clip = concatenate_videoclips(parts)

    # ---- 左下角功能字幕（灵山手艺：每段标注功能名）----
    if spec.get("label"):
        label = (
            TextClip(font=FONT, text=spec["label"], font_size=30,
                     color="white", bg_color="#00000088", margin=(14, 8))
            .with_duration(clip.duration)
            .with_position((36, H - 90))
        )
        clip = CompositeVideoClip([clip, label], size=(W, H))

    # ---- 右下角说话的小人：按 speakers 的起止秒切换 ----
    overlays = speaker_overlays(spec.get("speakers", []), clip.duration)
    if overlays:
        clip = CompositeVideoClip([clip, *overlays], size=(W, H))

    # ---- 音轨：旁白全量 + 原声压低 ----
    tracks = []
    if clip.audio is not None:
        tracks.append(clip.audio.with_volume_scaled(float(spec.get("system_audio", 0.2))))
    if spec.get("narration"):
        npath = base / spec["narration"]
        if not npath.exists():
            raise SystemExit(f"镜 {idx}: 口播不存在 {npath}")
        nar = AudioFileClip(str(npath))
        if nar.duration > clip.duration + 0.5:
            raise SystemExit(
                f"镜 {idx}: 旁白 {nar.duration:.1f}s 比画面 {clip.duration:.1f}s 长——"
                "补录画面或删减口播，不许音频赶画面。")
        tracks.append(nar)
    if tracks:
        clip = clip.with_audio(CompositeAudioClip(tracks))
    return clip


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("-o", "--out", default="demo-final.mp4")
    args = ap.parse_args()

    mpath = Path(args.manifest).resolve()
    base = mpath.parent
    scenes = json.loads(mpath.read_text(encoding="utf-8"))
    clips = [build_scene(base, s, i + 1) for i, s in enumerate(scenes)]
    final = concatenate_videoclips(clips)
    total = final.duration
    print(f"总时长 {total/60:.1f} 分钟（{total:.0f}s）")
    if total > 600:
        raise SystemExit("超过赛题 10 分钟红线，回去剪。")
    final.write_videofile(args.out, fps=FPS, codec="libx264", audio_codec="aac",
                          threads=4, preset="medium", logger="bar")
    print(f"完成：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
