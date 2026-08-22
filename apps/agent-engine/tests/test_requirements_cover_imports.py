"""代码里 import 的第三方包，必须在 requirements.txt 里登记。

## 为什么要有这条

2026-08-23：`pymupdf` 漏登记，线上 venv 从来没装过，**PDF 抽取在生产一直是
缺包降级**。而本地一切正常——三本教材判扫描件的测试是绿的、模块文档写得很细、
实测数据也是真的，唯独没人验证过服务器上有没有这个包。

这类问题最恶心的地方是它不报错：`extract_pdf` 里 `import fitz` 失败会走
`return PdfText("", 0, "环境里没装 PyMuPDF…")` 的降级分支，于是所有 PDF
都被记成「抽不出正文」，看起来和「这本书是扫描件」一模一样。

单测抓不到（本地装着），线上冒烟测也抓不到（返回 200、run 正常建）。
只能靠这条静态检查：**扫代码里的 import，比对 requirements**。
"""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: import 名 → 包名（不一致的才写这里）。
DISTRIBUTION_OF = {
    "fitz": "pymupdf",
    "sklearn": "scikit-learn",
    "yaml": "pyyaml",
    "dotenv": "python-dotenv",
    "PIL": "pillow",
}

#: 只在离线脚本里用、不进生产运行时的包。它们缺了顶多是某个分析脚本跑不了，
#: 不会让线上服务静默降级——所以不强制登记，但列在这里表示「知道它没登记」。
#: 往这里加东西前先问一句：这个 import 会不会出现在 `backend/` 的运行路径上？
#: 会的话不许进这个名单，老老实实写进 requirements。
OFFLINE_ONLY = {
    "pandas",      # scripts/jd_research/ 岗位数据分析
    "matplotlib",  # 同上，出图
    "duckdb",      # 同上，查招聘数据集
    "pypdf",       # scripts/ingest_interview_bank.py 离线导库
    "playwright",  # scripts/export_pdf.py 出交付 PDF
}

#: 本仓库自己的顶层包，不算第三方。
LOCAL_ROOTS = {"backend", "app", "scripts", "tests"}


def _sibling_modules() -> set[str]:
    """`scripts/` 下的兄弟脚本互相 import 时用的是裸模块名（`import ingest_domain`），
    看起来和第三方包一模一样。按盘上实际有没有这个 .py 判断，不靠命名猜。"""
    return {p.stem for p in (ROOT / "scripts").rglob("*.py")}


def _third_party_imports() -> dict[str, set[str]]:
    """扫 backend/ 与 scripts/ 的顶层 import，返回 {包名: {出现的文件}}。"""
    found: dict[str, set[str]] = {}
    siblings = _sibling_modules()
    for path in [*(ROOT / "backend").rglob("*.py"), *(ROOT / "scripts").rglob("*.py")]:
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                names = [(node.module or "").split(".")[0]] if node.level == 0 else []
            else:
                continue
            for name in names:
                if (
                    not name
                    or name in LOCAL_ROOTS
                    or name in sys.stdlib_module_names
                    or name in siblings
                ):
                    continue
                found.setdefault(DISTRIBUTION_OF.get(name, name), set()).add(
                    path.relative_to(ROOT).as_posix()
                )
    return found


def _declared() -> set[str]:
    text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    out: set[str] = set()
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name = re.split(r"[<>=!~\[]", line, maxsplit=1)[0].strip()
        if name:
            # pip 把 - 和 _ 视作等价，比对时统一
            out.add(name.lower().replace("_", "-"))
    return out


def test_每个第三方import都在requirements里() -> None:
    declared = _declared()
    missing = {
        pkg: sorted(files)
        for pkg, files in _third_party_imports().items()
        if pkg.lower().replace("_", "-") not in declared and pkg not in OFFLINE_ONLY
    }
    assert not missing, (
        "这些包被 import 了但没登记在 requirements.txt——线上装不上就会走降级分支，"
        f"而降级往往是静默的：{missing}"
    )


def test_pymupdf这条不许再掉() -> None:
    """单独钉住踩过的那个。"""
    assert "pymupdf" in _declared(), "pymupdf 漏登记过一次，导致 PDF 抽取在生产静默降级"
