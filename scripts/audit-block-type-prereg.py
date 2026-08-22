"""WO-L2 §补充的预注册检验：iotdb 的接地率落差是不是「语料多半不是散文」造成的。

两条假设照抄工单，判据在 iotdb 轮开跑前就写死（见工单「补充：iotdb 轮的预注册检验」）：

- **H1**：断言引「散文块」的 supported 率 > 引「输出表块」的。单尾 Fisher，α=0.05。
- **H2**：屏级无源率与该屏摘录池的散文块占比负相关。Spearman，双尾，α=0.05。
- **块类型判据**：以 ``` 围栏内字符占比 s、行首为 `+--` 或 `|` 的行占比 t 计，
  `s<0.2 且 t<0.1` 判散文；否则 `t>0.3` 判输出表；其余判代码。
- **证伪条件**：两条都不过，「语料非散文」这条解释作废，iotdb 的落差回到
  「真领域泛化差距」这个待解释项。出什么写什么。

工单没写死、由本脚本在 iotdb 轮（第 3 轮）**开跑之前**补定的一条，记在这里免得事后被当成
调过参：**一条断言同时引散文块和输出表块时，两组都不计入，另行报出被排除的条数**。
理由是 H1 比的是两类块的支持率，混引的断言归到哪一组都是替它选答案。

废屏剔除口径不自己另写一套，直接复用 `audit-grounding-scan.py::load_screens()` 的判定，
并在启动时逐屏对账——两边对不上就当场退出，免得两份口径偷偷分叉。

用法（项目根目录下）：

    python scripts/audit-block-type-prereg.py            # 默认 iotdb
    python scripts/audit-block-type-prereg.py --corpus odoo(rst) --detail
"""

from __future__ import annotations

import argparse
import glob
import importlib.util
import json
import os
import re
import sys

from scipy.stats import fisher_exact, spearmanr

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base", "intake_runs")
KB = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base")
#: 主语料 ai 的索引在 knowledge_base/ 根目录，领域库才各占 corpora/ 一个子目录。
#: 这条与 domain_intake.checkup_index_path() 同源，写死过一次就出过 0/49 的假结论。
MAIN_CORPUS = {"ai", "main", "default"}

FENCE = re.compile(r"^\s*(```|~~~)")
TABLE_LINE = re.compile(r"^\s*(\+--|\|)")


def classify(text: str) -> str:
    """散文 / 输出表 / 代码。判据来自工单，不许在这里调。"""
    lines = text.splitlines()
    fenced_chars = 0
    table_lines = 0
    in_fence = False
    for line in lines:
        if FENCE.match(line):
            in_fence = not in_fence
            fenced_chars += len(line)
            continue
        if in_fence:
            fenced_chars += len(line)
        elif TABLE_LINE.match(line):
            table_lines += 1
    s = fenced_chars / max(1, len(text))
    t = table_lines / max(1, len(lines))
    if s < 0.2 and t < 0.1:
        return "prose"
    if t > 0.3:
        return "table"
    return "code"


def load_blocks(corpus: str) -> dict[str, str]:
    """source_id → 块正文。索引路径按主库/领域库分流。"""
    name = corpus.split("(")[0].strip().lower()  # odoo(rst) → odoo
    path = (
        os.path.join(KB, "knowledge_index.jsonl")
        if name in MAIN_CORPUS
        else os.path.join(KB, "corpora", name, "knowledge_index.jsonl")
    )
    blocks: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            sid = rec.get("source_id")
            if sid:
                blocks[sid] = rec.get("content") or ""
    if not blocks:
        sys.exit(f"索引 {path} 一个块都没读出来——先查探测器再查数据")
    return blocks


