"""量一遍我们自己出过的课有多大，把结果写成一份可复算的统计快照。

我们要回答的问题只有一个：**「学完这个目标至少要花多久」这句话，凭什么这么说。**
不凭拍脑袋——凭 `apps/classroom/data/classrooms/*.json` 里已经出过的课的实测体量。

口径（照着读就能复算）：

- **可读字数**：幻灯片文本元素（去 HTML 标签）+ 口播 `speech.text` + 讨论 `topic/prompt`
  + 测验题干/选项/解析。不含 id、样式、坐标这类非阅读内容。
- **字数 → 分钟**：除以 390 字/分钟。这个数不是我们定的：Brysbaert 2019
  (*Journal of Memory and Language* 109:104047, 190 项研究 / 18,573 人) 报告中文默读
  260 wpm（26 项研究中 18 项为默读），并声明中文按 1.5 字/词换算，260 × 1.5 = 390 字/分钟。
- **所以算出来的是下限，不是估计值**：260 wpm 是该文中文各体裁的合并值（同文英语默读
  非虚构 238 wpm < 虚构 260 wpm，说明非虚构更慢），而我们的正文带公式、代码与图，比
  普通非虚构更慢；而且这个口径只算读，不算做题、不算动手、不算回看。
  真实耗时只会比它长。用它当「至少需要 X」的下限刚好，用它当预估会低报。

用法（在 `apps/agent-engine` 下）：

    python scripts/measure_course_volume.py            # 写 data/course_volume_stats.json
    python scripts/measure_course_volume.py --print    # 只打印不落盘
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from datetime import date
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = ROOT.parent / "classroom" / "data" / "classrooms"
DEFAULT_OUT = ROOT / "data" / "course_volume_stats.json"

# Brysbaert 2019, JML 109:104047：中文默读 260 wpm × 1.5 字/词。见模块 docstring。
CHARS_PER_MINUTE = 390.0
RATE_SOURCE = (
    "Brysbaert 2019, Journal of Memory and Language 109:104047，"
    "中文默读 260 wpm × 该文声明的 1.5 字/词换算 = 390 字/分钟"
)

_TAG = re.compile(r"<[^>]+>")


def _text_chars(value: str | None) -> int:
    """去掉 HTML 标签和空白后的可读字符数。"""
    if not value:
        return 0
    return len(re.sub(r"\s+", "", _TAG.sub("", value)))


def _quiz_questions(content: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """测验题存在 `questions[i]` 的数字键下（0/1/2…），不是数组。"""
    for block in content.get("questions") or []:
        if not isinstance(block, dict):
            continue
        for key, item in block.items():
            if key.isdigit() and isinstance(item, dict):
                yield item


def measure_course(course: dict[str, Any]) -> dict[str, Any]:
    scenes = course.get("scenes") or []
    chars = 0
    questions = 0
    for scene in scenes:
        content = scene.get("content") or {}
        chars += _text_chars(scene.get("title"))
        for element in (content.get("canvas") or {}).get("elements", []):
            chars += _text_chars(element.get("content"))
        for action in scene.get("actions") or []:
            chars += _text_chars(action.get("text"))
            chars += _text_chars(action.get("topic"))
            chars += _text_chars(action.get("prompt"))
        for question in _quiz_questions(content):
            questions += 1
            chars += _text_chars(question.get("question"))
            chars += _text_chars(question.get("analysis"))
            for option in question.get("options") or []:
                chars += _text_chars(option.get("label"))
    return {
        "id": course.get("id") or (course.get("stage") or {}).get("id"),
        "name": (course.get("stage") or {}).get("name", ""),
        "scenes": len(scenes),
        "chars": chars,
        "quiz_questions": questions,
        "read_minutes": round(chars / CHARS_PER_MINUTE, 2),
    }


def _repo_relative(path: Path) -> str:
    """写进快照的路径要能在别人机器上读懂，所以存仓库相对路径。"""
    path = path.resolve()
    repo = ROOT.parents[1]
    try:
        return path.relative_to(repo).as_posix()
    except ValueError:
        return path.as_posix()


def measure_dir(data_dir: Path) -> dict[str, Any]:
    courses = []
    for path in sorted(data_dir.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload.get("scenes"):
            courses.append(measure_course(payload))
    if not courses:
        raise SystemExit(f"没量到任何课：{data_dir}")

    minutes = sorted(c["read_minutes"] for c in courses)
    scenes = sorted(c["scenes"] for c in courses)
    per_scene = sorted(c["read_minutes"] / c["scenes"] for c in courses if c["scenes"])
    return {
        "measured_on": date.today().isoformat(),
        "source_dir": _repo_relative(data_dir),
        "script": "apps/agent-engine/scripts/measure_course_volume.py",
        "chars_per_minute": CHARS_PER_MINUTE,
        "chars_per_minute_source": RATE_SOURCE,
        "caveat": "只算读，不算做题与动手；速率取合并默读值。因此这些分钟数是下限，不是耗时预估。",
        "course_count": len(courses),
        "read_minutes": {
            "min": minutes[0],
            "p25": round(statistics.quantiles(minutes, n=4)[0], 2) if len(minutes) >= 4 else minutes[0],
            "median": round(statistics.median(minutes), 2),
            "max": minutes[-1],
        },
        "scenes": {"min": scenes[0], "median": statistics.median(scenes), "max": scenes[-1]},
        "read_minutes_per_scene": {"median": round(statistics.median(per_scene), 2)},
        "courses": courses,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DEFAULT_DATA_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--print", dest="print_only", action="store_true")
    args = parser.parse_args()

    stats = measure_dir(args.data)
    text = json.dumps(stats, ensure_ascii=False, indent=2)
    if args.print_only:
        print(text)
        return
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text + "\n", encoding="utf-8")
    print(f"{stats['course_count']} 门课已量完 → {args.out}")
    print(json.dumps(stats["read_minutes"], ensure_ascii=False))


if __name__ == "__main__":
    main()
