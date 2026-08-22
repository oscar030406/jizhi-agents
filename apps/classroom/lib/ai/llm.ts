/**
 * Unified LLM Call Layer
 *
 * All LLM interactions should go through callLLM / streamLLM.
 */

import { generateText, streamText } from 'ai';
import type { GenerateTextResult, JSONValue, LanguageModel, StreamTextResult } from 'ai';
import { createLogger } from '@/lib/logger';
import { PROVIDERS, getConfiguredProviderId } from './providers';
import { thinkingContext } from './thinking-context';
import { getModelMetadataKey } from './model-metadata';
import { getCanonicalModelId } from './model-aliases';
import {
  isFallbackWorthyError,
  isGenerationFallbackEnabled,
  isGenerationFallbackSource,
  pickFallbackModel,
} from './model-fallback';
import type { ThinkingCapability, ThinkingConfig } from '@/lib/types/provider';
import {
  getThinkingMode,
  pickThinkingBudget,
  pickThinkingEffort,
  pickThinkingLevel,
} from '@/lib/ai/thinking-config';
const log = createLogger('LLM');

// Re-export for external use
export type { ThinkingConfig } from '@/lib/types/provider';

// Re-export the parameter types accepted by AI SDK
type GenerateTextParams = Parameters<typeof generateText>[0];
type StreamTextParams = Parameters<typeof streamText>[0];

function _extractRequestInfo(params: GenerateTextParams | StreamTextParams) {
  const tools = params.tools ? Object.keys(params.tools as Record<string, unknown>) : undefined;

  const p = params as Record<string, unknown>;
  return {
    system: p.system as string | undefined,
    prompt: p.prompt as string | undefined,
    messages: p.messages as unknown[] | undefined,
    tools,
    maxOutputTokens: p.maxOutputTokens as number | undefined,
  };
}

function getModelId(params: GenerateTextParams | StreamTextParams): string {
  const m = params.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object' && 'modelId' in m) return (m as { modelId: string }).modelId;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Thinking / Reasoning Adapter
//
// Builds a lookup table from PROVIDERS at module load time, then uses it to
// map a unified ThinkingConfig into provider-specific providerOptions.
// Native providers (OpenAI/Anthropic/Google) are mapped to providerOptions.
// OpenAI-compatible providers are injected by the providers.ts fetch wrapper.
// ---------------------------------------------------------------------------

interface ModelThinkingInfo {
  thinking?: ThinkingCapability;
}

/** Provider/model → thinking capability (built once at module load) */
const MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      map.set(getModelMetadataKey(provider.id, model.id), {
        thinking: model.capabilities?.thinking,
      });
    }
  }
  return map;
})();

/** Model ID → thinking capability for IDs that are unique across providers. */
const UNIQUE_MODEL_THINKING_MAP: Map<string, ModelThinkingInfo> = (() => {
  const counts = new Map<string, number>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
    }
  }

  const map = new Map<string, ModelThinkingInfo>();
  for (const provider of Object.values(PROVIDERS)) {
    for (const model of provider.models) {
      if (counts.get(model.id) === 1) {
        map.set(model.id, {
          thinking: model.capabilities?.thinking,
        });
      }
    }
  }
  return map;
})();

/** Global thinking override from environment variable */
function getGlobalThinkingConfig(): ThinkingConfig | undefined {
  if (process.env.LLM_THINKING_DISABLED === 'true') {
    return { mode: 'disabled', enabled: false };
  }
  return undefined;
}

type ProviderOptions = Record<string, Record<string, JSONValue | undefined>>;

function getAnthropicEffort(
  thinking: ThinkingCapability,
  config: ThinkingConfig,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = pickThinkingEffort(thinking, config);
  if (!effort || effort === 'none' || effort === 'minimal') return undefined;
  return effort;
}

function normalizeProviderId(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  if (!provider) return undefined;
  if (provider === 'anthropic.messages' && modelId?.startsWith('MiniMax-')) return 'minimax';
  if (provider in PROVIDERS) return provider;
  const prefix = provider.split('.')[0];
  return prefix in PROVIDERS ? prefix : undefined;
}

function getModelProviderId(params: GenerateTextParams | StreamTextParams): string | undefined {
  const m = params.model;
  if (!m || typeof m !== 'object' || !('provider' in m)) return undefined;
  const provider = (m as { provider?: string }).provider;
  const modelId = 'modelId' in m ? (m as { modelId?: string }).modelId : undefined;
  return normalizeProviderId(provider, modelId);
}

/**
 * Map a unified ThinkingConfig to provider-specific providerOptions.
 */
