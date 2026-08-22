"""向量索引构建（KR1 知识库现代化）。

把 knowledge_index.jsonl 的全部块经 BAAI/bge-m3 嵌入，落
`knowledge_embeddings.npz`（float32 矩阵 + source_id 顺序 + 模型名）。
运行时 EmbeddingKnowledgeRetriever 载入矩阵，只对查询做单次嵌入调用；
API 失败自动降级 TF-IDF（诚实降级链与四桥同款）。

成本：745 块 ≈ 0.4M tokens，bge-m3 一次性 ≈ ¥0.3。重建时机：语料变更后。
用法（剥代理 + SILICONFLOW_API_KEY）：
  python scripts/build_embedding_index.py            # 默认语料
  python scripts/build_embedding_index.py --corpus manufacturing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.retriever import (  # noqa: E402
    CORPORA_DIR,
    DEFAULT_INDEX_PATH,
    load_index,
)

MODEL = "BAAI/bge-m3"
ENDPOINT = "https://api.siliconflow.cn/v1/embeddings"
BATCH = 32


def embed_batch(texts: list[str], key: str) -> np.ndarray:
    for attempt in range(4):
        resp = requests.post(
            ENDPOINT,
            headers={"Authorization": f"Bearer {key}"},
            json={"model": MODEL, "input": texts},
            timeout=60,
        )
        if resp.status_code == 200:
            data = resp.json()["data"]
            data.sort(key=lambda d: d["index"])
            return np.array([d["embedding"] for d in data], dtype=np.float32)
        if resp.status_code in (429, 500, 502, 503):
            time.sleep(5 * (attempt + 1))
            continue
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
    raise RuntimeError("重试耗尽")


def document_text(chunk) -> str:
    tags = " ".join(chunk.concept_tags)
    return f"{chunk.title} {chunk.topic} {tags} {chunk.content}"[:6000]


def build_corpus_index(corpus: str = "default") -> tuple[Path, int, int]:
    """建一个语料的向量索引，返回（产物路径, 行数, 维度）。

    从 main() 里抽出来的，行为一字未改——领域接入流水线要 import 它跑
    （shell 出去就拿不到分步事件）。CLI 仍然只是它的一层壳。
    """
    key = os.environ.get("SILICONFLOW_API_KEY", "")
    if not key:
        raise SystemExit("缺 SILICONFLOW_API_KEY")

    if corpus in {"default", "ai", ""}:
        index_path, out_dir = DEFAULT_INDEX_PATH, DEFAULT_INDEX_PATH.parent
    else:
        root = CORPORA_DIR / corpus
        index_path, out_dir = root / "knowledge_index.jsonl", root

    chunks = load_index(index_path, out_dir / "docs")
    print(f"语料 {corpus}：{len(chunks)} 块，模型 {MODEL}")

    vectors: list[np.ndarray] = []
    for i in range(0, len(chunks), BATCH):
        batch = chunks[i : i + BATCH]
        vectors.append(embed_batch([document_text(c) for c in batch], key))
        print(f"  {min(i + BATCH, len(chunks))}/{len(chunks)}")
    matrix = np.vstack(vectors)
    # 归一化后点积=余弦，检索端省一步
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True).clip(min=1e-9)

    out = out_dir / "knowledge_embeddings.npz"
    np.savez_compressed(
        out,
        matrix=matrix,
        source_ids=np.array([c.source_id for c in chunks]),
        model=np.array(MODEL),
    )
    print(f"→ {out}（{matrix.shape[0]}×{matrix.shape[1]}，{out.stat().st_size / 1e6:.1f}MB）")
    return out, int(matrix.shape[0]), int(matrix.shape[1])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="default")
    args = ap.parse_args()
    build_corpus_index(args.corpus)


if __name__ == "__main__":
    main()
