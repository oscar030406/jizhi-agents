r"""把前置边审计导成可勾的人工抽检表。零 API 调用。

    python scripts/prereq_review_sheet.py --intake data/knowledge_base/odoo_intake
    python scripts/prereq_review_sheet.py --intake ... --out docs/05-evidence/prereq-review-odoo.md

## 为什么要这一份

设计稿 §7.6：**只有人工签字的边能拦人**，模型抽的一律软前置。所以「章级前置图出了
13 条边」本身不构成任何效果承诺，验收线是**方向正确率 ≥80% 的人工抽检**。

审计数据本来就在 `prereq_chapter_audit.json` / `prereq_audit.json` 里，但那是 JSON，
逐条读要跳着看引用次数、复核判词、两端章名。这里把它摊平成一张表：一行一条边、
一列一个判据、末列留空给人打勾。**这一步是给人省时间，不是给模型加工序。**

审的时候只回答一个问题，与造图时问模型的是同一句：
**一个完全没接触过「前置」那一栏的人，直接去学「目标」那一栏的材料，会不会卡住？**
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_chapter_edges(intake: Path) -> tuple[dict[str, str], list[dict]]:
    f = intake / "prereq_chapter_audit.json"
    if not f.exists():
        return {}, []
    data = json.loads(f.read_text(encoding="utf-8"))
    return data.get("names", {}), data.get("edges", [])


def attach_contexts(intake: Path, edges: list[dict]) -> None:
    """给每条边补上**引用当时那句话**。零 API：直接重读语料。

    章名只能告诉你两章叫什么。判前置还是「参见」，靠的是链接周围那句话——
    「如果该选项不可用，请先启用 X」是前置；「更多细节参见 X」不是。
    审表上有没有这一列，人工抽检的速度差一个数量级。

    审计文件是复核那一步写的，早于本列存在；所以不从审计里读，从语料现算。
    """
    report = intake / "readiness.json"
    if not report.exists():
        return
    src = json.loads(report.read_text(encoding="utf-8")).get("source_dir")
    if not src or not Path(src).is_dir():
        return
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from backend.rag.structure_edges import load_markdown, structural_edges  # noqa: E402

    fresh = {(e["prereq"], e["target"]): e.get("contexts", []) for e in structural_edges(load_markdown(Path(src)))}
    for e in edges:
        e["contexts"] = fresh.get((e.get("prereq"), e.get("target")), [])


def load_node_edges(intake: Path) -> list[dict]:
    """节级审计是逐对判定的全量记录，只挑判出关系的那些。"""
    f = intake / "prereq_audit.json"
    if not f.exists():
        return []
    rows = json.loads(f.read_text(encoding="utf-8"))
    out = []
    for r in rows:
        rel = r.get("relation")
        if rel not in {"a_before_b", "b_before_a"}:
            continue
        a, b = r.get("pair", ["", ""])
        prereq, target = (a, b) if rel == "a_before_b" else (b, a)
        out.append({
            "prereq_name": prereq,
            "target_name": target,
            "confidence": r.get("confidence"),
            "because": r.get("because", ""),
        })
    return out


def sheet(intake: Path) -> str:
    names, chapter_edges = load_chapter_edges(intake)
    attach_contexts(intake, chapter_edges)
    node_edges = load_node_edges(intake)
    domain = intake.name.replace("_intake", "")
    passed = [e for e in chapter_edges if e.get("passed")]
    rejected = [e for e in chapter_edges if not e.get("passed")]

    lines = [
        f"# 前置边人工抽检表 · {domain}",
        "",
        "审的时候只回答一句：**一个完全没接触过「前置」的人，直接去学「目标」的材料，会不会卡住？**",
        "会卡 = 方向对，打 ✓；不会卡（两者并列、或只是「参见」）= 方向错，打 ✗。",
        "",
        f"验收线：**方向正确率 ≥ 80%**。达不到就如实写「结构信号法在 {domain} 上不成立」，",
        "别改阈值凑。审完把这份表存进 `docs/05-evidence/`，它是「领域泛化」唯一的人证。",
        "",
    ]

    if passed:
        lines += [
            f"## 章级边（结构提出 {len(chapter_edges)} 条，模型复核通过 {len(passed)} 条）",
            "",
            "「引用」列是证据强度：目标章的页面引用了前置章几次，反向几次。",
            "**「引用原句」是判这条边最快的依据**——「请先启用 X」是前置，「参见 X」不是。",
            "",
        ]
        for i, e in enumerate(passed, 1):
            lines += [
                f"**{i}. {e.get('prereq_name', e['prereq'])} → {e.get('target_name', e['target'])}**"
                f"（引用 {e['links']} 次，反向 {e['back_links']} 次）  方向对吗：[ ]",
                "",
            ]
            for c in (e.get("contexts") or [])[:2]:
                lines.append(f"> …{c[:150]}…")
                lines.append("")
            if not e.get("contexts"):
                lines += ["> （取不到引用原句）", ""]

    if rejected:
        lines += [
            f"### 被模型否掉的 {len(rejected)} 条（也要看——模型否错过）",
            "",
            "| # | 前置 | 目标 | 引用 | 模型说 | 你觉得该留吗 |",
            "|---|---|---|---|---|---|",
        ]
        for i, e in enumerate(rejected, 1):
            rel = (e.get("review") or {}).get("relation", "调用失败")
            lines.append(
                f"| {i} | {e.get('prereq_name', e['prereq'])} | {e.get('target_name', e['target'])} "
                f"| {e['links']} vs {e['back_links']} | {rel} |  |"
            )
        lines.append("")

    if node_edges:
        lines += [
            f"## 节级边（成对判定出的 {len(node_edges)} 条）",
            "",
            "| # | 前置 | 目标 | 置信 | 依据（模型从语料原样摘的） | 方向对吗 |",
            "|---|---|---|---|---|---|",
        ]
        for i, e in enumerate(node_edges, 1):
            lines.append(
                f"| {i} | {e['prereq_name']} | {e['target_name']} | {e.get('confidence')} "
                f"| {str(e.get('because', ''))[:70]} |  |"
            )
        lines.append("")

    if not passed and not node_edges:
        lines += ["（这个域还没有产出任何前置边，无从抽检。）", ""]

    lines += [
        "---",
        "",
        "## 已有一轮 agent 初审（2026-08-12），**不能替代人工签字**",
        "",
        "按引用原句逐条判过一轮，两个语料合计 **10/21 = 47.6% 正确，没过 80% 线**。",
        "失败模式集中在一处：「详见 / 参见 / 请查看 / 以…为例」这类**指路型**引用被当成了前置。",
        "结论与后续修法写在 `docs/05-evidence/prereg-v5-blind-transfer-20260812.md`。",
        "设计稿 §7.6 要求人工签字才算硬前置，所以这一轮只是给你缩小范围，不是结论。",
        "",
        "审完请在这里写结论：",
        "",
        "- 抽检条数：___ / 正确：___ / 正确率：___%",
        "- 过没过 80% 线：___",
        "- 与上面那轮 agent 初审的分歧在哪：___",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--intake", required=True, type=Path)
    ap.add_argument("--out", type=Path, help="不给就打到标准输出")
    args = ap.parse_args()

    text = sheet(args.intake)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
        print(f"已写入 {args.out}（{len(text.splitlines())} 行）")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
