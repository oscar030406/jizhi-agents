# 教具质量评测

装什么：交互教具（interactive 屏）的评测用例、五维量表与红线检查。跟隔壁
`whiteboard-layout` 是同一套打法（渲染 → 截图 → 打分），只换两样：scenario 从
白板动作序列换成一份可渲染的教具配置，rubric 从版面五维换成教具五维加四条红线。

- `scenarios/` — 用例，一份一个 JSON。文件名按内容起，红线样例统一 `bad-<码>-<形态>` 前缀，
  目录里字典序排下来正例和红线样例自然分成两堆。
- `rubric.md` — 五个维度各自的定义、为什么定这一维、红线 B1–B4、机械与模型的分工表、
  截图探针表、可直接搬进打分器的提示词。改判定口径改这里，别改到代码注释里去。
- `redlines.ts` — 红线里能确定性判掉的那一半，兼命令行自检。

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

## 覆盖

模板池八个形态各一份正例，其中四个主题无关模板（曲线 / 步进 / 取舍 / 拓扑）
故意用了智能制造题材——模板池八个里五个是大模型专属，通用模板在非大模型学科上
撑不撑得住是这条评测线最想量的东西。

另有五份红线样例：`bad-b1-stepper-echo`（复读三步）、`bad-b1-html-done-only`
（自由 HTML 只有一个「我已学完」）、`bad-b2-dead-slider`（滑块绑在不参与运算的系数上）、
`bad-b3-graph-no-notes`（点节点不出内容）、`bad-b4-curve-overflow`（曲线全溢出被丢光，
首屏空坐标轴）。它们同时是 `redlines.ts` 的回归用例。

## 还差的一环

截图那步还没接。`whiteboard-layout/capture.ts` 打的是 `/eval/whiteboard` 那个专用渲染页，
往里注入的是 `PPTElement[]`，教具用不上。要跑完整条线还缺两样，都落在本目录之外：

1. 一个挂 `TemplateWidgetHost` 的渲染页（自由 HTML 用例走 srcdoc），暴露一个注入配置的
   全局函数和一个就绪标志，与 `/eval/whiteboard` 同样形状。
2. 一个按 `rubric.md` 探针表操作再截图的采集脚本，一份用例出多帧——五维里的第一维
   和 B1 都要靠帧间差异判，单帧拍不出来。

在这两样接上之前，本目录能跑的是机械红线；模型打分的提示词已经写好在 `rubric.md`，
接上渲染页即可用。