function buildThinkingProviderOptions(
  providerId: string | undefined,
  modelId: string,
  config: ThinkingConfig,
): ProviderOptions | undefined {
  const lookupModelId = providerId ? getCanonicalModelId(providerId, modelId) : modelId;
  const info = providerId
    ? MODEL_THINKING_MAP.get(getModelMetadataKey(providerId, lookupModelId))
    : UNIQUE_MODEL_THINKING_MAP.get(lookupModelId);
  if (!info?.thinking) return undefined; // model has no thinking capability
  const thinking = info.thinking;
  if (thinking.control === 'none') return undefined;

  const mode = getThinkingMode(config);

  switch (thinking.requestAdapter) {
    case 'openai': {
      const effort = pickThinkingEffort(thinking, config);
      return effort ? { openai: { reasoningEffort: effort } } : undefined;
    }

    case 'anthropic': {
      const buildAnthropicOptions = (
        options: Record<string, JSONValue | undefined>,
      ): ProviderOptions => ({
        anthropic: options,
      });

      if (mode === 'disabled') return buildAnthropicOptions({ thinking: { type: 'disabled' } });

      if (thinking.control === 'toggle-budget' || thinking.control === 'budget-only') {
        const budget = pickThinkingBudget(thinking, config);
        return budget === undefined
          ? undefined
          : buildAnthropicOptions({ thinking: { type: 'enabled', budgetTokens: budget } });
      }

      const effort = getAnthropicEffort(thinking, config);
      if (!effort) return undefined;

      if (thinking.anthropicThinking?.type === 'adaptive') {
        // Some newly released Anthropic effort values can lag the local SDK
        // schema. OpenAI-compatible transports still inject those at fetch time.
        if (effort === 'xhigh') return undefined;
        return buildAnthropicOptions({
          thinking: { type: 'adaptive' },
          effort,
        });
      }

      const manualEffort = effort === 'xhigh' ? 'max' : effort;
      const budget = thinking.anthropicThinking?.budgetByEffort?.[manualEffort];
      if (!budget) return undefined;
      return buildAnthropicOptions({
        thinking: { type: 'enabled', budgetTokens: budget },
        effort: manualEffort,
      });
    }

    case 'google': {
      if (thinking.control === 'level') {
        const level = pickThinkingLevel(thinking, config);
        return level ? { google: { thinkingConfig: { thinkingLevel: level } } } : undefined;
      }

      const budget = pickThinkingBudget(thinking, config);
      if (budget === undefined) return undefined;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }

    default:
      // OpenAI-compatible providers are injected in providers.ts fetch wrapper.
      return undefined;
  }
}

/**
 * Resolve providerOptions for direct AI SDK calls that bypass callLLM/streamLLM.
 */
export function resolveThinkingProviderOptions(
  model: LanguageModel,
  thinkingConfig?: ThinkingConfig,
): ProviderOptions | undefined {
  if (!thinkingConfig) return undefined;
  if (typeof model !== 'object' || !('modelId' in model)) return undefined;
  const modelId = (model as { modelId?: string }).modelId ?? 'unknown';
  const provider = 'provider' in model ? (model as { provider?: string }).provider : undefined;
  return buildThinkingProviderOptions(
    normalizeProviderId(provider, modelId),
    modelId,
    thinkingConfig,
  );
}

/**
 * Inject provider-specific thinking options into LLM call params.
 *
 * For native providers (OpenAI/Anthropic/Google), this sets providerOptions.
 * For OpenAI-compatible providers, providerOptions won't work (stripped by
 * zod schema) — those are handled by the custom fetch wrapper via thinkingContext.
 *
 * Priority: caller's providerOptions > ThinkingConfig
 */
function injectProviderOptions<T extends GenerateTextParams | StreamTextParams>(
  params: T,
  thinking?: ThinkingConfig,
): T {
  if ((params as Record<string, unknown>).providerOptions) return params; // caller explicitly set providerOptions

  const modelId = getModelId(params);
  const providerId = getModelProviderId(params);

  if (thinking) {
    const opts = buildThinkingProviderOptions(providerId, modelId, thinking);
    if (opts) return { ...params, providerOptions: opts };
  }

  return params;
}

/**
 * Options for LLM call retry on validation failure.
 * This is separate from the AI SDK's built-in maxRetries (which handles network/5xx errors).
 */
export interface LLMRetryOptions {
  /** Max retry attempts when validate() fails or the response is empty (default: 0 = no retry) */
  retries?: number;
  /** Custom validation function. Return true to accept the result, false to retry.
   *  Default: checks that response text is non-empty. */
  validate?: (text: string) => boolean;
}

