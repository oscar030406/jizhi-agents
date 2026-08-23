# 教具质量评测

装什么：交互教具（interactive 屏）的评测用例、五维量表与红线检查。跟隔壁
`whiteboard-layout` 是同一套打法（渲染 → 截图 → 打分），只换两样：scenario 从
白板动作序列换成一份可渲染的教具配置，rubric 从版面五维换成教具五维加四条红线。

- `scenarios/` — 用例，一份一个 JSON。文件名按内容起，红线样例统一 `bad-<码>-<形态>` 前缀，
  目录里字典序排下来正例和红线样例自然分成两堆。
- `rubric.md` — 五个维度各自的定义、为什么定这一维、红线 B1–B4、机械与模型的分工表、
  截图探针表、可直接搬进打分器的提示词。改判定口径改这里，别改到代码注释里去。
- `redlines.ts` — 红线里能确定性判掉的那一半，兼命令行自检。
- `capture.ts` — 多帧采集：按 `rubric.md` 的探针表操作再截图，一份用例出多帧，
  产出图片和一份 `index.json`。它不打分、不调模型。

新文件往哪加：加用例就往 `scenarios/` 丢一个 JSON，字段抄现成的（`intent` 必填，
它是量表第二维的参照物；`expectRedLines` 正例写 `[]`）。加红线要同时动三处：
`rubric.md` 的红线表和分工表、`redlines.ts` 的判定、`scenarios/` 里配一份 `bad-` 样例。

## 跑

```bash
pnpm tsx eval/widget-quality/redlines.ts          # 全部用例
pnpm tsx eval/widget-quality/redlines.ts bad-b2   # 按 id 子串过滤
```

它先拿生成端那把真校验器（`validateTemplateParams`）过一遍用例，再跑红线，
最后和每份用例自带的 `expectRedLines` 对答案，对不上退出码 1。当前 13 份全对。

采集截图要先起开发服务器（渲染页是站内路由，不是静态文件）：

```bash
pnpm dev                                                          # 另开一个终端
pnpm tsx eval/widget-quality/capture.ts                           # 全部用例
pnpm tsx eval/widget-quality/capture.ts --filter curve            # 按 id 子串过滤
pnpm tsx eval/widget-quality/capture.ts --base-url http://localhost:3100 --out D:/shots
```

产出默认落在 `results/<时间戳>/`，一份用例一个子目录：`00.png` 永远是默认态，
`01.png` 起按探针表顺序排；`index.json` 记下每份用例的 `name` / `intent` 和每帧对应的
操作说明，正好填 `rubric.md` 第四节提示词里的 `{{name}}` `{{intent}}` `{{probes}}`。
被 `redlines.ts` 机械判死的用例不采集，只在 `index.json` 的 `skipped` 里记一行原因——
分工表定的：判死的不再送模型，省钱也免得两套结论打架。当前 13 份里 8 份采集共 24 帧，
5 份红线样例跳过。

两帧逐字节相同时脚本会在终端提一句。它不下结论：可能是教具真死了（那该 VLM 判），
也可能是探针点在了当前已选中的那个元素上（空操作）。加模板时最容易踩这个——
注意力那份用例的 `focusDefault` 就正好指着最后一个 token，照探针表「点最后一个」
拍出来的是一张和默认态一模一样的帧，会让好教具背上「点了没反应」的黑锅。

## 覆盖

模板池八个形态各一份正例，其中四个主题无关模板（曲线 / 步进 / 取舍 / 拓扑）
故意用了智能制造题材——模板池八个里五个是大模型专属，通用模板在非大模型学科上
撑不撑得住是这条评测线最想量的东西。

另有五份红线样例：`bad-b1-stepper-echo`（复读三步）、`bad-b1-html-done-only`
（自由 HTML 只有一个「我已学完」）、`bad-b2-dead-slider`（滑块绑在不参与运算的系数上）、
`bad-b3-graph-no-notes`（点节点不出内容）、`bad-b4-curve-overflow`（曲线全溢出被丢光，
首屏空坐标轴）。它们同时是 `redlines.ts` 的回归用例。

## 渲染页

`app/eval/widget/page.tsx`，形状照抄 `/eval/whiteboard`：注入函数挂 `window.__setWidget`，
就绪标志同名 `window.__evalReady`，采集脚本两页共用一套等待逻辑。模板教具直接挂产品的
`TemplateWidgetHost`，自由 HTML 走和产品同一条 `srcDoc` + `patchHtmlForIframe` 路径、
同一套 sandbox。渲染逻辑一行都没在评测页里重写——评测页另写一份渲染，量到的就不是产品的画面。

与白板那页的两处不同：画布只锁宽（1000）不锁高，教具的高度由内容自己撑，锁死 563 会把
长教具裁掉，而版式可读正是要判的一维；每次注入把 `key` 自增一次强制重挂，否则上一份用例
拖到一半的滑块位置会漏进下一份的默认态帧。

## 还差的一环

打分器还没写。多帧和 `index.json` 已经就位，`rubric.md` 第四节的提示词可以直接搬，
但调 VLM 要花钱，当前未放行，所以 `capture.ts` 一次模型都不调。接上之后按第五节结算：
机械红线判死的直接 `reject`，其余送多帧打分，红线数和加权均分分两栏列。

`results/` 是本地产物，别提交。`.gitignore` 里隔壁三条评测线的 `results/` 都单独列了，
这条还没加。
