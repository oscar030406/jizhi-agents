# tour

首访点击式引导（driver.js）与演示账号入口。`tour-steps.ts` 是三条引导（landing / classroom / admin）的文案与锚点；`tour.ts` 是引擎（完成态存 `jizhi.tour.<id>.v1`，`?tour=<id>` 重放）；其余是挂到页面上的小组件。锚点一律用 `data-tour` 属性，新步骤加在 `tour-steps.ts`。
