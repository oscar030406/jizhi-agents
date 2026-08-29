from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
from typing import Any

from backend.orchestration.workflow import AgentTrainingWorkflow
from backend.schemas.learner import FeedbackInput
from backend.schemas.resources import WorkflowRun
from backend.services.data_loader import get_learner_profile

DEMO_GOAL = "搭建可评测的 Agentic RAG 工作流"


def build_demo_runs(
    output_dir: Path,
    *,
    generation_mode: str = "deterministic",
) -> dict[str, Any]:
    """生成两种画像和高/低反馈链，并写入可校验 manifest。"""
    # 2026-08-28 移除确定性引擎后 mode 只剩两义：api/env=用真实路由；
    # deterministic=临时剥掉密钥（配合测试的罐头网关跑零成本演示轨）。
    # 剥离必须**临时**：全局抹空会污染同进程后续的嵌入检索（08-29 实测
    # 把三条按向量排序校准的检索测试打翻），函数退出时原样恢复。
    if generation_mode not in {"deterministic", "api", "env"}:
        raise ValueError(f"unsupported generation mode: {generation_mode}")
    _saved_keys: dict[str, str | None] = {}
    if generation_mode == "deterministic":
        for _k in ("SILICONFLOW_API_KEY", "DASHSCOPE_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY"):
            _saved_keys[_k] = os.environ.get(_k)
            os.environ[_k] = ""
    try:
        return _build_demo_runs_inner(output_dir, generation_mode)
    finally:
        for _k, _v in _saved_keys.items():
            if _v is None:
                os.environ.pop(_k, None)
            else:
                os.environ[_k] = _v


