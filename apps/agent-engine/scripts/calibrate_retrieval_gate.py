"""标定检索充分性门的三个阈值，用真实语料和真实查询，不拍脑袋。

背景：retriever 原来无条件返回 top_k，低分块照样当「事实边界」喂进生成。
加门之后阈值定多少，得看真实分布——定高了把有用证据也挡掉，定低了等于没加。

跑法：
    python scripts/calibrate_retrieval_gate.py
    python scripts/calibrate_retrieval_gate.py --corpus llm_basics
"""

import argparse
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.rag import retriever as R  # noqa: E402

# 真实查询：取自我们实际跑过的场景标题，覆盖命中/半命中/未命中三种情况
QUERIES = [
    ("命中", "什么是注意力机制 自注意力 Q K V"),
    ("命中", "RAG 检索增强生成 向量检索"),
    ("命中", "Transformer 架构 多头注意力"),
    ("半命中", "注意力权重的含义与阈值判断"),
    ("半命中", "Agent 工具调用与函数参数设计"),
    ("未命中", "石油管道三维形变监测"),
    ("未命中", "宋代瓷器烧制工艺"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="")
    ap.add_argument("--top-k", type=int, default=6)
    args = ap.parse_args()

    chunks = R.load_index()
    if not chunks:
        print("知识库为空，先跑 ingest 脚本")
        return 1
    ret = R.TfidfKnowledgeRetriever(chunks)
    print(f"语料块数：{len(chunks)}\n")

    all_scores, all_lens = [], []
    print(f"{'类别':<8}{'查询':<34}{'top1':>8}{'top6均值':>10}{'正文<80字块数':>14}")
    print("-" * 76)

    for kind, q in QUERIES:
        # 绕开门本身，直接看原始排序分布
        qv = ret._vectorize(R.normalize_query_terms([q]))
        from sklearn.metrics.pairwise import cosine_similarity

        scores = cosine_similarity(qv, ret.matrix)[0]
        ranked = sorted(zip(scores, ret.chunks), key=lambda x: x[0], reverse=True)[: args.top_k]
        top = [float(s) for s, _ in ranked]
        short = sum(1 for _, c in ranked if len(R._strip_heading_marks(c.content)) < 80)
        all_scores.extend(top)
        all_lens.extend(len(R._strip_heading_marks(c.content)) for _, c in ranked)
        print(f"{kind:<8}{q[:32]:<34}{top[0]:>8.4f}{statistics.mean(top):>10.4f}{short:>14}")

    print("\n分数分布（全部 top-k 命中）：")
    all_scores.sort()
    for p in (10, 25, 50, 75, 90):
        idx = int(len(all_scores) * p / 100)
        print(f"  P{p:<3} = {all_scores[min(idx, len(all_scores)-1)]:.4f}")

    print("\n正文长度分布：")
    all_lens.sort()
    for p in (10, 25, 50, 75, 90):
        idx = int(len(all_lens) * p / 100)
        print(f"  P{p:<3} = {all_lens[min(idx, len(all_lens)-1)]} 字")

    print(f"\n当前阈值：MIN_SCORE={R.MIN_SCORE}  MIN_CHUNK_CHARS={R.MIN_CHUNK_CHARS}  MIN_CHUNKS={R.MIN_CHUNKS}")
    print("\n带门实跑，看每条查询过门后还剩几块：")
    print(f"{'类别':<8}{'查询':<34}{'过门块数':>10}{'警告':>6}")
    print("-" * 62)
    for kind, q in QUERIES:
        res = ret.search(q, top_k=args.top_k)
        n = len(res.retrieved_chunks)
        flag = "有" if res.missing_evidence_warning else "—"
        print(f"{kind:<8}{q[:32]:<34}{n:>10}{flag:>6}")

    print("\n判读：未命中的查询应当过门块数很少且带警告；命中的应当留下 ≥MIN_CHUNKS 块且无警告。")
    print("若命中查询也被判为证据不足，说明 MIN_SCORE 定高了。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
