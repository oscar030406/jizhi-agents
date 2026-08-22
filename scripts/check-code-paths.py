"""扫代码里的文件路径构造，报告指向不存在位置的那些。

目录重排之后，硬编码路径不会报错，只会在真正跑到那行时才炸。这个脚本把它们提前找出来。

用法：
    python scripts/check-code-paths.py            # 只报告
    python scripts/check-code-paths.py --verbose  # 连同已通过的一起列
    python scripts/check-code-paths.py --selftest # 只跑层级换算的自检
"""

import ast
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERBOSE = "--verbose" in sys.argv

SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".next", ".venv", "venv",
    "dist", "build", ".turbo", ".pytest_cache", ".serena", ".claude",
}
# references/ 是第三方仓库，它们的内部路径不归我们管；
# tmp/ 是临时区（备份、跑批中间产物），里面的副本路径必然对不上，不算错；
# docs/archive/ 是快照，旧路径是历史记录本来就该停在原样（与 check-docs-paths.py 同口径）。
SKIP_TOPLEVEL = {"references", "tmp"}
SKIP_PREFIX = ("docs/archive/",)

# Python: ROOT.parent / "x" / "y"、Path("x/y")
PY_PATH_CHAIN = re.compile(r'((?:ROOT|REPO|BASE|HERE|ENGINE)(?:\.parents?\[\d\]|\.parent)*)\s*((?:/\s*"[^"]+"\s*)+)')
PY_SEGMENT = re.compile(r'"([^"]+)"')

# JS/TS: 绝对路径字面量
ABS_LITERAL = re.compile(r"['\"](D:/UserData/Desktop/[^'\"]+)['\"]")


# 每个文件里 ROOT/REPO/... 自己是怎么定义的，必须读出来，不能靠目录名猜。
# 猜的下场：backend/api/routes.py 的 ROOT 是 parents[2]，猜成包根就会把
# 全部正常路径报成"不存在"。
ROOT_DEF = re.compile(
    r"^\s*(ROOT|REPO|BASE|HERE|ENGINE)\s*=\s*Path\(__file__\)"
    r"(?:\.resolve\(\))?((?:\.parents?\[\d\]|\.parent)*)",
    re.M,
)


def levels_up(chain: str) -> int:
    """接在 `Path(__file__)` 后面时往上走几层——**起点是文件所在目录**。

    `Path(__file__).parents[0]` 就是文件所在目录，所以从「文件所在目录」这个起点算，
    `.parents[N]` 只要再往上 N 层。`.parent` 算 1 层。
    """
    n = chain.count(".parent") - len(re.findall(r"\.parents\[", chain))
    n += sum(int(m) for m in re.findall(r"\.parents\[(\d)\]", chain))
    return n


def levels_up_from_dir(chain: str) -> int:
    """接在一个**目录**（ROOT 之类）后面时往上走几层。

    与 `levels_up` 差一层，这是实测踩出来的：`ROOT.parents[0]` 是 ROOT 的上一级，
    不是 ROOT 自己。按 `levels_up` 算会少走一层，把
    `ROOT.parents[0] / "classroom"`（真值 `apps/classroom/`，存在）
    错报成 `apps/agent-engine/classroom/`（不存在）——2026-08-17 这条规则一次报出
    3 处假断链，占当时报告的一半。
    """
    return levels_up(chain) + len(re.findall(r"\.parents\[", chain))


def selftest() -> None:
    """两套口径各自钉死。差一层的 bug 就是从这里漏过去的。"""
    # 接在 Path(__file__) 后：起点是文件所在目录
    assert levels_up(".parent") == 1
    assert levels_up(".parents[1]") == 1
    assert levels_up(".parents[2]") == 2
    assert levels_up(".parent.parent") == 2
    # 接在目录后：parents[0] 已经是上一级
    assert levels_up_from_dir(".parent") == 1
    assert levels_up_from_dir(".parents[0]") == 1
    assert levels_up_from_dir(".parents[1]") == 2
    assert levels_up_from_dir(".parent.parent") == 2
    print("selftest ok")


def base_of(expr: str, file_path: str, text: str) -> str | None:
    """把 ROOT.parent 这类表达式解析成真实目录；解析不了返回 None（跳过，不误报）。"""
    var = re.match(r"(ROOT|REPO|BASE|HERE|ENGINE)", expr)
    if not var:
        return None
    defs = {m.group(1): m.group(2) for m in ROOT_DEF.finditer(text)}
    if var.group(1) not in defs:
        return None
    cur = os.path.dirname(os.path.abspath(file_path))
    for _ in range(levels_up(defs[var.group(1)])):
        cur = os.path.dirname(cur)
    # 表达式自身再往上走的层数（起点已经是目录，用 from_dir 那套口径）
    tail = expr[len(var.group(1)):]
    for _ in range(levels_up_from_dir(tail)):
        cur = os.path.dirname(cur)
    return cur


if "--selftest" in sys.argv:
    selftest()
    sys.exit(0)

broken, ok, outputs = [], [], []


def classify(rel, line, expr, target):
    """路径不存在不一定是错：脚本要写的产物本来就还没生成。

    判据：目标本身存在 → 通过；目标不存在但父目录存在 → 当作输出路径，只记不报；
    父目录也不存在 → 真的断了。
    """
    entry = (rel, line, expr, os.path.relpath(target, ROOT))
    if os.path.exists(target):
        ok.append(entry)
    elif os.path.isdir(os.path.dirname(target)):
        outputs.append(entry)
    else:
        broken.append(entry)


for base, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    rel_base = os.path.relpath(base, ROOT).replace(os.sep, "/")
    if rel_base.split("/")[0] in SKIP_TOPLEVEL:
        continue
    if rel_base.startswith(SKIP_PREFIX):
        continue
    for f in files:
        if not f.endswith((".py", ".ts", ".tsx", ".mjs", ".js")):
            continue
        p = os.path.join(base, f)
        rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
        try:
            text = io.open(p, encoding="utf-8").read()
        except Exception:
            continue

        for m in PY_PATH_CHAIN.finditer(text):
            segs = PY_SEGMENT.findall(m.group(2))
            if not segs:
                continue
            # 带变量或通配的段跳过，只查纯字面量
            if any("{" in s or "*" in s for s in segs):
                continue
            root_dir = base_of(m.group(1), p, text)
            if root_dir is None:
                continue
            target = os.path.join(root_dir, *segs)
            line = text[: m.start()].count("\n") + 1
            classify(rel, line, m.group(0).strip()[:70], target)

        for m in ABS_LITERAL.finditer(text):
            target = m.group(1)
            # 项目外的绝对路径（外部数据集之类）不归我们管
            if not os.path.abspath(target).startswith(os.path.abspath(ROOT)):
                continue
            line = text[: m.start()].count("\n") + 1
            classify(rel, line, target[:70], target)

if VERBOSE:
    print(f"解析通过 {len(ok)} 处。\n")
    if outputs:
        print(f"输出路径 {len(outputs)} 处（父目录在，产物还没生成，正常）：")
        for rel, line, _, target in sorted(outputs):
            print(f"  {rel}:{line} -> {target}")
        print()

if broken:
    print(f"以下 {len(broken)} 处路径断了（连父目录都不存在）：\n")
    for rel, line, expr, target in sorted(broken):
        print(f"  {rel}:{line}")
        print(f"      {expr}")
        print(f"      -> {target}\n")
    sys.exit(1)

print(f"代码路径检查通过：{len(ok)} 处指向真实位置，{len(outputs)} 处是待生成的输出。")
