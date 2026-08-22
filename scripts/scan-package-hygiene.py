"""交付包卫生扫描：AI 痕迹 + 密钥令牌，一次扫完出清单。

跟三个打包脚本里各自内嵌的扫描不是一回事——那三处是**阻断闸**，词表窄（只认
`Co-Authored-By` 一类最硬的证据），拦住就退出。这个是**清单扫描**：词表宽一档，
把 `.claude/`、HANDOFF、agent 工作日志、模型全串、`<think>`、会话令牌一并捞出来，
只列不删（批量删除要人过目）。两者并存是有意的，别合并。

词表按「精确匹配」写：RAG / LoRA / 智能体 / Agent 都是正经技术名词，不算痕迹。
误伤一次就得回去改正文，代价比漏一条大。

用法：
    python scripts/scan-package-hygiene.py <目录或 .zip>          # 扫，出清单
    python scripts/scan-package-hygiene.py <...> --md out.md      # 顺手写一份报告
    python scripts/scan-package-hygiene.py --selftest             # 先自证扫得到再去扫真包
"""

from __future__ import annotations

import argparse
import io
import os
import re
import sys
import zipfile

# 二进制与压缩产物不扫（在里面撞出来的都是噪声，实测 wasm/npz 会随机命中 key 形状）
SKIP_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".woff", ".woff2",
    ".ttf", ".otf", ".wasm", ".zip", ".npz", ".npy", ".pdf", ".mp4", ".mp3", ".wav",
    ".docx", ".xlsx", ".pptx", ".pyc", ".bin", ".pack", ".idx", ".so", ".dll", ".exe",
}
MAX_BYTES = 2_000_000  # 单文件只读前 2MB：痕迹从来不藏在第 5 万行
LINE_CAP = 120         # 报告里每条证据截断长度

# 第三方材料：不是我们写的，也无权改。命中照列，但单独归一组，别混进「要处理的」。
THIRD_PARTY = re.compile(r"(^|/)(references|reference_repos|node_modules)/|/textbooks/")

# ── 词表 ──────────────────────────────────────────────────────────────────────
# (规则名, 正则, 说明)。正则一律 re.I 以外的默认，需要忽略大小写的自己写 (?i)。
CONTENT_RULES: list[tuple[str, str, str]] = [
    ("协作署名", r"Co-Authored-By:\s*Claude|Generated with \[?Claude|claude\.ai/code",
     "commit 尾注/生成署名"),
    # `作为一名 ?AI` 单独一条太宽：课程语料里「你作为一名AI工程师，需要构建……」是正经题干，
    # 2026-08-17 首次扫真包时它误伤了 data/eval 下一批 case 文件。AI 后面必须跟「助手/模型」
    # 才算自述口吻。
    ("助手口吻", r"作为 ?AI ?助手|作为一名 ?AI ?(?:助手|模型|语言模型)|以下是我为(你|您)(生成|准备)|"
                 r"由 Claude 编写|我是一个大语言模型",
     "生成内容里残留的助手自述"),
    ("思维链标签", r"</?think>|<\|assistant\|>|<\|user\|>",
     "推理模型的思维链/角色标签没剥干净"),
    ("交接文档引用", r"HANDOFF-20\d{2}|AUTORUN-20\d{2}|\.claude[/\\](workorders|handoff)",
     "指向 agent 工作台账的引用"),
    ("模型全串", r"(?<![\w/-])(siliconflow:|Qwen/Qwen[\w.\-]+|deepseek-ai/DeepSeek[\w.\-]+|"
                 r"moonshotai/Kimi[\w.\-]+|zai-org/GLM[\w.\-]+|MiniMaxAI/MiniMax[\w.\-]+|"
                 r"stepfun-ai/Step[\w.\-]+|tencent/Hunyuan[\w.\-]+)",
     "厂商/型号全串或路由前缀"),
]
SECRET_RULES: list[tuple[str, str, str]] = [
    ("OpenAI 式密钥", r"sk-[A-Za-z0-9]{32,}", "sk- 开头的长串"),
    ("GitHub 令牌", r"gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}", "GitHub PAT/OAuth"),
    ("Google 密钥", r"AIza[A-Za-z0-9_\-]{30,}", "Google API key"),
    ("HuggingFace 令牌", r"(?<![\w])hf_[A-Za-z0-9]{30,}", "HF token"),
    ("Bearer 令牌", r"Bearer\s+[A-Za-z0-9._\-]{24,}", "请求头里写死的令牌"),
    ("会话令牌字段", r'"(session_?token|sessionToken|access_?token|refresh_?token)"\s*:\s*"[A-Za-z0-9._\-]{16,}"',
     "账号库/配置里的会话令牌"),
]

