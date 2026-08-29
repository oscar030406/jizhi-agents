r"""用**一个提示词、一个模型、一次跑完**给全库 chunk 标难度，并测它自己稳不稳。

## 这个脚本要回答什么

难度这件事我们**没有任何真值**——库里那 1704 条 `difficulty` 是早期会话写 `ingest_*.py`
时由模型按章节拍的常量，分次、分脚本、判据各不相同（实测证据：`em` 上 formula_density
与旧标签 Spearman +0.353，`ha` 上 -0.120，**符号翻转**）。拿它当金标，任何结论都悬空。

没有金标时，心理测量学的常规手段是**重测信度 + 收敛效度**，两者都不需要真值：

    1. 重测信度   同一段标两次是否同档            ← 只测模型自己稳不稳
    2. 收敛效度   LLM 标注 vs 机械特征的相关性     ← 两条独立路径是否指向同一个量
    3. 判据一致性 同一提示词下各来源内符号还翻不翻转 ← 直接检验「口径漂移」这个假设

第 2、3 项由 `validate_difficulty.py --llm-labels` 算，本脚本负责产出标注与第 1 项。

**三种结果都有价值**，不许挑好看的报：
- 重测高 + 与机械特征收敛 → 两条路互为交叉验证
- 重测高但不收敛         → 它们在测不同的东西，「难度」的定义得先拆开
- 重测就低               → 模型标难度不稳，这条路自己废掉，不用再争

## 跑法

    python scripts/label_chunk_difficulty.py --limit 12          # 试跑，先验工具
    python scripts/label_chunk_difficulty.py --retest 200        # 全量 + 重测子集
    python scripts/validate_difficulty.py --llm-labels data/eval/chunk_difficulty_labels.json

长任务后台跑并落日志。API 打不通先跑 `scripts/api_probe.py`。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.llm_gateway import LLMGateway  # noqa: E402

AGENT = "ChunkDifficultyLabeler"
INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
DEFAULT_OUT = ROOT / "data" / "eval" / "chunk_difficulty_labels.json"

#: 重测子集的抽样种子。写死才可复算——换种子等于换实验。
RETEST_SEED = 20260812

# ---------------------------------------------------------------------------
# 判据。这是本实验的核心产物：**一个明确的、写下来的判据**，
# 旧标签失败的根因就是没有它（每个 ingest 脚本各拍各的）。
# ---------------------------------------------------------------------------

SYSTEM = """你在给中文技术教材的切片标注**读者门槛**，供个性化学习系统按学习者档位筛选素材。

难度 = 读懂这一段需要的门槛，四档：

L1 入门：不需要该领域任何前置概念；出现的术语在本段内就有解释；代码（若有）是照抄即可运行的示例。
L2 基础：需要该领域的基本概念（入门材料里讲过的那些）；有少量未解释的术语；代码要理解才能改。
L3 进阶：需要多个前置概念同时在手；含公式推导、论文级方法名、或生产环境的工程取舍；未解释的术语密集。
L4 专家：需要该领域的系统性背景；含完整数学推导，或要跨多个子领域的知识才能读懂。

三条**明确排除**，违反会让标注不可用：

1. 不按「任务规模 / 项目复杂度」打分。一份手把手带做的大项目教程，若每一步都解释清楚，
   它是 L1 或 L2，不是 L4。做一件大事和读懂一段文字是两回事。
2. 不按篇幅打分。长不等于难。
3. 不按「这是书的第几章」打分。你只看给你的这段文字本身，不推测它在书里的位置。