def _build_demo_runs_inner(output_dir: Path, generation_mode: str) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    for path in output_dir.glob("*.json"):
        path.unlink()

    workflow = AgentTrainingWorkflow()
    beginner_profile = get_learner_profile("zero_beginner")
    engineer_profile = get_learner_profile("backend_to_agent")
    beginner = workflow.run(beginner_profile, learning_goal=DEMO_GOAL)
    engineer = workflow.run(engineer_profile, learning_goal=DEMO_GOAL)
    low_followup = workflow.run_followup(
        beginner_profile,
        beginner,
        FeedbackInput(
            learner_profile_id=beginner_profile.id,
            quiz_score=0.25,
            confidence=2,
            free_text="检索与审核仍然混淆，希望增加分步解释。",
            concept_scores={"rag": 0.2, "guardrails": 0.25},
        ),
    )
    high_followup = workflow.run_followup(
        engineer_profile,
        engineer,
        FeedbackInput(
            learner_profile_id=engineer_profile.id,
            quiz_score=0.95,
            confidence=5,
            free_text="基础闭环已掌握，希望增加故障注入与评测约束。",
            concept_scores={"evaluation": 0.95, "guardrails": 0.9},
        ),
    )

    scenarios = [
        ("beginner_initial", "01-beginner-initial.json", beginner, None),
        ("engineer_initial", "02-engineer-initial.json", engineer, None),
        ("low_score_followup", "03-low-score-followup.json", low_followup, "beginner_initial"),
        ("high_score_followup", "04-high-score-followup.json", high_followup, "engineer_initial"),
    ]
    manifest_runs: list[dict[str, Any]] = []
    for scenario, filename, run, parent_scenario in scenarios:
        (output_dir / filename).write_text(
            json.dumps(run.model_dump(mode="json"), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        manifest_runs.append(
            _manifest_item(
                scenario=scenario,
                filename=filename,
                run=run,
                parent_scenario=parent_scenario,
            )
        )

    manifest = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_commit": _git_commit(),
        "generation_mode": generation_mode,
        "goal": DEMO_GOAL,
        # 指标口径块：manifest 里的数字必须自带解释，不能指望读者去翻协议文档。
        # 这里的幻觉率是「生成端裸质量」——门禁放行前的原始测量值，
        # 用途是给仲裁门做输入；对外承诺挂的是「交付端」（门禁拦截后放行的部分）。
        # 两个口径差一个数量级，混着比就是审计抓到的那个事故。
        "metric_semantics": {
            "hallucination_rate": (
                "生成端 claim 级 unsupported 比例（充分性门开启后的口径，判定见 "
                "docs/05-evidence/evaluation_protocol.md §1）。这是门禁的输入不是产品的输出："
                "超过 arbitration 放行线（0.10）的 run 会被拦截转人工，见各 run 的 "
                "arbitration_action 字段。对外幻觉承诺挂交付端（released=true 的子集），"
                "不挂本列裸值。"
            ),
            "factuality_score": "claim 级 supported 加权分，放行线 0.62（ArbitrationAgent 同参）。",
            "released": "True=门禁放行（approve/approve_with_warning）；False=拦截转人工，属门禁活证案例。",
        },
        "runs": manifest_runs,
        "notes": (
            "Files are generated from executable workflows and revalidated by WorkflowRun schema. "
            "Deterministic mode is an offline mechanism demo, not evidence of real-LLM quality."
        ),
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def validate_demo_runs(output_dir: Path) -> dict[str, Any]:
    errors: list[str] = []
    manifest_path = output_dir / "manifest.json"
    if not manifest_path.exists():
        return {"valid": False, "run_count": 0, "followup_count": 0, "errors": ["manifest.json missing"]}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"valid": False, "run_count": 0, "followup_count": 0, "errors": [f"manifest invalid: {exc}"]}

    items = manifest.get("runs") or []
    runs_by_scenario: dict[str, WorkflowRun] = {}
    run_ids: set[str] = set()
    followup_count = 0
    for item in items:
        scenario = str(item.get("scenario", ""))
        filename = str(item.get("file", ""))
        path = output_dir / filename
        if not scenario or not filename:
            errors.append("manifest run missing scenario or file")
            continue
        if not path.exists():
            errors.append(f"missing demo file: {filename}")
            continue
        try:
            run = WorkflowRun.model_validate_json(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"invalid WorkflowRun {filename}: {exc}")
            continue
        if run.run_id in run_ids:
            errors.append(f"duplicate run_id: {run.run_id}")
        run_ids.add(run.run_id)
        runs_by_scenario[scenario] = run
        if run.parent_run_id:
            followup_count += 1
        if not run.trace:
            errors.append(f"trace missing: {filename}")
        if any(not step.artifacts.get("engine") for step in run.trace):
            errors.append(f"engine tag missing: {filename}")
        if not run.retrieval.source_ids:
            errors.append(f"sources missing: {filename}")
        if run.audit.hallucination_rate < 0 or run.audit.hallucination_rate > 1:
            errors.append(f"invalid hallucination rate: {filename}")

    for item in items:
        parent_scenario = item.get("parent_scenario")
        if not parent_scenario:
            continue
        scenario = item.get("scenario")
        child = runs_by_scenario.get(str(scenario))
        parent = runs_by_scenario.get(str(parent_scenario))
        if child is None or parent is None:
            errors.append(f"parent scenario unresolved: {scenario}->{parent_scenario}")
        elif child.parent_run_id != parent.run_id:
            errors.append(f"parent run mismatch: {scenario}->{parent_scenario}")

    return {
        "valid": not errors,
        "run_count": len(runs_by_scenario),
        "followup_count": followup_count,
        "errors": errors,
        "source_commit": manifest.get("source_commit", ""),
        "generation_mode": manifest.get("generation_mode", ""),
    }


def _manifest_item(
    *,
    scenario: str,
    filename: str,
    run: WorkflowRun,
    parent_scenario: str | None,
) -> dict[str, Any]:
    engines = [str(step.artifacts.get("engine", "unknown")) for step in run.trace]
    blueprint = run.diagnosis.personalization_blueprint
    return {
        "scenario": scenario,
        "file": filename,
        "run_id": run.run_id,
        "parent_run_id": run.parent_run_id,
        "parent_scenario": parent_scenario,
        "learner_profile_id": run.learner_profile_id,
        "learner_type": blueprint.learner_type if blueprint else "",
        "generation_reason": run.generation_reason,
        "engines": engines,
        "fallback_used": all(engine == "deterministic" for engine in engines),
        "trace_count": len(run.trace),
        "source_count": len(run.retrieval.source_ids),
        "factuality_score": run.audit.factuality_score,
        "hallucination_rate": run.audit.hallucination_rate,
        "debate_rounds": len(run.debate),
        "difficulty": run.diagnosis.recommended_difficulty,
        "mastery_change": run.mastery_change,
        # 仲裁判决必须抬到 manifest 面上。审计抓过这条：01 号 run 的幻觉率 0.735
        # 裸躺在 manifest 里没有任何口径标注，评委不用读 run 文件就能问穿——
        # 其实 run 里明明记着 block_pending_human_review（门禁拦截了它，这是活证不是事故），
        # 但「已拦截」这个事实只有翻 run 文件才看得见。
        "arbitration_action": run.arbitration.action if run.arbitration else None,
        "released": run.arbitration.action in {"approve", "approve_with_warning"}
        if run.arbitration
        else None,
    }


def _git_commit() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parents[2],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except Exception:
        return "unknown"
