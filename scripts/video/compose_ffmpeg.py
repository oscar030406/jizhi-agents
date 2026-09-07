# -*- coding: utf-8 -*-
"""v6 成片装配（ffmpeg 原生，按段并行编码后无损拼接；moviepy 版 53 分钟，这版几分钟）。

每段：实录按 KEEP 保留区间拼接 → 1920x1080/30fps → 对比度拉回（实录偏灰）→ 画面裁到口播长度 + 0.6 秒，
不够长就定格末帧；左下角字幕、右下角说话小人由 PIL 预渲染成透明 PNG 再 overlay。
用法：python scripts/video/compose_ffmpeg.py
"""
from __future__ import annotations

import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parents[2]
DEF = REPO / "docs" / "06-defense"
VIDEO = DEF / "video"
AUDIO = DEF / "audio" / "v6"
WORK = VIDEO / "build-v6"
OUT = DEF / "集智演示视频.mp4"
FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
AGENTS_DIR = REPO / "apps" / "classroom" / "public" / "agents"
W, H, FPS = 1920, 1080, 30
BUST = 168
TAIL = 0.6  # 画面比口播多留的秒数
# 画面色调，命令行 --tone 选：
#   dim  白底压到浅灰、字保持黑，去刺眼
#   dark 反相后色相转回（Chrome 强制暗色同一原理），深底浅字；页面里的插图也会反色
#   none 只拉对比度
TONES = {
    "none": "eq=contrast=1.18:brightness=-0.02:gamma=0.9:saturation=1.08",
    "dim": "eq=contrast=1.15:gamma=0.9:saturation=1.08,curves=all='0/0 0.5/0.40 1/0.76'",
    "dark": "eq=contrast=1.15:gamma=0.9,negate,hue=h=180,curves=all='0/0.07 1/1'",
}
EQ = TONES["dim"]

AGENT_ART = {
    "阿诊": ("azhen-bust.png", "学情诊断"),
    "阿检": ("ajian-bust.png", "知识检索"),
    "阿讲": ("ajiang-bust.png", "内容生成"),
    "阿审": ("ashen-a-bust.png", "审核"),
    "阿裁": ("acai-bust.png", "仲裁"),
    "阿路": ("alu-bust.png", "反馈决策"),
    "阿问": ("awen-bust.png", "导学"),
}

# 段号 → (实录, 左下角字幕, 保留区间；None 表示整段)。顺序即成片顺序，对齐答辩 PPT。
SCENES = [
    ("00", "card:opening", None, None),
    ("01", "raw/v5-01-首页与选题.mp4", "赛题四组要求：泛化、解耦、机制、反馈，逐条给出回答", None),
    ("02", "raw/v5-02-A语料与接入.mp4", "独创面：换领域不改代码，只投教材；九站接入可视，体检合格才开域", None),
    ("03", "raw/v5-03-A画像输入.mp4", "核心技术一：画像改的是资源结构，每个字段列出理由", None),
    ("04", "raw/v5-04-A协同与放行.mp4", "核心技术二：两家厂商判官逐字引原文，只修被指出的断言；发布门三出口", [[0, 34], [55, 83]]),
    ("05", "raw/v5-05-B课堂.mp4", "核心技术三：讲义、测验、实操指南、互动教具四种形态；实操带练", [[0, 23], [84, 119]]),
    ("06", "raw/v5-06-B反馈与导学.mp4", "答错即改路：降维解释、正确率、难度回档，三条决策依据；导学追问", [[0, 12], [38, 58], [62, 84]]),
    ("07", "raw/v5-07-CD智能制造.mp4", "两域实证：智能制造域课程、路径、报告随域切换，代码一行没改", None),
    # 知识宇宙有头 Chrome 补录：画布只占页面一块，裁出来放大；本身已是深色，不做反相
    ("10", "raw/v6-10-知识宇宙.mp4", "知识宇宙：三库一图 7,211 节点、19,256 条边；先后关系来自接入流水线", [[19, 38], [24, 30], [38, 64]],
     {"crop": "972:547:468:470", "tone": "none"}),
    ("08", "raw/v5-08-机构与隔离.mp4", "管理端：名册、指派、知识库归属；跨机构直连课程返回 404", None),
    ("09", "raw/v5-09-指标对账.mp4", "指标对账：幻觉率 2.08%、覆盖 96.0%、适配 85.2%，每个数带分子分母", None),
    ("99", "card:ending", None, None),
]


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg 失败：{' '.join(cmd[:6])}...\n{r.stderr[-1500:]}")


def duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True).stdout.strip()
    return float(out)


def text_box(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, font, pad=(14, 8), anchor_right=False):
    l, t, r, b = draw.textbbox((0, 0), text, font=font)
    tw, th = r - l, b - t
    x, y = xy
    if anchor_right:
        x = x - tw - 2 * pad[0]
    draw.rectangle([x, y, x + tw + 2 * pad[0], y + th + 2 * pad[1]], fill=(0, 0, 0, 136))
    draw.text((x + pad[0] - l, y + pad[1] - t), text, font=font, fill=(255, 255, 255, 255))


def render_label(text: str, path: Path) -> None:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    text_box(d, (36, H - 90), text, ImageFont.truetype(FONT, 30))
    img.save(path)


def render_speaker(role: str, path: Path) -> bool:
    art = AGENT_ART.get(role)
    if not art or not (AGENTS_DIR / art[0]).exists():
        return False
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bust = Image.open(AGENTS_DIR / art[0]).convert("RGBA")
    bust = bust.resize((int(bust.width * BUST / bust.height), BUST), Image.LANCZOS)
    img.alpha_composite(bust, (W - BUST - 36 + (BUST - bust.width) // 2, H - BUST - 120))
    d = ImageDraw.Draw(img)
    text_box(d, (W - 36, H - 108), f"{role} · {art[1]}", ImageFont.truetype(FONT, 28), pad=(12, 6), anchor_right=True)
    img.save(path)
    return True


def make_cards() -> dict[str, Path]:
    """片头/落版：答辩 PPT 封面底图，片头加第 18 页结语，落版加仓库地址。"""
    cover = Image.open(DEF / "v9" / "preview" / "01_cover.png").convert("RGB").resize((W, H), Image.LANCZOS)
    big = ImageFont.truetype(FONT_BOLD, 46)
    mid = ImageFont.truetype(FONT, 38)
    navy = (28, 32, 82)

    op = cover.copy()
    d = ImageDraw.Draw(op)
    d.text((100, 60), "一句需求生成一门课，只是起点。", font=big, fill=navy)
    d.text((100, 130), "集智交付的，是一套千人千面、知识保真，且支持领域泛化的全自动造课系统。", font=mid, fill=(70, 74, 120))
    p_open = WORK / "card-opening.png"
    op.save(p_open)

    ed = cover.copy()
    d = ImageDraw.Draw(ed)
    d.text((100, 60), "演示到此。", font=big, fill=navy)
    d.text((100, 130), "jizhi.chenmingkun.cn  ·  github.com/oscar030406/jizhi-agents", font=mid, fill=(70, 74, 120))
    p_end = WORK / "card-ending.png"
    ed.save(p_end)
    return {"opening": p_open, "ending": p_end}


def build_scene(sid: str, src: str, label: str | None, keep, speakers: list[dict], cards: dict[str, Path],
                extra: dict | None = None) -> tuple[Path, float]:
    extra = extra or {}
    eq = TONES[extra["tone"]] if extra.get("tone") else EQ
    crop = f"crop={extra['crop']}," if extra.get("crop") else ""
    nar = AUDIO / f"{sid}.mp3"
    target = round(duration(nar) + TAIL, 2)
    out = WORK / f"scene-{sid}.mp4"
    inputs: list[str] = []
    fc: list[str] = []
    if src.startswith("card:"):
        inputs += ["-loop", "1", "-framerate", str(FPS), "-i", str(cards[src[5:]])]
        fc.append(f"[0:v]scale={W}:{H},trim=0:{target},setpts=PTS-STARTPTS[base]")
    else:
        inputs += ["-i", str(VIDEO / src)]
        if keep:
            segs = []
            for i, (a, b) in enumerate(keep):
                fc.append(f"[0:v]trim={a}:{b},setpts=PTS-STARTPTS[k{i}]")
                segs.append(f"[k{i}]")
            fc.append(f"{''.join(segs)}concat=n={len(keep)}:v=1:a=0[cat]")
            head = "[cat]"
        else:
            head = "[0:v]"
        tail = f"tpad=stop_mode=clone:stop_duration=120,trim=0:{target},setpts=PTS-STARTPTS[base]"
        if eq == TONES["dark"]:
            # 按饱和度做蒙版：白底、黑字、灰线反相；有颜色的插图（小人、课程封面、彩色按钮）保留原样
            sat = "clip((max(max(r(X,Y),g(X,Y)),b(X,Y))-min(min(r(X,Y),g(X,Y)),b(X,Y)))*3,0,255)"
            fc.append(f"{head}{crop}scale={W}:{H}:flags=bicubic,fps={FPS},eq=contrast=1.15:gamma=0.9,"
                      f"format=gbrp,split=3[o][i][m]")
            fc.append("[i]negate,hue=h=180,curves=all='0/0.07 1/1'[inv]")
            fc.append(f"[m]geq=r='{sat}':g='{sat}':b='{sat}'[mask]")
            fc.append(f"[inv][o][mask]maskedmerge,format=yuv420p,{tail}")
        else:
            fc.append(f"{head}{crop}scale={W}:{H}:flags=bicubic,fps={FPS},{eq},{tail}")
    inputs += ["-i", str(nar)]
    n = 2
    cur = "[base]"
    if label:
        lp = WORK / f"label-{sid}.png"
        render_label(label, lp)
        inputs += ["-i", str(lp)]
        fc.append(f"{cur}[{n}:v]overlay=0:0[o{n}]")
        cur = f"[o{n}]"
        n += 1
    for k, sp in enumerate(speakers):
        pp = WORK / f"spk-{sid}-{k}.png"
        if not render_speaker(sp["role"], pp):
            continue
        s, e = float(sp["start"]), min(float(sp["end"]) + 0.3, target)
        inputs += ["-i", str(pp)]
        fc.append(f"{cur}[{n}:v]overlay=0:0:enable='between(t,{s},{e})'[o{n}]")
        cur = f"[o{n}]"
        n += 1
    fc.append(f"{cur}format=yuv420p[vout]")
    fc.append(f"[1:a]volume=8dB,apad,atrim=0:{target},asetpts=PTS-STARTPTS[aout]")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", ";".join(fc),
           "-map", "[vout]", "-map", "[aout]", "-t", str(target),
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-r", str(FPS),
           "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
           "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", str(out)]
    run(cmd)
    return out, target


def main() -> int:
    global EQ, OUT
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tone", choices=sorted(TONES), default="dim")
    ap.add_argument("-o", "--out", default=str(OUT))
    a = ap.parse_args()
    EQ = TONES[a.tone]
    OUT = Path(a.out)
    WORK.mkdir(parents=True, exist_ok=True)
    cards = make_cards()
    speakers = json.loads((AUDIO / "speakers.json").read_text(encoding="utf-8"))
    jobs = [(s[0], s[1], s[2], s[3], speakers.get(s[0], []), cards, s[4] if len(s) > 4 else None) for s in SCENES]
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(lambda j: build_scene(*j), jobs))
    total = sum(t for _, t in results)
    for s, (p, t) in zip(SCENES, results):
        sid = s[0]
        print(f"{sid} {t:6.1f}s  {p.name}")
    print(f"合计 {total:.1f} s（上限 600）")
    if total > 600:
        raise SystemExit("超过 10 分钟，回去剪口播。")
    lst = WORK / "concat.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p, _ in results), encoding="utf-8")
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
         "-c", "copy", "-movflags", "+faststart", str(OUT)])
    print(f"完成：{OUT}  {duration(OUT):.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
