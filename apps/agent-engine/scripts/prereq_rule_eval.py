r"""前置边过滤规则值多少：拿人工标注的表算一遍。零 API 调用。

    python scripts/prereq_rule_eval.py --sheet docs/05-evidence/prereq-review-iotdb-20260812.md \
                                       --intake data/knowledge_base/iotdb_intake

## 为什么要这一份

`link_intent`（「详见/参见」词表）写好很久了，**故意没接进产出**——它自己的文档
记着理由：08-12 试接过，IoTDB 候选边 35→17、标注子集 83%；Odoo 30→29、56%。
但那 15 条标签是写规则的人自己标的，规则又是照着这些例子写的，
等于同一批样本调参又验收。所以结论不作数，要接得先有别人标的边。

问题是：**在此之前，「过滤能带来多少」这个数根本算不出来。** 两份审表都是空模板，
08-12 那轮判定没落成机器可读的形式；想再问一次只能把整条链重跑，而重跑要花钱。

这个脚本把「算得出来」补上。标注表一填，四种规则的正确率当场出：

- `baseline`：现在的产出，全部引用一视同仁
- `seealso-filter`：命中「详见」族的引用不计入证据强度（杠杆①）
- `prereq-only`：只认「请先」族，其余一律不算（更严的一版）
- `two-of-three`：措辞、不对称、章节序三信号里两票才算（杠杆②③的合成形态）

**它不改任何产出**，只读审表与审计文件算数。要不要按某条规则改产出，
是看完数字之后的决定，不是这个脚本的事。

## 审表怎么填

生成的表里每条边末尾是 `方向对吗：[ ]`。填 `[✓]`（方向对）或 `[✗]`（方向错），
其余留空的当作**没审**，不进分母。判据只有一句：一个完全没接触过「前置」的人，
直接去学「目标」的材料，会不会卡住？
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: 审表里一条边的抬头：`**3. 系统配置参数 → 运维与查询优化**（引用 4 次，反向 0 次）  方向对吗：[✓]`
_ROW = re.compile(
    r"^\*\*\d+\.\s*(?P<prereq>.+?)\s*→\s*(?P<target>.+?)\*\*.*?方向对吗：\[(?P<mark>.)\]",
    re.M,
)
_YES = {"✓", "v", "V", "y", "Y", "对", "1"}
_NO = {"✗", "x", "X", "n", "N", "错", "0"}


def read_labels(sheet: Path) -> dict[tuple[str, str], bool]:
    """审表 → {(前置, 目标): 方向对不对}。没填的不进结果，也就不进分母。"""
    out: dict[tuple[str, str], bool] = {}
    for m in _ROW.finditer(sheet.read_text(encoding="utf-8")):
        mark = m.group("mark").strip()
        if mark in _YES:
            out[(m.group("prereq"), m.group("target"))] = True
        elif mark in _NO:
            out[(m.group("prereq"), m.group("target"))] = False
    return out


def read_edges(intake: Path) -> list[dict]:
    """章级审计里的候选边。带 `intents` 的才能评措辞类规则——
    没有就说明这份审计是接 `intents` 之前跑的，得重跑接入链的 ④。"""
    f = intake / "prereq_chapter_audit.json"
    if not f.exists():
        raise SystemExit(f"找不到 {f}")
    return json.loads(f.read_text(encoding="utf-8")).get("edges", [])


def _intents(edge: dict) -> dict:
    return edge.get("intents") or {}


#: 四种规则。每个返回「这条边算不算数」。
RULES = {
    "baseline": lambda e: True,
    # 杠杆①：命中「详见」族的引用不计入证据强度，剩下的还够 MIN_LINKS 才算
    "seealso-filter": lambda e: (_intents(e).get("prereq", 0) + _intents(e).get("unknown", 0)) >= 2,
    # 更严的一版：只认「请先」族
    "prereq-only": lambda e: _intents(e).get("prereq", 0) >= 1,
    # 措辞 + 不对称 + 引用量，两票才算
    "two-of-three": lambda e: sum(
        (
            _intents(e).get("prereq", 0) >= 1,
            e.get("back_links", 0) == 0,
            e.get("links", 0) >= 4,
        )
    )
    >= 2,
}


def evaluate(edges: list[dict], labels: dict[tuple[str, str], bool], names: dict) -> None:
    labeled = []
    for e in edges:
        key = (
            names.get(e.get("prereq"), e.get("prereq")),
            names.get(e.get("target"), e.get("target")),
        )
        if key in labels:
            labeled.append((e, labels[key]))
    if not labeled:
        raise SystemExit(
            "审表里一条填过的边都没有——先把 `方向对吗：[ ]` 填成 [✓] / [✗] 再来。\n"
            "没填的不进分母，所以现在算出来的任何数都是空的。"
        )
    missing_intents = sum(1 for e, _ in labeled if not _intents(e))
    if missing_intents:
        print(
            f"⚠ {missing_intents}/{len(labeled)} 条边没有 intents 字段——"
            "这份审计跑在接 intents 之前，措辞类规则算不了。重跑接入链的 ④ 再来。\n"
        )

    print(f"已标注 {len(labeled)} 条（未填的不进分母）\n")
    print(f"{'规则':<16}{'留下':>6}{'其中方向对':>12}{'正确率':>10}{'漏掉的对边':>12}")
    for name, rule in RULES.items():
        kept = [(e, ok) for e, ok in labeled if rule(e)]
        right = sum(1 for _e, ok in kept if ok)
        dropped_good = sum(1 for e, ok in labeled if ok and not rule(e))
        rate = f"{right / len(kept):.0%}" if kept else "—"
        print(f"{name:<16}{len(kept):>6}{right:>12}{rate:>10}{dropped_good:>12}")
    print(
        "\n「漏掉的对边」是这条规则误杀的真前置。**宁可漏不可误**是当前口径"
        "（一条假前置会拦住本来能往下学的人），但漏太多就等于这一层没产出。"
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True, type=Path, help="填好的人工抽检表")
    ap.add_argument("--intake", required=True, type=Path, help="<库>_intake 目录")
    args = ap.parse_args()

    labels = read_labels(args.sheet)
    edges = read_edges(args.intake)
    audit = json.loads((args.intake / "prereq_chapter_audit.json").read_text(encoding="utf-8"))
    evaluate(edges, labels, audit.get("names", {}))


if __name__ == "__main__":
    main()
