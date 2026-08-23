r"""数字扰动回归集构建：从课堂课程 JSON 抽含数字断言的正文句，程序化生成扰动对。

背景：审核链对数字型断言有盲区（NumPert 思路——翻转数值/单位/因果后果，量检出率）。
本脚本**只建集不跑判官**，产物供旁路上线前后对照用。

用法：python scripts\build_numeric_perturbation_set.py
产物：data/eval/numeric_perturbation_set.jsonl（每行：原句/扰动句/扰动类型/source_id）
      data/eval/numeric_perturbation_set.README.md
日志：data/eval/numeric_perturbation_build.log
可重跑：无随机性（遍历顺序固定、逐文件配额），重跑覆盖产物。
"""
from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 课程产物在 classroom 侧；本地没有时按顺序找备胎
CANDIDATE_COURSE_DIRS = [
    ROOT.parents[1] / "apps" / "classroom" / "data" / "classrooms",
    ROOT / "data" / "classrooms",
    ROOT.parents[1] / "trial_courses",
]
OUT_PATH = ROOT / "data" / "eval" / "numeric_perturbation_set.jsonl"
README_PATH = ROOT / "data" / "eval" / "numeric_perturbation_set.README.md"
LOG_PATH = ROOT / "data" / "eval" / "numeric_perturbation_build.log"

TARGET_PAIRS = 100          # 上限；下限 50，不够则报警
PER_FILE_QUOTA = 4          # 每个课程文件最多贡献的原句数，摊开覆盖面
MIN_LEN, MAX_LEN = 12, 160  # 句长过滤：太短没上下文，太长多半是代码块

# 数字+单位模式。只收无歧义单位，单字母（W/V/A/m）会误配 ID 和代码，不收。
UNIT_RE = re.compile(
    r"\d+(?:\.\d+)?\s*(?:ms|毫秒|秒|分钟|小时|天|%|％|倍|次|轮|步|层|维|个|条|道|"
    r"GB|MB|KB|token|tokens|epoch)"
)
CJK_RE = re.compile(r"[一-鿿]")
NUM_RE = re.compile(r"\d+(?:\.\d+)?")

# 三类扰动 ---------------------------------------------------------------

def perturb_value(s: str) -> str | None:
    """数值×2：只改句中第一个数字。"""
    m = NUM_RE.search(s)
    if not m:
        return None
    v = float(m.group())
    doubled = v * 2
    new = str(int(doubled)) if doubled == int(doubled) else f"{doubled:g}"
    out = s[: m.start()] + new + s[m.end():]
    return out if out != s else None

UNIT_SWAPS = [
    ("毫秒", "秒"), ("秒", "毫秒"), ("ms", "s"),
    ("分钟", "小时"), ("小时", "分钟"),
    ("GB", "MB"), ("MB", "GB"), ("KB", "MB"),
]

def perturb_unit(s: str) -> str | None:
    """单位替换：ms↔s 一类，只换第一处命中。"""
    for old, new in UNIT_SWAPS:
        # 单位必须紧跟数字，避免把正文词误换（如「秒懂」）
        pat = re.compile(r"(\d+(?:\.\d+)?\s*)" + re.escape(old))
        if pat.search(s):
            return pat.sub(lambda m: m.group(1) + new, s, count=1)
    return None

CONSEQUENCE_SWAPS = [
    ("大于", "小于"), ("小于", "大于"), ("高于", "低于"), ("低于", "高于"),
    ("增大", "减小"), ("减小", "增大"), ("增加", "减少"), ("减少", "增加"),
    ("上升", "下降"), ("下降", "上升"), ("升高", "降低"), ("降低", "升高"),
    ("更快", "更慢"), ("更慢", "更快"), ("变快", "变慢"), ("变慢", "变快"),
    ("越大", "越小"), ("越小", "越大"), ("越多", "越少"), ("越少", "越多"),
    ("提高", "降低"), ("超过", "低于"),
]

def perturb_consequence(s: str) -> str | None:
    """后果反转：大于→小于一类，只换第一处命中。"""
    for old, new in CONSEQUENCE_SWAPS:
        if old in s:
            return s.replace(old, new, 1)
    return None

PERTURBATIONS = [
    ("value_x2", perturb_value),
    ("unit_swap", perturb_unit),
    ("consequence_flip", perturb_consequence),
]

# 抽句 -------------------------------------------------------------------

