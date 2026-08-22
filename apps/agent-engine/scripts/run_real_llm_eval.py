from __future__ import annotations

import argparse
import csv
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import statistics
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

REQUIRED_AGENTS = (
    "LearnerDiagnosisAgent",
    "ResourceGenerationAgent",
    "ContentAuditAgent",
    "FeedbackDecisionAgent",
)

# Retrieval, path planning and arbitration are deterministic by design. Only these
# agents are expected to use an LLM when their route is enabled; a different engine
# means an actual fallback rather than a normal deterministic stage.
LLM_EXPECTED_ENGINES = {
    "LearnerDiagnosisAgent": {"llm+deterministic"},
    "ResourceGenerationAgent": {"llm"},
    "ContentAuditAgent": {"llm+deterministic"},
    "FeedbackDecisionAgent": {"llm"},
}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="真实 LLM 全量评测；无可用路由时默认拒绝运行，防止把 fallback 冒充 API 结果"
    )
    parser.add_argument("--gold", choices=["v1", "v2"], default="v2")
    parser.add_argument("--limit", type=int, default=0, help="0=全部；正式结果要求至少60条")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "eval" / "real_llm",
    )
    parser.add_argument(
        "--allow-fallback-only",
        action="store_true",
        help="仅用于检查脚本；输出会标记 invalid_for_claims=true",
    )
    parser.add_argument(
        "--concurrency", type=int, default=6,
        help="同时跑几个用例（用例之间互相独立；1=串行）",
    )
    args = parser.parse_args()

    os.environ["AGENT_GENERATION_MODE"] = "api"
    from backend.orchestration.workflow import AgentTrainingWorkflow
    from backend.services.data_loader import get_learner_profile, load_e2e_cases
    from backend.rag.claims import audited_char_ratio, claim_statistics
    from backend.services.evaluation_service import evaluate_run
    from backend.services.llm_gateway import LLMGateway

    gateway = LLMGateway(env=os.environ)
    route_status = {
        agent: gateway.route_for(agent).public_dict()
        for agent in REQUIRED_AGENTS
    }
    disabled = [agent for agent in REQUIRED_AGENTS if not gateway.is_enabled(agent)]
    if disabled and not args.allow_fallback_only:
        print("真实 LLM 路由未完整启用，拒绝生成可对外声称的结果：")
        for agent in disabled:
            print(f"  - {agent}: {route_status[agent]}")
        raise SystemExit(2)

    cases = load_e2e_cases(gold=args.gold)
    if args.limit > 0:
        cases = cases[: args.limit]

    done = 0

    def run_case(index_case: tuple[int, object]) -> dict:
        nonlocal done
        index, case = index_case
        # 每个用例一套 gateway+workflow：用例之间零共享，遥测计数才是这一条的真账
        # （共享单例并发跑时 before/after 快照会互相串味）。构造成本可忽略——
        # 检索器与概念图都是模块级单例。
        case_gateway = LLMGateway(env=os.environ)
        workflow = AgentTrainingWorkflow(gateway=case_gateway)
        profile = get_learner_profile(case.learner_profile_id)
        before = case_gateway.telemetry_snapshot()
        started = time.perf_counter()
        error = ""
        try:
            run = workflow.run(profile, learning_goal=case.learning_goal)
            evaluation = evaluate_run(case, profile, run)
            engine_trace = [
                {
                    "agent": step.agent,
                    "engine": str(step.artifacts.get("engine", "deterministic")),
                }
                for step in run.trace
            ]
            engines = [item["engine"] for item in engine_trace]
            # 审核门是两级设计：确定性字符重叠先初筛，judge 只终裁"存疑"的声明
            # （content_audit_agent._llm_review）。初筛零存疑时 judge 本来就不该被调，
            # 这时 engine=deterministic 是设计短路，不是降级——把它算成 fallback
            # 会平白把一整轮真实 LLM 评测判成不可对外声称。单独统计并如实披露。
            # 判官出没出场以 agent 自报的状态为准，不再靠 claims_supported 反推
            # （那个谓词在 weak 上与判官触发条件正好相反，实测 7 条里 3 条是假的）
            judge_state = getattr(workflow.audit_agent, "last_judge_state", "unknown")
            audit_llm_skipped = judge_state in {"no_claims", "disabled"}
            # 正文是模型写的还是护栏兜底的模板？模板是逐字抄教材，重叠打分必给满分，
            # 混进均值会把幻觉率稀释成「抄没抄」的度量。
            gen_engine = getattr(workflow.generation_agent, "last_engine", "unknown")
            reject_reason = getattr(workflow.generation_agent, "last_reject_reason", "")
            stats = claim_statistics(run.audit.claim_verdicts)
            fallback_used, fallback_step_rate, fallback_agents = _fallback_status(
                engine_trace, audit_llm_skipped=audit_llm_skipped
            )
            blocked = bool(run.arbitration and run.arbitration.action == "block_pending_human_review")
            row = {
                "case_id": case.id,
                "success": True,
                "error": "",
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "fallback_used": fallback_used,
                "fallback_step_rate": fallback_step_rate,
                "fallback_agents": fallback_agents,
                "audit_triggered": bool(run.audit.revision_required or run.debate),
                "audit_llm_skipped": audit_llm_skipped,
                "judge_state": judge_state,
                "generation_engine": gen_engine,
                "reject_reason": reject_reason,
                "hallucination_rate_upper": stats["hallucination_rate_upper"],
                "weak_rate": stats["weak_rate"],
                "claims_total": stats["claims_total"],
                "not_a_claim_count": stats["not_a_claim_count"],
                "audited_char_ratio": audited_char_ratio(run.resources),
                "debate_rounds": len(run.debate),
                "blocked": blocked,
                "factuality_score": run.audit.factuality_score,
                "hallucination_rate": run.audit.hallucination_rate,
                "concept_coverage": evaluation.concept_coverage,
                "difficulty_match": evaluation.difficulty_match,
                "faithfulness": evaluation.faithfulness,
                "context_precision": evaluation.context_precision,
                "context_concept_recall": evaluation.context_concept_recall,
                "engines": engines,
                "engine_trace": engine_trace,
                # 逐条判词随结果落盘：报出去的幻觉率必须能被任何人翻回逐条核对，
                # 否则「30%」只是个无法证伪的数字。
                "claim_verdicts": [
                    {"claim": v.claim, "verdict": v.verdict, "score": v.support_score,
                     "cited": list(v.source_ids), "matched": v.matched_source_id}
                    for v in run.audit.claim_verdicts
                ],
            }
        except Exception as exc:  # noqa: BLE001 - failures are part of measured reliability
            error = f"{type(exc).__name__}: {exc}"
            row = {
                "case_id": case.id,
                "success": False,
                "error": error,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "fallback_used": False,
                "fallback_step_rate": 0.0,
                "fallback_agents": [],
                "audit_triggered": False,
                "audit_llm_skipped": False,
                "judge_state": "run_failed",
                "generation_engine": "unknown",
                "reject_reason": "",
                "hallucination_rate_upper": 1.0,
                "weak_rate": 0.0,
                "claims_total": 0,
                "not_a_claim_count": 0,
                "audited_char_ratio": 0.0,
                "debate_rounds": 0,
                "blocked": False,
                "factuality_score": 0.0,
                "hallucination_rate": 1.0,
                "concept_coverage": 0.0,
                "difficulty_match": 0.0,
                "faithfulness": 0.0,
                "context_precision": 0.0,
                "context_concept_recall": 0.0,
                "engines": [],
                "engine_trace": [],
            }
        after = case_gateway.telemetry_snapshot()
        delta = {key: after[key] - before.get(key, 0) for key in after}
        row.update({f"gateway_{key}": value for key, value in delta.items()})
        done += 1
        print(
            f"[{done}/{len(cases)}] #{index} {case.id} success={row['success']} "
            f"fallback={row['fallback_used']}{'(' + '>'.join(row['fallback_agents']) + ')' if row['fallback_agents'] else ''} "
            f"ms={row['duration_ms']} error={error}",
            flush=True,
        )
        return row

    concurrency = max(1, args.concurrency)
    print(f"concurrency={concurrency}", flush=True)
    if concurrency == 1:
        rows = [run_case(item) for item in enumerate(cases, start=1)]
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            rows = list(pool.map(run_case, enumerate(cases, start=1)))

    summary = _summarize(rows, route_status, routes_incomplete=bool(disabled))
    _write_outputs(rows, summary, args.output_dir)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["api_failure_rate"] > 0 or summary["fallback_run_rate"] > 0:
        print("注意：结果包含 API 失败或 deterministic fallback，答辩时必须如实披露。")


