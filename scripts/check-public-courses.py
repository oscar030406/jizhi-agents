"""公共课程墙落盘课的两道体检 + 一道完整性检查。

课程墙的课是未登录也能读的门面，出门前必须过：
  ① 媒体与外链——本机生成的课里如果有 localhost / 127.0.0.1 / blob: 地址，
     迁到线上就是死链（服务端生成的媒体 URL 是绝对地址，见
     lib/server/classroom-media-generation.ts）。
  ② 密钥——课程 JSON 是模型产物，提示词回声、报错回显都可能把 key 带进正文。
  ③ 完整性——没有场景、没有审核记录的课不该上墙（卡面角标会是空的）。

用法：
  python scripts/check-public-courses.py
  python scripts/check-public-courses.py --dir apps/classroom/data/classrooms
退出码非 0 = 有课不合格，别发布。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "apps" / "classroom" / "data" / "classrooms"

# 迁移后会失效的地址。相对路径（/api/...）不算问题。
# 只查"整个字段值就是一个地址"的情况：讲义正文里出现 http://localhost:7860
# （教材里 Gradio 的访问地址）是课程内容，不是死链——按正文全文扫会误判。
DEAD_HOSTS = re.compile(r"^(?:https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+)[:/]|blob:)", re.I)

SECRET_PATTERNS = [
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), "疑似 API key（sk- 开头）"),
    (re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{16,}"), "疑似 Bearer token"),
    (re.compile(r"[A-Z_]*(?:API_KEY|SECRET|PASSWORD|TOKEN)\s*[=:]\s*['\"]?[A-Za-z0-9._\-]{12,}"),
     "疑似密钥赋值"),
]

# data: 图片是自包含的、迁移不会坏，但体积会把课程 JSON 撑大，超过阈值提醒。
DATA_URL_WARN_BYTES = 200_000


def check_course(path: Path) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    raw = path.read_text(encoding="utf-8")

    for pattern, label in SECRET_PATTERNS:
        hits = pattern.findall(raw)
        if hits:
            errors.append(f"{label} ×{len(hits)}")

    data_urls = re.findall(r"data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+", raw)
    heavy = [u for u in data_urls if len(u) > DATA_URL_WARN_BYTES]
    if heavy:
        warnings.append(f"内联 data URL 超 {DATA_URL_WARN_BYTES // 1000}KB ×{len(heavy)}")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [f"JSON 解析失败：{exc}"], warnings

    dead: list[str] = []

    def walk(node, path: str) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}[{i}]")
        elif isinstance(node, str) and DEAD_HOSTS.match(node.strip()):
            dead.append(f"{path} = {node.strip()[:80]}")

    walk(data, "$")
    for item in dead:
        errors.append(f"迁移后会失效的地址：{item}")

    # 摘录占位符必须在生成期就被换成教材原文（injectExcerpts）。漏到落盘的课里，
    # 学习者会直接看到 {{摘录:ha08s03#s3}} 这种字面量——讲稿里出现过（注入只走板书
    # 正文，不走 actions）。
    leftovers = raw.count("{{摘录")
    if leftovers:
        errors.append(f"残留未注入的摘录占位符 ×{leftovers}")

    scenes = data.get("scenes") or []
    if not scenes:
        errors.append("没有任何场景")
    if not (data.get("stage") or {}).get("name"):
        errors.append("stage.name 缺失（卡面标题会退成 id）")

    audited = [s for s in scenes if s.get("audit")]
    if not audited:
        errors.append("全课没有审核记录（课程卡的审核角标会整块缺失）")
    elif len(audited) < len(scenes):
        warnings.append(f"仅 {len(audited)}/{len(scenes)} 个场景带审核记录")

    claims = sum(int(s["audit"].get("totalClaims") or 0) for s in audited)
    if audited and claims == 0:
        warnings.append("审核记录里断言数为 0（角标会显示 0 条断言）")

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    args = parser.parse_args()

    directory = args.dir if args.dir.is_absolute() else ROOT / args.dir
    if not directory.is_dir():
        print(f"课程目录不存在：{directory}")
        return 1

    files = sorted(directory.glob("*.json"))
    if not files:
        print(f"课程目录是空的：{directory}")
        return 1

    failed = 0
    for path in files:
        errors, warnings = check_course(path)
        status = "FAIL" if errors else ("WARN" if warnings else "OK")
        size_kb = path.stat().st_size / 1024
        print(f"[{status}] {path.name} ({size_kb:.0f} KB)")
        for item in errors:
            print(f"    ✗ {item}")
        for item in warnings:
            print(f"    ! {item}")
        failed += bool(errors)

    print(f"\n{len(files)} 门课，{failed} 门不合格")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