def scan_load_screens() -> list[dict]:
    """借 audit-grounding-scan.py 的 load_screens()（文件名带连字符，只能按路径加载）。"""
    path = os.path.join(ROOT, "scripts", "audit-grounding-scan.py")
    spec = importlib.util.spec_from_file_location("_grounding_scan", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.load_screens()


def collect(corpus: str) -> list[dict]:
    """摊平成逐屏：断言、摘录池、废屏标记。剔废判据与 scan 对账后才用。"""
    usable = {
        (r["run"], r["tier"], r["scene"]): not r["unusable"]
        for r in scan_load_screens()
        if r["corpus"] == corpus
    }
    if not usable:
        sys.exit(f"scan 里没有 corpus={corpus} 的屏——域名写错了？（odoo 要写 odoo(rst)）")

    screens: list[dict] = []
    for run_dir in sorted(glob.glob(os.path.join(RUNS, "*"))):
        if not os.path.isdir(run_dir):
            continue
        try:
            run = json.load(open(os.path.join(run_dir, "run.json"), encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        rid = os.path.basename(run_dir)
        name = run.get("corpus", "?")
        if name == "odoo":
            name = "odoo(rst)" if rid >= "20260817" else "odoo(po旧)"
        if name != corpus:
            continue
        for path in glob.glob(os.path.join(run_dir, "trial_courses", "*.json")):
            if "kc_misses" in path:
                continue
            try:
                course = json.load(open(path, encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            tier = os.path.basename(path).replace(".json", "")
            for i, scene in enumerate(course.get("scenes", [])):
                audit = scene.get("audit") or {}
                claims = audit.get("claims") or []
                if not claims:
                    continue
                key = (rid, tier, i + 1)
                if key not in usable:
                    sys.exit(f"屏 {key} 在本脚本里有、在 scan 里没有——两边口径已分叉，停")
                screens.append({
                    "run": rid,
                    "tier": tier,
                    "scene": i + 1,
                    "usable": usable[key],
                    "claims": claims,
                    "sources": [s.get("source_id") for s in (audit.get("sources") or [])],
                })
    return screens


def h1(screens: list[dict], blocks: dict[str, str]) -> tuple[str, float | None]:
    """引散文块的断言 supported 率 vs 引输出表块的。单尾 Fisher。"""
    cell = {"prose": [0, 0], "table": [0, 0]}  # [supported, 其余]
    mixed = missing = 0
    for sc in screens:
        for c in sc["claims"]:
            sids = c.get("sourceIds") or []
            if not sids:
                continue
            kinds = set()
            for sid in sids:
                if sid not in blocks:
                    missing += 1
                    continue
                kinds.add(classify(blocks[sid]))
            if not kinds:
                continue
            # 「全引散文」「全引输出表」两组之外一律排除：只要掺了第二种块类型
            # （含代码块），这条断言归到哪一组都是替它选答案。
            if kinds == {"prose"} or kinds == {"table"}:
                kind = kinds.pop()
            else:
                mixed += 1
                continue
            cell[kind][0 if c.get("verdict") == "supported" else 1] += 1

    pn, po = cell["prose"]
    tn, to = cell["table"]
    print("H1 断言引散文块 vs 引输出表块的 supported 率（单尾 Fisher，α=0.05）")
    print(f"  散文  supported {pn}/{pn + po}" + (f" = {pn / (pn + po):.3f}" if pn + po else ""))
    print(f"  输出表 supported {tn}/{tn + to}" + (f" = {tn / (tn + to):.3f}" if tn + to else ""))
    print(f"  混引排除 {mixed} 条；索引里找不到的 sourceId {missing} 个")
    if min(pn + po, tn + to) == 0:
        print("  → 有一组是空的，Fisher 无从算起：H1 不成立（不是不显著，是没数据）\n")
        return "无数据", None
    p = fisher_exact([[pn, po], [tn, to]], alternative="greater")[1]
    verdict = "通过" if p < 0.05 else "不通过"
    print(f"  → p={p:.4f}  {verdict}\n")
    return verdict, p


def h2(screens: list[dict], blocks: dict[str, str]) -> tuple[str, float | None]:
    """屏级无源率 vs 该屏摘录池散文块占比。Spearman 双尾，预期负相关。"""
    xs: list[float] = []
    ys: list[float] = []
    rows = []
    for sc in screens:
        pool = [blocks[s] for s in sc["sources"] if s in blocks]
        if not pool:
            continue
        prose_ratio = sum(1 for b in pool if classify(b) == "prose") / len(pool)
        claims = sc["claims"]
        nosrc = sum(1 for c in claims if not (c.get("sourceIds") or [])) / len(claims)
        xs.append(prose_ratio)
        ys.append(nosrc)
        rows.append((sc["run"], sc["tier"], sc["scene"], len(pool), prose_ratio, nosrc))

    print("H2 屏级无源率 vs 摘录池散文块占比（Spearman 双尾，α=0.05，预期负相关）")
    for r in rows:
        print(f"  {r[0]} {r[1]:9s} 屏{r[2]} 池{r[3]:2d}块 散文占比 {r[4]:.3f} 无源率 {r[5]:.3f}")
    if len(xs) < 3:
        print(f"  → 只有 {len(xs)} 屏，Spearman 算不出来：H2 不成立（样本不足，不是不显著）\n")
        return "样本不足", None
    rho, p = spearmanr(xs, ys)
    verdict = "通过" if (p < 0.05 and rho < 0) else "不通过"
    print(f"  → n={len(xs)} ρ={rho:.3f} p={p:.4f}  {verdict}\n")
    return verdict, p


def selfcheck() -> None:
    """分类器先拿三个已知输入自证，再拿它下结论——产出为 0 先怀疑探测器。"""
    cases = [
        ("电子签名合法性指当地政府是否承认数字签署的文件。\n第二段普通行文。", "prose"),
        ("+----+----+\n| a  | b  |\n+----+----+\n| 1  | 2  |", "table"),
        ("```python\nfor i in range(10):\n    print(i)\n```", "code"),
    ]
    for text, want in cases:
        got = classify(text)
        assert got == want, f"分类器自证失败：{want} 判成了 {got}"
    print("分类器自证 3/3 通过（散文 / 输出表 / 代码）\n")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="iotdb", help="域名，odoo 要写 odoo(rst) 或 odoo(po旧)")
    ap.add_argument("--all-screens", action="store_true", help="连废屏一起算（只供对照，别引用）")
    args = ap.parse_args()

    selfcheck()
    blocks = load_blocks(args.corpus)
    screens = collect(args.corpus)
    if not args.all_screens:
        screens = [s for s in screens if s["usable"]]
    n_claims = sum(len(s["claims"]) for s in screens)
    print(f"域 {args.corpus}：{len(screens)} 屏、{n_claims} 条断言、索引 {len(blocks)} 块"
          + ("（含废屏）" if args.all_screens else "（已剔废屏）") + "\n")
    if not screens:
        sys.exit("没有可用屏——这一域还没跑体检，或全屏作废")

    v1, _ = h1(screens, blocks)
    v2, _ = h2(screens, blocks)

    print("预注册结论")
    print(f"  H1 {v1} ｜ H2 {v2}")
    if v1 != "通过" and v2 != "通过":
        print("  → 两条都不过：「语料非散文」这条解释作废，落差回到「真领域泛化差距」待解释项。")
    else:
        print("  → 至少一条通过，按上面各自的方向如实写，不要外推到没测的域。")


if __name__ == "__main__":
    main()
