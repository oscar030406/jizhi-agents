# -*- coding: utf-8 -*-
"""把录屏稿里的「旁白：」段落逐段合成为 mp3。

用法：
    python scripts/video/tts_narration.py docs/06-defense/录屏稿-v3.md -o docs/06-defense/audio/v3
    python scripts/video/tts_narration.py ... --only 04 07      # 只重合成指定段
    python scripts/video/tts_narration.py ... --engine edge      # 强制用 edge-tts
    python scripts/video/tts_narration.py ... --instruct         # CosyVoice2 加语气指令（有漏读进音频的风险，合成后必须过 asr_check）

稿件格式：每段以 `## NN 标题` 或 `## 片头` / `## 落版` 开头，段内有一行 `旁白：`，
其后到下一个 `## ` 之前的正文就是口播。

引擎：首选 SiliconFlow CosyVoice2-0.5B（key 读环境变量 SILICONFLOW_API_KEY，
没有就读 apps/agent-engine/.env），请求剥掉代理环境变量直连；失败回退 edge-tts。
产物：<out>/<段号>.mp3 与 <out>/durations.json（段号 → 秒），供 scenes-v3.json 对时长。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
_CN_DIGITS = "零一二三四五六七八九"
COSY_MODEL = "FunAudioLLM/CosyVoice2-0.5B"
COSY_VOICE = "anna"
EDGE_VOICE = "zh-CN-XiaoxiaoNeural"
INSTRUCTION = "请用清晰、平稳、像给同学讲解作品一样的语气说。"


# ---------- 稿件解析 ----------
def parse_script(path: Path) -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8")
    sections = re.split(r"^## ", text, flags=re.M)
    out: list[tuple[str, str]] = []
    for sec in sections[1:]:
        head, _, body = sec.partition("\n")
        m = re.match(r"(片头|落版|\d{2})\b", head.strip())
        if not m:
            continue
        sid = {"片头": "00", "落版": "99"}.get(m.group(1), m.group(1))
        nm = re.search(r"^旁白：\s*$", body, flags=re.M)
        if not nm:
            continue
        narration = body[nm.end():].strip()
        # 去掉段后的「## 六、」之类不会出现（已被 split），但保留换行给清洗器
        if narration:
            out.append((sid, narration))
    return out


# ---------- 播报清洗（移植自数字人项目 tts.py，纯函数） ----------
def _int_to_chinese(value: int) -> str:
    if value == 0:
        return "零"
    units = ["", "十", "百", "千"]
    groups = [("", 0), ("万", 4), ("亿", 8)]
    parts: list[str] = []
    for name, shift in reversed(groups):
        chunk = (value // 10**shift) % 10000
        if not chunk:
            continue
        s = ""
        zero_pending = False
        for pos in range(3, -1, -1):
            d = (chunk // 10**pos) % 10
            if d == 0:
                zero_pending = bool(s)
                continue
            if zero_pending:
                s += "零"
                zero_pending = False
            s += ("" if (d == 1 and pos == 1 and not s) else _CN_DIGITS[d]) + units[pos]
        parts.append(s + name)
    return "".join(parts)


def _number_to_chinese(tok: str) -> str:
    if "." in tok:
        whole, _, frac = tok.partition(".")
        return (_int_to_chinese(int(whole)) if whole else "零") + "点" + "".join(_CN_DIGITS[int(c)] for c in frac)
    return _int_to_chinese(int(tok))


def read_numbers_aloud(text: str) -> str:
    text = re.sub(r"(?<!\d)(\d{4})(?=年)", lambda m: "".join(_CN_DIGITS[int(c)] for c in m.group(1)), text)
    text = re.sub(r"(\d+(?:\.\d+)?)\s*%", lambda m: "百分之" + _number_to_chinese(m.group(1)), text)
    text = re.sub(
        r"\d+(?:\.\d+)?",
        lambda m: _number_to_chinese(m.group(0)) if len(m.group(0).replace(".", "")) <= 9
        else "".join(_CN_DIGITS[int(c)] for c in m.group(0) if c.isdigit()),
        text,
    )
    return text


def clean_for_speech(text: str) -> str:
    t = re.sub(r"[*#`_>「」『』《》]+", "", text)
    t = t.replace("——", "，").replace("—", "，")
    t = re.sub(r"[（(]([^）)]{1,20})[）)]", r"，\1，", t)
    t = re.sub(r"[（(][^）)]{21,}[）)]", "", t)
    t = re.sub(r"\s*\n+\s*", "。", t)
    t = re.sub(r"[。，]{2,}", "。", t)
    t = read_numbers_aloud(t)
    return t.strip()


# ---------- 引擎 ----------
def siliconflow_key() -> str:
    k = os.environ.get("SILICONFLOW_API_KEY", "").strip()
    if k:
        return k
    env = REPO / "apps" / "agent-engine" / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("SILICONFLOW_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def tts_cosyvoice(text: str, instruct: bool, speed: float) -> bytes | None:
    key = siliconflow_key()
    if not key:
        return None
    payload = {
        "model": COSY_MODEL,
        "input": (f"{INSTRUCTION}<|endofprompt|>{text}" if instruct else text),
        "voice": f"{COSY_MODEL}:{COSY_VOICE}",
        "response_format": "mp3",
        "speed": speed,
    }
    try:
        # trust_env=False：剥掉代理变量直连（Clash 下走代理会掉连接）
        with httpx.Client(trust_env=False, timeout=120) as c:
            r = c.post("https://api.siliconflow.cn/v1/audio/speech",
                       headers={"Authorization": f"Bearer {key}"}, json=payload)
            r.raise_for_status()
            return r.content or None
    except Exception as e:  # noqa: BLE001
        print(f"  [cosyvoice 失败] {type(e).__name__}: {str(e)[:120]}")
        return None


def tts_edge(text: str, out: Path, rate: str) -> bool:
    try:
        import edge_tts  # type: ignore
    except ImportError:
        print("  [edge-tts 未安装]")
        return False

    async def run() -> None:
        await edge_tts.Communicate(text, EDGE_VOICE, rate=rate).save(str(out))

    try:
        asyncio.run(run())
        return out.exists() and out.stat().st_size > 0
    except Exception as e:  # noqa: BLE001
        print(f"  [edge-tts 失败] {type(e).__name__}: {str(e)[:120]}")
        return False


def duration_of(path: Path) -> float:
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return round(float(p.stdout.strip()), 2)
    except ValueError:
        return -1.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("-o", "--out", default="docs/06-defense/audio/v3")
    ap.add_argument("--only", nargs="*", default=None, help="只合成这些段号，如 04 07")
    ap.add_argument("--engine", choices=["auto", "cosy", "edge"], default="auto")
    ap.add_argument("--instruct", action="store_true")
    ap.add_argument("--speed", type=float, default=1.0, help="CosyVoice2 语速倍率")
    ap.add_argument("--edge-rate", default="+0%", help="edge-tts 语速，如 +5%%")
    ap.add_argument("--dry-run", action="store_true", help="只打印清洗后的口播文本")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    segs = parse_script(Path(a.script))
    if not segs:
        print("没有解析到任何「旁白：」段")
        return 1
    dur_file = out / "durations.json"
    durations = json.loads(dur_file.read_text(encoding="utf-8")) if dur_file.exists() else {}
    script_text = {}
    for sid, raw in segs:
        if a.only and sid not in a.only:
            continue
        speech = clean_for_speech(raw)
        script_text[sid] = speech
        print(f"[{sid}] {len(speech)} 字")
        if a.dry_run:
            print("   ", speech)
            continue
        target = out / f"{sid}.mp3"
        ok = False
        if a.engine in ("auto", "cosy"):
            audio = tts_cosyvoice(speech, a.instruct, a.speed)
            if audio:
                target.write_bytes(audio)
                ok = True
                print(f"    cosyvoice -> {target.name}")
        if not ok and a.engine in ("auto", "edge"):
            ok = tts_edge(speech, target, a.edge_rate)
            if ok:
                print(f"    edge-tts -> {target.name}")
        if not ok:
            print(f"    合成失败：{sid}")
            continue
        durations[sid] = duration_of(target)
        print(f"    {durations[sid]} s")
    if not a.dry_run:
        dur_file.write_text(json.dumps(durations, ensure_ascii=False, indent=2), encoding="utf-8")
        (out / "speech-text.json").write_text(json.dumps(script_text, ensure_ascii=False, indent=2), encoding="utf-8")
        total = sum(v for v in durations.values() if v > 0)
        print(f"合计口播 {total:.0f} s（{total/60:.1f} 分）；时长表 {dur_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
