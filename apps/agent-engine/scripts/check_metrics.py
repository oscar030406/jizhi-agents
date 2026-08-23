"""对外数字一致性校验（数字止血的执法器）。

三件事：
1. **引用一致**：metrics.json 里每个条目声明了它被哪些文档引用（citations），
   逐一检查那些文档里真的写着当前口径的数值。
2. **陈旧值扫描**：每个条目可列 stale_values（历史上写错/过期的数字），
   在全部关键文档里扫，扫到即失败——这就是 faithfulness 0.913 事故的疫苗。
3. **活值抽查**（--live）：对便宜可重算的指标真跑一遍 source 命令比对。
   默认不跑（run_eval 要几十秒），CI/verify_all 里带上。

写死的纪律：改数字的唯一方式是「重跑 → 改 metrics.json → 跑本脚本改所有引用处」。
文档里出现 metrics.json 没有的新指标数字不归本脚本管（管不过来），
但列进 stale_values 的旧数字永远别想再溜进文档。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
REPO = ENGINE.parents[1]
METRICS = ENGINE / "data" / "metrics.json"

# 陈旧值扫描的范围：对外材料所在的目录。全仓扫会误伤（代码/日志里满是数字）。
SCAN_DIRS = [
    REPO / "docs" / "05-evidence",
    REPO / "docs" / "06-defense",
    REPO / "docs" / "02-spec",
    # 2026-08-12 补两个盲区。清查发现 04-research 里四份文档还写着 75.9%，其中两处是
    # 「对外一律只报 75.9%」「88.9% 一个字都不能说」这样的**口径指令**——而 75.9% 早已
    # 进 stale_values、88.9% 是正式入账的次数字。执法器扫不到的地方，废数就能安静躺着。
    REPO / "docs" / "04-research",
    REPO / "docs" / "03-design",
    REPO / "README.md",
    ENGINE / "PLAYBOOK.md",
    # 前端页面也是对外材料：公共首页上印着数字，此前不受执法器管。
    REPO / "apps" / "classroom" / "app",
    REPO / "apps" / "classroom" / "components" / "home",
]

SCAN_SUFFIXES = ("*.md", "*.tsx")


def iter_scan_files():
    for p in SCAN_DIRS:
        if p.is_file():
            yield p
        elif p.is_dir():
            for pattern in SCAN_SUFFIXES:
                yield from p.rglob(pattern)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="真跑 source 命令抽查活值")
    args = parser.parse_args()

    data = json.loads(METRICS.read_text(encoding="utf-8"))
    metrics = data["metrics"]
    failures: list[str] = []

    # 1. 引用一致
    for mid, m in metrics.items():
        for cite in m.get("citations", []):
            path = REPO / cite["file"]
            if not path.exists():
                failures.append(f"[{mid}] 引用文件不存在：{cite['file']}")
                continue
            text = path.read_text(encoding="utf-8")
            if cite["must_contain"] not in text:
                failures.append(
                    f"[{mid}] {cite['file']} 里找不到当前口径数值「{cite['must_contain']}」——"
                    f"文档没跟上 metrics.json，或数字被改错了"
                )

    # 2. 陈旧值扫描
    #
    # 第二个盲区（2026-08-12 修）：stale_values 里存的常常是整句描述，例如
    # 「75.9%（41/54，run 20260810-172357，摘录代码上限未含裸代码检测，被本轮同口径复测取代）」。
    # 按整串子串匹配，文档里写的裸「75.9%」**永远匹配不上**——最需要拦的形态恰好拦不住。
    # 修法是扫描时从每条 stale_value 里抽出**数值部分**（首个数字 token）当匹配键，
    # 不动 metrics.json 的既有格式：那份文件是对外数字的真源，改 schema 要连带改每一条，
    # 而这里抽取是自维护的——以后新增条目照旧写整句，执法器自己会提取。
    stale_map: dict[str, str] = {}
    # 认得出 75.9% / 0.913 / 16/16 / 70.4%/66.7% 这几种写法的**数值头**
    numeric_head = re.compile(r"^\d+(?:\.\d+)?%?(?:/\d+(?:\.\d+)?%?)*")
    # 只对**测量记录**抽数值头：带 run id 或带分子分母的那些。
    # 「44.4%（v1 rubric 口径基线）」这种描述性条目不抽——它没有 run 也没有分母，
    # 不是会被抄进文档的形态，抽了反而会撞上别的实验里同值的格子（实测撞过一次）。
    is_measurement = re.compile(r"run[s]?[ /]|\d+/\d+")
    for mid, m in metrics.items():
        for sv in m.get("stale_values", []):
            stale_map[sv] = mid
            if not is_measurement.search(sv):
                continue
            head = numeric_head.match(sv.strip())
            # 只有三位以上字符才当键：单个「0」「1」这种会把整份文档扫成火海
            if head and len(head.group().rstrip("%")) >= 3:
                stale_map.setdefault(head.group(), mid)
    # 文件级豁免：数据表里的数字撞上陈旧值时，行内豁免用不上——
    # `| q6 | 4 | 0.250 | 0.300 | ... |` 这种行加不进「无关」两个字，加了就是把数据写脏。
    # 实测撞过一次：DINA 对账表里的 guess 参数 0.300 撞上 api_hallucination_v2 的陈旧值。
    # 所以给一个文件级出口，**必须点名指标 id 并写理由**——写不出理由的豁免不该给。
    #   <!-- check_metrics: 陈旧值豁免 api_hallucination_v2 理由：本文的 0.300 是 DINA 猜测率参数 -->
    exempt_re = re.compile(r"<!--\s*check_metrics:\s*陈旧值豁免\s+([\w,\s]+?)\s+理由：(.+?)-->")

    if stale_map:
        pattern = re.compile("|".join(re.escape(s) for s in stale_map))
        for f in iter_scan_files():
            text = f.read_text(encoding="utf-8", errors="replace")
            exempt_ids = {
                mid.strip()
                for m in exempt_re.finditer(text)
                for mid in m.group(1).split(",")
                if mid.strip()
            }
            for bad_id in exempt_ids - set(metrics):
                failures.append(
                    f"{f.relative_to(REPO)} 豁免了一个不存在的指标 id「{bad_id}」——"
                    "写错 id 的豁免会变成永久盲区"
                )
            for hit in set(pattern.findall(text)):
                if stale_map[hit] in exempt_ids:
                    continue
                # 两类豁免：
                # (1) 历史勘误语境——行内出现「作废/勘误/旧/曾/事故」等
                # (2) **别人的数字**——行内出现 arXiv / 论文 / et al. / 文献引用标记。
                #     2026-08-12 补：执法器抓到过三处 `0.717`，全是外部论文的 AUC 基线
                #     （人机协同 Q-matrix 精修那条），与我们的拦截率同值纯属巧合。
                #     噪音大的执法器等于没有执法器，宁可漏也不能天天误报。
                # 判违规的口径（2026-08-12 定）：**不是「出现了旧数字」就违规**——
                # 研究台账本来就要引它分析的那一批。真正的违规只有两种形态：
                #   ① 把旧数字说成现值（现值 / 当前 / 目前 / 最新）
                #   ② 裸报，不写是哪个 run 的
                # 写了 run id 的反而是我们要的写法，不该罚。
                lines = [ln for ln in text.splitlines() if hit in ln]
                bad = []
                for ln in lines:
                    if re.search(
                        r"作废|勘误|旧|曾|事故|历史|stale|已被|推翻|不成立|不可信|复现不了"
                        r"|arXiv|arxiv|论文|et al|文献|基线出处|vs|同值|巧合|无关",
                        ln,
                    ):
                        continue  # 历史勘误 / 引别人的 / 对比语境
                    claims_current = re.search(r"现值|当前|目前|最新", ln)
                    has_run = re.search(r"run[s]?\s*`?\d{8}-\d{6}", ln)
                    if claims_current or not has_run:
                        bad.append(ln)
                if bad:
                    failures.append(
                        f"[{stale_map[hit]}] 陈旧值「{hit}」出现在 {f.relative_to(REPO)}："
                        f"{bad[0].strip()[:80]}"
                    )

    # 3. 活值抽查（只抽 run_eval 这组，便宜且全确定性）
    if args.live:
        out = subprocess.run(
            [sys.executable, "scripts/run_eval.py", "--gold", "both"],
            cwd=ENGINE,
            capture_output=True,
            text=True,
            timeout=600,
        ).stdout
        live = {}
        for key, mid in [
            ("faithfulness", "det_faithfulness"),
            ("hallucination_rate", "det_hallucination_rate"),
            ("concept_coverage", "det_concept_coverage"),
        ]:
            mm = re.search(rf"^\s*{key}:\s*([\d.]+)", out, re.MULTILINE)
            if not mm:
                failures.append(f"[{mid}] 活值抽查：run_eval 输出里找不到 {key}")
                continue
            live[mid] = float(mm.group(1))
            declared = metrics[mid]["value"]
            tol = metrics[mid].get("tolerance", 0.005)
            if abs(live[mid] - declared) > tol:
                failures.append(
                    f"[{mid}] 活值漂移：metrics.json 写 {declared}，现跑出 {live[mid]}"
                    f"（容差 {tol}）。代码动了数字没跟——重跑确认后更新 metrics.json 与全部引用处"
                )
        if live:
            print(f"活值抽查：{ {k: v for k, v in live.items()} }")

    if failures:
        print(f"\n数字一致性校验 FAIL（{len(failures)} 处）：")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print(f"数字一致性校验通过：{len(metrics)} 个指标，引用与陈旧值扫描全绿。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
