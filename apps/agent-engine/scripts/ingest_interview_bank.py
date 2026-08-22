# -*- coding: utf-8 -*-
"""面试题库入库：《LLMs 大模型面试问题和答案（97）》PDF → data/quiz/interview_bank.jsonl。

用途：结业理论卷的出题参照（求职级 L3 口径来源）——理论卷 MCQ 由管线基于题库
问答受控生成 + judge 复核，不直接照搬原文。登记于教材登记表（出题参照类）。

用法：python scripts\\ingest_interview_bank.py
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 书库在项目根的 data/textbooks/（本项目专属语料，不外置）。
# 换机器或另放时用环境变量 TZB_TEXTBOOKS_DIR 覆盖。
import os

TEXTBOOKS = Path(
    os.environ.get("TZB_TEXTBOOKS_DIR")
    or Path(__file__).resolve().parents[3] / "data" / "textbooks"
)
PDF = (
    TEXTBOOKS / "大模型入门与进阶" / "04-LLM基础与概念"
    / "LLMs大模型面试问题和答案（97）.pdf"
)
OUT = ROOT / "data" / "quiz" / "interview_bank.jsonl"

# 主题 → 概念标签（llm_basics 相关主题先入；langchain/RAG/agent 面留给对应模块）
TOPIC_CONCEPT = [
    ("基础面", "llm_basics"),
    ("进阶面", "llm_basics"),
    ("微调", "llm_basics"),
    ("预训练", "llm_basics"),
    ("推理面", "llm_basics"),
    ("强化学习面", "llm_basics"),
    ("Tokenizer", "llm_basics"),
    ("位置编码", "llm_basics"),
    ("Layer normalization", "llm_basics"),
    ("激活函数", "llm_basics"),
    ("Attention 升级", "llm_basics"),
    ("幻觉", "llm_basics"),
    ("评测面", "evaluation"),
    ("langchain", "rag"),
    ("向量库", "rag"),
    ("agent", "agent_basics"),
]

CHUNK_CHARS = 1600
MIN_CHUNK_CHARS = 300


def _concept_for(topic: str) -> str | None:
    for key, concept in TOPIC_CONCEPT:
        if key.lower() in topic.lower():
            return concept
    return None


def main() -> None:
    from pypdf import PdfReader

    if not PDF.is_file():
        sys.exit(f"题库 PDF 不存在：{PDF}")
    reader = PdfReader(str(PDF))
    text = "\n".join((p.extract_text() or "") for p in reader.pages)
    text = unicodedata.normalize("NFKC", text)  # 康熙部首字形 → 通用汉字

    lines = text.split("\n")
    # 按主题面聚合正文（问答精确配对在此类 PDF 上不可靠；出题语料只需主题级分块）
    records: list[dict] = []
    topic = ""
    buf: list[str] = []

    def flush_topic():
        nonlocal buf
        concept = _concept_for(topic)
        if concept and buf:
            body = "\n".join(buf)
            # 句界切块
            start = 0
            while start < len(body):
                end = min(start + CHUNK_CHARS, len(body))
                if end < len(body):
                    cut = max(body.rfind("。", start, end), body.rfind("\n", start, end))
                    if cut > start + MIN_CHUNK_CHARS:
                        end = cut + 1
                piece = body[start:end].strip()
                if len(piece) >= MIN_CHUNK_CHARS:
                    records.append(
                        {
                            "bank_id": f"iv{len(records) + 1:03d}",
                            "topic": topic,
                            "concept": concept,
                            "content": piece,
                        }
                    )
                start = end
        buf = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        if len(stripped) <= 40 and re.search(r"(面|篇|帖)\s*$", stripped):
            flush_topic()
            topic = stripped
            continue
        buf.append(stripped)
    flush_topic()

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    by_concept: dict[str, int] = {}
    for r in records:
        by_concept[r["concept"]] = by_concept.get(r["concept"], 0) + 1
    print(f"✅ {OUT}  共 {len(records)} 题  {by_concept}")


if __name__ == "__main__":
    main()