# 文件名/路径本身就是痕迹的，不看内容
PATH_RULES: list[tuple[str, str, str]] = [
    ("agent 配置目录", r"(^|/)\.(claude|cursor|codex|serena)/", "agent 工作目录整进包了"),
    ("agent 入口文件", r"(^|/)(CLAUDE|AGENTS|codex)\.md$|(^|/)\.mcp\.json$", "给 agent 读的入口文件"),
    ("交接/工单文件", r"(^|/)(HANDOFF|AUTORUN|WO)-[^/]*\.md$|(^|/)接手指南\.md$", "agent 工作台账"),
]

Hit = tuple[str, str, str, str]  # (分组, 规则, 路径, 证据)


def _scan_text(rel: str, text: str, group: str, out: list[Hit]) -> None:
    for rules in (CONTENT_RULES, SECRET_RULES):
        for name, pattern, _desc in rules:
            m = re.search(pattern, text)
            if m:
                line = text[: m.start()].count("\n") + 1
                start = text.rfind("\n", 0, m.start()) + 1
                end = text.find("\n", m.end())
                snippet = text[start : end if end > 0 else len(text)].strip()[:LINE_CAP]
                out.append((group, name, f"{rel}:{line}", snippet))


def _iter_zip(path: str):
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            rel = info.filename
            if os.path.splitext(rel)[1].lower() in SKIP_EXT:
                yield rel, None
                continue
            with z.open(info) as fh:
                raw = fh.read(MAX_BYTES)
            yield rel, raw


def _iter_dir(root: str):
    for base, dirs, files in os.walk(root):
        for f in files:
            full = os.path.join(base, f)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.splitext(f)[1].lower() in SKIP_EXT:
                yield rel, None
                continue
            try:
                with io.open(full, "rb") as fh:
                    raw = fh.read(MAX_BYTES)
            except OSError:
                continue
            yield rel, raw


def scan(target: str) -> tuple[list[Hit], int, int]:
    """返回 (命中清单, 扫过的文件数, 跳过的二进制数)。"""
    hits: list[Hit] = []
    walked = skipped = 0
    源 = _iter_zip(target) if target.lower().endswith(".zip") else _iter_dir(target)
    for rel, raw in 源:
        group = "第三方材料" if THIRD_PARTY.search("/" + rel) else "我方"
        for name, pattern, _desc in PATH_RULES:
            if re.search(pattern, "/" + rel):
                hits.append((group, name, rel, "（按路径命中，未读内容）"))
        if raw is None:
            skipped += 1
            continue
        walked += 1
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            try:
                text = raw.decode("utf-8", errors="ignore")
            except Exception:
                continue
        _scan_text(rel, text, group, hits)
    return hits, walked, skipped


