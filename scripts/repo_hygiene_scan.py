#!/usr/bin/env python3
"""出版卫生扫描：对 git 暂存区（或工作树）逐文件查密钥与协作痕迹。

交付纪律：每次推远端/打包前必跑；手工清必漏。词表精确匹配，
正常技术名词（RAG、Agent、TTS 音色名 fable、diffable 之类）不误伤。
用法：python scripts/repo_hygiene_scan.py [--staged]
退出码非 0 = 有命中，逐条打印 文件:行:类别:摘录。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

SECRET_PATTERNS = [
    ("api-key", re.compile(r"sk-[A-Za-z0-9]{20,}")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----")),
    ("password-assign", re.compile(r"(?i)(?:password|passwd|secret)\s*[:=]\s*['\"][^'\"]{6,}")),
]

# 协作痕迹：完整词边界，避免误伤 diffable / TTS 音色 'fable' / spoofable。
TRACE_PATTERNS = [
    ("agent-name", re.compile(r"(?<![A-Za-z_'\"-])(?:fable|opus5)(?![A-Za-z_'\"-])")),
    ("coauthor", re.compile(r"Co-Authored-By|Generated with Claude|Claude Code")),
    ("chat-residue", re.compile(r"作为 ?AI ?助手|<think>|我来帮你|好的，我")),
]

TEXT_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml",
                 ".css", ".html", ".txt", ".toml", ".sh", ".ps1", ".env", ".example"}

# 扫描器与打包脚本自身的词表定义是合法内容——扫描器扫到另一把扫描器不算命中。
SELF_EXEMPT = {"scripts/repo_hygiene_scan.py", "scripts/scan-package-hygiene.py",
               "scripts/publish-repo.ps1",
               "scripts/build-submission.ps1", "scripts/make-package.ps1"}

# chat-residue 只对**内容型**文件有意义（课程 JSON、文档）：`<think>` 与「好的，我来」
# 在代码里大量是产品自己的推理流解析器与 AI 教师台词（已实测 40+ 良性命中），
# 在内容文件里才是生成残留。已实测的误伤类别，词表按纪律收窄而不是放着天天狼来了。
CONTENT_SUFFIXES = {".md", ".json", ".txt"}


def tracked_files(staged: bool) -> list[Path]:
    cmd = ["git", "diff", "--cached", "--name-only"] if staged else ["git", "ls-files"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return [Path(p) for p in out.splitlines() if p.strip()]


def main() -> int:
    staged = "--staged" in sys.argv
    hits = 0
    for path in tracked_files(staged):
        if path.suffix.lower() not in TEXT_SUFFIXES or not path.exists():
            continue
        if path.as_posix() in SELF_EXEMPT:
            continue
        is_content = path.suffix.lower() in CONTENT_SUFFIXES
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            in_tests = "tests/" in path.as_posix() or "/test/" in path.as_posix()
            for label, pat in SECRET_PATTERNS + TRACE_PATTERNS:
                if label == "password-assign" and in_tests:
                    continue
                if label == "chat-residue" and not is_content:
                    continue
                if pat.search(line):
                    print(f"{path}:{lineno}:{label}: {line.strip()[:90]}")
                    hits += 1
    if hits:
        print(f"\n✗ 命中 {hits} 处，处理后再推。")
        return 1
    print("✓ 无密钥与协作痕迹命中。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
