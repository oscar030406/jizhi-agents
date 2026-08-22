# 参数化教具模板池

interactive 场景的站内教具模板：每个组件 = 一个模板（参数预制、交互数学确定性、断网可用），
由 `TemplateWidgetHost` 按 `templateId` 分发渲染。参数类型契约在 `lib/types/widgets.ts`，
生成端目录与校验在 `lib/generation/widget-templates.ts`。新增模板：加组件 + 三处同步注册。

两类模板，加新的之前先想清楚归哪类：

- **主题专用**：`AttentionPlayground` / `BpeMergeStepper` / `TemperatureSampler` /
  `RagRetrievalPlayground`，每个写死一条大模型内部机制，只有课讲的就是那条机制才该选。
- **主题无关**：`ParameterCurve`（有旋钮就有后果）/ `ProcessStepper`（先这样再那样）/
  `TradeoffMatrix`（看你在意什么）/ `LayeredGraph`（谁跟谁说话，且有分叉），
  不绑学科，数学、Python、机器人、部署、评测都能用。通用模板是覆盖率的来源。

`ProcessStepper` 与 `LayeredGraph` 的分界线是**有没有分叉**：一条直链用步进器，
一对多 / 多对一 / 有回边的拓扑用分层图。两个都能套时选步进器，它更简单。

参数自由度是刻意压的（曲线只给六个枚举族而不是公式字符串、滑块最多 2 个、
流程 3-8 步、拓扑图只收「谁在第几层」而绝不收坐标）：自由度越高 LLM 出错越多，
历史上 diagram widget 就是让模型自己排版才反复生成失败的。
每个模板在 `WIDGET_TEMPLATES` 里带一份 `sample` 默认参数，既当提示词示例又当降级形态，
测试会拿真校验器跑一遍它。
