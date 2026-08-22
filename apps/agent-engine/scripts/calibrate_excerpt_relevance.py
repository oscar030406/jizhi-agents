"""摘录咬合度量的真数据校准（默认零 API，纯只读）。

回答的唯一问题：**「摘录 ↔ 讲义前文」的哪一种机械相关性度量，能把判官眼里的
supports 和 unrelated 分开？** 分不开的度量直接淘汰，不许拍脑袋选信号。

数据源（只读）：
  data/eval/excerpt_relevance/verdicts-20260810-065004.jsonl   62 条
  data/eval/excerpt_relevance/verdicts-20260811-043314.jsonl   29 条
每条 = {context: 讲义前文尾 160 字, excerpt: 教材引文首 160 字, verdict: 三档}。
**运行期的过滤必须用同样的窗口**（前文取尾 160、摘录取首 160），否则这里标的阈值
到线上就换了量纲——adaptation lint 第一版就是栽在输入形态错配上。

统计口径沿用 scripts/calibrate_adaptation_lint.py：分离度 = |AUC-0.5|×2，
配 2000 次置换检验给噪声地板（unrelated 只有 7 条，点估计看着漂亮也可能是抽样噪声）。

用法：
  python scripts/calibrate_excerpt_relevance.py              # 零依赖 + TF-IDF 全表
  python scripts/calibrate_excerpt_relevance.py --embedding  # 追加 bge-m3 余弦（要 API key）
  python scripts/calibrate_excerpt_relevance.py --selftest   # 度量实现自检
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
EVAL = ROOT / "data/eval/excerpt_relevance"
RUNS = ["verdicts-20260810-065004.jsonl", "verdicts-20260811-043314.jsonl"]

VERDICTS = ["supports", "related", "unrelated"]

# 运行期窗口：与判官看到的一致（audit_excerpt_relevance.py 落盘时 context[-160:] / excerpt[:160]）
CTX_WINDOW = 160
EXC_WINDOW = 160

# ---------------------------------------------------------------- 零依赖度量
# 只留「字」：中日韩 + 拉丁字母数字。标点/空白/markdown 记号一律丢——
# 它们在任意两段中文里都重合，只加噪声不加区分度。
KEEP_RE = re.compile(r"[^一-鿿぀-ヿA-Za-z0-9]+")


def norm(text: str) -> str:
    return KEEP_RE.sub("", text.lower())


def grams(s: str, n: int) -> set[str]:
    return {s[i : i + n] for i in range(len(s) - n + 1)} if len(s) >= n else set()


def dice(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def containment(a: set[str], b: set[str]) -> float:
    """|A∩B| / min(|A|,|B|)——长度不对称时比 Dice 稳（前文 160 字 vs 摘录 160 字大致等长，
    但线上前文可能只有一句导语）。"""
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def lcs_len(a: str, b: str) -> int:
    """最长公共子串长度。共享「上下文腐蚀」（5 字）是强主题信号，
    共享「的时候」不是——bigram 计数分不出这个差别，最长串能。"""
    if not a or not b:
        return 0
    prev = [0] * (len(b) + 1)
    best = 0
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def zero_dep_metrics(ctx: str, exc: str) -> dict[str, float]:
    a, b = norm(ctx), norm(exc)
    out: dict[str, float] = {}
    for n in (2, 3, 4):
        ga, gb = grams(a, n), grams(b, n)
        out[f"g{n}_dice"] = dice(ga, gb)
        out[f"g{n}_cont"] = containment(ga, gb)
    out["lcs"] = float(lcs_len(a, b))
    # 共享 4-gram 的**个数**（不归一）：主题词共享是绝对量，短前文不该被摊薄
    out["g4_hits"] = float(len(grams(a, 4) & grams(b, 4)))
    return out


ZERO_DEP_KEYS = ["g2_dice", "g2_cont", "g3_dice", "g3_cont", "g4_dice", "g4_cont", "lcs", "g4_hits"]


# ---------------------------------------------------------------- TF-IDF 度量
def tfidf_scores(rows: list[dict]) -> list[float]:
    """引擎同款向量器（word 1-2gram + char_wb 2-4gram），IDF 在真语料上拟合。

    IDF 必须来自知识库而不是这 91 条——91 条里「注意力」很常见，
    在 1704 块的库里也常见，但拿 91 条拟合会把 IDF 拟合到评测集自身的分布上。
    """
    from scipy.sparse import hstack
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity

    from backend.rag.retriever import DEFAULT_INDEX_PATH, load_index

    corpus = [c.content for c in load_index(DEFAULT_INDEX_PATH)]
    word_vec = TfidfVectorizer(
        analyzer="word", ngram_range=(1, 2), token_pattern=r"(?u)\b[\w\-]+\b", lowercase=True
    )
    char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), lowercase=True)
    word_vec.fit(corpus)
    char_vec.fit(corpus)

    def vec(texts: list[str]):
        return hstack([word_vec.transform(texts), char_vec.transform(texts)]).tocsr()

    ctx = vec([r["context"] for r in rows])
    exc = vec([r["excerpt"] for r in rows])
    return [float(cosine_similarity(ctx[i], exc[i])[0][0]) for i in range(len(rows))]


# ---------------------------------------------------------------- 向量度量
def embedding_scores(rows: list[dict]) -> list[float] | None:
    """bge-m3 余弦。摘录侧走 npz 里已建好的块向量（按 sid 命中即用），
    前文侧现嵌入。硅基流动一律剥代理（trust_env=False）。"""
    import numpy as np
    import requests

    key = ""
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("SILICONFLOW_API_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        print("!! 无 SILICONFLOW_API_KEY，跳过向量度量")
        return None

    z = np.load(ROOT / "data/knowledge_base/knowledge_embeddings.npz", allow_pickle=True)
    by_sid = {sid: z["matrix"][i] for i, sid in enumerate(z["source_ids"])}

    s = requests.Session()
    s.trust_env = False

    def embed(texts: list[str]) -> list:
        out = []
        for i in range(0, len(texts), 16):
            batch = [t[:2000] for t in texts[i : i + 16]]
            r = s.post(
                "https://api.siliconflow.cn/v1/embeddings",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": "BAAI/bge-m3", "input": batch},
                timeout=60,
            )
            r.raise_for_status()
            for d in sorted(r.json()["data"], key=lambda d: d["index"]):
                v = np.array(d["embedding"], dtype=np.float32)
                out.append(v / (np.linalg.norm(v) or 1.0))
        return out

    ctx_vecs = embed([r["context"] for r in rows])
    # 摘录侧：npz 命中用库向量（线上就是这个），miss 的现嵌入（摘录被截到 160 字，
    # 与整块不等长，所以两条路都留着并在报告里标注命中率）
    miss = [i for i, r in enumerate(rows) if r["sid"] not in by_sid]
    fresh = embed([rows[i]["excerpt"] for i in miss]) if miss else []
    print(f"   npz 命中 {len(rows) - len(miss)}/{len(rows)}，现嵌 {len(miss)}")
    exc_vecs = []
    fi = 0
    for i, r in enumerate(rows):
        if r["sid"] in by_sid:
            v = by_sid[r["sid"]]
            exc_vecs.append(v / (np.linalg.norm(v) or 1.0))
        else:
            exc_vecs.append(fresh[fi])
            fi += 1
    return [float(np.dot(ctx_vecs[i], exc_vecs[i])) for i in range(len(rows))]


# ---------------------------------------------------------------- 统计
def auc(hi: list[float], lo: list[float]) -> float | None:
    if not hi or not lo:
        return None
    n = 0.0
    for a in hi:
        for b in lo:
            n += 1.0 if a > b else (0.5 if a == b else 0.0)
    return n / (len(hi) * len(lo))


def sep(a: float | None) -> float:
    return float("nan") if a is None else abs(a - 0.5) * 2


def sep_perm_p(hi: list[float], lo: list[float], n: int = 2000, seed: int = 20260811) -> float:
    obs = sep(auc(hi, lo))
    if obs != obs:
        return float("nan")
    pool = list(hi) + list(lo)
    rng = random.Random(seed)
    k = 0
    for _ in range(n):
        rng.shuffle(pool)
        if sep(auc(pool[: len(hi)], pool[len(hi) :])) >= obs - 1e-12:
            k += 1
    return (k + 1) / (n + 1)


def median(v: list[float]) -> float:
    if not v:
        return float("nan")
    s = sorted(v)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


# ---------------------------------------------------------------- 阈值扫描
def scan_threshold(rows: list[dict], key: str) -> None:
    """线上口径的混淆矩阵：低于阈值就拦。
    看两个数——unrelated 拦截率（要高）、supports 误伤率（要低）。"""
    vals = sorted({r["m"][key] for r in rows})
    print(f"\n  阈值扫描（{key}）  拦=低于阈值")
    print(f"    {'阈值':>10}{'拦unrel':>10}{'拦rel':>9}{'误伤sup':>10}{'总拦':>7}")
    best = None
    for t in vals:
        cut = {v: sum(1 for r in rows if r["verdict"] == v and r["m"][key] < t) for v in VERDICTS}
        n = {v: sum(1 for r in rows if r["verdict"] == v) for v in VERDICTS}
        # 选点准则：unrelated 召回优先，supports 误伤 ≤ 15% 是硬约束
        # （摘录归零是翻过的车，误伤上限比多拦一条重要）
        fp = cut["supports"] / max(n["supports"], 1)
        tp = cut["unrelated"] / max(n["unrelated"], 1)
        if fp <= 0.15 and (best is None or tp - fp > best[1]):
            best = (t, tp - fp)
        print(
            f"    {t:>10.4f}{cut['unrelated']:>4}/{n['unrelated']:<5}{cut['related']:>4}/{n['related']:<4}"
            f"{cut['supports']:>4}/{n['supports']:<5}{sum(cut.values()):>7}"
        )
    if best:
        print(f"    → 建议阈值 {best[0]:.4f}（Youden-like 最大化 TPR-FPR，FPR≤0.15 约束下）")


def confusion(rows: list[dict], key: str, t: float) -> None:
    """上线阈值的效果预估——后续复测的对照基线，报告里引的就是这张表。"""
    print(f"\n### 上线预估：{key} < {t} 即拦（换候选前的**上界损失**，换成功的那部分不会真丢）\n")
    print(f"{'判官档':<12}{'总数':>6}{'拦下':>6}{'放行':>6}{'拦截率':>9}")
    for v in VERDICTS:
        sub = [r["m"][key] for r in rows if r["verdict"] == v]
        cut = sum(1 for x in sub if x < t)
        print(f"{v:<12}{len(sub):>6}{cut:>6}{len(sub) - cut:>6}{cut / max(len(sub), 1):>9.1%}")
    bad = [r["m"][key] for r in rows if r["verdict"] == "unrelated"]
    good = [r["m"][key] for r in rows if r["verdict"] == "supports"]
    print(f"\n  unrelated 拦截率 {sum(1 for x in bad if x < t) / max(len(bad), 1):.1%}"
          f"  |  supports 误伤率 {sum(1 for x in good if x < t) / max(len(good), 1):.1%}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embedding", action="store_true", help="追加 bge-m3 余弦（需 API key）")
    ap.add_argument("--scan", default="", help="对该度量打阈值扫描表")
    ap.add_argument("--at", default="", help="打上线阈值的混淆矩阵，形如 bge:0.60")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        assert norm("如图 8.7 所示，Attention！") == "如图87所示attention"
        assert grams("abcd", 2) == {"ab", "bc", "cd"}
        assert dice({"a", "b"}, {"a", "b"}) == 1.0
        assert dice({"a"}, {"b"}) == 0.0
        assert containment({"a", "b", "c"}, {"a"}) == 1.0
        assert lcs_len("上下文腐蚀现象", "讨论上下文腐蚀") == 5
        assert lcs_len("abc", "xyz") == 0
        assert auc([1, 2], [0, 0]) == 1.0
        assert auc([0, 0], [0, 0]) == 0.5
        assert sep(auc([0, 0], [0, 0])) == 0.0
        m = zero_dep_metrics("注意力机制的核心是查询与键的点积", "点积后经 softmax 得到注意力权重")
        assert m["lcs"] >= 3 and m["g2_dice"] > 0
        print("selftest ok")
        return

    rows: list[dict] = []
    for f in RUNS:
        for line in (EVAL / f).open(encoding="utf-8"):
            if not line.strip():
                continue
            r = json.loads(line)
            if r.get("verdict") in VERDICTS:
                r["run"] = f[9:17]
                rows.append(r)
    print(f"载入 {len(rows)} 条标注：" + "  ".join(
        f"{v}={sum(1 for r in rows if r['verdict'] == v)}" for v in VERDICTS
    ))

    for r in rows:
        r["m"] = zero_dep_metrics(r["context"][-CTX_WINDOW:], r["excerpt"][:EXC_WINDOW])

    keys = list(ZERO_DEP_KEYS)
    print("\n计算 TF-IDF 余弦（引擎同款向量器，IDF 拟合在 1704 块真语料上）…")
    for r, v in zip(rows, tfidf_scores(rows)):
        r["m"]["tfidf"] = v
    keys.append("tfidf")

    if args.embedding:
        print("计算 bge-m3 余弦…")
        vals = embedding_scores(rows)
        if vals:
            for r, v in zip(rows, vals):
                r["m"]["bge"] = v
            keys.append("bge")

    by = {v: [r for r in rows if r["verdict"] == v] for v in VERDICTS}
    print("\n### 三档中位数 / 分离度（sep=|AUC-0.5|×2，p=置换检验 2000 次）\n")
    print(f"{'度量':<12}{'sup中位':>9}{'rel中位':>9}{'unrel中位':>10}"
          f"{'sep s|u':>9}{'p':>7}{'sep s|r':>9}{'p':>7}{'sep r|u':>9}{'p':>7}")
    ranked = []
    for k in keys:
        vv = {v: [r["m"][k] for r in by[v]] for v in VERDICTS}
        a_su = auc(vv["supports"], vv["unrelated"])
        a_sr = auc(vv["supports"], vv["related"])
        a_ru = auc(vv["related"], vv["unrelated"])
        p_su = sep_perm_p(vv["supports"], vv["unrelated"])
        mark = "  " if sep(a_su) >= 0.4 and p_su < 0.05 else "x "
        ranked.append((sep(a_su), p_su, k))
        print(f"{mark}{k:<10}{median(vv['supports']):>9.3f}{median(vv['related']):>9.3f}"
              f"{median(vv['unrelated']):>10.3f}{sep(a_su):>9.2f}{p_su:>7.3f}"
              f"{sep(a_sr):>9.2f}{sep_perm_p(vv['supports'], vv['related']):>7.3f}"
              f"{sep(a_ru):>9.2f}{sep_perm_p(vv['related'], vv['unrelated']):>7.3f}")
    print("\n（行首 x = 淘汰：supports|unrelated 分离度 <0.4 或置换 p ≥0.05，与随机分组没区别）")

    ranked.sort(reverse=True)
    print("\n### supports|unrelated 分离度排名：" + "  ".join(f"{k}={s:.2f}(p={p:.3f})" for s, p, k in ranked))

    # 分批稳定性：两批标注各自算一遍，只在一批上成立的度量不可信
    print("\n### 分批稳定性（sep s|u）\n")
    for k in keys:
        cells = []
        for run in sorted({r["run"] for r in rows}):
            sub = [r for r in rows if r["run"] == run]
            hi = [r["m"][k] for r in sub if r["verdict"] == "supports"]
            lo = [r["m"][k] for r in sub if r["verdict"] == "unrelated"]
            a = auc(hi, lo)
            cells.append(f"{run}={sep(a):.2f}" if a is not None else f"{run}=n/a")
        print(f"  {k:<10}" + "  ".join(cells))

    for k in (args.scan.split(",") if args.scan else []):
        if k.strip() in keys:
            scan_threshold(rows, k.strip())

    if args.at:
        k, _, t = args.at.partition(":")
        if k.strip() in keys:
            confusion(rows, k.strip(), float(t))


if __name__ == "__main__":
    sys.exit(main())
