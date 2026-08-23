"""在 1704 条**早期模型标注**上实测：机械特征与那批标签的相关性。

⚠️ **那批标签不是金标。** 它们是早期会话里写 `ingest_*.py` 时由模型按章节拍的常量
（脚本注释写的「人工定的常量」，那个「人」是当时的 agent，不是人类专家）。
所以这里算出来的一致率衡量的是「机械特征能不能复现当时那批拍法」，
**不是「标得对不对」**。真值我们没有——见 `label_chunk_difficulty.py` 的收敛效度实验。

跑法：
    python scripts/validate_difficulty.py            # 全量
    python scripts/validate_difficulty.py --source ha  # 只看某个来源

**这是验收脚本，不是演示脚本。** 数字难看就照报——机械特征与旧标签对不上是完全可能的
结果，那也是一条结论（说明这条路要么换特征要么加信号，而不是硬上）。

口径边界，报数时必须一起写：
- 旧标签是**章级常量**（一整章一个档，`ag` 那 38 条全是 L3），不是逐 chunk 标注，且由模型分次打出。
  所以「一致率」的上界本身就被粗粒度压着，低不等于特征没用。
- 跨来源比较意义有限：不同来源的旧标签是分次、分脚本打的，口径不统一。
  逐来源的 Spearman 比全局一致率更能说明问题。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.difficulty import (  # noqa: E402
    FEATURE_NAMES,
    TIERS,
    Features,
    assign_tiers,
    extract_features,
    score,
    _ranks,
)

INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"


def spearman(a: list[float], b: list[float]) -> float:
    """秩相关。并列用平均秩，所以直接对秩做 Pearson，不用简化公式。"""
    if len(a) < 3:
        return 0.0
    ra, rb = _ranks(a), _ranks(b)
    n = len(ra)
    ma, mb = sum(ra) / n, sum(rb) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    va = sum((x - ma) ** 2 for x in ra) ** 0.5
    vb = sum((y - mb) ** 2 for y in rb) ** 0.5
    return cov / (va * vb) if va and vb else 0.0


def convergent_validity(rows: list[dict], feats: list, combined: list[float], labels: dict) -> None:
    """收敛效度：机械特征 与 LLM 标注 的相关性。两条独立路径，都不需要真值。

    这是没有金标时唯一站得住的验收方式——若两条方法论完全不同的测量高度相关，
    说明它们在测同一个真实存在的量；若不相关，说明至少有一条测的不是难度。
    """
    paired = [(i, labels[r["source_id"]]["tier"]) for i, r in enumerate(rows) if r["source_id"] in labels]
    if len(paired) < 30:
        print(f"\n[收敛效度] 配对样本只有 {len(paired)} 条，不足以下结论")
        return
    idx = [i for i, _ in paired]
    llm = [float(TIERS.index(t)) for _, t in paired]
    print(f"\n[收敛效度] 配对 {len(paired)} 条")
    for name in FEATURE_NAMES:
        if name == "heading_depth":
            continue
        rho = spearman([getattr(feats[i], name) for i in idx], llm)
        print(f"  {name:<20} {rho:+.3f}")
    print(f"  {'合成分数':<18} {spearman([combined[i] for i in idx], llm):+.3f}  ← 收敛效度主数字")

    old = [float(TIERS.index(rows[i]['difficulty'])) for i in idx]
    print(f"\n[对照] LLM 标注 vs 旧标签 Spearman {spearman(llm, old):+.3f}")
    same = sum(1 for a, b in zip(llm, old) if a == b)
    print(f"       同档 {same}/{len(idx)} = {same / len(idx):.1%}（旧标签是章级常量，低是预期的）")

    print("\n[判据一致性] 逐来源 —— 旧标签在这里符号会翻转，同一提示词下还翻不翻")
    by_src: dict[str, list[int]] = defaultdict(list)
    for pos, i in enumerate(idx):
        by_src["".join(c for c in rows[i]["source_id"][:2] if c.isalpha())].append(pos)
    for src, pos in sorted(by_src.items()):
        if len(pos) < 20:
            continue
        rho = spearman([combined[idx[p]] for p in pos], [llm[p] for p in pos])
        print(f"  {src:<4} n={len(pos):<5} rho={rho:+.3f}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", help="只看某个 source_id 前缀，如 ha / em / hl")
    parser.add_argument(
        "--llm-labels",
        type=Path,
        help="label_chunk_difficulty.py 的产物；给了就算收敛效度",
    )
    args = parser.parse_args()

    # 只验活块：归档块进来会让同一块被算两次，κ 与收敛效度都算不准。
    from backend.rag.ingest import read_index_rows

    rows = read_index_rows(INDEX)
    if args.source:
        rows = [r for r in rows if r["source_id"].startswith(args.source)]
    if not rows:
        print("没有匹配的 chunk")
        return 1

    # 结构深度这一列现在取不到（现有 index 没存标题路径），统一填 1；
    # 它因此在本次验证里是常量列、相关性必然为 0——这是**已知的测不到**，
    # 不是「该特征无效」。接入管线接上 outline_sections 之后重跑才有意义。
    feats: list[Features] = [extract_features(r["content"]) for r in rows]
    human = [float(TIERS.index(r["difficulty"])) for r in rows]

    print(f"样本 {len(rows)} 条；旧标签分布 {dict(sorted(Counter(r['difficulty'] for r in rows).items()))}")
    print("\n逐特征 Spearman（与旧标签）")
    keep: list[str] = []
    for name in FEATURE_NAMES:
        rho = spearman([getattr(f, name) for f in feats], human)
        flag = ""
        if name == "heading_depth":
            flag = "  ← 本次为常量列，测不到"
        elif abs(rho) >= 0.15:
            keep.append(name)
            flag = "  ← 留用"
        else:
            flag = "  ← 信号太弱，剔除"
        print(f"  {name:<20} {rho:+.3f}{flag}")

    if not keep:
        print("\n没有任何特征达到 |rho| >= 0.15——这条路按现有特征走不通，如实报告。")
        return 0

    combined = score(feats, use=tuple(keep))
    rho_all = spearman(combined, human)
    auto = assign_tiers(combined)

    exact = sum(1 for a, h in zip(auto, rows) if a == h["difficulty"])
    within1 = sum(
        1 for a, h in zip(auto, rows) if abs(TIERS.index(a) - TIERS.index(h["difficulty"])) <= 1
    )
    n = len(rows)
    print(f"\n留用特征 {keep}")
    print(f"合成分数 Spearman  {rho_all:+.3f}")
    print(f"与旧标签完全一致       {exact}/{n} = {exact / n:.1%}")
    print(f"相差不超过一档     {within1}/{n} = {within1 / n:.1%}")

    print("\n混淆（行=旧标签，列=自动）")
    conf: dict[str, Counter] = defaultdict(Counter)
    for a, h in zip(auto, rows):
        conf[h["difficulty"]][a] += 1
    print("        " + "".join(f"{t:>7}" for t in TIERS))
    for t in TIERS:
        print(f"  {t:<6}" + "".join(f"{conf[t][c]:>7}" for c in TIERS))

    print("\n逐来源 Spearman（旧标签口径不统一，这个比全局一致率更能说明问题）")
    by_source: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_source["".join(c for c in r["source_id"][:2] if c.isalpha())].append(i)
    for src, idx in sorted(by_source.items()):
        if len(idx) < 10:
            continue
        rho = spearman([combined[i] for i in idx], [human[i] for i in idx])
        labels = len({rows[i]["difficulty"] for i in idx})
        note = "  ← 该来源只有一个档，秩相关无意义" if labels < 2 else ""
        print(f"  {src:<4} n={len(idx):<5} rho={rho:+.3f}{note}")

    if args.llm_labels:
        payload = json.loads(args.llm_labels.read_text(encoding="utf-8"))
        agreement = payload.get("retest_agreement") or {}
        if agreement.get("exact_rate") is not None:
            print(
                f"\n[重测信度] {agreement['exact']}/{agreement['n']} 同档 = "
                f"{agreement['exact_rate']:.1%}；一档内 {agreement['within_one_rate']:.1%}"
                f"（seed={agreement['seed']}）"
            )
        convergent_validity(rows, feats, combined, payload.get("labels") or {})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
