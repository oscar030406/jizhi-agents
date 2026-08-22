"""把 dair-ai《Prompt Engineering Guide》中文页策展入知识库——提示工程入门课的语料前置。

为什么是它（2026-08-10 需求稿拍板，docs/03-design/new-courses-requirements-20260810.md）：
提示工程课既有支撑只有 ha03s02 一小节，撑不起整门课；PEG 是 MIT 协议、带官方中文版，
TEXTBOOK_REGISTRY 已登记（ingested=False，入库后翻 True）。只取 introduction 5 篇 +
techniques 基础 5 篇（zeroshot/fewshot/cot/consistency/prompt_chaining）；ToT/APE/ReAct
等高级篇不入——课程 focus 禁令明确不许提及未入库技术。

方法：每篇 .zh.mdx 为一节，剥 MDX 壳（import 行、大写开头的 JSX 组件标签、图片），
代码围栏内一字不动（提示例子里有 <quotes> 这类小写角括号标记，是语料本体）；
中文标题以 _meta.zh.json 为准；front-matter 同库内其他源，license 记 MIT + 署名 DAIR.AI。

用法：
  python scripts/ingest_prompt_guide.py --dry   # 只打印切分统计与残留检查，不落盘
  python scripts/ingest_prompt_guide.py         # 写 data/knowledge_base/prompt_guide_docs/
  然后 python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.ingest import split_into_sections

DEFAULT_REPO = ROOT.parent.parent / "references" / "Prompt-Engineering-Guide"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "prompt_guide_docs"
REPO_URL = "https://github.com/dair-ai/Prompt-Engineering-Guide"
LICENSE_NOTE = "MIT；作者 DAIR.AI（Elvis Saravia 等）Prompt Engineering Guide 官方中文版；署名 DAIR.AI"

# 人工策展：(目录, 文件名去后缀, 难度)。范围=需求稿拍板的 10 篇，中文标题从 _meta.zh.json 取。
CURATED = [
    ("introduction", "settings", "L1"),
    ("introduction", "basics", "L1"),
    ("introduction", "elements", "L1"),
    ("introduction", "tips", "L1"),
    ("introduction", "examples", "L1"),
    ("techniques", "zeroshot", "L2"),
    ("techniques", "fewshot", "L2"),
    ("techniques", "cot", "L2"),
    ("techniques", "consistency", "L2"),
    ("techniques", "prompt_chaining", "L2"),
]

TOPIC = "prompt_engineering"
FENCE = re.compile(r"^\s*(```|~~~)")
# 残留检查：剥壳后的散文段里不许再出现这些（大写开头=JSX 组件；小写标签如 <quotes> 是语料）
RESIDUE = [re.compile(r"^import\s", re.MULTILINE), re.compile(r"</?[A-Z]")]


def _split_fences(text: str) -> list[tuple[bool, str]]:
    """按代码围栏切段，返回 [(是否围栏内, 段文本)]，围栏行本身归围栏段。"""
    segments: list[tuple[bool, str]] = []
    buf: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        if FENCE.match(line):
            if not in_fence:
                segments.append((False, "\n".join(buf)))
                buf = [line]
                in_fence = True
            else:
                buf.append(line)
                segments.append((True, "\n".join(buf)))
                buf = []
                in_fence = False
            continue
        buf.append(line)
    segments.append((in_fence, "\n".join(buf)))
    return segments


def _clean_prose(text: str) -> str:
    text = re.sub(r"^import\s.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\{/\*.*?\*/\}", "", text, flags=re.DOTALL)
    text = re.sub(r"<([A-Z][A-Za-z0-9]*)\b[^>]*>.*?</\1>", "", text, flags=re.DOTALL)  # <Cards>…</Cards>
    text = re.sub(r"<[A-Z][A-Za-z0-9]*\b[^>]*/>", "", text)  # <Screenshot … />
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    return text


def clean_mdx(text: str) -> str:
    """剥 MDX 壳；代码围栏内一字不动（提示例子是语料本体）。"""
    cleaned = "\n".join(
        seg if fenced else _clean_prose(seg) for fenced, seg in _split_fences(text)
    )
    cleaned = re.sub(r"^#\s+.*\n", "", cleaned, count=1)  # 原 H1 多为英文，标题以 _meta.zh 为准
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def check_residue(body: str) -> list[str]:
    hits = []
    for fenced, seg in _split_fences(body):
        if fenced:
            continue
        for pat in RESIDUE:
            hits += [m.group(0) for m in pat.finditer(seg)]
    return hits


def main() -> None:
    args = sys.argv[1:]
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    repo = Path(args[0]) if args else DEFAULT_REPO
    pages = repo / "pages"
    if not pages.exists():
        print(f"Prompt-Engineering-Guide 未找到：{repo}")
        sys.exit(1)

    meta = {
        group: json.loads((pages / group / "_meta.zh.json").read_text(encoding="utf-8"))
        for group in {g for g, _, _ in CURATED}
    }

    if not dry:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        for old in OUTPUT_DIR.glob("*.md"):
            old.unlink()

    written = 0
    total_chunks = 0
    bad = False
    for pno, (group, stem, difficulty) in enumerate(CURATED, 1):
        src = pages / group / f"{stem}.zh.mdx"
        if not src.exists():
            print(f"  跳过(缺失): {group}/{stem}.zh.mdx")
            bad = True
            continue
        title = f"提示工程指南·{meta[group].get(stem, stem)}"
        body = clean_mdx(src.read_text(encoding="utf-8"))
        residue = check_residue(body)
        if residue:
            print(f"  !! {stem}: 剥壳残留 {residue}")
            bad = True
        source_id = f"pg{pno:02d}"
        chunks = split_into_sections(body)  # 与 build_knowledge_base 同一把刀，统计=真口径
        total_chunks += len(chunks)

        if dry:
            sizes = ", ".join(str(len(c)) for c in chunks)
            head = chunks[0][:60].replace("\n", " ")
            tail = chunks[-1][-60:].replace("\n", " ")
            print(f"  {source_id} {group}/{stem} ({difficulty}) {title}")
            print(f"      {len(body)} 字 -> {len(chunks)} 块 [{sizes}]")
            print(f"      首块: {head}...")
            print(f"      尾块: ...{tail}")
            continue

        url = f"{REPO_URL}/blob/main/pages/{group}/{stem}.zh.mdx"
        front = "\n".join([
            "---",
            f"source_id: {source_id}",
            f"title: {title}",
            f"topic: {TOPIC}",
            f"difficulty: {difficulty}",
            f"concept_tags: {TOPIC}",
            f"url: {url}",
            f"license: {LICENSE_NOTE}",
            "grade: B",
            "---",
            "",
        ])
        (OUTPUT_DIR / f"{source_id}.md").write_text(
            front + f"# {title}\n\n{body}\n", encoding="utf-8")
        written += 1

    if dry:
        print(f"\n[dry] {len(CURATED)} 篇 -> 预计 {total_chunks} chunks；未写任何文件")
        if bad:
            sys.exit(1)
    else:
        print(f"\nwritten {written} 篇 -> {OUTPUT_DIR}")
        print("next: python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py")
        if bad:
            sys.exit(1)


if __name__ == "__main__":
    main()