每段给一句 why，说清是哪个具体的东西构成了门槛（某个未解释的术语、某段推导、某个前置概念）。
只输出 JSON：{"labels": [{"id": "原样抄回给你的 id", "tier": "L1|L2|L3|L4", "why": "一句话"}]}"""

PROMPT_FINGERPRINT = hashlib.sha256(SYSTEM.encode("utf-8")).hexdigest()[:12]
TIERS = ("L1", "L2", "L3", "L4")


def build_user(batch: list[dict]) -> str:
    parts = []
    for row in batch:
        parts.append(f"--- id: {row['source_id']}\n标题：{row['title']}\n正文：\n{row['content']}")
    return "\n\n".join(parts)


def label_batch(gateway: LLMGateway, batch: list[dict]) -> dict[str, dict]:
    """返回 {id: {"tier":..., "why":...}}。失败或缺项就不返回该 id——**不补默认值**。

    补默认值会把「模型没标」伪装成「模型标了 L2」，正是我们要测的稳定性被污染的方式。
    """
    parsed = gateway.structured_chat(
        AGENT, SYSTEM, build_user(batch), temperature=0.2, max_tokens=1200
    )
    if not parsed:
        return {}
    out: dict[str, dict] = {}
    valid_ids = {r["source_id"] for r in batch}
    for item in parsed.get("labels") or []:
        if not isinstance(item, dict):
            continue
        cid, tier = str(item.get("id", "")), str(item.get("tier", "")).upper()
        if cid in valid_ids and tier in TIERS:
            out[cid] = {"tier": tier, "why": str(item.get("why", "")).strip()}
    return out


def run_pass(gateway: LLMGateway, rows: list[dict], batch_size: int, workers: int, tag: str) -> dict[str, dict]:
    batches = [rows[i : i + batch_size] for i in range(0, len(rows), batch_size)]
    labels: dict[str, dict] = {}
    done = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for result in pool.map(lambda b: label_batch(gateway, b), batches):
            labels.update(result)
            done += 1
            if done % 10 == 0 or done == len(batches):
                elapsed = time.time() - started
                print(
                    f"[{tag}] {done}/{len(batches)} 批，已标 {len(labels)}/{len(rows)} 条，"
                    f"{elapsed:.0f}s",
                    flush=True,
                )
    return labels


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="只标前 N 条，用于试跑验工具")
    parser.add_argument("--retest", type=int, default=0, help="在随机 N 条上再标一遍测重测信度")
    parser.add_argument("--batch-size", type=int, default=6)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    # 强制置位，不能用 setdefault：`backend/__init__` 在 import 时就把 .env 里的
    # 本脚本没有确定性形态可退——标注就是要问模型。
    gateway = LLMGateway()
    route = gateway.route_for(AGENT)
    if not route.enabled:
        print(f"路由未启用：provider={route.provider} model={route.model}；检查 {route.api_key_env}")
        return 1
    print(f"模型 {route.provider}/{route.model}；提示词指纹 {PROMPT_FINGERPRINT}", flush=True)

    # 只标活块。给归档块标难度是白花钱——它们永远不会被检索到。
    from backend.rag.ingest import read_index_rows

    rows = read_index_rows(INDEX)
    if args.limit:
        rows = rows[: args.limit]
    print(f"待标 {len(rows)} 条，批大小 {args.batch_size}，并发 {args.workers}", flush=True)

    labels = run_pass(gateway, rows, args.batch_size, args.workers, "pass1")

    retest: dict[str, dict] = {}
    agreement: dict[str, object] = {}
    if args.retest:
        subset = random.Random(RETEST_SEED).sample(rows, min(args.retest, len(rows)))
        retest = run_pass(gateway, subset, args.batch_size, args.workers, "retest")
        both = [c for c in retest if c in labels]
        same = sum(1 for c in both if retest[c]["tier"] == labels[c]["tier"])
        within1 = sum(
            1
            for c in both
            if abs(TIERS.index(retest[c]["tier"]) - TIERS.index(labels[c]["tier"])) <= 1
        )
        agreement = {
            "n": len(both),
            "exact": same,
            "exact_rate": round(same / len(both), 4) if both else None,
            "within_one_rate": round(within1 / len(both), 4) if both else None,
            "seed": RETEST_SEED,
        }
        print(f"\n重测信度：{same}/{len(both)} 同档 = {same / len(both):.1%}" if both else "\n重测子集为空")

    coverage = len(labels) / len(rows) if rows else 0.0
    payload = {
        "_meta": {
            "prompt_fingerprint": PROMPT_FINGERPRINT,
            "model": f"{route.provider}/{route.model}",
            "batch_size": args.batch_size,
            "temperature": 0.2,
            "n_requested": len(rows),
            "n_labeled": len(labels),
            "coverage": round(coverage, 4),
            "note": "旧的 difficulty 字段是早期会话分次拍的常量，与本次标注不同源、不可混用",
        },
        "telemetry": gateway.telemetry_snapshot(),
        "retest_agreement": agreement,
        "labels": labels,
        "retest_labels": retest,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\n标注覆盖 {len(labels)}/{len(rows)} = {coverage:.1%}")
    if coverage < 0.95:
        print("⚠️ 覆盖率偏低——有批次解析失败或被截断，先查 telemetry 再用这批数据")
    from collections import Counter

    print("档位分布:", dict(sorted(Counter(v["tier"] for v in labels.values()).items())))
    print(f"落盘 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
