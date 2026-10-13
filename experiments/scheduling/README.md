# 调度实验（本机）

在本机起一套完整的栈，把课堂端两条真模型调用的路由放进一个 k 槽的派发器里，
用脚本用户打负载，逐 job 记时间。论文那边要的是「机制在一套真服务里跑过、
逐 job 承诺在实测等待上成立」这一条证据。

**不碰线上。** 这里所有东西都只在 127.0.0.1 上跑，分支是 `sched-experiment`，
不 push、不部署。改了哪些文件、怎么回退，见 `../../docs/调度实验改动说明.md`。

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `start-local.ps1` | 起引擎（8001）和课堂（3210），并把这一轮的调度参数交给课堂进程 |
| `stop-local.ps1` | 按 PID 停掉上面两个进程（连同子进程） |
| `run-cell.mjs` | 负载发生器：建测试账号 + 按需求规则打请求 |
| `summarize.mjs` | 把记录汇总成表，并做边界检查 |
| `remove-test-accounts.mjs` | 删掉实验建的 `loadtest_*` 账号 |
| `records/` | 本轮产物（不进版本库） |

## 两类作业

| 类 | 路由 | 一次多久 | 逐 job 上限 ℓ |
|---|---|---|---|
| `guide` | `POST /api/practice-guide` | 线上实测 135 / 158 / 228 秒 | 170 秒 |
| `blueprint` | `POST /api/adaptive/blueprint` | 线上实测中位数 8.2 秒、p90 13.6 秒、最大 44.1 秒 | 25 秒 |

两条都是真模型调用。`guide` 每次都带 `refresh: true`，`blueprint` 每次换一个目标串，
所以不会命中引擎侧的缓存——每一单都是真花钱的一次生成。

**上限是在引擎侧生效的，不只是调用方不等了。** 课堂端把本次的剩余上限放在
`x-sched-deadline-ms` 头里，引擎的模型网关按它压单次超时、在流式拼块的循环里看表、
上限用完就不再重试。线上 2026-09-23 的日志里有一次带练路线在引擎跑满 228.1 秒，
而路由那边 170 秒就已经断开——那种情况下上限只是「调用方观察到的」，
服务器并没有被释放出来，预留-退还那条规则的前提就不成立。现在不是这样了。

## 跑一轮

```powershell
# 1. 起服务（一轮一组参数；换策略要重起课堂进程）
.\experiments\scheduling\start-local.ps1 -K 2 -Policy fcfs `
    -LimitMs 170000 -PromiseMs 400000 -B0Ms 30000 -Eta 0.5 -Cell smoke-fcfs

# 等两个服务都就绪（课堂第一次编译路由要一会儿）
curl http://127.0.0.1:8001/health
curl http://127.0.0.1:3210/api/health      # engineBridge 要是 ok
```

```powershell
# 2. 打负载
node experiments\scheduling\run-cell.mjs --cell smoke-fcfs `
    --users 3 --jobs 10 --think independent --think-mean 20 `
    --mix guide=0.3,blueprint=0.7
```

```powershell
# 3. 换策略：停课堂、带新参数重起、再跑一轮
.\experiments\scheduling\stop-local.ps1 -Only classroom
.\experiments\scheduling\start-local.ps1 -K 2 -Policy spjf ... -Cell smoke-spjf
```

```powershell
# 4. 汇总
node experiments\scheduling\summarize.mjs experiments\scheduling\records\jobs-*.jsonl
```

```powershell
# 5. 收工
.\experiments\scheduling\stop-local.ps1
```

## 作业类怎么分配

`--mix guide=0.3,blueprint=0.7` 按概率抽，`--pattern guide,guide,blueprint,...` 按固定顺序发。
**小样本用 `--pattern`**：10 单里按 0.2 的概率抽长作业，有一成的机会一个都抽不到，
实测撞上过一次。

## 需求规则（`--think`）

| 值 | 含义 | 额外参数 |
|---|---|---|
| `open` | 开环：按时刻表发请求，前一单回没回来都不影响 | `--schedule <csv>`，一列，单位秒 |
| `independent` | 闭环：拿到结果后想一会儿再发下一单，思考时间与上一单的代价无关 | `--think-mean <秒>` |
| `wait-scaled` | 闭环：等得越久想得越久（人会慢下来或者放弃） | `--think-mean`、`--think-slope` |

## 记录落在哪

`records/` 下，一轮三个文件：

| 文件 | 内容 |
|---|---|
| `jobs-<cell>.jsonl` | 逐 job 一行：入队 / 派发 / 完成时刻、实测服务时间、是否触上限、策略、基策略给的名次、派发那一刻的两种账与预算、派发器自身耗时（微秒）、请求与响应字节数 |
| `decisions-<cell>.jsonl` | 逐次派发决策一行：闸有没有开火、基策略提的是谁、当刻每个排在前面的等待者的账与预算 |
| `client-<cell>.jsonl` | 客户端这一侧的时间（提交时刻、返回时刻、往返时长、HTTP 状态） |
| `manifest-<cell>.json` | 这一轮的参数 |
| `classroom-<cell>.log`、`engine.*.log` | 两个服务的日志 |

**不存提示词，也不存生成出来的正文**，只有时间、大小和 id。

## 规模代理（`spjf` 按什么排序）

派发的那一刻能算出来的量：

- `guide`：引擎按 `milestone_count` 决定要写几段里程碑，而输出 token 数是这次调用
  耗时的主项。里程碑数由画像的时间预算与项目难度决定（引擎 `practice_guide.py`
  的 `_milestone_count`），两项课堂端都拿得到。取 `30 × 里程碑数 + 8 ×[有仓库链接]`。
- `blueprint`：同类中位数 8 秒，再加一个随目标串长度的很小的线性项。

系数没有标定过——它只用来排序，不进任何判定式。论文那边的保证对任意打分都成立，
包括故意弄坏的打分，所以另外留了两档：`SCHED_SCORE_MODE=inverted`（把代理反过来）
与 `random`（随机序），用来看预测错的时候闸兜不兜得住。

## 离线检验

不花钱的那一份在 `apps/classroom/tests/server/classroom-dispatch.test.ts`：

```powershell
cd apps\classroom
npx vitest run tests/server/classroom-dispatch.test.ts
```

断言三条：开关关着时不建队列、并发不超 k、开闸后每个 job 比同输入先到先派
多等的时间不超过承诺值。
