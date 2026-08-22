"""摘录难度的外部尺子：教材自己排不排难度，我们的摘录挑在哪个分位。

起因：难度这条线上我们已经有两把外部尺子（代码形态、行文形态），但它们量的是**写法**，
不量**选材**。检索层每次从 1704 个 chunk 里挑摘录，挑难的还是挑易的，此前没有读数。

三个问题，全部零 LLM、纯机械特征，同一份输入永远得到同一组读数：

1. **教材自己是按难度递增编排的吗？**（外部锚）
   逐来源算「章节序位 vs 机械难度分位」的 Spearman。
   这条先问，是因为「课程内难度应该递增」是我们默认成立的常识——
   如果教材自己都不这么排，这条常识就没有语料支撑，不许拿它当判据。

2. **我们选的摘录落在全语料难度分布的哪个分位？**
   随机选的期望中位是 0.50。显著偏高＝在给学习者挑难的，偏低＝挑易的。

3. **一门课从头到尾，摘录难度递增吗？**
   只对摘录数 ≥4 的课出数，少于 4 条的 Spearman 读不出东西。

难度分＝`backend/rag/difficulty.py` 的 `score()`：六个机械特征各自转秩后等权求和，
所以它是**语料内相对量**，不是绝对难度。这正是我们要的——问题本来就是「相对语料挑在哪」。

跑法：
    cd apps/agent-engine
    python scripts/experiments/excerpt_difficulty_placement.py \
        --json data/eval/excerpt_difficulty_placement.json

口径边界，报数时必须一起写：
- `heading_depth` 这一列现有 index 取不到，恒为 1，因此它在 `score()` 里是常量列、
  对排序无贡献。这是**已知的测不到**，不是特征无效（与 `validate_difficulty.py` 同一处限制）。
- 章节序位取自 `source_id` 的 `<来源><章号>s<节号>#s<块号>` 编码，
  只有编码规整的来源能算，其余跳过并报出跳过数。
- 摘录难度分位衡量的是**选材**，与生成物本身的难度无关。
  一段难 chunk 被降维讲解之后可以很好懂——这条尺子看不见那件事。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from backend.rag.difficulty import extract_features, score, _ranks  # noqa: E402

INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
CLASSROOMS = ROOT.parents[0] / "classroom" / "data" / "classrooms"

#: 讲义里摘录的落款：`—— 摘自《标题》[source_id]`。source_id 是回到语料的唯一钥匙。
EXCERPT_RE = re.compile(r"——\s*摘自《[^》]+》\[([^\]]+)\]")

#: `ha01s01#s1` = 来源 ha / 第 1 章 / 第 1 节 / 第 1 块。
SOURCE_ID_RE = re.compile(r"^([a-z]+)(\d+)s(\d+)#s(\d+)$")

#: 课内趋势至少要几条摘录才出数。3 条以下 Spearman 只是噪声。
MIN_EXCERPTS_FOR_TREND = 4


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


def quantile(sorted_vals: list[float], q: float) -> float:
    """线性插值分位。空列表返回 0.0。"""
    if not sorted_vals:
        return 0.0
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


#: 只看散文特征。摘录天然偏散文（代码块另有 `beginner_code_form` 闸拦着），
#: 用全特征算出来的「摘录更简单」可能只是体裁差异，不是难度差异。
#: 换成这一组重跑，两个数一起报，读者自己判断哪一半是体裁哪一半是难度。
PROSE_FEATURES = ("term_density", "term_variety", "mean_sentence_len")


def load_corpus(use: tuple[str, ...] | None = None) -> tuple[list[dict], dict[str, float]]:
    """全语料算一次难度分，转成 0–1 分位。分位是语料内相对量。"""
    rows = [json.loads(line) for line in INDEX.read_text(encoding="utf-8").splitlines() if line]
    feats = [extract_features(r["content"]) for r in rows]
    scores = score(feats, use=use) if use else score(feats)
    ranks = _ranks(scores)
    n = max(len(rows) - 1, 1)
    pct = {r["source_id"]: ranks[i] / n for i, r in enumerate(rows)}
    return rows, pct


def textbook_order_trend(rows: list[dict], pct: dict[str, float]) -> dict:
    """尺子一：教材自己是不是按难度递增编排的。"""
    by_source: dict[str, list[tuple[float, float]]] = defaultdict(list)
    skipped = 0
    for r in rows:
        m = SOURCE_ID_RE.match(r["source_id"])
        if not m:
            skipped += 1
            continue
        src, chapter, section, block = m.group(1), *map(int, m.groups()[1:])
        # 序位＝(章, 节, 块) 的字典序，压成一个单调标量。
        by_source[src].append((chapter * 1_000_000 + section * 1_000 + block, pct[r["source_id"]]))

    out = {}
    for src, pairs in sorted(by_source.items()):
        pairs.sort()
        out[src] = {
            "n": len(pairs),
            "rho": round(spearman([p[0] for p in pairs], [p[1] for p in pairs]), 3),
        }
    return {"by_source": out, "skipped_ids": skipped}


def excerpt_placement(pct: dict[str, float]) -> dict:
    """尺子二、三：我们的摘录挑在哪个分位，课内是否递增。"""
    courses = sorted(CLASSROOMS.glob("*.json"))
    all_pcts: list[float] = []
    missing = 0
    per_course = []

    for path in courses:
        data = json.loads(path.read_text(encoding="utf-8"))
        # 按场景顺序展开，页序就是列表下标——课内趋势要的就是这个顺序。
        ordered: list[float] = []
        for scene in data.get("scenes", []):
            for sid in EXCERPT_RE.findall(json.dumps(scene, ensure_ascii=False)):
                if sid in pct:
                    ordered.append(pct[sid])
                else:
                    missing += 1
        all_pcts.extend(ordered)
        if len(ordered) >= MIN_EXCERPTS_FOR_TREND:
            per_course.append(
                {
                    "course": data.get("stage", {}).get("name") or data["id"],
                    "n": len(ordered),
                    "rho_page_vs_difficulty": round(
                        spearman(list(range(len(ordered))), ordered), 3
                    ),
                    "median_pct": round(quantile(sorted(ordered), 0.5), 3),
                }
            )

    s = sorted(all_pcts)
    return {
        "n_excerpts": len(all_pcts),
        "unresolved_source_ids": missing,
        "percentile": {
            "p25": round(quantile(s, 0.25), 3),
            "median": round(quantile(s, 0.5), 3),
            "p75": round(quantile(s, 0.75), 3),
            "mean": round(sum(s) / len(s), 3) if s else 0.0,
        },
        "courses_with_trend": per_course,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", type=Path, help="落盘路径")
    args = parser.parse_args()

    rows, pct = load_corpus()
    print(f"语料 {len(rows)} 条，难度分已转 0–1 分位")

    trend = textbook_order_trend(rows, pct)
    print("\n[尺子一] 教材章节序位 vs 机械难度分位（Spearman）")
    for src, v in trend["by_source"].items():
        print(f"  {src:<4} n={v['n']:<5} rho={v['rho']:+.3f}")
    if trend["skipped_ids"]:
        print(f"  （{trend['skipped_ids']} 条 source_id 编码不规整，跳过）")

    place = excerpt_placement(pct)
    p = place["percentile"]
    print(f"\n[尺子二] 摘录 {place['n_excerpts']} 条落在全语料难度分位")
    print(f"  P25 {p['p25']:.3f} ｜ 中位 {p['median']:.3f} ｜ P75 {p['p75']:.3f} ｜ 均值 {p['mean']:.3f}")
    print("  随机选材的期望中位是 0.500")
    if place["unresolved_source_ids"]:
        print(f"  （{place['unresolved_source_ids']} 条摘录的 source_id 在语料里找不到）")

    # 证伪路径：把代码占比与公式密度剔掉再排一次。中位显著回升＝上面那个数一半是体裁差异。
    _, pct_prose = load_corpus(use=PROSE_FEATURES)
    prose = excerpt_placement(pct_prose)
    pp = prose["percentile"]
    print("\n[尺子二·证伪] 只用散文特征（剔掉 code_ratio / formula_density）重排")
    print(f"  P25 {pp['p25']:.3f} ｜ 中位 {pp['median']:.3f} ｜ P75 {pp['p75']:.3f} ｜ 均值 {pp['mean']:.3f}")
    place["prose_only"] = pp

    print(f"\n[尺子三] 课内页序 vs 摘录难度（≥{MIN_EXCERPTS_FOR_TREND} 条摘录的课）")
    for c in place["courses_with_trend"]:
        print(f"  {c['course'][:24]:<26} n={c['n']:<3} rho={c['rho_page_vs_difficulty']:+.3f}  中位 {c['median_pct']:.3f}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps({"textbook_order": trend, "excerpts": place}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
