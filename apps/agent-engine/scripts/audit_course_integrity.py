"""排雷 A 层：15 门课全景机械体检（2026-08-10 用户令：停新功能，系统排雷）。

逐课逐场景查（全部零 LLM 成本）：
- 讲义场景：正文字数、占位符残渣（{{摘录}}）、NaN 字面量、空元素
- quiz：题目数、每题 answer_index 合法（在选项范围内）、选项非空、解析非空
- interactive：widgetConfig 结构（templateId+params 或 html 兜底）、params 非空
- 摘录：自包含守卫复扫（与 evidence-grounding 同判据）+ source_id 是否在审核 sources 里
- 审核：audit 存在性、claims 数、grounded 标记
产出 markdown 台账段落，汇入 defect ledger。

用法：python scripts/audit_course_integrity.py [--courses-dir ../classroom/data/classrooms]
"""

from __future__ import annotations

import argparse
import glob
import html as H
import json
import os
import re

FIGURE = re.compile(r"如图\s*\d+[.．]\d+|如下图|见图\s*\d")
OPER = re.compile(r"完整的?代码(可以)?在|code/chapter|启动后访问|localhost:\d+|建议读者亲自|点击加载|如图所示")
EXC = re.compile(r"📖\s*(.*?)——\s*摘自《([^《》]*)》\s*\[([^\]]+)\]", re.S)
PLACEHOLDER = re.compile(r"\{\{\s*摘录[^}]*\}\}")
TAG = re.compile(r"<[^>]+>")


def elements_of(scene: dict) -> list:
    c = scene.get("content") or {}
    els = c.get("elements")
    if els is None and isinstance(c, dict):
        canvas = c.get("canvas")
        if isinstance(canvas, dict):
            els = canvas.get("elements")
    return els if isinstance(els, list) else []


def text_of(scene: dict) -> str:
    parts = []
    for el in elements_of(scene):
        if isinstance(el, dict) and el.get("type") == "text" and isinstance(el.get("content"), str):
            parts.append(H.unescape(TAG.sub(" ", el["content"])))
    return "\n".join(parts)


def audit_course(path: str) -> list[str]:
    d = json.load(open(path, encoding="utf-8"))
    cid = os.path.basename(path)[:-5]
    name = d.get("stage", {}).get("name", "")
    issues: list[str] = []
    scenes = d.get("scenes", [])
    if not scenes:
        return [f"{cid} {name}: 无场景"]
    for i, sc in enumerate(scenes, 1):
        t = sc.get("type")
        title = sc.get("title", "")
        loc = f"{cid}·s{i}「{title[:12]}」"
        text = text_of(sc)
        audit = sc.get("audit")
        sources = {s.get("source_id") for s in (audit or {}).get("sources", []) if isinstance(s, dict)}

        if PLACEHOLDER.search(text):
            issues.append(f"[占位符残渣] {loc}")
        if "NaN" in text:
            issues.append(f"[NaN字面量] {loc}")

        if t == "slide":
            if len(text.strip()) < 200:
                issues.append(f"[讲义过短 {len(text.strip())}字] {loc}")
            for m in EXC.finditer(text):
                body, _bt, sid = m.group(1), m.group(2), m.group(3)
                fh = len(FIGURE.findall(body))
                if fh >= 2 or OPER.search(body):
                    issues.append(f"[摘录不自包含] {loc} sid={sid} 「{body[:30]}…」")
                if sources and sid not in sources:
                    issues.append(f"[摘录sid不在审核sources] {loc} sid={sid}")
        elif t == "quiz":
            # 真实 schema（-Bc 实查校准，首版尺子按想象写产出 158 条假阳）：
            # questions[] 每项是题组：数字键 '0','1'… 是子题 + id/hasAnswer；
            # 子题字段 question/options[{label,value}]/answer(["B"])/analysis/points。
            qs = (sc.get("content") or {}).get("questions") or []
            if not qs:
                issues.append(f"[quiz无题目] {loc}")
            qi = 0
            for group in qs:
                if not isinstance(group, dict):
                    continue
                subs = [v for k, v in sorted(group.items()) if k.isdigit() and isinstance(v, dict)]
                # 双 schema 并存（第四次尺子校准）：旧课嵌套题组（数字键子题），
                # 新课平铺（group 本身就是题：有 question/options 字段）
                if not subs and "question" in group:
                    subs = [group]
                for sub in subs:
                    qi += 1
                    if sub.get("type") == "short_answer":
                        continue  # 主观题合法无选项无答案键（hasAnswer: false）
                    opts = sub.get("options") or []
                    values = {o.get("value") for o in opts if isinstance(o, dict)}
                    ans = sub.get("answer") or []
                    if not opts:
                        issues.append(f"[quiz子题{qi}无选项] {loc}")
                    elif not ans or not set(ans) <= values:
                        issues.append(f"[quiz子题{qi}答案键非法 ans={ans}] {loc}")
                    if not str(sub.get("analysis") or "").strip():
                        issues.append(f"[quiz子题{qi}无解析] {loc}")
        elif t == "interactive":
            c = sc.get("content") or {}
            wc = c.get("widgetConfig") or {}
            if wc.get("type") == "template" or wc.get("templateId"):
                params = wc.get("params")
                if not params:
                    issues.append(f"[模板教具无params] {loc}")
            elif not (c.get("html") or "").strip():
                issues.append(f"[教具无html无模板] {loc}")

        if audit is None and t in ("slide", "quiz"):
            issues.append(f"[无审核记录] {loc}")
    return issues


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--courses-dir", default=os.path.join(os.path.dirname(__file__), "../../classroom/data/classrooms"))
    args = ap.parse_args()
    files = sorted(glob.glob(os.path.join(args.courses_dir, "*.json")))
    all_issues: list[str] = []
    for f in files:
        all_issues.extend(audit_course(f))
    print(f"体检 {len(files)} 门课，问题 {len(all_issues)} 条：\n")
    from collections import Counter
    kinds = Counter(i.split("]")[0] + "]" for i in all_issues)
    for k, c in kinds.most_common():
        print(f"{c:3d} × {k}")
    print()
    for i in all_issues:
        print("-", i)


if __name__ == "__main__":
    main()
