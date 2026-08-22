"""把 Datawhale《tiny-universe》的 TinyRAG / TinyGraphRAG 讲解文策展入知识库。

为什么是它（2026-08-10，docs/03-design/kb-expansion-plan-20260810.md 批 2）：
RAG/知识库岗 12 条技能只接地 7 条，其中"外挂知识库整体架构设计"实测 0.000、
"向量检索与相似度函数选型"0.084，全库找不到一篇从零讲清"分块→向量化→向量库→
检索→生成"整链的中文教材。TinyRAG 正是手搓这条整链（含 numpy 余弦相似度与
top-k 查询），TinyGraphRAG 补图检索侧的架构（三元组抽取、社区聚类、局部/全局查询）。
许可 CC BY-NC-SA 4.0，与库内 hello-agents / happy-llm / llm-deploy 同社区同许可。

难度标注口径（同 ingest_llm_deploy.py）：库里没有自动启发式，difficulty 是各脚本
按章节人工定的常量；L4 在本库特指综合实战/毕业设计（ha13/ha16），不是"最难理论"，
所以本次最高到 L3。分档：RAG 概念介绍 = L1；TinyRAG 各模块的白盒实现（numpy 级
代码，无推导）= L2；TinyGraphRAG 的动机与前置模块 = L2，其三元组抽取/实体消歧/
社区检测/图检索算法 = L3。

本仓特有的清洗：6 段英文提示词模板（GET_ENTITY、GET_TRIPLETS、
ENTITY_DISAMBIGUATION、GEN_COMMUNITY_REPORT、LOCAL_QUERY、GLOBAL_QUERY，
合计 13.4KB）写在 ```python 围栏里，模板内部带 `## Goal` / `## Example` 这类
markdown 标题——split_into_sections 按 H2/H3 切块时会从围栏中间劈开，切出一堆
半截英文提示词块。这些块既不是可引用的中文证据，又会污染检索，整段剔除。

用法：
  python scripts/ingest_tiny_universe.py --dry   # 只打印切分统计与残留检查，不落盘
  python scripts/ingest_tiny_universe.py         # 写 data/knowledge_base/tiny_universe_docs/
  然后 python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.ingest import split_into_sections

DEFAULT_REPO = ROOT.parent.parent / "references" / "tiny-universe"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "tiny_universe_docs"
REPO_URL = "https://github.com/datawhalechina/tiny-universe"
# 仓库没有 LICENSE 文件，许可写在 README 末尾的 LICENSE 节（2026-08-10 磁盘核对，
# commit a5ae08d）。与 llm-deploy 同样的"只在 README 声明"形态。
LICENSE_NOTE = (
    "CC BY-NC-SA 4.0（署名-非商业-相同方式共享，见 README LICENSE 节，仓库无 LICENSE 文件）；"
    "作者 Datawhale tiny-universe；竞赛非商用需署名"
)

TOPIC = "rag"  # 复用库内既有 topic（56 chunks），不新造概念面
TAGS = ["rag"]  # 同上：PRETEST_DIM_CONCEPTS 的 rag 维直接吃这个标签

# 人工策展：(相对 content 的文件, 收录的小节标题, 文档标题, 难度)。
# 小节标题按原文精确匹配，改名了就报错，不静默漏收。
CURATED = [
    (
        "TinyRAG/readme.md",
        ["1. RAG 介绍"],
        "TinyRAG 手搓最小 RAG：外挂知识库的五大模块与索引-检索-生成流程",
        "L1",
    ),
    (
        "TinyRAG/readme.md",
        ["2. 向量化"],
        "TinyRAG 向量化模块：Embedding 基类与余弦相似度计算",
        "L2",
    ),
    (
        "TinyRAG/readme.md",
        ["3. 文档加载和切分"],
        "TinyRAG 文档加载与分块：按 Token 长度切分与片段重叠",
        "L2",
    ),
    (
        "TinyRAG/readme.md",
        ["4. 数据库 && 向量检索"],
        "TinyRAG 向量数据库与向量检索：持久化、相似度打分与 top-k 查询",
        "L2",
    ),
    (
        "TinyRAG/readme.md",
        ["5. 大模型模块"],
        "TinyRAG 生成模块：大模型基类与 RAG 提示模板",
        "L2",
    ),
    (
        "TinyRAG/readme.md",
        ["6.  LLM Tiny-RAG Demo"],
        "TinyRAG 端到端 Demo：建库、持久化与加载后问答",
        "L2",
    ),
    (
        "TinyGraphRAG/readme.md",
        ["项目动机"],
        "TinyGraphRAG 项目动机：分块破坏语义连续性与全局查询难题",
        "L2",
    ),
    (
        "TinyGraphRAG/readme.md",
        ["前置实现", "1. 实现 LLM 模块", "2. 实现 Embedding 模块", "3. 实现与 Neo4j 的交互"],
        "TinyGraphRAG 前置模块：LLM 封装、Embedding 与 Neo4j 图数据库交互",
        "L2",
    ),
    (
        "TinyGraphRAG/readme.md",
        ["核心实现", "数据预处理"],
        "TinyGraphRAG 数据预处理：文档分块、实体与三元组抽取、实体消歧与合并",
        "L3",
    ),
    (
        "TinyGraphRAG/readme.md",
        ["社区聚类概览", "社区检测实现", "社区摘要生成"],
        "TinyGraphRAG 社区聚类与摘要：Leiden 社区检测与社区报告生成",
        "L3",
    ),
    (
        "TinyGraphRAG/readme.md",
        ["节点嵌入生成", "检索算法概览", "局部查询算法实现", "全局查询算法实现"],
        "TinyGraphRAG 图检索算法：节点嵌入、局部查询与全局查询",
        "L3",
    ),
]

MIN_DOC_CHARS = 500  # TinyRAG 单节本来就短（1-2KB），比 llm-deploy 的 800 放宽
FENCE = re.compile(r"^\s*(`{3,})")
HEADING = re.compile(r"^(#{2,3})\s+(.*?)\s*$")
TEMPLATE_HEADING = re.compile(r"^#{2,4} ")


def _fenced_spans(lines: list[str]) -> list[tuple[int, int]]:
    """返回代码围栏的行区间 [start, end]（含围栏行本身）。支持 ``` 与 ````。"""
    spans: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        m = FENCE.match(lines[i])
        if not m:
            i += 1
            continue
        fence = m.group(1)
        start = i
        i += 1
        while i < len(lines) and not re.match(r"^\s*" + fence + r"\s*$", lines[i]):
            i += 1
        spans.append((start, min(i, len(lines) - 1)))
        i += 1
    return spans


def drop_prompt_templates(text: str) -> str:
    """剔除内部带 markdown 标题的代码围栏——本仓的英文提示词模板都长这样。

    只认"围栏内有 `## xxx` 行"这一条特征：普通 python/csv 围栏没有二级标题，
    6 段提示词模板每段都有（Goal / Example / Format / Your response…）。
    **必须是 ## 起步**：单个 `#` 会把 Demo 代码里的 python 注释（`# 没有保存数据库`）
    误判成标题，把整段示例代码删掉——实测踩过，tu06 一度只剩 100 字。
    """
    lines = text.split("\n")
    drop: set[int] = set()
    for start, end in _fenced_spans(lines):
        block = lines[start : end + 1]
        if any(TEMPLATE_HEADING.match(ln) for ln in block):
            drop.update(range(start, end + 1))
    return "\n".join(ln for i, ln in enumerate(lines) if i not in drop)


def clean_body(text: str) -> str:
    text = drop_prompt_templates(text)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def blocks_by_heading(text: str) -> dict[str, str]:
    """按 H2/H3 切块（围栏内的 # 行不算标题），返回 {标题: 含标题的块文本}。"""
    lines = text.split("\n")
    fenced = {i for start, end in _fenced_spans(lines) for i in range(start, end + 1)}
    out: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []
    for i, line in enumerate(lines):
        m = HEADING.match(line) if i not in fenced else None
        if m:
            if current is not None:
                out[current] = "\n".join(buf).strip()
            current = m.group(2)
            buf = [line]
            continue
        if current is not None:
            buf.append(line)
    if current is not None:
        out[current] = "\n".join(buf).strip()
    return out


