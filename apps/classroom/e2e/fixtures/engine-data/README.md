# e2e 用的引擎数据目录（假的）

`playwright.config.ts` 的 `webServer.env` 把 `ENGINE_DATA_DIR` 指到这里，dev server
起来后所有读引擎数据目录的服务端代码看到的都是这棵树。

**这里面没有一个字节来自真实引擎。** 拿 e2e 的 `/admin` 截图去当线上证据是错的。

## 为什么要有它

`/admin/knowledge/runs/<id>` 是服务端组件，直接读盘，`page.route` 的桩伸不进去。
不给它一份盘上的数据，`knowledge-to-report.spec.ts` 的「① 接入」就只能验到
「请求被接受、URL 跟着跳」，泳道、每站实数、事件流回放一条都断不了。

## 装什么

    knowledge_base/intake_runs/20260823T101500-e2e001/
      run.json       ← 站位表（每站的 order/label/deps/status/duration）
      events.jsonl   ← 一行一条事件，页面的泳道与回放都由它推出来

run id 与 `e2e/fixtures/test-data/knowledge-pipeline.ts` 的 `E2E_RUN_ID` 是同一个值
（接入桩返回的就是它），库名同 `E2E_CORPUS`。改一处必须改另一处，否则接入完跳过去是 404。

## 只放了四站，不是九站

引擎真实的一次 run 有九站（`apps/agent-engine/backend/services/domain_intake.py`
的 `STAGES`）。这里**只留了前四站**：`receive → chunk → (index ‖ knowledge)`。
站 id、站号、标签、依赖都照抄引擎那份，没有编造出来的站。

四站够断三件事，多的站只是让页面看着热闹：

- **泳道分波**：`index` 与 `knowledge` 都只依赖 `chunk`，落在同一波 → 页面出「（并行）」；
  两站的运行区间在事件里是重叠的 → 每张卡上出「与另外 1 站同时在跑」。
- **每站实数**：`chunk` 的 `chunks: 128`、`index` 的 `probe_hits: 5` 是页面上真会渲染的数字。
- **事件流回放**：11 条事件，够拖回放游标看到「N / 11 条」跟着变。

## 新加东西之前

想让某个 `/admin` 页面在 e2e 里有数，就在这棵树下按引擎的真实路径补文件
（`knowledge_base/<...>`）。别为了让页面「不空」而堆数据——空态本身也是要验的东西。
