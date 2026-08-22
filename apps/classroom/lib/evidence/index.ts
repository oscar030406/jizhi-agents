/**
 * 证据模型（设计稿 §4.4）——四种交互的产物归拢到同一条流、同一个测项上。
 *
 * - `./types`      四个子盒的类型、构造（测项唯一、判定逐测项独立）、证据/信号的判据
 * - `./weight`     权重（导出量、纯的、序列函数、可替换可重算）与两条时间量：
 *   遗忘 `R(t)` 与置信度扩散——它们是两件事，不许再混成一个衰减因子
 * - `./ledger`     只追加的落盘（复用 RuntimeStore）与选择函数
 * - `./fold`       履历 → 画像。`画像 = (fold 更新规则 声明 履历)`，§4.1 那个 fold
 * - `./wheel-spinning` 连错到阈值就放弃这个知识点、换点（§5.3 / §5.4 / B-15）
 * - `./from-quiz`  交卷结果 → 证据草稿（场景级，item-level 降级）
 * - `./from-tutor` 导学判分 → 证据草稿（概念级，per-kc）
 * - `./trajectory` 履历 → 时间轨迹，供学情报告画图
 *
 * 已接线：quiz 交卷与导学判分都在写这条流；画像仍走旧的 localStorage EMA，
 * **两轨并行**——fold 算出来的画像先只用于展示与对照，切换是下一步。
 */
export * from './types';
export * from './weight';
export * from './ledger';
export * from './fold';
export * from './wheel-spinning';
