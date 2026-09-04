# 集智 · 多智能体个性化课程生成与学习系统

培训机构手里往往只有一份教材，来听课的人基础却差得很远。把这份资料交给大模型改写成课，会撞上两个问题：一是讲错，模型顺着上下文补出教材里没有的说法；二是讲给谁不清楚，难度只在开头选一次，之后不再随着学习者的作答变化。我们做的是一条受控的生产链：事实内容从指定知识库直出并标注到段，两个不同厂商的判官逐条核验断言，代码和数值等式在交付前真跑一遍；学习者画像决定难度档、讲解深度和测验难度带，测验成绩回写画像，影响下一门课取什么材料。

## 两种使用方式

**线上实例** https://jizhi.chenmingkun.cn 。不登录可以看公共课程墙与全部示例课（每一屏带审核徽标和引用出处）、`/agents` 智能体页（协同调度过程与执行轨迹）、`/evidence` 证据页（评测数字的来源与口径）。学员学情报告、全景学习路径和机构管理端需要登录。

**克隆到本地部署**。见下面的「本地部署」。

## 系统构成

| 服务 | 技术栈 | 端口 | 职责 |
|---|---|---|---|
| classroom | Next.js 16 / TypeScript，Node ≥ 20.9，pnpm 10 | 3210 | 课堂产品层：造课编排、教学履约合同、讲义与互动教具渲染、发布门、学情报告、机构管理端 |
| agent-engine | Python 3.12 / FastAPI / LangGraph | 8001，仅本机 | 多智能体引擎：学情诊断、领域检索、生成、双判官审核、仲裁、反馈决策、导学 |
| PostgreSQL 16（可选） | | 5432 | 账号与服务端持久化；未配置时以访客模式运行 |

课程数据落在 `apps/classroom/data/`，语料与索引落在 `apps/agent-engine/data/`，两处都要持久化。

引擎用有向状态图组织多智能体协同：审核不通过返回重生成，两个判官分歧升级仲裁，预算超限熔断。规则显式写死，执行过程因此可视，`/agents` 页的轨迹就是从这里出来的。

## 学习端的几块功能

- 五阶学习路径：`/path` 按前置基础、大模型原理、检索与知识工程、智能体工程、平台评测与护栏五阶排 43 个节点，排序真源是 `apps/classroom/data/learning-path.json`，不由引擎现算。
- 知识宇宙 3D 视图：路径页可切到三维图，把教材、章节、证据块、概念、课程四层和它们之间的边画在一张图里，也能切「本域 / 全站」两种范围。
- 项目带练：`/practice` 把一个实操项目按学习者画像拆成里程碑，再把里程碑拆成代码任务，骨架留 TODO，伴学教练按三级提示递进，提交后判代码。
- 实操项目库：人工智能应用开发库现有 22 个实操项目，由 practice-scout 从公开 GitHub 仓库拉候选、按概念起草，管理者审核后才发布。
- 外部可视化教具：教具卡同样从 GitHub 实拉候选、经管理者审核发布，按概念挂到讲义和课堂互动屏上。

## 本地部署

```powershell
# 引擎
cd apps/agent-engine
pip install -r requirements.txt
copy .env.example .env            # 至少填 SILICONFLOW_API_KEY

# 课堂
cd ../classroom
pnpm install
copy .env.example .env.local      # 填模型 key、GROUNDING_URL、GROUNDING_TOKEN

# 一键起两个服务
cd ../..
.\scripts\start-demo.ps1
```

打开 http://127.0.0.1:3210 造课。脚本是 PowerShell，其他平台照着内容手工起 uvicorn 和 `pnpm dev` 两个进程即可。

知识库数据包（教材语料切片与索引）因教材版权不随仓库发布，按书单登记向项目组索取，解压到 `apps/agent-engine/data/`。没有数据包系统照常运行，生成降级为通识模式，页面标注「未接地」，不伪装成有据。

### 配置项

| 变量 | 位置 | 说明 |
|---|---|---|
| `SILICONFLOW_API_KEY` | 引擎 `.env`、课堂 `.env.local` | 模型服务密钥。密钥即开关：缺 key 时生成环节显式报错，不静默退回规则。 |
| `LLM_PROVIDER_FAST / STRONG / JUDGE`、`LLM_MODEL_*` | 引擎 `.env` | 三档模型路由。路由禁用时对应环节显式失败。 |
| `AI_SERVICE_TOKEN` ↔ `GROUNDING_TOKEN` | 引擎 ↔ 课堂 | 课堂调引擎的内部鉴权，两边必须一致，只能用 ASCII。 |
| `GROUNDING_URL` | 课堂 `.env.local` | 引擎地址，本地为 `http://127.0.0.1:8001`。 |
| `AUDIT_MODEL`、`ARBITER_MODEL` | 课堂 `.env.local` | 双判官与仲裁模型。 |
| `GITHUB_TOKEN`（选填） | 引擎 `.env` | 实操项目侦察用，搜公开仓库。不配按匿名配额跑，同一 IP 一小时最多四次起草；配只读 PAT 后升到 30 次/分。 |

启动后验证三条。第三条不能省，浏览器会用客户端渲染把 SSR 500 兜回来，页面看着正常：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8001/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/api/classroom
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3210/classroom/<id>   # id 取清单里任意一门
```

## 目录结构

| 路径 | 内容 |
|---|---|
| `apps/classroom/` | 课堂产品层。测试在 `tests/`。 |
| `apps/agent-engine/` | 多智能体引擎。测试在 `tests/`，离线评测与消融脚本在 `scripts/`，指标真源 `data/metrics.json`。 |
| `scripts/` | 一键演示 `start-demo.ps1`、生产发布 `deploy/build-release.ps1` 与 `deploy/apply-release.sh`。 |
| `docs/` | 技术实现文档与部署说明。 |

## 复跑单元测试

两套测试都不需要 API key。

```bash
cd apps/agent-engine && python -m pytest tests/ -q    # 697 例，693 passed / 4 skipped，约 86 秒
cd apps/classroom   && pnpm test                      # 4818 例（546 个文件），4808 passed / 10 skipped
```

需要真实模型的评测另有一套脚本在 `apps/agent-engine/scripts/`，跑一轮要花钱，所以没有进 CI。冻结口径下的三项核心结果：可核事实断言的幻觉率 2.08%（12/576 条，57 次真实模型运行，断言级三判官多数表决）；核心知识点覆盖率 96.0%（48/50，6 门金标课，金标由教材目录独立构建、生成前冻结）；画像—难度适配准确率 85.2%（12 主题 × 9 画像，n=108，95% CI 77.8–92.6）。第三项点估计过了 85% 的线，置信区间下界没过，这项算部分满足。三个数字的完整口径、复算命令和逐条判词见 `apps/agent-engine/data/metrics.json`。

## 文档

- [技术实现文档](docs/技术实现文档.pdf)
- [部署说明](docs/部署说明.md)

## 许可证

代码以 MIT 许可证开源，见 [LICENSE](LICENSE)。教材语料与知识库数据包不在仓库内，按版权方要求只用于非商业教学场景。
