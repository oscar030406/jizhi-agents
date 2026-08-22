"""把 Datawhale《Happy-LLM》七章教材策展入知识库（课外轨·LLM 基础课的语料底座）。

为什么是它：《从零构建大模型》的开源中文对应物（CC BY-NC-SA 4.0，与 hello-agents
同许可同社区），从 NLP 基础到 Transformer、预训练、对齐、应用完整覆盖——
高校未开、企业最要的"课外补新"核心知识。商业版权书（Raschka 等）只做深度骨架参照。

方法与 ingest_hello_agents 同款：每章取编号正文小节，跳过习题/参考文献/小结，
写带 front-matter 的 md（source_id 前缀 hl），manifest 记署名。

用法：python scripts\\ingest_happy_llm.py  然后  python scripts\\build_knowledge_base.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_REPO = ROOT.parent.parent / "references" / "happy-llm-main"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "happy_llm_docs"
REPO_URL = "https://github.com/datawhalechina/happy-llm"
LICENSE_NOTE = "CC BY-NC-SA 4.0（署名-非商业-相同方式共享）；作者 Datawhale happy-llm；竞赛非商用需署名"

# 人工策展：(章号, 文件名, 概念标签, 难度)。全部归 llm_basics，难度随章节递进。
CURATED = [
    (1, "chapter1/第一章 NLP基础概念.md", ["llm_basics"], "L1"),
    (2, "chapter2/第二章 Transformer架构.md", ["llm_basics"], "L2"),
    (3, "chapter3/第三章 预训练语言模型.md", ["llm_basics"], "L2"),
    (4, "chapter4/第四章 大语言模型.md", ["llm_basics"], "L2"),
    (5, "chapter5/第五章 动手搭建大模型.md", ["llm_basics"], "L3"),
    (6, "chapter6/第六章 大模型训练流程实践.md", ["llm_basics"], "L3"),
    (7, "chapter7/第七章 大模型应用.md", ["llm_basics", "rag"], "L3"),
]

SKIP_HEADING = re.compile(r"^(习题|参考文献|本章小结|本章总结|小结|总结|.*(小结|总结)与展望)")
NUMBERED = re.compile(r"^\d+\.\d+")
MIN_SECTION_CHARS = 400


def clean_body(text: str) -> str:
    text = re.sub(r"<div[^>]*>.*?</div>", "", text, flags=re.DOTALL)
    text = re.sub(r"<img[^>]*>", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"</?strong>|</?b>|</?em>|</?u>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def split_sections(body: str) -> list[tuple[str, str]]:
    parts = re.split(r"\n(?=## )", body)
    out = []
    for part in parts:
        m = re.match(r"##\s+(.+)", part)
        if not m:
            continue
        heading = m.group(1).strip()
        heading = re.sub(r"^[^\w一-鿿]+", "", heading).strip()
        out.append((heading, part[m.end():].strip()))
    return out


def main() -> None:
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPO
    docs_dir = repo / "docs"
    if not docs_dir.exists():
        print(f"happy-llm 未找到：{repo}")
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
            source_id = f"hl{chno:02d}s{sec_idx:02d}"
            front = "\n".join(
                [
                    "---",
                    f"source_id: {source_id}",
                    f"title: Happy-LLM 第{chno}章 {heading}",
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
