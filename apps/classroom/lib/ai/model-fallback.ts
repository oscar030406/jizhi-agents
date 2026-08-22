/**
 * 生成端跨模型回落（WO-M2）。
 *
 * ## 为什么有这个东西
 *
 * 2026-08-17 主生成模型 `Qwen/Qwen3.5-397B-A17B` 整天间歇 503/超时，两轮语料体检
 * 4/4 生成全败、一屏没出；而同一个 key 下白名单里其余五个模型全程可用。生成端此前
 * 只在**同一个模型上**重试（`ai` SDK 的 maxRetries / RetryError），备胎通着也用不上。
 *
 * ## 默认关闭
 *
 * `GENERATION_MODEL_FALLBACK` 不设或不是 1/true/on/yes 时，`isGenerationFallbackEnabled()`
 * 返回 false，`callLLM` 的候选循环只跑一轮——与改动前逐行同路径、同错误对象、同账本。
 * 评测/体检要纯净实验，就让它保持关闭。
 *
 * ## 只做生成端（红线）
 *
 * 换判官 = 换尺子。本项目吃过把评测模型换成快档、分数从 0.238 虚高到 0.922 的亏，
 * 所以下面用**白名单**而不是黑名单：`scene-audit` / `scene-audit-2` /
 * `scene-audit-arbiter` / `quiz-grade` 不在表里，将来新增判官 source 也不会被
 * 默默带上回落——要加只能有人手动往这张表里写。
 */

import type { LanguageModel } from 'ai';
import { statusFromError } from '@/lib/server/llm-error-response';

/** 一次真实发生过的回落，落进 usage 账本与生成产物元数据，不许静默替换。 */
export interface ModelFallbackEvent {
  /** callLLM 的 source 标签，如 'scene-content' */
  source: string;
  /** 原本要用的模型 id（与 usage 账本 modelId 同口径，不带 provider 前缀） */
  from: string;
  /** 实际用上的模型 id */
  to: string;
  /** 为什么降：'HTTP 503' / '超时或网络中断' */
  reason: string;
}

/**
 * 允许回落的 callLLM source。只有这四个是「产出课程内容」的生成调用：
 * 前两个是交互式逐场景生成链，后两个是服务端批量生成链。
 */
const GENERATION_SOURCES: ReadonlySet<string> = new Set([
  'scene-content',
  'scene-actions',
  'generate-classroom',
  'generate-classroom-scene',
]);

export function isGenerationFallbackSource(source: string): boolean {
  return GENERATION_SOURCES.has(source);
}

/** 开关。默认关。 */
export function isGenerationFallbackEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.GENERATION_MODEL_FALLBACK ?? '').trim());
}

const TIMEOUT_NAMES = new Set([
  'TimeoutError',
  'ConnectTimeoutError',
  'HeadersTimeoutError',
  'BodyTimeoutError',
]);

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isTimeoutOrNetwork(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const e = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    lastError?: unknown;
    errors?: unknown;
  };
  // 主动 abort 不算故障：客户端换页/取消请求都走这里，换个模型只会把一次
  // 已经没人要的生成再打一遍。`AbortSignal.timeout()` 抛的是 TimeoutError，
  // 与 AbortError 名字不同，所以这两者能分开。
  if (e.name === 'AbortError') return false;
  if (typeof e.name === 'string' && TIMEOUT_NAMES.has(e.name)) return true;
  if (typeof e.code === 'string' && TIMEOUT_CODES.has(e.code)) return true;
  if (typeof e.message === 'string' && /fetch failed|socket hang up|terminated/i.test(e.message)) {
    return true;
  }
  if (Array.isArray(e.errors) && e.errors.some((nested) => isTimeoutOrNetwork(nested, seen))) {
    return true;
  }
  return isTimeoutOrNetwork(e.cause, seen) || isTimeoutOrNetwork(e.lastError, seen);
}

/**
 * 这个错误值不值得换模型重试。
 *
 * - **算**：上游 5xx（503/502/500…）、超时、连接中断。这些是「这台模型现在不行」。
 * - **不算**：4xx。401/403 是 key 不对、400 是请求不合法、404 是模型名写错——
 *   换一个模型同样会挂，只会把一次错误变成六次错误。
 * - **不算 429**：同一个 key 的配额限流换模型救不了，而且它有自己的退避语义，
 *   插一脚只会打乱上层的重试节奏。
 * - **不算主动 abort**：见 isTimeoutOrNetwork 里的注释。
 */
export function isFallbackWorthyError(error: unknown): string | undefined {
  const status = statusFromError(error);
  if (status !== undefined) return status >= 500 ? `HTTP ${status}` : undefined;
  return isTimeoutOrNetwork(error) ? '超时或网络中断' : undefined;
}

export interface FallbackCandidate {
  model: LanguageModel;
  modelId: string;
  providerId: string;
  /** 备胎自己的输出上限，用来把上一档的 maxOutputTokens 夹住（65536 发给 32768 的模型会 400）。 */
  outputWindow?: number;
}

/**
 * 白名单里当前模型的**下一个**。
 *
 * 白名单 = 运维在 `<PREFIX>_MODELS`（如 `SILICONFLOW_MODELS`）里显式列的那串，
 * 顺序即优先级，第一个是主模型。当前模型不在任何白名单里就不回落——我们不知道
 * 它属于哪一族，猜出来的备胎不是备胎。
 *
 * 失败（key 缺失、模型没注册）返回 undefined：回落本身出事绝不能把原始错误盖掉。
 */
export async function pickFallbackModel(
  currentModelId: string,
  tried: ReadonlySet<string>,
): Promise<FallbackCandidate | undefined> {
  try {
    const { getServerProviders, resolveApiKey, resolveBaseUrl, resolveProxy } =
      await import('@/lib/server/provider-config');
    const { getModel } = await import('@/lib/ai/providers');

    for (const [providerId, entry] of Object.entries(getServerProviders())) {
      const models = entry.models;
      const idx = models?.indexOf(currentModelId) ?? -1;
      if (!models || idx < 0) continue;

      const nextId = models.slice(idx + 1).find((m) => !tried.has(m));
      if (!nextId) return undefined;

      const { model, modelInfo } = getModel({
        providerId: providerId as Parameters<typeof getModel>[0]['providerId'],
        modelId: nextId,
        apiKey: resolveApiKey(providerId, ''),
        baseUrl: resolveBaseUrl(providerId),
        proxy: resolveProxy(providerId),
      });
      return { model, modelId: nextId, providerId, outputWindow: modelInfo?.outputWindow };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
