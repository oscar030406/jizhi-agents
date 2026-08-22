r"""课程算力账报表：把 `data/eval/course_cost.json` 的原始记录汇成可直接进文档的表。

存在的理由是"数字单一真源"——答辩稿里的每一个成本数字都必须能追到这里，
不允许手打。口径三条，写死在输出里，防止被转述成更好看的说法：

  1. **token 是硬数据，单价是估算**（`backend/services/cost_meter.py` 的价格常量），
     最终以硅基流动账单页为准。
  2. 报的是**边际成本**：一次过闸的课时花多少。判官打回的重试轮次另计，
     且 2026-07-24 之前的重试没有落盘（失败路径在记账之前就抛了，已修）。
  3. 整门课的数字是**外推**，不是实测——按已测课时的均值 × 课时数，标注样本量。

用法：python scripts\report_course_cost.py [--markdown]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COST_FILE = ROOT / "data" / "eval" / "course_cost.json"
CURRICULUM = ROOT / "data" / "curriculum"


def lesson_count(concept: str) -> int:
    path = CURRICULUM / f"{concept}.json"
    if not path.is_file():
        return 0
    course = json.loads(path.read_text(encoding="utf-8"))
    if course.get("chapters"):
        return sum(len(ch.get("lessons", [])) for ch in course["chapters"])
    return len(course.get("lessons", []))


def collect() -> tuple[list[dict], dict]:
    records = json.loads(COST_FILE.read_text(encoding="utf-8")) if COST_FILE.is_file() else {}
    rows = []
    for concept, runs in sorted(records.items()):
        built = sum(r.get("lessons_built", 0) for r in runs)
        tokens = sum(r.get("total_tokens", 0) for r in runs)
        # 结业卷每轮重出、不进课时缓存，必须从总账里减掉才是课时的边际成本。
        # 老记录没有 exam_tokens 字段（记账是 2026-07-24 才分相的），减 0，
        # 这些行会在报表里被标成口径不纯。
        exam = sum(r.get("exam_tokens", 0) for r in runs)
        rows.append({
            "concept": concept,
            "runs": len(runs),
            "lessons_metered": built,
            "tokens": tokens,
            "exam_tokens": exam,
            "lesson_tokens": tokens - exam,
            "calls": sum(r.get("api_calls", 0) for r in runs),
            "cny": sum(r.get("estimated_cost_cny", 0.0) for r in runs),
            "phase_split": all("exam_tokens" in r for r in runs),
            "lessons_total": lesson_count(concept),
        })
    # 只有既产出了课时、又分了相的记录能算干净的"每课时"
    clean = [r for r in rows if r["lessons_metered"] and r["phase_split"]]
    metered = sum(r["lessons_metered"] for r in clean)
    total_tok = sum(r["lesson_tokens"] for r in clean)
    total_cny = sum(r["cny"] * (r["lesson_tokens"] / r["tokens"] if r["tokens"] else 0) for r in clean)
    summary = {
        "lessons_metered": metered,
        "per_lesson_tokens": total_tok / metered if metered else 0,
        "per_lesson_cny": total_cny / metered if metered else 0,
        "dropped_unsplit": [r["concept"] for r in rows if r["lessons_metered"] and not r["phase_split"]],
    }
    return rows, summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markdown", action="store_true")
    args = parser.parse_args()
    rows, summary = collect()

    if not args.markdown:
        print(json.dumps({"rows": rows, "summary": summary}, ensure_ascii=False, indent=2))
        return

    n = summary["lessons_metered"]
    out = [
        "| 概念 | 记账轮次 | 已计量课时 | 总 token | 其中结业卷 | 课时 token | API 调用 | 估算 ¥ | 课程总课时 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        exam = f"{r['exam_tokens']:,}" if r["phase_split"] else "未分相"
        out.append(
            f"| `{r['concept']}` | {r['runs']} | {r['lessons_metered']} | {r['tokens']:,} | {exam} | "
            f"{r['lesson_tokens']:,} | {r['calls']} | {r['cny']:.4f} | {r['lessons_total']} |"
        )
    out += [
        "",
        f"**每课时边际成本（实测均值，n={n}）**："
        f"{summary['per_lesson_tokens']:,.0f} token ≈ ¥{summary['per_lesson_cny']:.3f}"
        "（已扣除结业卷）",
        "",
        "口径（不可省略）：",
        "1. token 是硬数据，单价是估算（`backend/services/cost_meter.py` 价格常量），以账单为准。",
        "2. 这是**一次过闸**的边际成本；判官打回的重试轮次另计，"
        "且 2026-07-24 修好记账漏洞之前的重试未落盘。",
        "3. 整门课若按均值 × 课时数外推，须标注为外推值与样本量，不得说成实测。",
        "4. 结业卷不进课时缓存、每轮重出，已单独列账并从课时成本里扣除；"
        "报一门课的总价时要把它加回来一次。",
    ]
    if summary["dropped_unsplit"]:
        out.append(
            f"5. 以下概念的记录早于分相记账，已排除在均值之外："
            f"{'、'.join(summary['dropped_unsplit'])}。"
        )
    print("\n".join(out))


if __name__ == "__main__":
    main()
