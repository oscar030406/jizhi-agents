"""把 AIGC-Interview-Book 的两篇 Agent 工程正文策展进主库（前缀 ib）。

只收两篇：主库原来对 Agent Harness Engineering、自进化 Agent 与多平台运行时
两项岗位技能一块证据都没有（skill-map covered 11/13），这两篇是库内唯一
成体系讲这两件事的中文正文。**其余章节不收**——面试题清单体不适合当事实证据语料，
理由同 ingest_agentguide.py 里对 04-interview 的那条注记。

用法：
    python scripts\\ingest_interview_book.py [仓库本地路径]

输出 data/knowledge_base/interview_book_docs/*.md，之后跑
build_knowledge_base.py + build_embedding_index.py 重建索引。

许可：上游仓库 GPL-3.0（根目录有 LICENSE 实体文件）。逐篇 front-matter 与
ATTRIBUTION.md / sources_manifest.csv 都保留仓库 URL、文件路径与许可声明。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = ROOT.parent.parent / "references" / "AIGC-Interview-Book-main"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "interview_book_docs"
REPO_URL = "https://github.com/WeThinkIn/AIGC-Interview-Book"
LICENSE_NOTE = "GPL-3.0（仓库根目录有 LICENSE 实体文件）；再分发须保留署名、原始 URL 与同许可条款"

# (仓库根目录下相对路径, 标题, 概念标签, 难度)。首个标签为主概念。
# 标题会和正文一起进嵌入（build_embedding_index._chunk_text），所以按文档实际讲的东西写。
CURATED = [
    (
        "AI Agent基础/08_Agent_Harness_Engineering高频考点.md",
        "Agent Harness Engineering 运行时脚手架工程",
        ["deployment", "evaluation"],
        "L4",
    ),
    (
        "AI Agent基础/09_自进化Agent与多平台运行时高频考点.md",
        "自进化 Agent 与多平台运行时",
        ["deployment", "context_engineering"],
        "L4",
    ),
]

MIN_BODY_CHARS = 600


def clean_body(text: str) -> str:
    """去目录、把 HTML 小标题还原成 markdown 标题、脱面试问答壳。

    切块器（backend/rag/ingest.split_into_sections）只认 markdown 的 H2/H3，
    这两篇正文用的是 `<h1 id="q-001">`/`<h2 id="q-002">`。不还原的话整篇会退化成
    按段落硬切的窗口，一块横跨几个主题，语义门检索会被稀释。
    """
    # 开头是一整块目录（锚点链接），到第一条 `---` 分隔线为止，检索价值为负
    head, sep, rest = text.partition("\n---\n")
    if sep and "## 第一章" in head:
        text = rest
    # <h1 id="q-001">1. xxx</h1> → ## xxx，<h2> → ###；顺手脱掉「面试问题：」的问答壳
    def _heading(match: re.Match[str]) -> str:
        level = "##" if match.group(1) == "1" else "###"
        title = re.sub(r"^(面试问题|面试题)[：:]\s*", "", match.group(2).strip())
        return f"{level} {title}"

    text = re.sub(r"<h([12])\s+id=\"[^\"]*\">(.*?)</h\1>", _heading, text, flags=re.DOTALL)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"^---$\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main() -> None:
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPO
    if not repo.exists():
        print(f"AIGC-Interview-Book not found at {repo}")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DIR.glob("*.md"):
        old.unlink()

    written = 0
    for index, (rel_path, title, tags, difficulty) in enumerate(CURATED, start=1):
        src = repo / rel_path
        if not src.exists():
            print(f"skipped (missing): {rel_path}")
            continue
        body = clean_body(src.read_text(encoding="utf-8"))
        if len(body) < MIN_BODY_CHARS:
            print(f"skipped (too short): {rel_path}")
            continue
        source_id = f"ib{index:03d}"
        front = "\n".join(
            [
                "---",
                f"source_id: {source_id}",
                f"title: {title}",
                f"topic: {tags[0]}",
                f"difficulty: {difficulty}",
                f"concept_tags: {', '.join(tags)}",
                f"url: {REPO_URL}/blob/main/{rel_path.replace(' ', '%20')}",
                f"repo_path: {rel_path}",
                f"license: {LICENSE_NOTE}",
                "---",
                "",
            ]
        )
        (OUTPUT_DIR / f"{source_id}_{src.stem}.md").write_text(front + body + "\n", encoding="utf-8")
        written += 1

    print(f"written {written} docs -> {OUTPUT_DIR}")
    print("next: python scripts\\build_knowledge_base.py && python scripts\\build_embedding_index.py")


if __name__ == "__main__":
    main()