def _fallback_status(
    engine_trace: list[dict[str, str]], *, audit_llm_skipped: bool = False
) -> tuple[bool, float, list[str]]:
    expected_steps = [
        item for item in engine_trace if item.get("agent") in LLM_EXPECTED_ENGINES
    ]
    if audit_llm_skipped:
        # 初筛零存疑 ⇒ 判官按设计不出场，这一步不参与 fallback 判定
        expected_steps = [i for i in expected_steps if i.get("agent") != "ContentAuditAgent"]
    fallback_agents = [
        item["agent"]
        for item in expected_steps
        if item.get("engine") not in LLM_EXPECTED_ENGINES[item["agent"]]
    ]
    return (
        bool(fallback_agents),
        len(fallback_agents) / max(1, len(expected_steps)),
        fallback_agents,
    )


def _summarize(rows: list[dict], route_status: dict, *, routes_incomplete: bool) -> dict:
    n = len(rows)
    successes = [row for row in rows if row["success"]]
    durations = sorted(row["duration_ms"] for row in rows)
    total_attempts = sum(row["gateway_attempts"] for row in rows)
    total_request_failures = sum(row["gateway_request_failures"] for row in rows)
    total_parse_failures = sum(row["gateway_parse_failures"] for row in rows)
    total_tokens = sum(row["gateway_total_tokens"] for row in rows)
    fallback_runs = sum(bool(row["fallback_used"]) for row in rows)
    # 护栏拒收 ≠ 基础设施故障：前者是模型答了但违反证据不变量、护栏正常工作，
    # 后者才是调用/解析挂了。旧版把两者压成一个 fallback 布尔量，把正向证据
    # 写成了「不可对外声称」的理由。
    guardrail_rows = [r for r in rows if r.get("reject_reason") == "guardrail_evidence_invariant"]
    infra_rows = [r for r in rows if r.get("reject_reason") == "llm_call_or_parse_failed"]
    # 正文由模型写的 run 才进内容类指标的均值；护栏兜底的正文是逐字抄教材的模板，
    # 重叠打分必给满分，混进去等于用「抄没抄」稀释「对不对」。
    llm_rows = [r for r in successes if r.get("generation_engine") == "llm"]
    template_rows = [r for r in successes if r.get("generation_engine") != "llm"]

    reasons: list[str] = []
    if routes_incomplete:
        reasons.append("one or more required model routes were disabled")
    if n < 60:
        reasons.append("fewer than 60 runs were evaluated")
    if len(successes) != n:
        reasons.append("one or more workflow runs failed")
    if infra_rows:
        reasons.append("infrastructure fallback (call/parse failure) occurred")
    if total_request_failures:
        reasons.append("one or more API request attempts failed")
    if total_parse_failures:
        reasons.append("one or more model responses failed JSON parsing")

    invalid_for_claims = bool(reasons)
    return {
        "n": n,
        "invalid_for_claims": invalid_for_claims,
        "claimability_reasons": reasons,
        # 技术上跑干净 ≠ 可以当最终成绩：v2 金标已参与校准，冻结算法后的教师盲测
        # holdout 始终是缺的一环。这条与 invalid_for_claims 分开，免得把「这轮跑砸了」
        # 和「这套证据等级本就不够」混成一个信号。
        "requires_human_holdout": True,
        "evidence_tier_note": (
            "v2 是已参与校准的独立规则种子集，只能作为工程一致率；"
            "最终幻觉率必须来自冻结算法后的教师盲测 holdout"
        ),
        "routes": route_status,
        "run_success_rate": len(successes) / max(1, n),
        "api_failure_rate": total_request_failures / max(1, total_attempts),
        "json_parse_failure_rate": total_parse_failures / max(1, total_attempts),
        "fallback_run_rate": fallback_runs / max(1, n),
        "fallback_step_rate": _mean(rows, "fallback_step_rate"),
        "audit_trigger_rate": sum(row["audit_triggered"] for row in rows) / max(1, n),
        "audit_llm_skipped_rate": sum(row.get("audit_llm_skipped", False) for row in rows) / max(1, n),
        # —— 口径 v2（2026-08-04 重建）——
        # 幻觉率一律报区间：下界只数 unsupported，上界把 weak（证据不足以支持）
        # 也算进去。RAGTruth / FACTS Grounding 的通行口径没有 weak 这个第三态。
        "llm_content_runs": len(llm_rows),
        "template_content_runs": len(template_rows),
        "hallucination_lower_llm_content": _mean(llm_rows, "hallucination_rate"),
        "hallucination_upper_llm_content": _mean(llm_rows, "hallucination_rate_upper"),
        "weak_rate_llm_content": _mean(llm_rows, "weak_rate"),
        "hallucination_lower_template": _mean(template_rows, "hallucination_rate"),
        "claims_per_run_llm_content": _mean(llm_rows, "claims_total"),
        # 判官认定「不该拿证据核」的句数（教学类比/指令/回指）。分母被缩了多少要看得见，
        # 不能靠豁免规则悄悄缩。
        "not_a_claim_per_run": _mean(llm_rows, "not_a_claim_count"),
        "audited_char_ratio": _mean(successes, "audited_char_ratio"),
        "guardrail_reject_rate": len(guardrail_rows) / max(1, n),
        "infra_fallback_rate": len(infra_rows) / max(1, n),
        # 闸门放行子集的幻觉率是**同义反复**：放行条件本身就是 hallucination_rate<=0.10
        # （arbitration_agent.py），所以这个数不管模型多差都不可能超过 0.10。
        # 它度量的是闸门阈值，不是内容质量——必须与拦截率一起报，且注明上界。
        "gate_delivered_runs": sum(1 for r in successes if not r["blocked"]),
        "gate_delivered_hallucination_tautological": (
            sum(r["hallucination_rate"] for r in successes if not r["blocked"])
            / max(1, sum(1 for r in successes if not r["blocked"]))
        ),
        "average_debate_rounds": _mean(rows, "debate_rounds"),
        "interception_rate": sum(row["blocked"] for row in rows) / max(1, n),
        "total_tokens": total_tokens,
        "average_tokens_per_run": total_tokens / max(1, n),
        "average_latency_ms": statistics.mean(durations) if durations else 0.0,
        "p95_latency_ms": _percentile(durations, 0.95),
        "faithfulness": _mean(successes, "faithfulness"),
        "context_precision": _mean(successes, "context_precision"),
        "context_concept_recall": _mean(successes, "context_concept_recall"),
        "hallucination_rate": _mean(successes, "hallucination_rate"),
        "concept_coverage": _mean(successes, "concept_coverage"),
        "difficulty_match": _mean(successes, "difficulty_match"),
    }


