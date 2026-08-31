#!/usr/bin/env python
"""对外数字位对账：扫对外文档里的每个数字，比对 `metrics.json`，报作废值命中。

## 为什么有这个脚本

交付纪律要求「扫描脚本化，每次重新打包都跑」。那条纪律原本只有一半——
`scripts/repo_hygiene_scan.py` 扫 AI 痕迹与密钥。**这是缺的另一半：数字。**

手工扫必漏，而且改一次口径就要重扫一遍。2026-08-24 那次改口径
（「事实性」改名「有据率」）+ 换读数（体检重跑）+ 清假账（成本表 ¥0）之后，
需要确认没有作废读数渗进对外材料——那一次是手工加脚本混着做的，
这里把它固化下来。

## 扫什么、不扫什么

**扫**：仓库根 README、`apps/*/README.md`、`docs/06-defense/` 下全部 `.md`。
这些是「评委会读到」的面。

**不扫**（明写出来，免得下个人以为扫了）：

- `docs/05-evidence/` 与 `docs/04-research/`：内部证据文档，本来就该出现
  中间读数与作废值（它们记的是「这个数为什么作废」）。扫了全是噪声。
- `apps/classroom/public/skill-map.json`：`/skills` 公开页的构建期快照，
  197 个数值字段是岗位需求分布这类市场数据，与实验指标无交叉引用。
  **它确实缺过期检测**（语料重建后 chunks 数会失真），但那是另一件事，
  别混进这个脚本装作扫过了。
- `.pptx`：二进制，要解压扫 slide XML。`--pptx` 单独开，默认不扫——
  它慢且容易误报（图表数据点会被当数字）。

## 怎么加一条作废值

改 `STALE` 那张表：键是数字的字面形态，值是一句人话说明它为什么作废、
现在应该是多少。**说明是给三个月后的人看的**，写「旧值」等于没写。
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
METRICS = ROOT / "apps/agent-engine/data/metrics.json"

#: 会被评委读到的面。加新的对外文档记得加进来。
SURFACES = [
    "README.md",
    "apps/agent-engine/README.md",
    "apps/classroom/README.md",
    "docs/06-defense/*.md",
]

#: 已作废的读数：出现在对外文档里就要报。值写清「为什么废、现在是多少」。
STALE: dict[str, str] = {
    "1529": "主语料旧块数；2026-08-24 补齐 175 块后是 1704",
    "0.753": "SM 接入体检旧读数（引擎松口径「事实性」），且未标小样本",
    "0.823": "iotdb 接入体检旧读数；体检重跑后 0.927（同为松口径）",
    "0.573": "iotdb 重投批按有据率算的值，只在解释两套口径差时用，不作对外指标",
    # 2026-08-24 泛化域定稿换届后作废的一批（Odoo 删除、iotdb 重投、旧五库口径退役）
    "0.848": "Odoo 域接地率；该域已删除，正式泛化端换届为智能制造+iotdb",
    "0.594": "iotdb 域旧接地率「待解释项」；已归因（量具污染+检索挑块）并修复，只在讲归因过程时引用",
    "3046": "Odoo 语料块数；该域已删除",
    "3202": "iotdb 旧库块数；重投后 2716",
    "531": "旧五库体检断言合计；五库口径退役，新口径为两泛化库分列",
}


#: 逐处豁免：某个作废值在某份文件里被允许出现（引用它只为讲清它为什么作废）。
#: 键是 (文件名, 数字字面)，值是理由。豁免一处必须写理由——没有理由的豁免不收。
ALLOW: dict[tuple[str, str], str] = {
    ("design-implementation.md", "0.594"): "§7.4 归因叙述：讲旧落差如何被查明修复，必须给出原数",
    ("slide14.xml", "0.594"): "PPT 泛化页归因行：同上，讲修复故事需要原数",
}


def allowed(fname: str, num: str) -> bool:
    return (fname, num) in ALLOW

#: 冻结指标：不许被新读数覆盖，出现处必须带口径。这里只清点不判对错——
#: 口径注记是不是齐全要人看，脚本判不了「这句话算不算口径」。
FROZEN = {
    "2.1%": "幻觉率（576 条可核断言 / 12 条判无据，断言级三判官多数决）",
    "85.2%": "画像-资源难度适配准确率（95% CI 77.8–92.6，n=108）",
    "96.0%": "核心知识点覆盖率（六门金标课 48/50，金标生成前冻结）",
}

#: 数字字面量。前后不许粘连字母数字，避免把版本号、DOI 切碎。
NUM = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?%?)(?![\w])")


def surfaces() -> list[Path]:
    out: list[Path] = []
    for pat in SURFACES:
        out.extend(sorted(ROOT.glob(pat)) if "*" in pat else [ROOT / pat])
    return [p for p in out if p.is_file()]


def known_values() -> dict[str, list[str]]:
    """`metrics.json` 里每个指标值的几种写法 → 指标 id。"""
    data = json.loads(METRICS.read_text(encoding="utf-8"))["metrics"]
    idx: dict[str, list[str]] = {}
    for key, spec in data.items():
        val = spec.get("value")
        if val is None:
            continue
        unit = spec.get("unit") or ""
        for form in {f"{val}", f"{val}{unit}"}:
            idx.setdefault(form, []).append(key)
    return idx


def scan_text(path: Path, text: str) -> list[tuple[int, str, str]]:
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if not s or s.startswith("<!--"):
            continue
        for m in NUM.finditer(s):
            hits.append((lineno, m.group(1), s[:110]))
    return hits


def scan_pptx(path: Path) -> list[tuple[str, str, str]]:
    """解压扫 slide XML。默认不跑（`--pptx` 开）——慢，且图表数据点会被当数字。"""
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not name.startswith("ppt/slides/slide"):
                continue
            txt = re.sub(r"<[^>]+>", "", z.read(name).decode("utf-8", "ignore"))
            for m in NUM.finditer(txt):
                i = m.start()
                out.append((name.rsplit("/", 1)[-1], m.group(1), txt[max(0, i - 40) : i + 30]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="对外数字位对账（只报不改）")
    ap.add_argument("--pptx", action="store_true", help="连答辩 PPT 一起扫（慢，易误报）")
    args = ap.parse_args()

    known = known_values()
    files = surfaces()
    all_hits: list[tuple[Path, int, str, str]] = []
    for f in files:
        for lineno, num, line in scan_text(f, f.read_text(encoding="utf-8")):
            all_hits.append((f, lineno, num, line))

    print(f"扫了 {len(files)} 份对外文档，{len(all_hits)} 处数字")
    print("不扫：docs/05-evidence、docs/04-research、skill-map.json、.pptx（见模块头）\n")

    stale_hits = [h for h in all_hits if h[2] in STALE and not allowed(h[0].name, h[2])]
    print(f"=== 作废读数命中：{len(stale_hits)} 处 ===")
    for f, lineno, num, line in stale_hits:
        print(f"  {f.relative_to(ROOT)}:{lineno}  {num}")
        print(f"      {STALE[num]}")
        print(f"      {line}")
    if not stale_hits:
        print("  （无）")

    frozen_hits = [h for h in all_hits if h[2] in FROZEN]
    seen: dict[str, int] = {}
    for _, _, num, _ in frozen_hits:
        seen[num] = seen.get(num, 0) + 1
    print(f"\n=== 冻结指标清点（口径注记要人看，脚本不判）===")
    for num, note in FROZEN.items():
        print(f"  {num:<8} {seen.get(num, 0)} 处   {note}")
    missing = [n for n in FROZEN if n not in seen]
    if missing:
        print(f"  ⚠ 这几个冻结指标在对外文档里一处都没有：{'、'.join(missing)}")
        print("    可能是被改写了，也可能这份文档本来就不谈它——人看一眼。")

    if args.pptx:
        deck = ROOT / "docs/06-defense/集智答辩-v7-销冠版.pptx"
        if deck.is_file():
            pptx_hits = [h for h in scan_pptx(deck) if h[1] in STALE and not allowed(h[0], h[1])]
            print(f"\n=== PPT 作废读数命中：{len(pptx_hits)} 处 ===")
            for slide, num, ctx in pptx_hits:
                print(f"  {slide}  {num}  …{ctx.strip()}…")
            if not pptx_hits:
                print("  （无）")

    if stale_hits:
        print("\n✗ 有作废读数渗进对外文档，逐条核过再打包。")
        return 1
    print("\n✓ 对外文档没有作废读数。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
