# -*- coding: utf-8 -*-
"""生成片头 / 落版图卡（1920×1080，靛蓝配色，与 v8 PPT 同一套色）。

用法：
    python scripts/video/make_cards.py -o docs/06-defense/video
产物：opening-card-v3.png、end-card-v3.png
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
NAVY = (20, 28, 58)
INK = (240, 242, 248)
MUTED = (168, 178, 210)
ACCENT = (138, 164, 255)
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_SONG = r"C:\Windows\Fonts\simsun.ttc"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def center_text(draw: ImageDraw.ImageDraw, y: int, text: str, f: ImageFont.FreeTypeFont, fill) -> int:
    w = draw.textlength(text, font=f)
    draw.text(((W - w) / 2, y), text, font=f, fill=fill)
    return int(y + f.size * 1.35)


def card(lines: list[tuple[str, str, int, tuple]], rule_y: int | None) -> Image.Image:
    img = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(img)
    if rule_y is not None:
        d.rectangle([W / 2 - 40, rule_y, W / 2 + 40, rule_y + 4], fill=ACCENT)
    # 竖排总高度，居中
    total = sum(int(size * 1.35) + gap for _, _, size, _, gap in lines)
    y = (H - total) // 2 + 20
    for text, path, size, color, gap in lines:
        y = center_text(d, y, text, font(path, size), color) + gap
    return img


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", default="docs/06-defense/video")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    opening = card(
        [
            ("集智", FONT_SONG, 132, INK, 28),
            ("一句需求，交付一门可学、可查、可改的课", FONT_BOLD, 54, INK, 40),
            ("两家机构 · 两名学员 · 两个领域", FONT_REG, 36, MUTED, 0),
        ],
        rule_y=300,
    )
    opening.save(out / "opening-card-v3.png")

    end = card(
        [
            ("jizhi.chenmingkun.cn", FONT_BOLD, 72, INK, 36),
            ("资料进机构知识库 · 课程按人指派 · 每句可核", FONT_REG, 40, MUTED, 14),
            ("反馈改路线 · 缺什么明说", FONT_REG, 40, MUTED, 44),
            ("所有数字附分子分母与复算命令，见 /evidence", FONT_REG, 30, ACCENT, 0),
        ],
        rule_y=330,
    )
    end.save(out / "end-card-v3.png")
    print(f"图卡已生成：{out / 'opening-card-v3.png'}，{out / 'end-card-v3.png'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