# 剥壳后不许再出现的东西
RESIDUE = [
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), "图片引用"),
    (re.compile(r"<!--"), "HTML 注释"),
    (re.compile(r"&emsp;|&nbsp;|&thinsp;"), "HTML 空白实体"),
]


def check_residue(body: str) -> list[str]:
    hits = [name for pat, name in RESIDUE if pat.search(body)]
    # 提示词模板残留：正文里如果还有围栏内标题，说明剔除规则没盖住
    lines = body.split("\n")
    for start, end in _fenced_spans(lines):
        if any(TEMPLATE_HEADING.match(ln) for ln in lines[start : end + 1]):
            hits.append("围栏内 markdown 标题（提示词模板未剔净）")
            break
    return hits


def build_docs(repo: Path) -> list[dict]:
    """策展清单 → 待入库文档。dry / 落盘 / 覆盖率模拟三处共用这一份真源。"""
    content = repo / "content"
    cache: dict[str, dict[str, str]] = {}
    docs: list[dict] = []
    for no, (rel, keys, title, difficulty) in enumerate(CURATED, 1):
        if rel not in cache:
            src = content / rel
            cache[rel] = blocks_by_heading(clean_body(src.read_text(encoding="utf-8"))) if src.exists() else {}
        blocks = cache[rel]
        missing = [k for k in keys if k not in blocks]
        body = "\n\n".join(blocks[k] for k in keys if k in blocks).strip()
        # 砍掉正文开头那行原小节标题：策展标题已经说了同一件事，留着会让
        # split_into_sections 把 "# 策展标题" 单独切成一个 30-40 字的裸标题块，
        # 而检索端的 MIN_CHUNK_CHARS=80 长度门又会把它滤掉——白占索引。
        body = re.sub(r"\A#{2,3}\s+[^\n]*\n+", "", body)
        docs.append({
            "source_id": f"tu{no:02d}",
            "rel": rel,
            "title": title,
            "difficulty": difficulty,
            "body": body,
            "missing": missing,
            "url": f"{REPO_URL}/blob/main/content/{rel}",
        })
    return docs


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--dry"]
    dry = "--dry" in sys.argv[1:]
    repo = Path(args[0]) if args else DEFAULT_REPO
    if not (repo / "content").exists():
        print(f"tiny-universe 未找到：{repo}")
        sys.exit(1)

    if not dry:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        for old in OUTPUT_DIR.glob("*.md"):
            old.unlink()

    written = 0
    total_chunks = 0
    by_difficulty: dict[str, int] = {}
    bad = False
    for doc in build_docs(repo):
        if doc["missing"]:
            print(f"  !! {doc['rel']}: 小节标题对不上 {doc['missing']}（上游改标题了）")
            bad = True
        if len(doc["body"]) < MIN_DOC_CHARS:
            print(f"  !! {doc['source_id']} {doc['rel']}: 清洗后仅 {len(doc['body'])} 字，低于 {MIN_DOC_CHARS}，不入库")
            bad = True
            continue
        residue = check_residue(doc["body"])
        if residue:
            print(f"  !! {doc['source_id']}: 剥壳残留 {residue}")
            bad = True

        page = f"# {doc['title']}\n\n{doc['body']}"
        chunks = split_into_sections(page)  # 与 build_knowledge_base 同一把刀，统计=真口径
        total_chunks += len(chunks)
        by_difficulty[doc["difficulty"]] = by_difficulty.get(doc["difficulty"], 0) + len(chunks)

        if dry:
            sizes = ", ".join(str(len(c)) for c in chunks)
            head = chunks[0][:70].replace("\n", " ")
            tail = chunks[-1][-70:].replace("\n", " ")
            print(f"  {doc['source_id']} {doc['rel']} ({doc['difficulty']}) {doc['title']}")
            print(f"      {len(doc['body'])} 字 -> {len(chunks)} 块 [{sizes}]")
            print(f"      首块: {head}...")
            print(f"      尾块: ...{tail}")
            continue

        front = "\n".join([
            "---",
            f"source_id: {doc['source_id']}",
            f"title: {doc['title']}",
            f"topic: {TOPIC}",
            f"difficulty: {doc['difficulty']}",
            f"concept_tags: {', '.join(TAGS)}",
            f"url: {doc['url']}",
            f"license: {LICENSE_NOTE}",
            "grade: B",
            "---",
            "",
        ])
        (OUTPUT_DIR / f"{doc['source_id']}.md").write_text(front + page + "\n", encoding="utf-8")
        written += 1

    dist = ", ".join(f"{k}={v}" for k, v in sorted(by_difficulty.items()))
    if dry:
        print(f"\n[dry] {len(CURATED)} 篇 -> 预计 {total_chunks} chunks；难度分布 {dist}；未写任何文件")
    else:
        print(f"\nwritten {written} 篇 / {total_chunks} chunks -> {OUTPUT_DIR}")
        print(f"难度分布 {dist}")
        print("next: python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py")
    if bad:
        sys.exit(1)


if __name__ == "__main__":
    main()
