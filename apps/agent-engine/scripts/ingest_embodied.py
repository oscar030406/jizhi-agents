"""把 Datawhale《dive-into-embodied-ai》策展入知识库——领域泛化验证的新域语料。

为什么是它（2026-08-10 用户拍板具身智能域）：赛题点名的前沿产业、与现有
LLM/Agent 语料域距离足够远（运动学/控制/仿真/VLA）；CC BY-NC-SA 4.0 与库内
教材同许可同社区。鱼香 ROS 教程因「维权骑士版权保护+无开源许可」被否。
教材部分子域施工中——只策展内容成熟的 7 个子域（~700k 字）。

方法：每篇编号文章为一节（>6000 字的按 ## 再切），写带 front-matter 的 md
（source_id 前缀 em），manifest 同款署名。

用法：python scripts/ingest_embodied.py  然后  python scripts/build_knowledge_base.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_REPO = ROOT.parent.parent / "references" / "dive-into-embodied-ai"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "embodied_docs"
REPO_URL = "https://github.com/datawhalechina/dive-into-embodied-ai"
LICENSE_NOTE = "CC BY-NC-SA 4.0（署名-非商业-相同方式共享，见 README LICENSE 节，仓库无 LICENSE 文件）；作者 Datawhale dive-into-embodied-ai；竞赛非商用需署名"

# 人工策展：(子域目录, topic, 难度)。只收内容成熟的子域（施工中的 intro/
# perception 单篇/world-model 两篇不进——语料薄会让检索退化）。
CURATED = [
    ("foundations/robotics-and-ros2", "embodied_ros2", "L1"),
    ("foundations/controllers", "embodied_control", "L2"),
    ("foundations/simulation", "embodied_sim", "L2"),
    ("foundations/rl-for-robotics", "embodied_rl", "L3"),
    ("foundations/vla", "embodied_vla", "L3"),
    ("foundations/vlm", "embodied_vlm", "L3"),
    ("practices/quadruped", "embodied_practice", "L3"),
]

MAX_DOC_CHARS = 6000
MIN_DOC_CHARS = 800


def clean_body(text: str) -> str:
    text = re.sub(r"^---\n.*?\n---\n", "", text, flags=re.DOTALL)  # docusaurus front-matter
    text = re.sub(r"import\s+\w+\s+from\s+['\"].*?['\"];?\n", "", text)
    text = re.sub(r"<div[^>]*>.*?</div>", "", text, flags=re.DOTALL)
    text = re.sub(r"<img[^>]*/?>", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"</?strong>|</?b>|</?em>|</?u>", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def doc_title(raw: str, fallback: str) -> str:
    m = re.search(r"^title:\s*(.+)$", raw, flags=re.MULTILINE)
    if m:
        return m.group(1).strip().strip("'\"")
    m = re.search(r"^#\s+(.+)$", raw, flags=re.MULTILINE)
    return m.group(1).strip() if m else fallback


def split_long(body: str) -> list[tuple[str, str]]:
    """长文按 ## 切；短文整篇一节（heading 用空串占位由调用方给标题）。"""
    if len(body) <= MAX_DOC_CHARS:
        return [("", body)]
    parts = re.split(r"\n(?=## )", body)
    out = []
    for part in parts:
        m = re.match(r"##\s+(.+)", part)
        if m:
            out.append((m.group(1).strip(), part[m.end():].strip()))
        elif part.strip():
            out.append(("", part.strip()))
    return out or [("", body)]


def main() -> None:
    repo = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_REPO
    docs_dir = repo / "docs"
    if not docs_dir.exists():
        print(f"dive-into-embodied-ai 未找到：{repo}")
        sys.exit(1)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_DIR.glob("*.md"):
        old.unlink()

    written = 0
    for dno, (rel, topic, difficulty) in enumerate(CURATED, 1):
        subdir = docs_dir / rel
        files = sorted(
            f for f in subdir.rglob("*.md")
            if "placeholder" not in f.name.lower()
        )
        sec_idx = 0
        for f in files:
            raw = f.read_text(encoding="utf-8", errors="ignore")
            title = doc_title(raw, f.stem)
            body = clean_body(raw)
            if len(body) < MIN_DOC_CHARS:
                continue
            url = f"{REPO_URL}/blob/main/docs/{f.relative_to(docs_dir).as_posix()}"
            for heading, content in split_long(body):
                if len(content) < MIN_DOC_CHARS:
                    continue
                sec_idx += 1
                source_id = f"em{dno:02d}s{sec_idx:02d}"
                full_title = f"具身智能·{title}" + (f" {heading}" if heading else "")
                front = "\n".join([
                    "---",
                    f"source_id: {source_id}",
                    f"title: {full_title}",
                    f"topic: {topic}",
                    f"difficulty: {difficulty}",
                    f"concept_tags: {topic}",
                    f"url: {url}",
                    f"license: {LICENSE_NOTE}",
                    "grade: B",
                    "---",
                    "",
                ])
                (OUTPUT_DIR / f"{source_id}.md").write_text(
                    front + f"# {full_title}\n\n{content}\n", encoding="utf-8")
                written += 1
        print(f"  {rel} -> {sec_idx} 节 ({topic}, {difficulty})")

    print(f"\nwritten {written} 节 -> {OUTPUT_DIR}")
    print("next: python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py")


if __name__ == "__main__":
    main()
