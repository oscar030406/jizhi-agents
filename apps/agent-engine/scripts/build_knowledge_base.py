from __future__ import annotations

import csv
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.ingest import load_markdown_chunks, parse_front_matter, write_index

KB_DIR = ROOT / "data" / "knowledge_base"
HELLO_DIR = KB_DIR / "hello_agents_docs"
HAPPY_DIR = KB_DIR / "happy_llm_docs"
AGENTGUIDE_DIR = KB_DIR / "agentguide_docs"
D2L_DIR = KB_DIR / "d2l_docs"  # 第二领域迁移切片（deep_learning，Apache-2.0）
EMBODIED_DIR = KB_DIR / "embodied_docs"  # 领域泛化新域（具身智能，CC BY-NC-SA，2026-08-10）
PROMPT_GUIDE_DIR = KB_DIR / "prompt_guide_docs"  # 提示工程课语料（DAIR.AI PEG 中文版，MIT，2026-08-10）
LLM_DEPLOY_DIR = KB_DIR / "llm_deploy_docs"  # 推理部署/压缩语料，给入门主题补 L3（llm-deploy，CC BY-NC-SA，2026-08-10）
TINY_UNIVERSE_DIR = KB_DIR / "tiny_universe_docs"  # RAG 整链白盒实现（tiny-universe，CC BY-NC-SA，2026-08-10）
SELF_LLM_DIR = KB_DIR / "self_llm_docs"  # MoE 架构解析 + 端侧部署实操（self-llm，Apache-2.0，2026-08-10）
SAMPLE_DIR = KB_DIR / "sample_docs"

SUPPLEMENT_CONCEPTS = {"guardrails"}  # hello-agents 未覆盖的概念，从 AgentGuide 补


def _manifest_rows(doc_dir: Path, only_concepts: set[str] | None = None) -> list[dict]:
    rows = []
    for path in sorted(doc_dir.glob("*.md")):
        metadata, _ = parse_front_matter(path.read_text(encoding="utf-8"))
        if only_concepts is not None:
            tags = {t.strip() for t in metadata.get("concept_tags", "").split(",")}
            if not tags & only_concepts:
                continue
        rows.append(
            {
                "source_id": metadata.get("source_id", path.stem),
                "title": metadata.get("title", path.stem),
                "url": metadata.get("url", ""),
                "license": metadata.get("license", "sample generated for competition prototype"),
                "grade": metadata.get("grade", ""),
                "note": metadata.get("note", ""),
            }
        )
    return rows


def main() -> None:
    # 主库优先 hello-agents（B 级，CC-BY-NC-SA）；guardrails 概念用 AgentGuide 安全文档补（C 级）。
    # 都没有时退回 AgentGuide / 自造样例，保证测试可跑。
    output = KB_DIR / "knowledge_index.jsonl"
    chunks = []
    manifest_rows: list[dict] = []
    sources = []

    if any(HELLO_DIR.glob("*.md")):
        chunks += load_markdown_chunks(HELLO_DIR)
        manifest_rows += _manifest_rows(HELLO_DIR)
        sources.append("hello_agents_docs(primary,B)")
        if any(HAPPY_DIR.glob("*.md")):
            happy = load_markdown_chunks(HAPPY_DIR)
            chunks += happy
            manifest_rows += _manifest_rows(HAPPY_DIR)
            sources.append(f"happy_llm_docs(llm_basics,B)={len(happy)}chunks")
        if any(AGENTGUIDE_DIR.glob("*.md")):
            supp = [c for c in load_markdown_chunks(AGENTGUIDE_DIR) if SUPPLEMENT_CONCEPTS & set(c.concept_tags)]
            chunks += supp
            manifest_rows += _manifest_rows(AGENTGUIDE_DIR, only_concepts=SUPPLEMENT_CONCEPTS)
            sources.append(f"agentguide guardrails supplement(C)={len(supp)}chunks")
        if any(D2L_DIR.glob("*.md")):
            d2l = load_markdown_chunks(D2L_DIR)
            chunks += d2l
            manifest_rows += _manifest_rows(D2L_DIR)
            sources.append(f"d2l_docs(deep_learning,B)={len(d2l)}chunks")
        if any(EMBODIED_DIR.glob("*.md")):
            emb = load_markdown_chunks(EMBODIED_DIR)
            chunks += emb
            manifest_rows += _manifest_rows(EMBODIED_DIR)
            sources.append(f"embodied_docs(embodied_*,B)={len(emb)}chunks")
        if any(PROMPT_GUIDE_DIR.glob("*.md")):
            pg = load_markdown_chunks(PROMPT_GUIDE_DIR)
            chunks += pg
            manifest_rows += _manifest_rows(PROMPT_GUIDE_DIR)
            sources.append(f"prompt_guide_docs(prompt_engineering,B)={len(pg)}chunks")
        if any(LLM_DEPLOY_DIR.glob("*.md")):
            ld = load_markdown_chunks(LLM_DEPLOY_DIR)
            chunks += ld
            manifest_rows += _manifest_rows(LLM_DEPLOY_DIR)
            sources.append(f"llm_deploy_docs(deployment,B)={len(ld)}chunks")
        if any(TINY_UNIVERSE_DIR.glob("*.md")):
            tu = load_markdown_chunks(TINY_UNIVERSE_DIR)
            chunks += tu
            manifest_rows += _manifest_rows(TINY_UNIVERSE_DIR)
            sources.append(f"tiny_universe_docs(rag,B)={len(tu)}chunks")
        if any(SELF_LLM_DIR.glob("*.md")):
            sl = load_markdown_chunks(SELF_LLM_DIR)
            chunks += sl
            manifest_rows += _manifest_rows(SELF_LLM_DIR)
            sources.append(f"self_llm_docs(llm_basics+deployment,B)={len(sl)}chunks")
    elif any(AGENTGUIDE_DIR.glob("*.md")):
        chunks += load_markdown_chunks(AGENTGUIDE_DIR)
        manifest_rows += _manifest_rows(AGENTGUIDE_DIR)
        sources.append("agentguide_docs")
    else:
        chunks += load_markdown_chunks(SAMPLE_DIR)
        manifest_rows += _manifest_rows(SAMPLE_DIR)
        sources.append("sample_docs")

    write_index(chunks, output)
    with (KB_DIR / "sources_manifest.csv").open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["source_id", "title", "url", "license", "grade", "note"])
        writer.writeheader()
        writer.writerows(manifest_rows)

    print(f"corpus: {' + '.join(sources)}")
    print(f"indexed {len(chunks)} chunks -> {output}")
    concept_counts: dict[str, int] = {}
    difficulty_counts: dict[str, int] = {}
    for chunk in chunks:
        difficulty_counts[chunk.difficulty] = difficulty_counts.get(chunk.difficulty, 0) + 1
        for tag in chunk.concept_tags:
            concept_counts[tag] = concept_counts.get(tag, 0) + 1
    for tag in sorted(concept_counts):
        print(f"  {tag}: {concept_counts[tag]} chunks")
    print("  difficulty: " + ", ".join(f"{k}={v}" for k, v in sorted(difficulty_counts.items())))


if __name__ == "__main__":
    main()