def collect_strings(obj, out: list[str]) -> None:
    if isinstance(obj, dict):
        for v in obj.values():
            collect_strings(v, out)
    elif isinstance(obj, list):
        for v in obj:
            collect_strings(v, out)
    elif isinstance(obj, str) and len(obj) > MIN_LEN:
        out.append(obj)

def extract_sentences(path: Path) -> list[str]:
    raw: list[str] = []
    collect_strings(json.loads(path.read_text(encoding="utf-8")), raw)
    seen: list[str] = []
    for text in raw:
        text = re.sub(r"<[^>]+>", " ", text)  # 幻灯片元素里有 HTML
        for s in re.split(r"(?<=[。！？!?；;])", text):
            s = s.strip()
            if (
                MIN_LEN <= len(s) <= MAX_LEN
                and CJK_RE.search(s)          # 必须含中文，滤掉 ID/纯代码
                and UNIT_RE.search(s)
                and "def " not in s and "import " not in s  # 滤代码行
            ):
                seen.append(s)
    return seen

# 兜底示例句：所有课程目录都空时用（docs 语料风格的最小集）
FALLBACK_SENTENCES = [
    "接口响应超过 200 毫秒时用户会明显感到卡顿。",
    "学习率设为 0.1 时损失下降更快，但过大会震荡。",
    "该模型上下文窗口为 128 KB，超过后精度下降。",
    "重试 3 次仍失败则任务标记为不可恢复。",
    "批大小增大 2 倍后显存占用超过 24 GB。",
]

def main() -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8"),
                  logging.StreamHandler(sys.stdout)],
    )
    log = logging.getLogger("numpert")

    course_dir = next((d for d in CANDIDATE_COURSE_DIRS if d.is_dir() and any(d.glob("*.json"))), None)
    pairs: list[dict] = []
    global_seen: set[str] = set()

    if course_dir is None:
        log.warning("所有课程目录均为空（%s），退用内置示例句最小集", [str(d) for d in CANDIDATE_COURSE_DIRS])
        sources = [("fallback", FALLBACK_SENTENCES)]
    else:
        log.info("课程目录：%s", course_dir)
        sources = []
        for f in sorted(course_dir.glob("*.json")):
            sources.append((f.stem, extract_sentences(f)))

    for source_id, sentences in sources:
        used = 0
        for s in sentences:
            if len(pairs) >= TARGET_PAIRS or used >= PER_FILE_QUOTA:
                break
            if s in global_seen:
                continue
            made = False
            for ptype, fn in PERTURBATIONS:
                if len(pairs) >= TARGET_PAIRS:
                    break
                perturbed = fn(s)
                if perturbed and perturbed != s:
                    pairs.append({
                        "original": s,
                        "perturbed": perturbed,
                        "perturbation_type": ptype,
                        "source_id": source_id,
                    })
                    made = True
            if made:
                global_seen.add(s)
                used += 1

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        for p in pairs:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")

    by_type: dict[str, int] = {}
    for p in pairs:
        by_type[p["perturbation_type"]] = by_type.get(p["perturbation_type"], 0) + 1
    n_sources = len({p["source_id"] for p in pairs})
    log.info("产出 %d 对（目标 50-100）| 按类型 %s | 覆盖 %d 个来源文件", len(pairs), by_type, n_sources)
    log.info("写入 %s", OUT_PATH)
    if len(pairs) < 50:
        log.warning("不足 50 对，语料太薄，考虑放宽单位表或加课程源")

    README_PATH.write_text(
        f"""# 数字扰动回归集（numeric_perturbation_set.jsonl）

来源：{course_dir or '内置示例句'} 的课程正文句（数字+单位模式抽取）。
每行字段：original（原句，视为正确）/ perturbed（扰动句，视为植入错误）/
perturbation_type（value_x2 数值×2 | unit_swap 单位替换 | consequence_flip 后果反转）/
source_id（来源课程文件名）。

用法：审核链旁路上线前后，各跑一遍判官——把 original 和 perturbed 分别喂给审核，
统计「perturbed 被标错、original 未被误伤」的比例，即数字断言检出率与误报率。
本集只建不判，两次对照用同一份文件，别重新生成（重跑脚本会覆盖）。
重建：python scripts\\build_numeric_perturbation_set.py（确定性，无随机种子）。
""",
        encoding="utf-8",
    )
    log.info("README 写入 %s", README_PATH)

if __name__ == "__main__":
    main()
