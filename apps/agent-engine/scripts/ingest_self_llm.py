"""把 Datawhale《self-llm》的 MoE 架构解析与端侧部署教程策展入知识库。

为什么是它（2026-08-10，docs/03-design/kb-expansion-plan-20260810.md 批 3）：
算法岗"MoE 混合专家架构"实测 0.062、部署岗"边云端部署方案"0.000，两条都缺
中文成型语料。self-llm 是 100+ 模型的部署/微调实操库，其中少数几篇是真正的
架构解析 Blog（混元 A13B / Qwen3 / XVERSE-MoE 讲共享专家与 Top-k 路由），
端侧那半边有 GGUF+Ollama、llama.cpp、MLX 三条实操线。许可 Apache-2.0
（LICENSE 文件真实存在，2026-08-10 磁盘核对 commit baf3b69）。

**严禁全量入库**：仓库 280+ 篇 md 里绝大多数是"换个模型名的同一套部署命令"，
全量进来只会让部署主题的 IDF 塌掉（实测机制见下），本脚本只收 9 篇。

难度标注口径（同 ingest_llm_deploy.py）：人工常量，L4 特指综合实战/毕业设计，
本次最高 L3。分档：讲清 MoE 路由机制与架构取舍的解析 Blog = L3；
照着敲就能跑通的部署实操 = L2。

本仓特有的清洗：Obsidian 风格的首行标签（`#llm #ollama #LoRA部署`）、
`[[双链]]`、标题与要点里的装饰 emoji（🚀🎯✅🌟🔗）——都是写作工具留下的壳，
不是正文。

⚠ 入库前必读（2026-08-10 实测，别再重复踩）：本批对 /skills 徽标是**净负**。
覆盖判定走 TF-IDF（skill_map 用 top_k=1，恒小于 MIN_CHUNKS=2，向量检索器
必然回落 TF-IDF），而 TF-IDF 分数随同主题语料增多而**下降**：部署岗有三条
技能贴着 0.12 的线（ONNX/TensorRT 0.116、模型量化 0.134、StreamingLLM 0.135），
新增部署语料会把它们往下压，而新块自己够不到 0.12。要不要入库应按"课程生成
是否需要这些素材"来决定，别按徽标来决定。

用法：
  python scripts/ingest_self_llm.py --dry   # 只打印切分统计与残留检查，不落盘
  python scripts/ingest_self_llm.py         # 写 data/knowledge_base/self_llm_docs/
  然后 python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.ingest import split_into_sections

DEFAULT_REPO = ROOT.parent.parent / "references" / "self-llm"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "self_llm_docs"
REPO_URL = "https://github.com/datawhalechina/self-llm"
LICENSE_NOTE = "Apache-2.0（LICENSE 文件，2026-08-10 磁盘核对）；作者 Datawhale self-llm"

# 人工策展：(相对仓库根的路径, 标题, topic, 难度)。
CURATED = [
    (
        "models/Hunyuan-A13B-Instruct/01-Hunyuan-A13B-Instruct 模型架构解析 Blog.md",
        "self-LLM 混元 A13B 架构解析：MoE 混合专家、共享专家与 Top-k 路由",
        "llm_basics", "L3",
    ),
    (
        "models/Qwen3/01-Qwen3-模型结构解析-Blog.md",
        "self-LLM Qwen3 模型结构解析：MoE 层、GQA 与 RoPE",
        "llm_basics", "L3",
    ),
    (
        "models/XVERSE/06-XVERSE-MoE-A4.2B.md",
        "self-LLM XVERSE-MoE-A4.2B：稀疏激活专家模型的部署调用",
        "llm_basics", "L2",
    ),
    (
        "models/Qwen1.5/06-Qwen1.5-MoE-A2.7B.md",
        "self-LLM Qwen1.5-MoE-A2.7B：混合专家模型的加载与推理",
        "llm_basics", "L2",
    ),
    (
        "models/Llama3_1/动手转换GGUF模型并使用Ollama本地部署.md",
        "self-LLM 端侧部署：转换 GGUF 模型并用 Ollama 本地部署",
        "deployment", "L2",
    ),
    (
        "models_mlx/docs/MLX-LM_Intro.md",
        "self-LLM MLX-LM 入门：Apple Silicon 端侧推理与统一内存",
        "deployment", "L2",
    ),
    (
        "models_amd/gemma4/6-llamacpp-rocm7-deploy.md",
        "self-LLM llama.cpp 本地部署：ROCm 环境下的量化模型推理",
        "deployment", "L2",
    ),
    (
        "models_amd/qwen3.5/4-ollama-rocm7-deploy.md",
        "self-LLM Ollama 本地部署：ROCm 环境下的模型服务化",
        "deployment", "L2",
    ),
    (
        "models/Gemma3/03-gemma-3-4b-it-ollama + open-webui部署.md",
        "self-LLM Ollama + Open WebUI：端侧模型的对话界面部署",
        "deployment", "L2",
    ),
]

MIN_DOC_CHARS = 800
REFS_TAIL = re.compile(r"\n#*\s*参考(文献|链接|文章|资料)[：:]?[ \t]*\n.*\Z", re.DOTALL)
# 装饰性 emoji（本仓标题里成片出现）。技术符号不在此列。
EMOJI = re.compile(
    "[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF️✅❌]"
)

RESIDUE = [
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), "图片引用"),
    (re.compile(r"\[\["), "Obsidian 双链"),
    (EMOJI, "装饰 emoji"),
    (re.compile(r"<!--"), "HTML 注释"),
    (re.compile(r"^#[a-zA-Z一-龥]+\s+#", re.M), "Obsidian 标签行"),
]


def clean_body(text: str) -> str:
    # Obsidian 首行标签（`#llm #ollama #LoRA部署`）：写作工具的壳，不是标题也不是正文。
    # 先 lstrip——有的文件以空行开头，\A 会对不上（实测 Llama3_1 那篇）。
    text = text.lstrip()
    text = re.sub(r"\A(?:#[^\s#]+[ \t]+)+#[^\s#]+[ \t]*\n", "", text)
    text = re.sub(r"^#\s+.*\n", "", text, count=1)  # 原 H1，标题以策展清单为准
    # 尾部参考链接堆：不是可引用的证据。砍掉超过四分之一正文就判定匹配错位，宁可不砍。
    cut = REFS_TAIL.sub("\n", text)
    text = cut if len(cut) >= 0.75 * len(text) else text
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[\[([^\]|]*\|)?([^\]]+)\]\]", r"\2", text)  # [[04-xxx|别名]] → 别名
    text = EMOJI.sub("", text)
    text = re.sub(r"&emsp;|&nbsp;|&thinsp;", "", text)
    text = re.sub(r"^#+\s*$", "", text, flags=re.M)  # emoji 剥完只剩井号的空标题
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"^#{2,3}\s+[^\n]*\n+", "", text, count=1)  # 见 tiny-universe：避免裸标题块
    return text.strip()


def check_residue(body: str) -> list[str]:
    return [name for pat, name in RESIDUE if pat.search(body)]


def build_docs(repo: Path) -> list[dict]:
    """策展清单 → 待入库文档。dry / 落盘 / 覆盖率模拟三处共用这一份真源。"""
    docs = []
    for no, (rel, title, topic, difficulty) in enumerate(CURATED, 1):
        src = repo / rel
        body = clean_body(src.read_text(encoding="utf-8")) if src.exists() else ""
        docs.append({
            "source_id": f"sl{no:02d}",
            "rel": rel,
            "title": title,
            "topic": topic,
            "tags": [topic],
            "difficulty": difficulty,
            "body": body,
            "missing": [] if src.exists() else [rel],
            "url": f"{REPO_URL}/blob/master/{rel}",
        })
    return docs


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--dry"]
    dry = "--dry" in sys.argv[1:]
    repo = Path(args[0]) if args else DEFAULT_REPO
    if not (repo / "LICENSE").exists():
        print(f"self-llm 未找到：{repo}")
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
            print(f"  跳过(缺失): {doc['rel']}")
            bad = True
            continue
        if len(doc["body"]) < MIN_DOC_CHARS:
            print(f"  !! {doc['source_id']}: 清洗后仅 {len(doc['body'])} 字，低于 {MIN_DOC_CHARS}，不入库")
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
            print(f"  {doc['source_id']} ({doc['difficulty']}/{doc['topic']}) {doc['title']}")
            print(f"      {doc['rel']}")
            print(f"      {len(doc['body'])} 字 -> {len(chunks)} 块 [{sizes}]")
            print(f"      首块: {head}...")
            print(f"      尾块: ...{tail}")
            continue

        front = "\n".join([
            "---",
            f"source_id: {doc['source_id']}",
            f"title: {doc['title']}",
            f"topic: {doc['topic']}",
            f"difficulty: {doc['difficulty']}",
            f"concept_tags: {', '.join(doc['tags'])}",
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
