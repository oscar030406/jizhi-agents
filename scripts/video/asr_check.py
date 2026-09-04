# -*- coding: utf-8 -*-
"""合成音频的 ASR 回核：转写回文本，与口播稿比对，抓漏读、错读和语气指令泄漏。

用法：
    python scripts/video/asr_check.py docs/06-defense/audio/v3            # 用 tts_narration 落盘的 speech-text.json 作对照
    python scripts/video/asr_check.py docs/06-defense/audio/v3 --model small --threshold 0.85

判定：
- 相似度（去标点后的字符级 SequenceMatcher ratio）低于阈值 → 标红，重合成；
- 转写里出现「语气」「请用」「说吗」「endofprompt」等指令词 → 指令泄漏，重合成；
- 中文数字转写差异常见（ASR 会把「百分之二点一」写回 2.1%），比对前把两边数字都归一化成阿拉伯数字，避免假阳。

ASR 用本机 openai-whisper（已缓存 small 模型），不走网络。
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

LEAK_WORDS = ("语气", "请用", "说吗", "endofprompt", "end of prompt", "讲解一样")
_CN = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _cn_to_int(s: str) -> int | None:
    if not s:
        return None
    total, section, num = 0, 0, 0
    units = {"十": 10, "百": 100, "千": 1000}
    big = {"万": 10_000, "亿": 100_000_000}
    for ch in s:
        if ch in _CN:
            num = _CN[ch]
        elif ch in units:
            section += (num or 1) * units[ch]
            num = 0
        elif ch in big:
            total += (section + num) * big[ch]
            section, num = 0, 0
        else:
            return None
    return total + section + num


def normalize(text: str) -> str:
    t = re.sub(r"[\s，。、；：！？,.;:!?“”\"'‘’（）()《》「」【】\-—…·%]", "", text)
    t = t.replace("百分之", "")
    # 中文数字 → 阿拉伯数字（含「点」小数）
    def repl(m: re.Match) -> str:
        whole = _cn_to_int(m.group(1))
        if whole is None:
            return m.group(0)
        frac = m.group(2)
        if frac:
            digits = "".join(str(_CN.get(c, "")) for c in frac)
            return f"{whole}.{digits}"
        return str(whole)
    t = re.sub(r"([零一二两三四五六七八九十百千万亿]+)(?:点([零一二三四五六七八九]+))?", repl, t)
    return t.lower()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio_dir")
    ap.add_argument("--model", default="small")
    ap.add_argument("--threshold", type=float, default=0.85)
    ap.add_argument("--only", nargs="*", default=None)
    a = ap.parse_args()

    d = Path(a.audio_dir)
    ref_file = d / "speech-text.json"
    if not ref_file.exists():
        print(f"缺 {ref_file}，先跑 tts_narration.py")
        return 1
    refs = json.loads(ref_file.read_text(encoding="utf-8"))
    # v5 起一段可能是多块 [{role, text}]：对照文本按块顺序拼起来，与拼好的 mp3 对得上
    refs = {
        sid: ("".join(b.get("text", "") for b in ref) if isinstance(ref, list) else ref)
        for sid, ref in refs.items()
    }

    import whisper  # type: ignore

    model = whisper.load_model(a.model)
    bad = 0
    report = {}
    for sid, ref in sorted(refs.items()):
        if a.only and sid not in a.only:
            continue
        mp3 = d / f"{sid}.mp3"
        if not mp3.exists():
            print(f"[{sid}] 缺音频")
            bad += 1
            continue
        # initial_prompt 把 whisper 拉向简体输出；仍有繁体时用 zhconv 转回，避免「後/檢」假阳
        hyp = model.transcribe(str(mp3), language="zh", fp16=False, initial_prompt="以下是简体中文的产品演示旁白。")["text"]
        try:
            from zhconv import convert  # type: ignore
            hyp = convert(hyp, "zh-cn")
        except ImportError:
            pass
        ratio = difflib.SequenceMatcher(None, normalize(ref), normalize(hyp)).ratio()
        leaks = [w for w in LEAK_WORDS if w in hyp and w not in ref]
        flag = ratio < a.threshold or bool(leaks)
        bad += int(flag)
        report[sid] = {"ratio": round(ratio, 3), "leaks": leaks, "hyp": hyp}
        mark = "重合成" if flag else "通过"
        print(f"[{sid}] ratio={ratio:.3f} {mark}" + (f" 泄漏词={leaks}" if leaks else ""))
        if flag:
            # 只打差异片段，别把整段贴出来
            sm = difflib.SequenceMatcher(None, normalize(ref), normalize(hyp))
            diffs = [(normalize(ref)[i1:i2], normalize(hyp)[j1:j2]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]
            for r_, h_ in diffs[:6]:
                print(f"      稿「{r_}」 → 听「{h_}」")
    (d / "asr-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{'全部通过' if not bad else f'{bad} 段需重合成'}；报告 {d / 'asr-report.json'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
