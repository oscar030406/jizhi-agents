"""把 Datawhale《Hello-Agents》16 章教材策展为主知识库（PLAYBOOK Phase B-1）。

为什么换主库：AgentGuide 无许可、偏索引；hello-agents 是 CC BY-NC-SA 的深度教材，
章节序=天然前置图，难度自然分层（L1 基础→L4 实战），是内容深度的"肉"。

方法：每章只取**编号正文小节**（如 4.1/8.3），跳过 习题/参考文献/小结/emoji 输出块
（习题另入题库 B-3）。每小节写成带 front-matter 的 md，按概念+难度打标，
manifest 记 CC-BY-NC-SA 署名 + B 级。

用法：python scripts\\ingest_hello_agents.py  然后  python scripts\\build_knowledge_base.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_REPO = ROOT.parent.parent / "references" / "hello-agents-main"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "hello_agents_docs"
REPO_URL = "https://github.com/datawhalechina/hello-agents"
LICENSE_NOTE = "CC BY-NC-SA 4.0（署名-非商业-相同方式共享）；作者 Datawhale hello-agents；竞赛非商用需署名"

# 人工策展：(章号, 文件名, 概念标签, 难度)。难度按章节进阶分层——这也给难度定标更细的信号。
CURATED = [
    (1, "chapter1/第一章 初识智能体.md", ["agent_basics"], "L1"),
    (3, "chapter3/第三章 大语言模型基础.md", ["agent_basics"], "L1"),
    (4, "chapter4/第四章 智能体经典范式构建.md", ["agent_basics", "tool_calling"], "L2"),
    (6, "chapter6/第六章 框架开发实践.md", ["langgraph"], "L2"),
    (8, "chapter8/第八章 记忆与检索.md", ["rag"], "L2"),
    (7, "chapter7/第七章 构建你的Agent框架.md", ["langgraph", "agent_basics"], "L3"),
    (9, "chapter9/第九章 上下文工程.md", ["context_engineering"], "L3"),
    (10, "chapter10/第十章 智能体通信协议.md", ["tool_calling"], "L3"),
    (12, "chapter12/第十二章 智能体性能评估.md", ["evaluation"], "L3"),
    (13, "chapter13/第十三章 智能旅行助手.md", ["deployment", "agent_basics"], "L4"),
    (16, "chapter16/第十六章 毕业设计.md", ["deployment"], "L4"),
]

# 跳过的小节：习题(入题库)、参考文献、小结/总结、emoji 开头(代码输出块)
SKIP_HEADING = re.compile(r"^(习题|参考文献|本章小结|本章总结|小结|总结|.*(小结|总结)与展望)")
NUMBERED = re.compile(r"^\d+\.\d+")
MIN_SECTION_CHARS = 400


def clean_body(text: str) -> str:
    text = re.sub(r"<div[^>]*>.*?</div>", "", text, flags=re.DOTALL)
    text = re.sub(r"<img[^>]*>", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)  # 图片
    text = re.sub(r"</?strong>|</?b>|</?em>|</?u>", "", text)  # 行内强调
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sections(body: str) -> list[tuple[str, str]]:
    """按 H2 切分，返回 [(小节标题, 小节正文)]。"""
    parts = re.split(r"\n(?=## )", body)
    out = []
    for part in parts:
        m = re.match(r"##\s+(.+)", part)
        if not m:
            continue
        heading = m.group(1).strip()
        heading = re.sub(r"^[^\w一-鿿]+", "", heading).strip()  # 去 emoji 前缀后再判
        out.append((heading, part[m.end():].strip()))
    return out


def main() -> None:
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPO
    docs_dir = repo / "docs"
    if not docs_dir.exists():
        print(f"hello-agents 未找到：{repo}")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DIR.glob("*.md"):
        old.unlink()

    written = 0
    for chno, rel, tags, difficulty in CURATED:
        src = docs_dir / rel
        if not src.exists():
            print(f"  跳过(缺失): {rel}")
            continue
        body = clean_body(src.read_text(encoding="utf-8"))
        url = f"{REPO_URL}/blob/main/docs/{rel}"
        sec_idx = 0
        for heading, content in split_sections(body):
            if SKIP_HEADING.match(heading) or not NUMBERED.match(heading):
                continue
            if len(content) < MIN_SECTION_CHARS:
                continue
            sec_idx += 1
            source_id = f"ha{chno:02d}s{sec_idx:02d}"
            front = "\n".join(
                [
                    "---",
                    f"source_id: {source_id}",
                    f"title: 第{chno}章 {heading}",
                    f"topic: {tags[0]}",
                    f"difficulty: {difficulty}",
                    f"concept_tags: {', '.join(tags)}",
                    f"url: {url}",
                    f"license: {LICENSE_NOTE}",
                    "grade: B",
                    "---",
                    "",
                ]
            )
            (OUTPUT_DIR / f"{source_id}.md").write_text(front + f"# {heading}\n\n{content}\n", encoding="utf-8")
            written += 1
        print(f"  第{chno}章 -> {sec_idx} 小节 ({', '.join(tags)}, {difficulty})")

    print(f"\nwritten {written} 小节 -> {OUTPUT_DIR}")
    print("next: python scripts\\build_knowledge_base.py")


if __name__ == "__main__":
    main()