SAMPLE = {
    # 每条规则各埋一颗，扫不到就是词表坏了——先自证再去扫真包（K2 的做法）
    "a/CLAUDE.md": "随便什么内容",
    "a/.claude/workorders/WO-X.md": "工单",
    "a/HANDOFF-20260817-9.md": "交接",
    "a/notes.md": "Co-Authored-By: Claude Opus 5\n",
    "a/copy.md": "作为 AI 助手，我认为……\n",
    "a/gen.md": "<think>先想一下</think>正文\n",
    "a/ref.md": "详见 HANDOFF-20260816-2.md 第四节\n",
    "a/cfg.ts": "const M = 'siliconflow:Qwen/Qwen3.6-35B-A3B';\n",
    "a/leak.py": "KEY = 'sk-" + "a" * 40 + "'\n",
    "a/leak2.py": "TOK = 'ghp_" + "b" * 36 + "'\n",
    "a/leak3.py": "G = 'AIza" + "c" * 35 + "'\n",
    "a/leak4.py": "H = 'hf_" + "d" * 34 + "'\n",
    "a/leak5.ts": "headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' }\n",
    "a/accounts.json": '{"sessionToken": "abcdefghijklmnopqrstuvwx"}\n',
}
# 只有在这里出现、不该被任何规则命中的正常文本（防误伤）
CLEAN = {
    "b/ok1.md": "我们用 RAG 做检索增强，LoRA 微调，多智能体（Agent）协同。\n",
    "b/ok2.md": "判官模型属于通义系，具体型号收在详情折叠里。\n",
    "b/ok3.py": "AGENTS = ['diagnose', 'retrieve']  # agent 编排\n",
    "b/ok4.md": "嵌入模型 BAAI/bge-m3，1024 维。\n",
    # 课程语料的角色设定题干，不是助手自述。这条是真包上扫出来的误伤，钉在这里防回退。
    "b/ok5.json": '{"scenario": "你作为一名AI工程师，需要构建一个简易的旅行规划原型系统。"}\n',
}


def selftest() -> int:
    import tempfile

    expected = {n for n, _, _ in CONTENT_RULES + SECRET_RULES + PATH_RULES}
    with tempfile.TemporaryDirectory() as d:
        for rel, body in {**SAMPLE, **CLEAN}.items():
            p = os.path.join(d, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(p), exist_ok=True)
            io.open(p, "w", encoding="utf-8").write(body)
        hits, walked, _ = scan(d)
    fired = {h[1] for h in hits}
    missing = expected - fired
    false_pos = sorted({h[2] for h in hits if h[2].startswith("b/")})
    print(f"自证：扫了 {walked} 个文件，命中 {len(hits)} 条，触发规则 {len(fired)}/{len(expected)}")
    for name in sorted(fired):
        print(f"  ✓ {name}")
    if missing:
        print(f"  ✗ 没触发：{'、'.join(sorted(missing))}")
    if false_pos:
        print(f"  ✗ 误伤正常技术名词：{'、'.join(false_pos)}")
    ok = not missing and not false_pos
    print("自证通过——这把尺子可以拿去扫真包。" if ok else "自证不通过，词表有问题，别用它下结论。")
    return 0 if ok else 1


def render(target: str, hits: list[Hit], walked: int, skipped: int) -> str:
    lines = [
        f"扫描对象：{target}",
        f"读了 {walked} 个文本文件，跳过 {skipped} 个二进制/压缩件（单文件只读前 {MAX_BYTES // 1000} KB）。",
        "",
    ]
    for group in ("我方", "第三方材料"):
        rows = [h for h in hits if h[0] == group]
        lines.append(f"## {group}：{len(rows)} 条命中")
        if not rows:
            lines.append("\n（无）\n")
            continue
        lines.append("")
        for _g, name, where, snip in sorted(rows, key=lambda r: (r[1], r[2])):
            lines.append(f"- **{name}** `{where}`")
            lines.append(f"  - `{snip}`")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", help="目录或 .zip")
    ap.add_argument("--md", help="把清单写成 markdown")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.target:
        ap.error("要么给扫描目标，要么 --selftest")
    hits, walked, skipped = scan(args.target)
    report = render(args.target, hits, walked, skipped)
    print(report)
    if args.md:
        io.open(args.md, "w", encoding="utf-8").write(report + "\n")
        print(f"\n已写入 {args.md}")
    # 只列不删，也不用退出码替人做判断——清单交给人看
    return 0


if __name__ == "__main__":
    sys.exit(main())
