"""把 AgentGuide 仓库的正文文档策展为本项目的真实领域知识库切片（PLAYBOOK P1-1）。

用法：
    python scripts\\ingest_agentguide.py [AgentGuide本地路径]

默认在 ..\\reference_AgentGuide 找克隆的仓库。输出：
    data/knowledge_base/agentguide_docs/*.md   带 front-matter 的知识库切片（提交物）
    之后运行 build_knowledge_base.py 重建索引与 manifest。

许可与合规：AgentGuide（https://github.com/adongwanai/AgentGuide）未声明开源许可。
本脚本只做本地检索语料转换，逐篇保留真实 GitHub URL 供引用溯源；
公开分发或商用前应联系作者授权。策展清单（CURATED）应由团队人工复核。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = ROOT.parent.parent / "references" / "AgentGuide-main"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "agentguide_docs"
REPO_URL = "https://github.com/adongwanai/AgentGuide"

# 人工策展清单：(仓库根目录下相对路径, 概念标签, 难度)。
# 概念标签前 1 个为主概念（对应诊断体系的 7 个核心概念），其余为辅助标签。
# stub（🚧 占位）会被自动跳过；团队复核时直接增删本清单即可。
CURATED = [
    ("docs/00-getting-started/01-agent-map.md", ["agent_basics"], "L1"),
    ("docs/01-theory/01-what-is-agent.md", ["agent_basics"], "L1"),
    ("docs/01-theory/04-react-framework.md", ["agent_basics", "tool_calling"], "L2"),
    ("docs/01-theory/09-evaluation-metrics.md", ["evaluation"], "L2"),
    ("docs/02-tech-stack/11-context-engineering-practices.md", ["agent_basics", "context_engineering"], "L3"),
    ("docs/02-tech-stack/12-factor-agent-architecture.md", ["agent_basics", "deployment"], "L3"),
    ("docs/02-tech-stack/14-mcp-protocol.md", ["tool_calling"], "L2"),
    ("docs/02-tech-stack/15-agent-memory.md", ["agent_basics", "context_engineering"], "L3"),
    ("docs/02-tech-stack/22-parlant-agent-compliance-deep-dive.md", ["guardrails"], "L3"),
    ("docs/02-tech-stack/23-lessons-learned.md", ["deployment"], "L3"),
    ("docs/02-tech-stack/24-agent-sandbox-guide.md", ["guardrails", "tool_calling"], "L3"),
    ("docs/02-tech-stack/26-agent-evaluation-harness-guide.md", ["evaluation"], "L3"),
    ("docs/02-tech-stack/agent-evaluation-complete-guide.md", ["evaluation"], "L3"),
    ("docs/02-tech-stack/27-agent-harness-engineering.md", ["deployment", "langgraph"], "L4"),
    ("docs/03-practice/03-agent-security.md", ["guardrails"], "L3"),
    ("docs/03-practice/05-ship-agent-project.md", ["deployment"], "L2"),
    # 04-interview 下的 playbook 是面试题清单体，不适合做事实证据语料，勿加
    ("resources/rag/document-parsing.md", ["rag"], "L2"),
    ("resources/rag/papers/agentic_rag/agentic_rag.md", ["rag"], "L3"),
    ("resources/agent/frameworks.md", ["langgraph"], "L2"),
    ("resources/agent/ai-agent-production-challenges.md", ["deployment", "guardrails"], "L3"),
    ("resources/agent/official-guides.md", ["agent_basics"], "L2"),
]

STUB_MARKERS = ["🚧", "正在编写中", "敬请期待"]
MIN_BODY_CHARS = 600


def clean_body(text: str) -> str:
    # 去掉 HTML 徽章/图片等站点装饰，保留正文
    text = re.sub(r"<div[^>]*>.*?</div>", "", text, flags=re.DOTALL)
    text = re.sub(r"<img[^>]*>", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main() -> None:
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPO
    if not (repo / "docs").exists():
        print(f"AgentGuide repo not found at {repo}; clone it first:")
        print(f"  git clone --depth 1 {REPO_URL} {repo}")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DIR.glob("*.md"):
        old.unlink()

    written = 0
    skipped = []
    for index, (rel_path, tags, difficulty) in enumerate(CURATED, start=1):
        src = repo / rel_path
        if not src.exists():
            skipped.append((rel_path, "missing"))
            continue
        raw = src.read_text(encoding="utf-8")
        body = clean_body(raw)
        if any(marker in body[:400] for marker in STUB_MARKERS) or len(body) < MIN_BODY_CHARS:
            skipped.append((rel_path, "stub_or_too_short"))
            continue
        title_match = re.search(r"^#\s+(.+)", body, flags=re.MULTILINE)
        title = title_match.group(1).strip() if title_match else src.stem
        source_id = f"ag{index:03d}"
        url = f"{REPO_URL}/blob/main/{rel_path}"
        front = "\n".join(
            [
                "---",
                f"source_id: {source_id}",
                f"title: {title}",
                f"topic: {tags[0]}",
                f"difficulty: {difficulty}",
                f"concept_tags: {', '.join(tags)}",
                f"url: {url}",
                "license: AgentGuide 仓库未声明开源许可；本切片仅作本地检索与引用溯源，分发前需作者授权",
                "---",
                "",
            ]
        )
        out_name = f"{source_id}_{src.stem}.md"
        (OUTPUT_DIR / out_name).write_text(front + body + "\n", encoding="utf-8")
        written += 1

    print(f"written {written} docs -> {OUTPUT_DIR}")
    for rel_path, reason in skipped:
        print(f"skipped ({reason}): {rel_path}")
    print("next: python scripts\\build_knowledge_base.py")


if __name__ == "__main__":
    main()
