/**
 * 上屏前抹掉指标台账原文里的模型全串与接入机器上的项目目录名。
 *
 * 台账 `caliber`/`source`（`apps/agent-engine/data/metrics.json`）是给内部复算用的原文，
 * 里面有 `A=<厂商>/<型号>` 这种模型全串，以及 `cd <项目目录>` 这种本机路径。
 * 这两样都属于「内部代号」，不该跟着交付物出去。
 *
 * **抹的只是标识**：判官几家、几票、怎么聚合、分子分母，一个字没删——
 * 口径的可复算性靠的是这些，不是靠模型叫什么名字。
 *
 * 真源是台账本身，不在这里改：台账要保留全串，内部复算得认得出是哪个模型。
 * 所以脱敏只发生在渲染层，且**必须每个渲染点都走这个函数**——
 * 08-16 就是因为泛化对比页做了脱敏、`/admin` 的指标带没做，同一批字符串漏在另一个页面上。
 */
const MASK = '〈型号略〉';

export function redactCaliber(text: string): string {
  return text
    .replace(/(?:[A-Za-z][\w.-]*\/)+(?:MiniMax|Qwen|Kimi|DeepSeek|GLM|moonshot)[\w.-]*/gi, MASK)
    .replace(/\b(?:MiniMax|Qwen|Kimi|DeepSeek|GLM|GPT|Claude)[\w.-]*(?:\(v?[\d.]+\))?/gi, MASK)
    .replace(/挑战杯/g, '<项目根>');
}
