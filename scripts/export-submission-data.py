"""提交包「测试数据」装配器（赛题提交形式第 3 项）。

产出两样：
  ① 知识库切片：领域文档 chunk 抽样 + 来源清单 + 版权署名；
  ② ≥2 组差异化学情数据：每组 = 输入画像 + 多智能体协同中间数据
     （诊断/检索/审核逐条判词/执行轨迹/辩论）+ 最终生成的个性化学习资源。

数据全部取自引擎归档 run（data/runs/*.json，本身就是完整 IO 快照），零模型调用。
挑选规则：不同画像各一组，优先真 LLM 生成（trace 里 ResourceGenerationAgent
engine=llm），排除确定性模板兜底（正文含「的证据要点：」）。

用法：python scripts/export-submission-data.py --out dist/submission-data
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "apps" / "agent-engine"
KB = ENGINE / "data" / "knowledge_base"
RUNS = ENGINE / "data" / "runs"

TEMPLATE_MARKER = "的证据要点："
KB_SLICE_CHUNKS = 60


def pick_runs() -> list[tuple[Path, dict]]:
    """每个画像挑一份最好的 run，至少凑齐两组差异化画像。"""
    best: dict[str, tuple[int, Path, dict]] = {}
    for path in sorted(RUNS.glob("*.json")):
        try:
            d = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(d, dict) or "resources" not in d or "learner_profile_id" not in d:
            continue
        body = json.dumps(d.get("resources", {}), ensure_ascii=False)
        gen_llm = any(
            step.get("agent") == "ResourceGenerationAgent"
            and str(step.get("artifacts", {}).get("engine")) == "llm"
            for step in d.get("trace", [])
        )
        # 打分：真 LLM 生成 +4；非模板正文 +2；带辩论回合 +1（协同中间数据更完整）
        score = (4 if gen_llm else 0) + (0 if TEMPLATE_MARKER in body else 2) + (1 if d.get("debate") else 0)
        pid = d["learner_profile_id"]
        if pid not in best or score > best[pid][0]:
            best[pid] = (score, path, d)
    ranked = sorted(best.values(), key=lambda t: -t[0])
    return [(p, d) for _, p, d in ranked]


def load_profiles() -> dict[str, dict]:
    path = ENGINE / "data" / "learner_profiles" / "learner_profiles.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data["profiles"] if isinstance(data, dict) and "profiles" in data else data
    return {p["id"]: p for p in items}


def export_kb_slice(out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    chunks = []
    with (KB / "knowledge_index.jsonl").open(encoding="utf-8") as fh:
        for line in fh:
            if not line.strip():
                continue
            chunks.append(json.loads(line))
            if len(chunks) >= KB_SLICE_CHUNKS:
                break
    (out / "knowledge_chunks_sample.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in chunks) + "\n", encoding="utf-8")
    for name in ("sources_manifest.csv", "ATTRIBUTION.md"):
        src = KB / name
        if src.exists():
            shutil.copy2(src, out / name)
    (out / "README.md").write_text(
        "# 知识库切片\n\n"
        f"- `knowledge_chunks_sample.jsonl`：领域知识库前 {KB_SLICE_CHUNKS} 个检索 chunk"
        "（全库结构相同，字段含 source_id / 标题 / 正文 / 概念标签 / 难度）。\n"
        "- `sources_manifest.csv`：全部语料来源清单。\n"
        "- `ATTRIBUTION.md`：开源教材署名与许可。\n\n"
        "说明：学情数据组引用的检索证据以 chunk 全文快照内嵌在各组\n"
        "`2-协同决策中间数据.json` 里（知识库此后经过重建，chunk 编号世代不同，\n"
        "以组内快照为准）。\n",
        encoding="utf-8")
    return len(chunks)


def export_learner_groups(out: Path, count: int) -> list[str]:
    profiles = load_profiles()
    runs = pick_runs()[:count]
    if len(runs) < 2:
        raise SystemExit(f"差异化画像不足两组（只找到 {len(runs)}），检查 {RUNS}")
    labels = []
    for i, (run_path, run) in enumerate(runs, start=1):
        pid = run["learner_profile_id"]
        profile = profiles.get(pid, {"id": pid})
        group = out / f"组{i}-{pid}"
        group.mkdir(parents=True, exist_ok=True)
        # 链条自洽断言：资源引用的每个 chunk 必须在中间数据的检索快照里能查到全文
        used = set((run.get("resources") or {}).get("used_sources") or [])
        chunk_ids = {c.get("source_id")
                     for c in (run.get("retrieval") or {}).get("retrieved_chunks", [])}
        if not used <= chunk_ids:
            raise SystemExit(f"{run_path.name}: used_sources 有 {used - chunk_ids} 不在检索快照内，链条断裂")
        (group / "1-输入画像.json").write_text(
            json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
        middle = {
            "learner_profile_id": pid,
            "source_run": run_path.name,
            "learning_goal": run.get("learning_goal"),
            "diagnosis": run.get("diagnosis"),
            "retrieval": run.get("retrieval"),
            "audit": run.get("audit"),
            "trace": run.get("trace"),
            "debate": run.get("debate"),
            "arbitration": run.get("arbitration"),
            "learning_path": run.get("learning_path"),
        }
        (group / "2-协同决策中间数据.json").write_text(
            json.dumps(middle, ensure_ascii=False, indent=2), encoding="utf-8")
        resources = {"learner_profile_id": pid, "source_run": run_path.name,
                     **(run.get("resources") or {})}
        (group / "3-最终学习资源.json").write_text(
            json.dumps(resources, ensure_ascii=False, indent=2), encoding="utf-8")
        labels.append(f"组{i}-{pid}（目标：{run.get('learning_goal','')[:30]}）")
    (out / "README.md").write_text(
        "# 差异化学情数据组\n\n"
        "每组三个文件，构成一次完整生成的输入→中间→输出：\n\n"
        "1. `1-输入画像.json`——学习者初始学情（学历背景、分项能力级、偏好、约束）。\n"
        "2. `2-协同决策中间数据.json`——多智能体协同全过程：学情诊断、知识检索、\n"
        "   审核逐条断言判定（supported/weak/unsupported 三态）、执行轨迹（每步\n"
        "   agent 与引擎标注）、辩论回合与仲裁、学习路径规划。\n"
        "3. `3-最终学习资源.json`——个性化讲义 + 实操任务 + 分阶测试题（三形态）。\n\n"
        "三段用 id 互相咬合：目录名与文件 1 的 `id`、文件 2/3 的 `learner_profile_id`\n"
        "是同一画像；文件 3 的 `used_sources` 逐条对应文件 2 `retrieval.retrieved_chunks`\n"
        "里的 `source_id`（含 chunk 全文快照，出处 URL 一并在内）；`source_run` 指向\n"
        "引擎归档 run 原件（apps/agent-engine/data/runs/）。\n\n"
        + "\n".join(f"- {s}" for s in labels) + "\n",
        encoding="utf-8")
    return labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=ROOT / "dist" / "submission-data")
    parser.add_argument("--groups", type=int, default=3)
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else ROOT / args.out
    if out.exists():
        shutil.rmtree(out)
    n = export_kb_slice(out / "知识库切片")
    labels = export_learner_groups(out / "学情数据组", args.groups)
    print(f"知识库切片 {n} chunks；学情数据 {len(labels)} 组：")
    for s in labels:
        print(" ", s)
    print(f"输出：{out}")


if __name__ == "__main__":
    main()
