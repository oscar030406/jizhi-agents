"""把 Datawhale《LLM-Deploy》的压缩与显存章节策展入知识库——给入门主题补 L3 素材。

为什么是它（2026-08-10，docs/03-design/kb-expansion-plan-20260810.md 批 1）：
适配率探针里 advanced→被判 transition 的 5 例（attention/gradient/rag/softmax），
病根是入门主题只有 L1/L2 语料，advanced 档学习者拿不到够硬的摘录。llm-deploy
的量化/蒸馏/剪枝/内存四章是数学推导 + 生产代码 + 工程取舍的成型教材，正好补这一档；
其中第 10 章（KV-Cache / PagedAttention / FlashAttention）直接落在 attention 主题上。
许可 CC BY-NC-SA 4.0，与库内 hello-agents / happy-llm 同社区同许可。

难度标注口径（本次入库的价值全在这一列，标错等于白做）：
库内没有自动启发式，difficulty 是各 ingest 脚本按章节人工定的常量（hl/em/pg 皆然），
L4 在本库特指综合实战/毕业设计（ha13/ha16），不是"最难的理论"——所以本次最高只到 L3。
分档规则：概述/前置知识/思想介绍 = L2；含公式推导、论文级方法（GPTQ/SmoothQuant/
OBD/OBS/SparseGPT/DepGraph）、生产实现细节的 = L3。逐篇抽查过正文首尾，见 --dry 输出。

跳过的文件：chapter1_4（131B 占位）、chapter2_4 / chapter3_4（总结，内容与正文重叠，
沿用 happy-llm 脚本"跳过小结/总结"的口径）、chapter4-9（低秩分解/表示/加速/框架/
并行/并发，本批不在缺口清单上）。

用法：
  python scripts/ingest_llm_deploy.py --dry   # 只打印切分统计与残留检查，不落盘
  python scripts/ingest_llm_deploy.py         # 写 data/knowledge_base/llm_deploy_docs/
  然后 python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.ingest import split_into_sections

DEFAULT_REPO = ROOT.parent.parent / "references" / "llm-deploy"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "llm_deploy_docs"
REPO_URL = "https://github.com/datawhalechina/llm-deploy"
# 仓库没有 LICENSE 文件，许可写在 README 的 LICENSE 节（2026-08-10 磁盘核对，
# commit 55b79af）。署名照 CC BY-NC-SA 要求记到 manifest。
LICENSE_NOTE = "CC BY-NC-SA 4.0（署名-非商业-相同方式共享，见 README LICENSE 节，仓库无 LICENSE 文件）；作者 Datawhale llm-deploy；竞赛非商用需署名"

TOPIC = "deployment"  # 复用库内既有 topic（ha13/ha16/ag 同名），不新造概念面

# 人工策展：(章号, 相对 docs 的路径, 标题, 概念标签, 难度)。
CURATED = [
    (1, "chapter1/chapter1_0.md", "数值类型与精度格式（FP32/FP16/BF16）", ["deployment", "quantization"], "L2"),
    (1, "chapter1/chapter1_1.md", "为什么要量化：原理、量化参数与分类", ["deployment", "quantization"], "L2"),
    (1, "chapter1/chapter1_2.md", "训练后量化 PTQ：LLM.int8 / SmoothQuant / GPTQ", ["deployment", "quantization"], "L3"),
    (1, "chapter1/chapter1_3.md", "量化感知训练 QAT：LLM-QAT", ["deployment", "quantization"], "L3"),
    (2, "chapter2/chapter2_1.md", "知识蒸馏的思想", ["deployment", "distillation"], "L2"),
    (2, "chapter2/chapter2_2.md", "白盒蒸馏：MiniLLM 与逆向 KL 散度", ["deployment", "distillation"], "L3"),
    (2, "chapter2/chapter2_3.md", "黑盒蒸馏：上下文学习蒸馏与思维链蒸馏", ["deployment", "distillation"], "L3"),
    (3, "chapter3/chapter3_1.md", "剪枝概述：原理、分类与度量", ["deployment", "pruning"], "L2"),
    (3, "chapter3/chapter3_2.md", "非结构化剪枝：OBD / OBS / SparseGPT / Wanda", ["deployment", "pruning"], "L3"),
    (3, "chapter3/chapter3_2_1.md", "OBD 公式推导", ["deployment", "pruning"], "L3"),
    (3, "chapter3/chapter3_2_2.md", "OBS 公式推导", ["deployment", "pruning"], "L3"),
    (3, "chapter3/chapter3_3.md", "结构化剪枝：DepGraph 与 LLM-Pruner", ["deployment", "pruning"], "L3"),
    (10, "chapter10/chapter10_1.md", "KV-Cache：显存换时间与占用估算", ["deployment", "inference_memory"], "L3"),
    (10, "chapter10/chapter10_2.md", "PagedAttention：分页显存管理与写时复制", ["deployment", "inference_memory"], "L3"),
    (10, "chapter10/chapter10_3.md", "FlashAttention：分块计算与 HBM 访存优化", ["deployment", "inference_memory"], "L3"),
]

MIN_DOC_CHARS = 800  # 占位文件兜底（策展清单已排除，这里防上游改文件）
# 剥壳后不许再出现的东西（都是本脚本自己负责清掉的；语料里的 <Reasoning>、
# <start> 这类提示词模板标记是正文本体，不算残留，不检查也不清）
RESIDUE = [
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), "图片引用"),
    (re.compile(r"</?span\b", re.I), "span 标签"),
    (re.compile(r"<!--"), "HTML 注释"),
    (re.compile(r"&emsp;|&nbsp;|&thinsp;"), "HTML 空白实体"),
    (re.compile(r"^#+\s*参考(文献|链接|文章|资料)", re.M), "参考链接节"),
]


REFS_TAIL = re.compile(r"\n#*\s*参考(文献|链接|文章|资料)[：:]?[ \t]*\n.*\Z", re.DOTALL)


def clean_body(text: str) -> str:
    # chapter1_0 开头是章节写作计划（"整体暂定三～四个章节"+待办式小节），
    # 正文从第一条水平线之后才开始；这段计划入库只会污染检索。
    text = re.sub(r"\A#\s*\d+\..*?章节说明.*?\n---\n", "", text, flags=re.DOTALL)
    # ch1 各节开头残留同一份写作计划句（"…-方式：原理讲解+代码，"），不是正文
    text = re.sub(r"^.*原理讲解\+.*?代码[，。]?[ \t]*$\n?", "", text, flags=re.M)
    # 尾部参考文献/参考链接：链接堆，不是可引用的证据。带标题和裸行两种写法都有。
    # 砍掉超过四分之一正文说明匹配到的不是文末那处，宁可不砍也不能吞正文。
    cut = REFS_TAIL.sub("\n", text)
    text = cut if len(cut) >= 0.75 * len(text) else text
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"</?span[^>]*>", "", text, flags=re.I)
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"&emsp;|&nbsp;|&thinsp;", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 空标题（下一行还是标题）：切块时会独占一小块，检索端按裸标题过滤掉，白占索引
    text = re.sub(r"^#+[^\n]*\n\n?(?=#)", "", text, flags=re.M)
    return text.strip()


def check_residue(body: str) -> list[str]:
    return [name for pat, name in RESIDUE if pat.search(body)]


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--dry"]
    dry = "--dry" in sys.argv[1:]
    repo = Path(args[0]) if args else DEFAULT_REPO
    docs = repo / "docs"
    if not docs.exists():
        print(f"llm-deploy 未找到：{repo}")
        sys.exit(1)

    if not dry:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        for old in OUTPUT_DIR.glob("*.md"):
            old.unlink()

    written = 0
    total_chunks = 0
    by_difficulty: dict[str, int] = {}
    bad = False
    seq: dict[int, int] = {}
    for chno, rel, title, tags, difficulty in CURATED:
        src = docs / rel
        if not src.exists():
            print(f"  跳过(缺失): {rel}")
            bad = True
            continue
        body = clean_body(src.read_text(encoding="utf-8"))
        if len(body) < MIN_DOC_CHARS:
            print(f"  !! {rel}: 清洗后仅 {len(body)} 字，低于 {MIN_DOC_CHARS}，不入库")
            bad = True
            continue
        residue = check_residue(body)
        if residue:
            print(f"  !! {rel}: 剥壳残留 {residue}")
            bad = True

        seq[chno] = seq.get(chno, 0) + 1
        source_id = f"ld{chno:02d}s{seq[chno]:02d}"
        full_title = f"LLM-Deploy 第{chno}章 {title}"
        # 与 build_knowledge_base 同一把刀切同一段文本（含落盘时补的 H1），统计=真口径
        chunks = split_into_sections(f"# {full_title}\n\n{body}")
        total_chunks += len(chunks)
        by_difficulty[difficulty] = by_difficulty.get(difficulty, 0) + len(chunks)

        if dry:
            sizes = ", ".join(str(len(c)) for c in chunks)
            head = chunks[0][:70].replace("\n", " ")
            tail = chunks[-1][-70:].replace("\n", " ")
            print(f"  {source_id} {rel} ({difficulty}) {full_title}")
            print(f"      {len(body)} 字 -> {len(chunks)} 块 [{sizes}]")
            print(f"      首块: {head}...")
            print(f"      尾块: ...{tail}")
            continue

        url = f"{REPO_URL}/blob/main/docs/{rel}"
        front = "\n".join([
            "---",
            f"source_id: {source_id}",
            f"title: {full_title}",
            f"topic: {TOPIC}",
            f"difficulty: {difficulty}",
            f"concept_tags: {', '.join(tags)}",
            f"url: {url}",
            f"license: {LICENSE_NOTE}",
            "grade: B",
            "---",
            "",
        ])
        (OUTPUT_DIR / f"{source_id}.md").write_text(
            front + f"# {full_title}\n\n{body}\n", encoding="utf-8")
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
