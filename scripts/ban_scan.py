"""三禁扫描：赛题口吻 / 元叙事 / 内部代号。

扫的是**上屏或落库的字符串**——DOM 文本、或课程 JSON 里的正文字段，
不扫源码注释、不扫提示词模板本身（那是给模型看的，不上屏）。

用法：
  python ban_scan.py dom <文件.txt>            # 扫实拔下来的 DOM 文本
  python ban_scan.py scene <run_id>            # 扫体检 run 产出的讲义正文

本脚本原是 WO-K2 那一轮写在会话 scratchpad 里的临时工具，L2 的复算要靠它，2026-08-17 晚按用户裁决落进 `scripts/`。**除了把写死的绝对路径改成按 __file__ 推导，一个字都没动**——动了 K2 报告里那些数就不再可复算。
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BANS = [
    # 赛题口吻
    ("赛题口吻", re.compile(r"赛题|参赛|评委|挑战杯|本次大赛|竞赛作品|赛道|答辩|评分标准|获奖")),
    # 元叙事：模型谈自己 / 谈提示词 / 谈生成过程
    ("元叙事", re.compile(
        r"作为(?:一个)?(?:AI|人工智能|语言模型|大模型)|我是(?:一个)?(?:AI|语言模型)"
        r"|本(?:课|文|内容|讲义)(?:由|系)?(?:AI|人工智能|大模型|模型)生成"
        r"|根据我的训练|我的训练数据|提示词|prompt|system prompt"
        r"|铁律\s*\d|按铁律|降一档|降档|第[一二三四]档"
        r"|\[推断\]|（未验证）|\(未验证\)|注：无出处"
        r"|<think>|</think>|好的，我来|以下是我为你|希望这(?:份|个)(?:讲义|内容)对你有帮助",
        re.I)),
    # 内部代号：工单号、裸难度码、完整模型串、fixture 名
    ("内部代号", re.compile(
        r"\bWO-[A-Z]\d|\bJ8[a-z]?\b|\bK[1-4]\s*工单"
        r"|(?<![A-Za-z0-9/-])L[123](?![A-Za-z0-9])"
        r"|Qwen/[\w.\-]+|deepseek-ai/[\w.\-]+|MiniMaxAI/[\w.\-]+|zai-org/[\w.\-]+"
        r"|siliconflow:|fixture|intake_runs|trial_courses",
        re.I)),
]
TAG = re.compile(r"<[^>]+>")


def scan(text, where, hits):
    for name, pat in BANS:
        for m in pat.finditer(text):
            hits.append((name, where, m.group(0), text[max(0, m.start() - 45):m.end() + 45]
                         .replace("\n", " ")))


def main():
    mode, target = sys.argv[1], sys.argv[2]
    hits = []
    if mode == "dom":
        scan(open(target, encoding="utf-8").read(), os.path.basename(target), hits)
    elif mode == "scene":
        runs = os.path.join(
            os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base", "intake_runs"), target)
        for path in sorted(glob.glob(os.path.join(runs, "trial_courses", "*.json"))):
            if "kc_misses" in path:
                continue
            course = json.load(open(path, encoding="utf-8"))
            for i, sc in enumerate(course.get("scenes", []), 1):
                for el in (sc.get("content") or {}).get("elements", []) or []:
                    if isinstance(el.get("content"), str):
                        scan(TAG.sub("", el["content"]),
                             f"{os.path.basename(path)[:-5]}#屏{i}", hits)
                scan(str(sc.get("title", "")), f"{os.path.basename(path)[:-5]}#屏{i}标题", hits)
    else:
        raise SystemExit("mode 只能是 dom / scene")

    if not hits:
        print(f"三禁扫描通过：{mode} {target} 零命中")
        return 0
    print(f"三禁命中 {len(hits)} 处：")
    for name, where, tok, ctx in hits:
        print(f"  [{name}] {where} «{tok}» … {ctx[:130]}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
