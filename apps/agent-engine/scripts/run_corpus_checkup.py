"""对**既有**语料库跑一次 ⑥⑦ 体检（试跑课程 + 指标复测），不建库、不覆盖。

    python scripts/run_corpus_checkup.py iotdb

产物落 `data/knowledge_base/intake_runs/<run_id>/`：事件流 `events.jsonl`、
记录 `run.json`、试跑课程与 `trial_courses/REPORT.md`。

为什么有这个脚本而不是只留 HTTP 口：⑥ 要打 classroom 的生成与审核接口，一轮十几分钟，
而引擎进程可能是别人起的、不带 --reload。走脚本就是同一批 service 函数在本进程里跑完，
不用为了一次体检重启线上进程。HTTP 口（`POST /api/domain-intake/checkups`）照样在，
两条路进的是同一个 `create_checkup_run`。

会调用生成与审核接口，按 token 计费。成本在 run.json 的 `stages.metrics.detail.cost`
（口径：`apps/classroom/data/usage/<月>.jsonl` 的增量，账本无单价字段，不折算金额）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services import domain_intake  # noqa: E402


def preflight(corpus: str) -> list[str]:
    """开跑前先确认这一轮体检的三个前提。返回不满足的项。

    为什么值这十几行：2026-08-16 的第一轮 iotdb 体检花了 158k token 才发现引擎少配
    `AI_SERVICE_TOKEN`，证据桥全程 401——判官一块教材都没看到
    （`judge_evidence_pool = 0`），幻觉那一格整格作废。桥的状态一次 GET 就能问出来，
    问在花钱之前。

    - **证据桥**：classroom 的 `/api/health` 自己探引擎，`engineBridge` 不是 ok 就别开跑。
    - **目标库预热**（WO-L1）：按域检索器在引擎里懒加载，冷启动构建实测 3.4~7.2s、
      两屏并发撞上冷缓存翻倍到 13s，超过 classroom 侧旧 6s 超时——体检池 12/48 屏的
      桥故障全是开跑头两屏撞冷缓存。health 探针只验 learning-modes 路由，焐不热检索器，
      所以这里直接打一次**目标库**的检索：缓存焐热 + 顺带验证这个库真检索得通。
    - **判官路由**：引擎侧盲评判档走 `LLMGateway`，判官 key 缺失时
      时它整格空着。这条只警告不拦——另外两格照样出数。
    """
    import os

    import requests

    from backend.services.llm_gateway import LLMGateway

    blockers = []
    try:
        body = requests.get(f"{domain_intake.CLASSROOM_BASE_URL}/api/health", timeout=15).json()
        bridge = (body.get("data") or body).get("engineBridge")
    except Exception as exc:  # noqa: BLE001
        bridge = f"探不到（{type(exc).__name__}）"
    if bridge != "ok":
        blockers.append(
            f"证据检索桥 engineBridge={bridge}——判官与正文都读不到语料，这一轮体检不成立。"
            "引擎要带 AI_SERVICE_TOKEN 起（与 classroom 的 GROUNDING_TOKEN 同值）"
        )
    else:
        engine_base = os.environ.get("ENGINE_BASE_URL", "http://127.0.0.1:8001")
        try:
            resp = requests.get(
                f"{engine_base}/internal/v1/personalize/evidence",
                params={"query": corpus, "top_k": "1", "corpus": corpus},
                headers={"x-internal-token": os.environ.get("AI_SERVICE_TOKEN", "")},
                timeout=60,  # 冷构建实测最大 13.2s，留足余量；焐热后命中 ~0.2s
            )
            if resp.status_code != 200:
                blockers.append(
                    f"目标库 {corpus} 检索预热失败：HTTP {resp.status_code}——"
                    "试跑屏拿不到摘录，接地那一格会整格作废"
                )
        except Exception as exc:  # noqa: BLE001
            blockers.append(
                f"目标库 {corpus} 检索预热失败（{type(exc).__name__}）——"
                f"引擎 {engine_base} 打不通或检索超时，试跑屏拿不到摘录"
            )
    if not LLMGateway().route_for("EvaluationJudge").enabled:
        print(
            "警告：判官路由未启用（API key 缺失），盲评判档那一格会空着。"
            "要它出数先在 .env 配好判官档 key。",
            flush=True,
        )
    return blockers


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__)
        return 2
    blockers = preflight(args[0])
    if blockers and "--force" not in argv:
        for b in blockers:
            print(f"前置检查未过：{b}", flush=True)
        print("确认要在这个状态下跑，加 --force。", flush=True)
        return 2
    run = domain_intake.create_checkup_run(args[0])
    print(f"run_id={run.run_id} corpus={run.corpus} scope={run.record['scope']}", flush=True)
    domain_intake.execute(run)
    record = domain_intake.read_run(run.run_id) or {}
    print(json.dumps(record.get("stages", {}).get("metrics", {}), ensure_ascii=False, indent=1))
    # 资料到位率跟着结果一起报（真源在 stages.trial.detail，这里只转印）：
    # 没拿到摘录的屏凭模型记忆写，接地数字要对着这一行打折扣读。
    er = (record.get("stages", {}).get("trial", {}).get("detail", {}) or {}).get("evidence_ready") or {}
    if er:
        print(f"资料到位率 {er.get('ready')}/{er.get('total')} 屏", flush=True)
        for item in er.get("no_material") or []:
            print(f"  ⚠ {item.get('tier')}「{item.get('scene')}」无资料生成：" + "；".join(item.get("reasons") or []), flush=True)
    print(f"status={record.get('status')} duration_ms={record.get('duration_ms')}")
    return 0 if record.get("status") == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
