r"""提交包组织器（v4 §4.1/§4.2）：按赛题第七节清单结构生成 dist/submission/。

赛题要求（docs/saiti_close_reading.md §提交形式）：
  测试数据 = ≥1 垂直领域知识库切片 + ≥2 组差异化学情数据源
             （输入画像特征 + 多智能体协同决策中间数据 + 最终生成资源的完整输入输出示例）
  软件模块 = 源码 + 部署说明 + 单元测试用例（按"协同调度逻辑/生成准确性"归档）

用法：python scripts\build_submission_package.py [--output dist\submission]
可重复执行（幂等重建）。视频与 PPT 由人工放入 materials/ 目录。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# demo runs 的真源在引擎自己的 data/ 下。原先指向 legacy-platform/web-next/data/demo-runs，
# 那个 app 2026-08-01 退役后目录整个没了——`if demo_dir.is_dir()` 直接假，学情数据一份没拷
# 也不报错，包照出。这类静默空包比报错难发现，所以改指真源。
DEMO_RUNS = ROOT / "data" / "demo_runs"

# 单元测试归档：协同调度逻辑 vs 生成准确性（赛题点名两类）
SCHEDULING_TESTS = [
    "test_workflow", "test_feedback", "test_learner_state", "test_ablation",
    "test_tutor_service", "test_compare_service", "test_gateway", "test_model_routing",
]
ACCURACY_TESTS = [
    "test_claims", "test_eval", "test_fact_invariance", "test_difficulty_calibration",
    "test_exam_paper", "test_curriculum", "test_quiz", "test_retrieval", "test_cost_meter",
    "test_job_skill_map", "test_adversarial",
]


def classify_tests() -> dict[str, list[str]]:
    groups: dict[str, list[str]] = {"协同调度逻辑": [], "生成准确性与评测": [], "其他": []}
    for path in sorted((ROOT / "tests").glob("test_*.py")):
        stem = path.stem
        if any(stem.startswith(p) for p in SCHEDULING_TESTS):
            groups["协同调度逻辑"].append(path.name)
        elif any(stem.startswith(p) for p in ACCURACY_TESTS):
            groups["生成准确性与评测"].append(path.name)
        else:
            groups["其他"].append(path.name)
    return groups


def build(output: Path) -> None:
    if output.exists():
        shutil.rmtree(output)
    (output / "materials").mkdir(parents=True)
    (output / "software").mkdir()
    (output / "test_data").mkdir()

    # ---------------- 测试数据：知识库切片
    kb_dst = output / "test_data" / "knowledge_base_slice"
    kb_dst.mkdir()
    for name in ("knowledge_index.jsonl", "sources_manifest.csv", "concept_graph.json", "ATTRIBUTION.md"):
        src = ROOT / "data" / "knowledge_base" / name
        if src.is_file():
            shutil.copy2(src, kb_dst / name)

    # ---------------- 测试数据：差异化学情数据源（完整输入输出示例）
    # demo-runs 是真实引擎产物：输入画像 + 全部 Agent trace（中间决策数据）+ 最终资源
    runs_dst = output / "test_data" / "learner_scenarios"
    runs_dst.mkdir()
    demo_dir = DEMO_RUNS
    copied = 0
    if demo_dir.is_dir():
        for f in sorted(demo_dir.glob("*.json")):
            if f.name == "manifest.json":
                continue
            shutil.copy2(f, runs_dst / f.name)
            copied += 1
        manifest = demo_dir / "manifest.json"
        if manifest.is_file():
            shutil.copy2(manifest, runs_dst / "manifest.json")

    # ---------------- 测试数据：造课工坊事件轨（多智能体协同决策中间数据的生产侧样本）
    # 每条轨=一次真实造课的完整事件流：检索/生成/引用门禁拦截/判官打回判词/重写/插话吸收/过闸
    studio_dst = output / "test_data" / "course_studio_runs"
    studio_src = ROOT / "data" / "studio_runs"
    if studio_src.is_dir():
        studio_dst.mkdir()
        for f in sorted(studio_src.glob("*.jsonl")):
            shutil.copy2(f, studio_dst / f.name)
        (studio_dst / "README.md").write_text(
            "# 造课工坊事件轨\n\n每行一个事件（JSON）：多智能体造课的完整中间决策数据——\n"
            "检索供料、生成、引用门禁拦截、独立判官打回（含判词）、重写、观看者插话注入、过闸审计。\n"
            "回放：web-next /studio 页「回放示范场」。\n", encoding="utf-8")

    # ---------------- 岗位调研（模块一：场景与适配的量化依据）
    research_dst = output / "materials" / "job_market_research"
    research_dst.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT.parent.parent / "docs" / "02-spec" / "job_market_research.md", research_dst / "job_market_research.md")
    jd_assets = ROOT.parent.parent / "docs" / "assets" / "jd"
    if jd_assets.is_dir():
        shutil.copytree(jd_assets, research_dst / "charts", dirs_exist_ok=True)
    scripts_src = ROOT / "scripts" / "jd_research"
    if scripts_src.is_dir():
        shutil.copytree(scripts_src, output / "software" / "research_scripts", dirs_exist_ok=True)

    # ---------------- 测试数据：评测集与消融结果
    eval_dst = output / "test_data" / "evaluation"
    eval_dst.mkdir()
    for rel in ("eval/gold_v2", "eval/ablation", "eval/difficulty_calibration.json"):
        src = ROOT / "data" / rel
        if src.is_dir():
            shutil.copytree(src, eval_dst / Path(rel).name)
        elif src.is_file():
            shutil.copy2(src, eval_dst / src.name)

    # ---------------- 软件模块：单测归档清单 + 部署说明指引
    groups = classify_tests()
    total = sum(len(v) for v in groups.values())
    lines = [
        "# 单元测试用例归档（赛题点名两类）",
        "",
        f"共 {total} 个测试文件（`python -m pytest -q` 一键全量）。",
        "",
    ]
    for group, files in groups.items():
        lines.append(f"## {group}（{len(files)}）")
        lines += [f"- tests/{f}" for f in files]
        lines.append("")
    (output / "software" / "UNIT_TESTS.md").write_text("\n".join(lines), encoding="utf-8")

    (output / "software" / "README.md").write_text(
        "# 软件模块\n\n"
        "- 源码：私有仓库（评审权限开放方式见材料文档；亦可用本包外层源码快照）\n"
        "- 部署说明：见仓库 README 与 docs/（双服务起法、断网演示路径）\n"
        "- 单元测试：UNIT_TESTS.md 归档清单，`python -m pytest -q` 一键运行\n"
        "- 评测复算：docs/evaluation_protocol.md（每个指标一条命令）\n",
        encoding="utf-8")

    (output / "materials" / "README.md").write_text(
        "# 材料文档（人工放入）\n\n- 作品设计实现方案\n- 作品介绍\n- 演示视频（≤10 分钟，"
        "按赛题三段：画像输入→协同可视化→资源生成闭环）\n- 经审核通过的参赛报名表扫描件\n",
        encoding="utf-8")

    # ---------------- 课程导出件（教师可直接拿走改的 Word / Markdown / 打印版）
    export_dst = output / "course_exports"
    export_dst.mkdir(parents=True, exist_ok=True)
    exported = 0
    try:
        sys.path.insert(0, str(ROOT / "scripts"))
        from export_course import export as export_course  # noqa: E402

        for course_file in sorted((ROOT / "data" / "curriculum").glob("*.json")):
            if course_file.stem == "catalog":
                continue
            exported += len(export_course(course_file.stem, export_dst,
                                          ["md", "docx", "html"], keep_citations=True))
    except Exception as exc:  # 导出失败不该拖垮打包，但要显式记账
        (export_dst / "EXPORT_FAILED.txt").write_text(str(exc), encoding="utf-8")
    (export_dst / "README.md").write_text(
        "\n".join([
            "# 课程导出件",
            "",
            "每门课三种格式：",
            "",
            "- `*.md` Markdown，纯文本可直接改",
            "- `*.docx` Word，标准库手写 OOXML，Word/WPS 可直接打开编辑",
            "- `*.print.html` 打印版，浏览器打开后 Ctrl/⌘+P 选「另存为 PDF」",
            "",
            "重新生成：`python scripts/export_course.py --all --out dist/exports`",
        ]) + "\n",
        encoding="utf-8")

    # ---------------- 顶层清单与自检
    checks = {
        "课程导出文件数": exported,
        "知识库切片文件数": len(list(kb_dst.iterdir())),
        "差异化学情数据源组数": copied,
        "评测目录项数": len(list(eval_dst.iterdir())),
        "单元测试文件数": total,
    }
    problems = []
    if copied < 2:
        problems.append(f"学情数据源不足 2 组（现 {copied}）")
    if checks["知识库切片文件数"] < 3:
        problems.append("知识库切片文件缺失")
    (output / "PACKAGE_MANIFEST.json").write_text(
        json.dumps({"checks": checks, "problems": problems}, ensure_ascii=False, indent=2),
        encoding="utf-8")

    print(json.dumps(checks, ensure_ascii=False))
    if problems:
        print("⚠ 缺项：", "；".join(problems))
        raise SystemExit(1)
    print(f"✅ 提交包结构就绪 → {output}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist" / "submission")
    args = parser.parse_args()
    build(args.output)


if __name__ == "__main__":
    main()
