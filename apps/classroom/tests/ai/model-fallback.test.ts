/**
 * 生成端跨模型回落（WO-M2）。零 API：上游用 mock 造 5xx / 超时。
 *
 * 这份用例的第一职责不是证明回落能用，而是证明**关掉时什么都没变**——
 * 开关默认关，默认路径上的调用次数、抛出的错误对象、账本行必须与加这层之前一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';

const aiMock = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

const usageMock = vi.hoisted(() => ({
  normalizeUsage: vi.fn((usage: unknown) => usage),
  recordUsage: vi.fn(async (_input: Record<string, unknown>) => undefined),
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: aiMock.generateText, streamText: aiMock.streamText };
});

vi.mock('@/lib/usage/normalize', () => ({
  normalizeUsage: usageMock.normalizeUsage,
  hasBillableTokens: () => true,
}));

vi.mock('@/lib/server/usage-storage', () => ({
  recordUsage: usageMock.recordUsage,
}));

// 白名单固定成三档，不依赖 .env.local 当时长什么样（那是会变的）。
vi.mock('@/lib/server/provider-config', () => ({
  getServerProviders: () => ({
    siliconflow: {
      models: ['Qwen/Qwen3.5-397B-A17B', 'MiniMaxAI/MiniMax-M2.5', 'zai-org/GLM-5.2'],
    },
  }),
  resolveApiKey: () => 'test-key',
  resolveBaseUrl: () => 'https://api.siliconflow.cn/v1',
  resolveProxy: () => undefined,
}));

import { callLLM } from '@/lib/ai/llm';
import { usageAttribution } from '@/lib/ai/usage-context';
import type { ModelFallbackEvent } from '@/lib/ai/model-fallback';
import { isFallbackWorthyError } from '@/lib/ai/model-fallback';
import { redactCaliber } from '@/lib/metrics/redact-caliber';

const PRIMARY = 'Qwen/Qwen3.5-397B-A17B';

function primaryParams() {
  return {
    model: { provider: 'openai.chat', modelId: PRIMARY },
    prompt: 'hi',
    maxOutputTokens: 65536,
    maxRetries: 0,
  } as unknown as Parameters<typeof callLLM>[0];
}

function upstream(status: number) {
  return new APICallError({
    message: `upstream ${status}`,
    url: 'https://api.siliconflow.cn/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
  });
}

function timeout() {
  const err = new Error('Headers Timeout Error');
  err.name = 'HeadersTimeoutError';
  return err;
}

function okResult(text = 'ok') {
  return { text, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' };
}

/** 收集本次调用里的回落留痕，跟路由 enterWith 的做法一致。 */
async function runCollecting<T>(fn: () => Promise<T>): Promise<{
  result?: T;
  error?: unknown;
  fallbacks: ModelFallbackEvent[];
}> {
  const fallbacks: ModelFallbackEvent[] = [];
  return usageAttribution.run({ classroomId: 'test-course', fallbacks }, async () => {
    try {
      return { result: await fn(), fallbacks };
    } catch (error) {
      return { error, fallbacks };
    }
  });
}

const ORIGINAL_SWITCH = process.env.GENERATION_MODEL_FALLBACK;

beforeEach(() => {
  aiMock.generateText.mockReset();
  usageMock.recordUsage.mockClear();
  delete process.env.GENERATION_MODEL_FALLBACK;
});

afterEach(() => {
  if (ORIGINAL_SWITCH === undefined) delete process.env.GENERATION_MODEL_FALLBACK;
  else process.env.GENERATION_MODEL_FALLBACK = ORIGINAL_SWITCH;
});

// ---------------------------------------------------------------------------
// 一、开关关闭 = 行为不变（本单的头号硬约束）
// ---------------------------------------------------------------------------

