"""检查文档里写的路径是否真实存在。

搬过目录之后文档里的路径最容易烂掉，而且烂了不报错，接手的人照着敲才发现。
每次改完目录结构跑一遍：

    python scripts/check-docs-paths.py

覆盖范围：README + docs 下几份对外文档，加上 docs/05-evidence/ 与 docs/06-defense/
两个目录的全部 .md（验收一直拿这两个目录当证据）。docs/archive 是归档件，
里面的旧路径是历史记录，不算错，不查。

判据（2026-08-15 扩覆盖时按补充检查器踩过的误报补齐）：
- 以 `/` 开头的是 URL 路由不是文件，跳过；
- 带 glob、尖括号、省略号的是示意写法，跳过；
- 相对路径挨个 base 试（仓库根 / 文档自身目录 / apps/classroom / apps/agent-engine …）；
- 模块导入写法（`lib/quiz/grading`）补 .ts/.tsx/.py 再试一遍。
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TARGETS = [
    Path("README.md"),
    # 「接手指南.md」在 .claude/handoff/ 下，是 agent 工作文件不是项目文档，
    # 按纪律原地不动、靠 .gitignore 挡，不纳入本检查（2026-08-12）。
    Path("docs/README.md"),
    Path("docs/02-spec/product-provenance.md"),
    Path("docs/03-design/external-assets-index.md"),
]
for d in ("docs/05-evidence", "docs/06-defense"):
    TARGETS += sorted(p.relative_to(ROOT) for p in (ROOT / d).rglob("*.md"))

# 反引号里的内容；先取第一段（`path 说明` 这种写法只有前半是路径）
CODE = re.compile(r"`([^`\n]+)`")
LOOKS_LIKE_PATH = re.compile(r"^[\w.@\-]+(/[\w.@\[\]\-]+)+$")
# 绝对路径、URL、运行期产物，不算缺失
IGNORE = re.compile(r"^(https?:|[A-Za-z]:[\\/]|\.env|node_modules|localhost|127\.0\.0\.1)")
# 示意写法，不是真路径
SKIP_MARKS = ("//", "<", "…", "...", "*", "{", "$")

# 文档里的路径常常是相对某个 app 写的（如 lib/generation/xxx.ts 相对 apps/classroom）
BASES = ["", "apps/classroom", "apps/agent-engine", "apps/legacy-platform", "docs"]
# 模块导入写法没有后缀，补一遍
SUFFIXES = ["", ".ts", ".tsx", ".py", ".mjs", ".md"]


PRUNE = {"node_modules", ".next", ".git", ".venv", "__pycache__", "dist"}
# references/ 是第三方参考仓库的原样拷贝，路径照查，但不拿它内部的目录名当「仓库目录名」
# ——它下面有 Qwen/、Pro/ 之类，会把模型 ID `Qwen/Qwen3.6-35B-A3B` 误认成仓库路径。
NO_DIRNAME_HARVEST = "references"


def index_repo():
    """全仓相对路径索引（posix 形式）+ 出现过的目录名集合。

    文档里常写「相对某个上下文」的短路径（`runs/20260813-001359/verdicts.jsonl`
    实际在 apps/agent-engine/data/eval/adaptation_probe/ 下），穷举 base 会没完没了，
    所以用后缀命中。同时收集目录名：首段不是仓库里任何目录名的，根本不是仓库路径
    （npm 包 `@dicebear/core`、模型 ID `Qwen/Qwen3.6-35B-A3B`、二选一写法 `find/replace`），
    直接不判。
    """
    paths, dirnames = set(), set()
    for p in ROOT.rglob("*"):
        parts = p.relative_to(ROOT).parts
        if PRUNE & set(parts):
            continue
        paths.add(p.relative_to(ROOT).as_posix())
        if p.is_dir() and (len(parts) == 1 or parts[0] != NO_DIRNAME_HARVEST):
            dirnames.add(p.name)
    return paths, dirnames


PATHS, DIRNAMES = index_repo()


def exists(cand: str, doc_dir: Path) -> bool:
    for base in [ROOT / b for b in BASES] + [doc_dir]:
        for suf in SUFFIXES:
            if (base / (cand + suf)).exists():
                return True
    for suf in SUFFIXES:
        tail = "/" + cand + suf
        if any(p.endswith(tail) for p in PATHS):
            return True
    return False


bad = []
nonrepo_samples = []
checked = skipped_url = skipped_nonrepo = 0

for rel in TARGETS:
    path = ROOT / rel
    if not path.exists():
        bad.append((rel, "<文档本身不存在>"))
        continue
    text = path.read_text(encoding="utf-8")
    for raw in CODE.findall(text):
        cand = raw.strip().split()[0] if raw.strip() else ""
        cand = cand.split("#")[0]                      # 锚点
        cand = re.sub(r":\d+(-\d+)?$", "", cand)       # file.ts:42 行号
        cand = cand.rstrip(",;:)）（").rstrip("/")
        cand = re.sub(r"^(\.\./)+", "", cand)          # ../x 一律按仓库内解析
        if not cand or any(s in cand for s in SKIP_MARKS) or IGNORE.match(cand):
            continue
        if cand.startswith("/"):                       # URL 路由，不是文件
            skipped_url += 1
            continue
        if not LOOKS_LIKE_PATH.match(cand):
            continue
        if cand.split("/")[0] not in DIRNAMES:   # 首段不是仓库里的目录名 ⇒ 不是仓库路径
            skipped_nonrepo += 1
            nonrepo_samples.append((rel, cand))
            continue
        checked += 1
        if not exists(cand, path.parent):
            bad.append((rel, cand))

print(f"检查 {len(TARGETS)} 份文档：{checked} 条候选路径（另跳过 {skipped_url} 条 URL 路由、{skipped_nonrepo} 条非仓库写法）")

if bad:
    print("\n以下路径在文档里写着但磁盘上不存在：\n")
    for doc, p in bad:
        print(f"  {doc}  ->  {p}")
    print(f"\n共 {len(bad)} 处。")
    sys.exit(1)

if "-v" in sys.argv:
    print("\n跳过的非仓库写法（人工复核用）：")
    for doc, c in nonrepo_samples:
        print(f"  {doc}  ->  {c}")

print("文档里的路径全部存在。")
