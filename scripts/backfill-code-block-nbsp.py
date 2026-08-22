"""存量课的代码块脱 &nbsp;：空格换回真空格，缩进改由 white-space: pre-wrap 保。

为什么需要：生成链的两个代码块发射器（`lib/generation/md-to-elements.ts`、
`slide-templates.ts`）过去把代码里每个空格写成 `&nbsp;`。屏幕上看不出来，
但学习者复制下来的每个空格都是 U+00A0，粘进 Python 直接
`SyntaxError: invalid non-printable character U+00A0`（compile() 实测）。

发射器已改成 pre-wrap + 真空格，新生成的课干净了；已经落盘的课里 HTML 是烤死的，
只能回填。这是修链路之后补存量，不是拿修妆代替修链路。

做法是文本级替换，不走 JSON 反序列化——课程 JSON 由
`JSON.stringify(data, null, 2)` 写出且结尾无换行，Python 重新序列化会把整个文件
改一遍格式，diff 没法看。已核实全部 4052 处 `&nbsp;` 都落在
`defaultFontName == "Consolas"` 的代码元素里，正文一处没有，所以整文件替换安全。
（正文行内 `<code>` 用的是另一串 style，带 background，不会被误伤。）

用法：
  python scripts/backfill-code-block-nbsp.py            # 干跑，只报数
  python scripts/backfill-code-block-nbsp.py --write    # 真改，先备份到 tmp/
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COURSE_DIR = ROOT / "apps" / "classroom" / "data" / "classrooms"

# 课程 JSON 里引号是转义的，模式按转义后的样子写
OLD_STYLE = r'style=\"font-size: 14px; font-family: Consolas, monospace;\"'
NEW_STYLE = r'style=\"font-size: 14px; font-family: Consolas, monospace; white-space: pre-wrap;\"'


def bump_updated_at(raw: str, stamp: int) -> str:
    """把 stage.updatedAt 推到现在。

    不推的话这次回填只对新访客生效：load-classroom.ts 的新鲜度闸门是
    `serverAt > localAt` 严格大于，访问过这门课的浏览器会永远用 IndexedDB 里
    带 &nbsp; 的旧副本（这正是 08-10 排雷记的 #8 号雷，别再踩一次）。
    定位方式是「从 "stage" 往后找第一个 updatedAt」，不能图省事按文件里第一个换：
    落盘形态有两种坑——4 门课的 JSON 是单行的，OrIuCbq0Lw 的 stage.updatedAt 还是
    ISO 串而不是整数，按 `"updatedAt":\\s*\\d+` 找会命中某个场景的时间戳。
    场景各自的 updatedAt 不动。
    """
    i = raw.find('"stage"')
    if i == -1:
        return raw
    m = re.compile(r'"updatedAt"\s*:\s*(?:\d+|"[^"]*")').search(raw, i)
    if not m:
        return raw
    return raw[: m.start()] + f'"updatedAt": {stamp}' + raw[m.end() :]


def fix_raw(raw: str, stamp: int) -> tuple[str, dict]:
    """与 slide-templates.ts 的 codeLineHtml 同口径。"""
    stats = {
        "style": raw.count(OLD_STYLE),
        "blank": raw.count(">&nbsp;<"),
        "nbsp": raw.count("&nbsp;"),
    }
    out = raw.replace(OLD_STYLE, NEW_STYLE)
    # 空行占位：空 <p> 会塌成 0 高，换 <br>（PPTX 导出正好走 breakLine 分支）
    out = out.replace(">&nbsp;<", "><br><")
    out = out.replace("&nbsp;", " ")
    return bump_updated_at(out, stamp), stats


def verify(text: str, path: Path) -> None:
    """改完必须仍是合法 JSON，且代码元素里不再有 &nbsp;。"""
    data = json.loads(text)
    leftover = [0]

    def walk(node):
        if isinstance(node, dict):
            content = node.get("content")
            if isinstance(content, str) and "&nbsp;" in content:
                leftover[0] += content.count("&nbsp;")
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    if leftover[0]:
        raise SystemExit(f"{path.name}: 回填后仍残留 {leftover[0]} 处 &nbsp;，已中止")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="真写盘（默认只干跑）")
    parser.add_argument("--dir", default=str(COURSE_DIR))
    args = parser.parse_args()

    courses = sorted(Path(args.dir).glob("*.json"))
    if not courses:
        print(f"没找到课程：{args.dir}")
        return 1

    backup = None
    if args.write:
        backup = ROOT / "tmp" / f"course-backup-nbsp-{datetime.now():%Y%m%d-%H%M%S}"
        backup.mkdir(parents=True, exist_ok=True)

    stamp = int(datetime.now().timestamp() * 1000)
    touched = total = 0
    for path in courses:
        raw = path.read_text(encoding="utf-8")
        if "&nbsp;" not in raw and OLD_STYLE not in raw:
            continue
        fixed, stats = fix_raw(raw, stamp)
        verify(fixed, path)
        touched += 1
        total += stats["nbsp"]
        print(
            f"  {path.stem:<16} style {stats['style']:>3}  空行 {stats['blank']:>3}"
            f"  NBSP {stats['nbsp']:>4}"
        )
        if args.write:
            shutil.copy2(path, backup / path.name)
            path.write_text(fixed, encoding="utf-8", newline="")

    print(f"\n{'已改' if args.write else '待改（干跑）'}：{touched} 门课，{total} 处 NBSP")
    if backup:
        print(f"备份：{backup}")
    else:
        print("加 --write 才会真改。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