describe('开关关闭时行为与现状一致', () => {
  it('默认（未设环境变量）就是关闭', () => {
    expect(process.env.GENERATION_MODEL_FALLBACK).toBeUndefined();
  });

  it('主模型 503：只打一次，原样抛回同一个错误对象，不换模型', async () => {
    const err = upstream(503);
    aiMock.generateText.mockRejectedValue(err);

    const { error, fallbacks } = await runCollecting(() =>
      callLLM(primaryParams(), 'scene-content'),
    );

    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect(error).toBe(err); // 同一个引用，不是包装过的新错误
    expect(fallbacks).toEqual([]);
  });

  it('主模型超时：同样只打一次', async () => {
    aiMock.generateText.mockRejectedValue(timeout());
    const { error } = await runCollecting(() => callLLM(primaryParams(), 'scene-content'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect((error as Error).name).toBe('HeadersTimeoutError');
  });

  it('成功路径：模型参数一字未改，账本不带 fallbackFrom', async () => {
    aiMock.generateText.mockResolvedValue(okResult());

    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));

    const sent = aiMock.generateText.mock.calls[0][0] as {
      model: { modelId: string };
      maxOutputTokens: number;
    };
    expect(sent.model.modelId).toBe(PRIMARY);
    expect(sent.maxOutputTokens).toBe(65536);

    await vi.waitFor(() => expect(usageMock.recordUsage).toHaveBeenCalled());
    const row = usageMock.recordUsage.mock.calls[0][0];
    expect(row.modelId).toBe(PRIMARY);
    expect(row).not.toHaveProperty('fallbackFrom');
  });

  it('校验重试（retries）语义不变：同一个模型重试满次数后返回最后结果', async () => {
    aiMock.generateText.mockResolvedValue({ ...okResult(''), text: '' });

    const { result } = await runCollecting(() =>
      callLLM(primaryParams(), 'scene-content', { retries: 2 }),
    );

    expect(aiMock.generateText).toHaveBeenCalledTimes(3);
    for (const call of aiMock.generateText.mock.calls) {
      expect((call[0] as { model: { modelId: string } }).model.modelId).toBe(PRIMARY);
    }
    expect((result as { text: string }).text).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 二、开关打开后的回落本身
// ---------------------------------------------------------------------------

describe('开关打开后的跨模型回落', () => {
  beforeEach(() => {
    process.env.GENERATION_MODEL_FALLBACK = '1';
  });

  it('主模型 503 → 降到白名单下一档，成功返回', async () => {
    aiMock.generateText
      .mockRejectedValueOnce(upstream(503))
      .mockResolvedValueOnce(okResult('备胎生成的内容'));

    const { result, fallbacks } = await runCollecting(() =>
      callLLM(primaryParams(), 'scene-content'),
    );

    expect(aiMock.generateText).toHaveBeenCalledTimes(2);
    expect((result as { text: string }).text).toBe('备胎生成的内容');
    expect(fallbacks).toEqual([
      {
        source: 'scene-content',
        from: PRIMARY,
        to: 'MiniMaxAI/MiniMax-M2.5',
        reason: 'HTTP 503',
      },
    ]);
  });

  it('账本记实际用上的模型，并写明 fallbackFrom', async () => {
    aiMock.generateText.mockRejectedValueOnce(upstream(503)).mockResolvedValueOnce(okResult());

    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));

    await vi.waitFor(() => expect(usageMock.recordUsage).toHaveBeenCalled());
    const row = usageMock.recordUsage.mock.calls[0][0];
    expect(row.modelId).toBe('MiniMaxAI/MiniMax-M2.5');
    expect(row.fallbackFrom).toBe(PRIMARY);
    expect(row.classroomId).toBe('test-course');
  });

  it('备胎的 maxOutputTokens 被夹到它自己的输出上限（GLM-5.2 = 32768）', async () => {
    aiMock.generateText
      .mockRejectedValueOnce(upstream(503))
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce(okResult());

    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));

    const third = aiMock.generateText.mock.calls[2][0] as {
      model: { modelId: string };
      maxOutputTokens: number;
    };
    expect(third.model.modelId).toBe('zai-org/GLM-5.2');
    expect(third.maxOutputTokens).toBe(32768);
  });

  it('白名单走完仍失败：抛最后一个错误，不无限降', async () => {
    aiMock.generateText.mockRejectedValue(upstream(503));

    const { error, fallbacks } = await runCollecting(() =>
      callLLM(primaryParams(), 'scene-content'),
    );

    expect(aiMock.generateText).toHaveBeenCalledTimes(3); // 白名单三档，各一次
    expect(APICallError.isInstance(error)).toBe(true);
    expect(fallbacks.map((f) => f.to)).toEqual(['MiniMaxAI/MiniMax-M2.5', 'zai-org/GLM-5.2']);
  });

  it('判官链不回落（红线）：scene-audit 503 只打一次', async () => {
    aiMock.generateText.mockRejectedValue(upstream(503));

    const { fallbacks } = await runCollecting(() => callLLM(primaryParams(), 'scene-audit'));

    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
    expect(fallbacks).toEqual([]);
  });

  it('quiz-grade（评分=尺子）同样不回落', async () => {
    aiMock.generateText.mockRejectedValue(upstream(503));
    await runCollecting(() => callLLM(primaryParams(), 'quiz-grade'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('鉴权错（401）不回落——换模型救不了错 key', async () => {
    aiMock.generateText.mockRejectedValue(upstream(401));
    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('429 限流不回落——同一个 key 的配额，换模型没用', async () => {
    aiMock.generateText.mockRejectedValue(upstream(429));
    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('客户端 abort 不回落', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    aiMock.generateText.mockRejectedValue(abort);
    await runCollecting(() => callLLM(primaryParams(), 'scene-content'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });

  it('不在白名单里的模型不回落', async () => {
    aiMock.generateText.mockRejectedValue(upstream(503));
    const params = {
      model: { provider: 'openai.chat', modelId: 'some/unlisted-model' },
      prompt: 'hi',
      maxRetries: 0,
    } as unknown as Parameters<typeof callLLM>[0];

    await runCollecting(() => callLLM(params, 'scene-content'));
    expect(aiMock.generateText).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 三、错误分类与上屏脱敏
// ---------------------------------------------------------------------------

describe('错误分类', () => {
  it.each([
    [500, 'HTTP 500'],
    [502, 'HTTP 502'],
    [503, 'HTTP 503'],
  ])('%i 值得换模型', (status, reason) => {
    expect(isFallbackWorthyError(upstream(status))).toBe(reason);
  });

  it.each([400, 401, 403, 404, 429])('%i 不换', (status) => {
    expect(isFallbackWorthyError(upstream(status))).toBeUndefined();
  });

  it('AbortSignal.timeout 的 TimeoutError 算超时', () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    expect(isFallbackWorthyError(err)).toBe('超时或网络中断');
  });

  it('undici 的 fetch failed 算网络中断', () => {
    expect(isFallbackWorthyError(new TypeError('fetch failed'))).toBe('超时或网络中断');
  });

  it('包在 cause 链里的超时也认得出', () => {
    const inner = new Error('connect ETIMEDOUT');
    (inner as { code?: string }).code = 'ETIMEDOUT';
    expect(isFallbackWorthyError(new Error('wrapped', { cause: inner }))).toBe('超时或网络中断');
  });
});

describe('上屏脱敏', () => {
  // 车间面板渲染的是 redactCaliber(f.to)。白名单里每一档都必须被抹掉，
  // 否则「回落」这条黄行本身就成了泄型号的入口。
  it.each([
    'Qwen/Qwen3.5-397B-A17B',
    'MiniMaxAI/MiniMax-M2.5',
    'Qwen/Qwen3.5-122B-A10B',
    'deepseek-ai/DeepSeek-V3.2',
    'Qwen/Qwen3-30B-A3B-Instruct-2507',
    'zai-org/GLM-5.2',
  ])('%s 上屏被抹成〈型号略〉', (modelId) => {
    expect(redactCaliber(modelId)).toBe('〈型号略〉');
  });
});
