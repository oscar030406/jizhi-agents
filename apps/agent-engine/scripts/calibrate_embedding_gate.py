"""标定向量检索充分性门（EMB_MIN_SCORE）。

与 calibrate_retrieval_gate.py（TF-IDF 版）同法：命中/未命中两组查询各测 top1
余弦，阈值取两簇之间。量纲随嵌入模型走，换模型必须重跑本脚本。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.embedding_retriever import _embed_query, load_embedding_matrix  # noqa: E402
from backend.rag.retriever import DEFAULT_INDEX_PATH, load_index  # noqa: E402

HIT_QUERIES = [
    "注意力机制 为什么要除以 sqrt(d_k)",
    "RAG 检索增强生成 文本分块",
    "Agent 工具调用与函数参数设计",
    "LoRA 参数高效微调",
]
MISS_QUERIES = [
    "厨房烘焙酵母发面技巧",
    "拖拉机变速箱维修",
    "宋代瓷器烧制工艺",
    "马拉松训练配速表",
]


def main() -> None:
    loaded = load_embedding_matrix(DEFAULT_INDEX_PATH.parent / "knowledge_embeddings.npz")
    if loaded is None:
        raise SystemExit("先跑 build_embedding_index.py")
    matrix, _ = loaded
    chunks = load_index()

    def top1(q: str) -> tuple[float, str]:
        v = _embed_query(q)
        if v is None:
            raise SystemExit("查询嵌入失败（key/网络）")
        cos = matrix @ v
        i = int(cos.argmax())
        return float(cos[i]), chunks[i].title

    print("命中组：")
    hit_scores = []
    for q in HIT_QUERIES:
        s, t = top1(q)
        hit_scores.append(s)
        print(f"  {s:.3f}  {q}  → {t}")
    print("未命中组：")
    miss_scores = []
    for q in MISS_QUERIES:
        s, t = top1(q)
        miss_scores.append(s)
        print(f"  {s:.3f}  {q}  → {t}")
    lo, hi = max(miss_scores), min(hit_scores)
    print(f"\n未命中最高 {lo:.3f} | 命中最低 {hi:.3f}")
    if lo < hi:
        print(f"建议 EMB_MIN_SCORE 取中点 ≈ {(lo + hi) / 2:.2f}")
    else:
        print("两簇重叠——纯阈值门不可行，需要改判据（如 margin 或 rerank）")


if __name__ == "__main__":
    main()