const DEFAULT_VALIDATE = (text: string) => text.trim().length > 0;

// ---------------------------------------------------------------------------
// Usage capture
//
// Every server-side LLM call funnels through callLLM/streamLLM, so usage is
// recorded here in one place. Fire-and-forget: failures never affect generation.
// The fs-backed storage is imported dynamically so llm.ts stays safe to bundle
// wherever it's transitively imported.
// ---------------------------------------------------------------------------

function buildUsageMeta(params: GenerateTextParams | StreamTextParams, source: string) {
  const rawModelId = getModelId(params);
  // 落账优先用 getModel() 挂上的真实 providerId。`getModelProviderId` 读的是 AI SDK
  // 的 `model.provider`，对所有 OpenAI 兼容第三方都是 'openai.chat'，归一化成 openai
  // 就把 siliconflow 记成了 openai。只改账本口径，不动 thinking 路径的解析。
  const providerId =
    getConfiguredProviderId(params.model) ?? getModelProviderId(params) ?? 'unknown';
  const modelId = getCanonicalModelId(providerId, rawModelId);
  return { source, providerId, modelId, modelString: `${providerId}:${modelId}` };
}

/**
 * Record one call's usage. Never throws.
 *
 * `finishReason` 是后加的：产物断在半截时，「撞到输出上限」和「模型自己收尾」
 * 长得一模一样，不记就没法归因。见
 * apps/engine/data/eval/model_matrix_20260730/README.md。
 */
function recordUsageSafe(
  rawUsage: unknown,
  meta: { source: string; providerId: string; modelId: string; modelString: string },
  finishReason?: string,
  fallbackFrom?: string,
): void {
  void (async () => {
    try {
      const { normalizeUsage } = await import('@/lib/usage/normalize');
      const { recordUsage } = await import('@/lib/server/usage-storage');
      // 课程归因走异步上下文，不进 callLLM 的签名——全库 23 个调用点里
      // 大部分不属于任何课程，加必填参数只会让它们传 undefined。
      // 同一个模式 thinking-context.ts 已经用过一次，这里照做。
      const { currentClassroomId } = await import('@/lib/ai/usage-context');
      const classroomId = currentClassroomId();
      await recordUsage({
        kind: 'llm',
        source: meta.source,
        providerId: meta.providerId,
        modelId: meta.modelId,
        modelString: meta.modelString,
        usage: normalizeUsage(rawUsage as never),
        ...(finishReason ? { finishReason } : {}),
        ...(classroomId ? { classroomId } : {}),
        ...(fallbackFrom ? { fallbackFrom } : {}),
      });
    } catch (err) {
      log.warn('Usage capture failed (ignored):', err);
    }
  })();
}

/**
 * 换下一档模型，或者放弃（返回 undefined）。
 *
 * **开关关闭时第一个条件就短路**，后面的动态 import 一次都不会发生——
 * 这是「关掉 = 行为不变」的落点。见 lib/ai/model-fallback.ts。
 */
async function nextGenerationFallback(
  source: string,
  currentModelId: string,
  error: unknown,
  tried: Set<string>,
): Promise<{ model: LanguageModel; modelId: string; outputWindow?: number } | undefined> {
  if (!isGenerationFallbackEnabled() || !isGenerationFallbackSource(source)) return undefined;
  const reason = isFallbackWorthyError(error);
  if (!reason) return undefined;

  tried.add(currentModelId);
  const candidate = await pickFallbackModel(currentModelId, tried);
  if (!candidate) return undefined;

  log.warn(
    `[${source}] ${currentModelId} failed (${reason}); falling back to ${candidate.modelId}`,
  );
  // 如实留痕：账本靠 buildUsageMeta 自动记实际模型，这一条是给生成产物元数据
  // 和车间面板用的——静默替换是这个项目明令零容忍的事。
  try {
    const { recordModelFallback } = await import('@/lib/ai/usage-context');
    recordModelFallback({ source, from: currentModelId, to: candidate.modelId, reason });
  } catch {
    /* 留痕失败不影响回落本身 */
  }
  return candidate;
}

