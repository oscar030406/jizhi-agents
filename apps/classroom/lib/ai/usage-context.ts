/**
 * 课程归因的异步上下文：让 token 账单能落到「哪一门课」上。
 *
 * ## 为什么需要
 *
 * `data/usage/*.jsonl` 每行记的是一次 LLM 调用的 token 账，字段里**没有 classroomId**。
 * 管理端设计稿（`docs/03-design/admin-dashboard-spec-20260810.md` §1.2）从 08-10 起
 * 就记着这条限制：「做不了精确的按课成本归因——要么按时间窗对齐 classroom-jobs 近似，
 * 要么在打点处补一个字段」。08-14 复审（H7）时字段仍然没有。
 *
 * ## 为什么用异步上下文而不是加参数
 *
 * `callLLM(params, source)` 全库 **23 个调用点、16 个文件**。给签名加一个
 * `classroomId` 要改所有调用点，其中大部分（web-search / verify-model / quiz-grade）
 * 根本不属于任何课程，改了也只是传 undefined。
 *
 * 同一个问题这个仓库已经解过一次：`thinking-context.ts` 用
 * `AsyncLocalStorage` 把 per-request 的 thinking 配置带到底层 fetch 包装器，
 * 没有污染任何调用签名。这里照抄那个模式——**不新发明机制**。
 *
 * ## 用法
 *
 * 课程生成入口把整段工作包起来：
 *
 * ```ts
 * await usageAttribution.run({ classroomId: stage.id }, async () => {
 *   // 这段里的每一次 callLLM / streamLLM 落账时都会带上 classroomId
 * });
 * ```
 *
 * 没包的地方 `getStore()` 返回 undefined，落账行为与改动前一字不差——
 * **不包也不会坏**，这是选异步上下文而不是必填参数的另一半理由。
 *
 * ## 边界
 *
 * - **只对新记录生效。** 已有两个月的 jsonl 不会追溯补字段——那需要按时间窗猜，
 *   猜出来的归因不是账。管理端读到没有 classroomId 的旧行时照旧不出按课成本。
 * - 服务端专用（`node:async_hooks`）。客户端不会引到这个模块。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelFallbackEvent } from '@/lib/ai/model-fallback';

export interface UsageAttribution {
  /** 这次调用属于哪门课。落进 usage jsonl 的 `classroomId` 字段。 */
  classroomId?: string;
  /**
   * 这段上下文里真实发生过的生成端跨模型回落（WO-M2）。**调用方自己传一个数组
   * 进来才收集**——路由拿它填进生成产物元数据，让「这一页其实是备胎生成的」
   * 在车间面板上看得见。回落开关默认关，关着时这个数组永远是空的。
   */
  fallbacks?: ModelFallbackEvent[];
}

export const usageAttribution = new AsyncLocalStorage<UsageAttribution | undefined>();

/** 当前上下文里的课程 id；不在上下文里就是 undefined。 */
export function currentClassroomId(): string | undefined {
  return usageAttribution.getStore()?.classroomId;
}

/** 记一次回落。没人开数组收集（或不在上下文里）就是空操作。 */
export function recordModelFallback(event: ModelFallbackEvent): void {
  usageAttribution.getStore()?.fallbacks?.push(event);
}
