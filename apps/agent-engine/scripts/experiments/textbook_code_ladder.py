r"""三档代码形态的外部尺子：拿真实教材配套源码校准，不自己拍。

    python scripts/experiments/textbook_code_ladder.py

## 为什么要这一份

2026-08-13 实测：一个自述「完全不懂技术、没写过代码」的学员，拿到的摘录是
`import numpy` + `def query(...)` + `np.array(...)`。**行数没超我们设的 5 行上限，
形态整段超纲。** 当时我的第一反应是把行数上限调更小——那是拍脑袋。

用户给的四份配套源码是外部尺子：教材作者已经替我们回答了「学到哪一步该见什么代码」。
按难度排开量一遍，就能得到一条**有出处的**形态阶梯，而不是我们自选的阈值。

## 语料（用户自购/自学材料，只读不入库、不进交付包）

- `python入门`  ——《Python 编程：从入门到实践》（蟒蛇书）配套源码，按章分目录
- `鱼书1`       ——《深度学习入门：基于 Python 的理论与实现》
- `从零构建大模型` ——《Build a Large Language Model (From Scratch)》
- `gpt-2`       —— OpenAI GPT-2 官方实现

路径写死在下面 SOURCES 里：它们在用户桌面而不在仓库内，**不复制进仓库**
（版权纪律：书只进书目背书，源码不入库）。路径不存在就跳过并说明。
"""

from __future__ import annotations

import argparse
import re
import statistics as st
from pathlib import Path

#: 按难度从低到高排。同一本书的「入门段」与「全书」分两行——它们之间的差
#: 正好是 beginner 与 transition 的分界，只量全书会把这一档抹掉。
#: scripts/experiments/ → scripts/ → apps/agent-engine/ → apps/ → 仓库根（四层）
_REPO = Path(__file__).resolve().parents[4]

SOURCES: list[tuple[str, Path]] = [
    ("蟒蛇书 1-6 章（入门段）", Path(r"D:\UserData\Desktop\python入门")),
    ("蟒蛇书 全书", Path(r"D:\UserData\Desktop\python入门")),
    # 仓库里已有的配套源码，不用另外下载
    ("笨办法学 Python v2", _REPO / "references" / "learn-python-the-smart-way-v2"),
    ("动手学深度学习 d2l-zh", _REPO / "references" / "d2l-zh-main"),
    ("Happy-LLM", _REPO / "references" / "happy-llm-main"),
    ("tiny-universe 白盒实现", _REPO / "references" / "tiny-universe"),
    ("鱼书1 深度学习入门", Path(r"D:\UserData\Desktop\鱼书1")),
    ("从零构建大模型", Path(r"D:\UserData\Desktop\从零构建大模型")),
    ("GPT-2 官方实现", Path(r"D:\UserData\Desktop\gpt-2")),
]

STRUCT = {
    "import": re.compile(r"^\s*(?:from\s+\S+\s+import\s|import\s)", re.M),
    "def": re.compile(r"^\s*def\s", re.M),
    "class": re.compile(r"^\s*class\s", re.M),
    "decorator": re.compile(r"^\s*@\w", re.M),
}
SKIP_DIRS = (".idea", ".vs", ".vscode", ".git", "__pycache__", "node_modules")


def measure(files: list[Path]) -> dict | None:
    rows = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        code = [ln for ln in text.splitlines() if ln.strip()]
        if not code:
            continue
        commented = sum(
            1 for ln in code if ln.strip().startswith("#") or ("#" in ln and not ln.strip().startswith("#"))
        )
        rows.append({
            "lines": len(code),
            "comment_ratio": commented / len(code),
            **{k: bool(rx.search(text)) for k, rx in STRUCT.items()},
        })
    if not rows:
        return None
    ln = [r["lines"] for r in rows]
    return {
        "files": len(rows),
        "median_lines": st.median(ln),
        "mean_lines": st.mean(ln),
        "max_lines": max(ln),
        "pct_le5": sum(1 for x in ln if x <= 5) / len(ln),
        "pct_le10": sum(1 for x in ln if x <= 10) / len(ln),
        "median_comment": st.median(r["comment_ratio"] for r in rows),
        **{k: sum(r[k] for r in rows) / len(rows) for k in STRUCT},
    }


def collect(root: Path, chapters: range | None = None) -> list[Path]:
    if chapters is not None:
        out: list[Path] = []
        for i in chapters:
            for pat in (f"chapter_{i:02d}", f"ch{i:02d}", f"ch{i}"):
                out += list((root / pat).rglob("*.py"))
        if out:
            return out
    return [p for p in root.rglob("*.py") if not any(d in p.parts for d in SKIP_DIRS)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    results: list[tuple[str, dict]] = []
    for label, root in SOURCES:
        if not root.is_dir():
            print(f"跳过 {label}：路径不存在 {root}")
            continue
        chapters = range(1, 7) if "入门段" in label else None
        stats = measure(collect(root, chapters))
        if stats:
            results.append((label, stats))

    if not results:
        print("没有可量的语料")
        return 1

    print(f"{'语料':<26}{'文件':>6}{'行中位':>7}{'≤5行':>7}{'≤10行':>7}{'注释比':>7}"
          f"{'import':>8}{'def':>7}{'class':>7}")
    print("-" * 88)
    for label, s in results:
        print(f"{label:<26}{s['files']:>6}{s['median_lines']:>7.0f}"
              f"{s['pct_le5']:>7.0%}{s['pct_le10']:>7.0%}{s['median_comment']:>7.2f}"
              f"{s['import']:>8.0%}{s['def']:>7.0%}{s['class']:>7.0%}")

    print("\n读法：教材作者已经替我们回答了「学到哪一步该见什么代码」。")
    print("入门段 import/def/class 全为 0——这不是长度问题，是形态问题；")
    print("越往后 class 占比越高，那才是 advanced 档「生产形态」的出处。")

    if args.json:
        import json

        args.json.write_text(
            json.dumps({label: s for label, s in results}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