/**
 * Unified wrapper around `generateText`.
 *
 * @param params - Same parameters as AI SDK's `generateText`
 * @param source - A short label for log grouping (e.g. 'scene-stream', 'pbl-chat')
 * @param retryOptions - Optional retry-on-validation-failure settings
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export async function callLLM<T extends GenerateTextParams>(
  params: T,
  source: string,
  retryOptions?: LLMRetryOptions,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<GenerateTextResult<any, any>> {
  const maxAttempts = (retryOptions?.retries ?? 0) + 1;
  const validate = retryOptions?.validate ?? (maxAttempts > 1 ? DEFAULT_VALIDATE : undefined);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lastResult: GenerateTextResult<any, any> | undefined;
  let lastError: unknown;

  // 跨模型回落（WO-M2，默认关）。开关关闭时 nextGenerationFallback 一进门就
  // 返回 undefined，外层循环只跑一轮 —— 与加这层之前完全同一条路径。
  let activeParams: T = params;
  const originalModelId = getModelId(params);
  const triedModels = new Set<string>();

  for (;;) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Resolve effective thinking config: per-call > global env > undefined
        const effectiveThinking = thinking ?? getGlobalThinkingConfig();
        const injectedParams = injectProviderOptions(activeParams, effectiveThinking);

        // Wrap in thinkingContext so the custom fetch wrapper in providers.ts
        // can read the config and inject vendor-specific body params for
        // OpenAI-compatible providers.
        const result = await thinkingContext.run(effectiveThinking, () =>
          generateText(injectedParams),
        );

        // Validate result (only when retries are configured)
        if (validate && !validate(result.text)) {
          log.warn(
            `[${source}] Validation failed (attempt ${attempt}/${maxAttempts}), ${attempt < maxAttempts ? 'retrying...' : 'giving up'}`,
          );
          lastResult = result;
          continue;
        }

        // 账本记的是**实际打出去的那个模型**（meta 从 activeParams 现算），
        // 回落过就再补一个 fallbackFrom 说明它本来该是谁。不许静默替换。
        const actualModelId = getModelId(activeParams);
        recordUsageSafe(
          result.usage,
          buildUsageMeta(activeParams, source),
          (result as { finishReason?: string }).finishReason,
          actualModelId === originalModelId ? undefined : originalModelId,
        );
        return result;
      } catch (error) {
        lastError = error;

        if (attempt < maxAttempts) {
          log.warn(
            `[${source}] Call failed (attempt ${attempt}/${maxAttempts}), retrying...`,
            error,
          );
          continue;
        }
      }
    }

    // 校验失败（lastResult 有值）不是「这台模型挂了」，不换模型——保持原语义。
    if (lastResult) break;
    const next = await nextGenerationFallback(
      source,
      getModelId(activeParams),
      lastError,
      triedModels,
    );
    if (!next) break;

    const currentMaxOut = (activeParams as { maxOutputTokens?: number }).maxOutputTokens;
    activeParams = {
      ...activeParams,
      model: next.model,
      // 上一档的输出上限可能超过备胎的（65536 → 32768 的模型会被拒 400）。
      ...(next.outputWindow && (currentMaxOut ?? Infinity) > next.outputWindow
        ? { maxOutputTokens: next.outputWindow }
        : {}),
    };
  }

  // All attempts exhausted — return last result or throw last error
  if (lastResult) return lastResult;
  throw lastError;
}

/**
 * Unified wrapper around `streamText`.
 *
 * Returns the same StreamTextResult.
 *
 * @param params - Same parameters as AI SDK's `streamText`
 * @param source - A short label for log grouping
 * @param thinking - Optional per-call thinking config (overrides global LLM_THINKING_DISABLED)
 */
export function streamLLM<T extends StreamTextParams>(
  params: T,
  source: string,
  thinking?: ThinkingConfig,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): StreamTextResult<any, any> {
  // Resolve effective thinking config and wrap in thinkingContext
  const effectiveThinking = thinking ?? getGlobalThinkingConfig();

  // Wrap onFinish to capture usage when the stream completes, preserving any
  // caller-supplied onFinish. totalUsage aggregates across steps.
  const usageMeta = buildUsageMeta(params, source);
  const callerOnFinish = (params as Record<string, unknown>).onFinish as
    | ((event: { totalUsage?: unknown; usage?: unknown; finishReason?: string }) => void | Promise<void>)
    | undefined;
  const wrappedParams = {
    ...params,
    onFinish: async (event: { totalUsage?: unknown; usage?: unknown; finishReason?: string }) => {
      recordUsageSafe(event.totalUsage ?? event.usage, usageMeta, event.finishReason);
      if (callerOnFinish) await callerOnFinish(event);
    },
  } as T;

  const injectedParams = injectProviderOptions(wrappedParams, effectiveThinking);
  const result = thinkingContext.run(effectiveThinking, () => streamText(injectedParams));

  return result;
}
