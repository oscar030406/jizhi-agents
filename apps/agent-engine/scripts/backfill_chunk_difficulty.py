r"""给已建成的库补上难度分层——**只改 difficulty 一格，不重切块**。

## 为什么需要它

域接入流水线此前把每个 chunk 的 `difficulty` 写成声明区间的下界，于是管理端填
「分三档」建出来的库，索引里 100% 是 L1（实测：smart-manufacturing 1703 块、
iotdb 2716 块，全 L1）。主库不是这样——它由早期逐域脚本建，走
`backend.rag.emit.plan_sections` 的机械特征分位法，有 L1/L2/L3/L4 的分布。
同一个产品里两套行为，而 `excerptDifficultyCap` 给检索传的 `max_difficulty`
在难度恒定的库上等于没有作用：进阶学习者与零基础学习者拿到同一批证据块。

`scripts/ingest_domain.py` 已经修好（新建的库直接带分层）。这个脚本是给
**已经建好、不能重建**的库用的：重建会让 source_id 重新编号，旧课正文里的
`[docs-plc#s31]` 会集体指向别的段落（判据见 `backend.rag.ingest.write_index`）。
所以这里逐行改写 `difficulty`，`source_id` / `content` / `concept_tags` 一个字不动。

## 口径

分层用的是与主库同一套机械特征分位法，只保证**语料内相对**难度；绝对准确度没过验收
（重测 κ=0.292、收敛效度 0.282，见 `backend/rag/difficulty.py` 模块头），
所以它只用来分层、不作难度承诺。

两处与建库时的口径差异，如实记着：
1. 特征取自索引里存的 `content`（已经过 strip_media），不是磁盘原文；
2. `heading_depth` 索引里没存，用 `title` 里的 " / " 段数还原。
两者对**相对**排序的影响很小（同一批块用同一套口径），但不是逐字复现建库那一刻的结果。

归档块（`superseded=true`）原样跳过：它们不参与检索，改它们没有收益，只会让 diff 变大。

用法：
    python scripts/backfill_chunk_difficulty.py --corpus smart-manufacturing --dry
    python scripts/backfill_chunk_difficulty.py --corpus smart-manufacturing
    python scripts/backfill_chunk_difficulty.py --corpus iotdb --tier-range L1-L3
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.rag.difficulty import TIERS, extract_features, score  # noqa: E402
from backend.rag.emit import _band_index, tier_bounds  # noqa: E402

KB = ROOT / "data" / "knowledge_base"


def _tier_range_of(corpus: str, override: str | None) -> tuple[str, str]:
    """难度区间：命令行 > 接入报告里记的 > 流水线默认 L1-L3。返回 (区间, 来源)。"""
    if override:
        return override, "命令行"
    readiness = KB / f"{corpus}_intake" / "readiness.json"
    if readiness.exists():
        try:
            data = json.loads(readiness.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            data = {}
        declared = ((data.get("difficulty") or {}) or {}).get("tier_range")
        if declared:
            return str(declared), "接入报告"
    return "L1-L3", "流水线默认（接入报告里没记）"


def backfill(corpus: str, tier_range: str, dry: bool) -> int:
    index = KB / "corpora" / corpus / "knowledge_index.jsonl"
    if not index.exists():
        print(f"[跳过] 索引不在盘：{index}")
        return 1

    rows = []
    for line in index.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rows.append(json.loads(line))  # 坏行直接抛：半截索引比没有索引更危险

    lo, hi = tier_bounds(tier_range)
    band = TIERS[lo - 1 : hi] or [TIERS[0]]

    before = collections.Counter(str(r.get("difficulty")) for r in rows)
    active = [r for r in rows if not r.get("superseded")]
    by_file: dict[str, list[int]] = collections.defaultdict(list)
    for i, r in enumerate(rows):
        if r.get("superseded"):
            continue
        by_file[str(r.get("source_id", "")).partition("#")[0]].append(i)

    changed = 0
    for indices in by_file.values():
        feats = [
            extract_features(
                str(rows[i].get("content") or ""),
                heading_depth=len(str(rows[i].get("title") or "").split(" / ")),
            )
            for i in indices
        ]
        if not feats:
            continue
        for slot, i in zip(_band_index(score(feats), len(band)), indices):
            new = band[slot]
            if rows[i].get("difficulty") != new:
                changed += 1
            rows[i]["difficulty"] = new

    after = collections.Counter(str(r.get("difficulty")) for r in rows)
    print(f"== {corpus}｜区间 {tier_range}｜{len(rows)} 行（活块 {len(active)}，文件 {len(by_file)}）")
    print(f"   改前：{dict(sorted(before.items()))}")
    print(f"   改后：{dict(sorted(after.items()))}   变更 {changed} 行")
    if dry:
        print("   （--dry：没写盘）")
        return 0

    backup = index.with_suffix(".jsonl.bak-difficulty")
    if not backup.exists():  # 只留第一份原始态，重复跑不覆盖它
        backup.write_text(index.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"   原始索引备份到 {backup.name}")
    index.write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )
    print("   已写盘")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="库名（可逗号分隔多个）")
    ap.add_argument("--tier-range", default="", help="难度区间，如 L1-L3；不给就按接入报告/默认")
    ap.add_argument("--dry", action="store_true", help="只报分布，不写盘")
    args = ap.parse_args()
    rc = 0
    for corpus in [c.strip() for c in args.corpus.split(",") if c.strip()]:
        tier_range, src = _tier_range_of(corpus, args.tier_range or None)
        print(f"[区间来源] {corpus}: {src}")
        rc |= backfill(corpus, tier_range, args.dry)
    return rc


if __name__ == "__main__":
    sys.exit(main())