def _mean(rows: list[dict], field: str) -> float:
    # .get 兜底：旧格式的行（历史产物、测试夹具）没有 v2 新增字段，
    # 缺字段按 0 计而不是崩掉整份汇总
    return sum(float(row.get(field, 0.0)) for row in rows) / max(1, len(rows))


def _percentile(sorted_values: list[int], percentile: float) -> float:
    if not sorted_values:
        return 0.0
    index = max(0, min(len(sorted_values) - 1, int(round((len(sorted_values) - 1) * percentile))))
    return float(sorted_values[index])


def _write_outputs(rows: list[dict], summary: dict, output_dir: Path) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "real_llm_results.json").write_text(
        json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with (output_dir / "real_llm_results.csv").open("w", encoding="utf-8", newline="") as file:
        fieldnames = [k for k in (rows[0] if rows else {}) if k != "claim_verdicts"]
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            serializable = dict(row)
            serializable["engines"] = ">".join(serializable["engines"])
            serializable["fallback_agents"] = ">".join(serializable["fallback_agents"])
            serializable["engine_trace"] = json.dumps(
                serializable["engine_trace"], ensure_ascii=False
            )
            # CSV 不装逐条判词（JSON 里有），否则一格几万字符没法看
            serializable.pop("claim_verdicts", None)
            writer.writerow(serializable)
    lines = [
        "# Real LLM Evaluation",
        "",
        f"- Runs: {summary['n']}",
        f"- Invalid for external claims: {summary['invalid_for_claims']}",
        f"- Claimability reasons: {', '.join(summary['claimability_reasons']) or 'none'}",
        f"- Run success rate: {summary['run_success_rate']:.3f}",
        f"- API failure rate: {summary['api_failure_rate']:.3f}",
        f"- JSON parse failure rate: {summary['json_parse_failure_rate']:.3f}",
        f"- Fallback run rate: {summary['fallback_run_rate']:.3f}",
        f"- Audit trigger rate: {summary['audit_trigger_rate']:.3f}",
        f"- Audit LLM skipped (deterministic screen found nothing disputed): {summary['audit_llm_skipped_rate']:.3f}",
        f"- Average debate rounds: {summary['average_debate_rounds']:.3f}",
        f"- Interception rate: {summary['interception_rate']:.3f}",
        f"- Total tokens: {summary['total_tokens']}",
        f"- Average latency: {summary['average_latency_ms']:.1f} ms",
        f"- P95 latency: {summary['p95_latency_ms']:.1f} ms",
        f"- Faithfulness: {summary['faithfulness']:.3f}",
        "",
        "## 幻觉率（口径 v2，2026-08-04 重建）",
        "",
        f"- 真 LLM 正文 run 数 / 护栏兜底模板 run 数: "
        f"{summary['llm_content_runs']} / {summary['template_content_runs']}",
        f"- **真 LLM 正文 幻觉率区间: {summary['hallucination_lower_llm_content']:.3f} "
        f"～ {summary['hallucination_upper_llm_content']:.3f}**"
        f"（下界只数 unsupported，上界含 weak；weak 占比 {summary['weak_rate_llm_content']:.3f}）",
        f"- 护栏兜底模板 run 的幻觉率: {summary['hallucination_lower_template']:.3f}"
        "（正文是逐字抄教材，重叠打分必给满分，不能与上一行混比）",
        f"- 每 run 断言数: {summary['claims_per_run_llm_content']:.1f}"
        f"（另有 {summary['not_a_claim_per_run']:.1f} 句被判官判为非事实断言，不进分母）；"
        f"被审正文占比: {summary['audited_char_ratio']:.3f}",
        f"- 护栏拒收率 {summary['guardrail_reject_rate']:.3f}（模型答了但违反证据不变量，"
        f"护栏正常工作）/ 基础设施故障率 {summary['infra_fallback_rate']:.3f}",
        f"- 闸门放行 {summary['gate_delivered_runs']} 例，放行子集幻觉率 "
        f"{summary['gate_delivered_hallucination_tautological']:.3f} —— "
        "⚠ **同义反复**：放行条件本身就是 hallucination_rate<=0.10，"
        "该数值上界恒为 0.10，度量的是闸门阈值不是内容质量",
        f"- Concept coverage: {summary['concept_coverage']:.3f}",
        f"- Difficulty match: {summary['difficulty_match']:.3f}",
    ]
    (output_dir / "real_llm_results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
