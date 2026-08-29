# 多智能体引擎

Agent 应用开发实训方向的个性化学习引擎。七个 Agent 协同：学情诊断、知识检索、资源生成、
内容审核、仲裁、路径规划、反馈决策。每个核心 Agent 都是 LLM 优先、确定性兜底，trace 里
如实标注这一步用的是哪个引擎。

**先读 [PLAYBOOK.md](PLAYBOOK.md)**——目标逆推、架构不变量、路线图和执行规则都在那里。

2026-08-04 起本目录是引擎的唯一真源。此前 `apps/engine`（研发区）与 `apps/agent-engine`
（运行时）是同一份代码的两份拷贝，靠 `vendor_sync.py` 手工同步；现在两边已合并，
vendor 机制作废，合并前的快照留在 `docs/archive/engine-premerge-20260804/`。

## 目录

```text
app/        FastAPI HTTP 层，线上入口就是 app.main:app（8001）
backend/    引擎本体：agents / rag / orchestration / services / schemas
scripts/    评测与运维脚本（run_eval、ablation、learning_eval、build_* 等）
tests/      pytest 回归，211 项
data/       知识库、课程库、题库、评测数据与运行记录
frontend/   backend.main:app 托管的原生演示页，只给 8000 那个入口用
```

## 跑起来

要求 Python 3.12+。运行所需的画像、题库、知识索引和评测基线都已在仓库里，正常启动不重建数据。

```powershell
cd apps\agent-engine
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env        # 填 key；不填就是确定性模式，不调外部 API
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

- 健康检查 http://127.0.0.1:8001/health
- API 文档 http://127.0.0.1:8001/docs
- 内部接口 `/internal/v1/personalize/*`、`/internal/v1/practice/*`，走 `x-internal-token` 鉴权，
  token 必须与 classroom 的 `GROUNDING_TOKEN` 一致，不一致课堂会静默降级成裸生成。

整套演示（引擎 8001 + 课堂 3210）用项目根的 `scripts\start-demo.ps1`，它带桥探活，
比手工起服务更容易发现"端口通了但桥没通"。

`backend.main:app`（8000）是引擎自带的独立入口，挂着 `/api/*` 和演示前端，评测和本地调试用。
线上只跑 `app.main:app`。

## 测试与评测

```powershell
python -m compileall -q backend scripts
python -m pytest tests -q
python scripts\run_eval.py --gold both --mode deterministic
```

评测结果写 `data/eval/eval_results.csv`（v1 自证对照，不作效果结论）和
`data/eval/eval_results_v2.csv`（当前口径的独立规则基线）。

对外引用的数字只认 `data/metrics.json`，引用前跑 `python scripts\check_metrics.py` 对账。

`python scripts\generate_sample_data.py --force` 会覆盖已提交的画像、题库和 v1 结果，
是破坏性维护命令，只在明确要重建夹具时执行。

## 配置

系统只有真实模型一条生成路径：在 `.env` 里配好 provider 与 key 即启用（缺 key 时
生成环节显式报错，不做无模型降级）。当前推荐硅基流动一个 key 覆盖三档异构模型
（Qwen 快线 / DeepSeek 生成 / GLM 审核），模型 ID 以供应商实际返回的列表为准。
回归测试不依赖任何 key：套件向真实代码路径注入罐头输出封闭运行。

`.env` 不进 git、不进 Docker 镜像、不进交付包。

## 知识来源

主知识库是 hello-agents 教材切片（CC BY-NC-SA 4.0），AgentGuide 作为安全与工程实践补充。
逐条来源、许可和证据等级以 `data/knowledge_base/sources_manifest.csv` 为准，署名要求见
`data/knowledge_base/ATTRIBUTION.md`。生成内容只能引用本轮实际检索到的 `source_id`。
