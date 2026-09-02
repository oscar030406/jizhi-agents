import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fetchEvidence, requireEvidenceWhenConfigured } from '@/lib/generation/evidence-grounding';
import { fetchLearnerBlueprint } from '@/lib/generation/learner-profile';

// 四桥显式告警的语义锁：未配置可以降级；配置后失败必须显式抛出。

const ENV_KEY = 'GROUNDING_URL';

describe('bridge onFailure semantics', () => {
  const origEnv = process.env[ENV_KEY];
  const origFetch = global.fetch;

  beforeEach(() => {
    process.env[ENV_KEY] = 'http://127.0.0.1:9';
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = origEnv;
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  test('未配置 GROUNDING_URL：不触发 onFailure', async () => {
    delete process.env[ENV_KEY];
    const onFailure = vi.fn();
    const result = await fetchEvidence('q', undefined, undefined, onFailure);
    expect(result).toMatchObject({ status: 'unavailable', configured: false });
    expect(requireEvidenceWhenConfigured(result)).toBeNull();
    expect(await fetchLearnerBlueprint('goal', {}, onFailure)).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('HTTP 500：显式 unavailable，生产调用不得继续', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const onFailure = vi.fn();
    const result = await fetchEvidence('q', undefined, undefined, onFailure);
    expect(result).toMatchObject({ status: 'unavailable', configured: true });
    expect(() => requireEvidenceWhenConfigured(result)).toThrow('HTTP 500');
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  test('网络异常：触发 onFailure 且返回 null', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const onFailure = vi.fn();
    await expect(fetchLearnerBlueprint('goal', {}, onFailure)).rejects.toThrow('学情诊断桥不可达');
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('学情诊断桥 HTTP 失败：不得静默生成通用课程', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const onFailure = vi.fn();
    await expect(fetchLearnerBlueprint('goal', {}, onFailure)).rejects.toThrow('HTTP 503');
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('503'));
  });

  test('学情诊断把证据账本折出的概念掌握度送进引擎', async () => {
    global.fetch = vi.fn(async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        corpus: 'smart-manufacturing',
        concept_mastery: { plc_scan_cycle: 0.82 },
      });
      return new Response(
        JSON.stringify({
          data: {
            mastery_vector: { plc_scan_cycle: 0.82 },
            weak_concepts: [],
            recommended_difficulty: 'L2',
            learning_risks: [],
            diagnosis_summary: '',
            blueprint: null,
          },
        }),
        { status: 200 },
      );
    });
    const result = await fetchLearnerBlueprint('PLC 联调', {
      corpus: 'smart-manufacturing',
      conceptMastery: { plc_scan_cycle: 0.82 },
    });
    expect(result?.mastery_vector).toEqual({ plc_scan_cycle: 0.82 });
  });

  // 证据桥屏级重试（WO-L1 根因修复的一半）：引擎按域检索器冷启动 3.4~13.2s 实测，
  // 首次超时后引擎仍在后台把检索器建完，立刻重试命中缓存。语义锁两条：
  // 只重试一次；两次都失败才算失败（onFailure 恰好一次）。
  test('证据桥网络异常：重试一次，两次都失败才触发 onFailure', async () => {
    const mock = vi.fn().mockRejectedValue(new DOMException('t', 'TimeoutError'));
    global.fetch = mock;
    const onFailure = vi.fn();
    const result = await fetchEvidence('q', undefined, undefined, onFailure);
    expect(result).toMatchObject({ status: 'unavailable', configured: true });
    expect(() => requireEvidenceWhenConfigured(result)).toThrow('证据检索桥不可达');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('TimeoutError'));
  });

  test('证据桥首次超时、重试成功：返回证据且不触发 onFailure', async () => {
    const payload = {
      data: {
        chunks: [{ source_id: 'x#s1', title: 't', content: 'c'.repeat(100), concept_tags: [] }],
      },
    };
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    global.fetch = mock;
    const onFailure = vi.fn();
    const result = await fetchEvidence('q', undefined, undefined, onFailure);
    const bundle = requireEvidenceWhenConfigured(result);
    expect(bundle?.chunks).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('200 但零命中：复查一次仍空才显式 empty 并阻断整课', async () => {
    // Response body 只能读一次，mock 必须每次调用给新实例（生产端每次 attempt 都是新 fetch）
    const mock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ data: { chunks: [] } }), { status: 200 }));
    global.fetch = mock;
    const onFailure = vi.fn();
    const result = await fetchEvidence('q', undefined, undefined, onFailure);
    expect(result).toMatchObject({ status: 'empty' });
    // 空结果要隔 3 秒复查一次（引擎 embedding 瞬态降级会假报 0 命中）
    expect(mock).toHaveBeenCalledTimes(2);
    expect(() => requireEvidenceWhenConfigured(result)).toThrow('未命中可用于本课的证据');
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('200 零命中但复查命中：返回证据，不误杀', async () => {
    const hit = {
      data: {
        chunks: [{ source_id: 'x#s1', title: 't', content: 'c'.repeat(100), concept_tags: [] }],
      },
    };
    const mock = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ data: { chunks: [] } }), { status: 200 }),
      )
      .mockImplementation(async () => new Response(JSON.stringify(hit), { status: 200 }));
    global.fetch = mock;
    const result = await fetchEvidence('q', undefined, undefined, vi.fn());
    expect(requireEvidenceWhenConfigured(result)?.chunks).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
