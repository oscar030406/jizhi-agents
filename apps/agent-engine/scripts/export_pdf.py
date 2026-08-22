r"""把 export_course.py 产出的 *.print.html 渲染成可下载的 *.pdf。

为什么走 headless chromium：PDF 里要嵌中文字体、要保留打印 CSS 的版式，
纯 Python/JS 的 PDF 库做 CJK 既重又容易缺字；chromium 的打印引擎是现成且正确的。
这是**构建期**步骤（产物是静态文件，随提交包/前端 public 一起发），不进运行时。

依赖：playwright（`pip install playwright && playwright install chromium`）。
没装就明确报错退出，不静默糊弄。

用法：python scripts\export_pdf.py [--exports dist\exports]
读该目录下所有 *.print.html，同名写出 *.pdf。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exports", type=Path, default=ROOT / "dist" / "exports")
    args = ap.parse_args()

    htmls = sorted(args.exports.glob("*.print.html"))
    if not htmls:
        print(f"没有 *.print.html：先跑 export_course.py --all --out {args.exports}")
        raise SystemExit(1)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("需要 playwright：pip install playwright && playwright install chromium")
        raise SystemExit(2)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        for html in htmls:
            out = html.with_name(html.name.replace(".print.html", ".pdf"))
            # file:// 让 chromium 直接读本地 HTML；打印 CSS 自动生效（print media）
            page.goto(html.resolve().as_uri())
            page.pdf(path=str(out), print_background=True)
            print(f"✅ {out.name}  ({out.stat().st_size // 1024} KB)")
        browser.close()


if __name__ == "__main__":
    main()
