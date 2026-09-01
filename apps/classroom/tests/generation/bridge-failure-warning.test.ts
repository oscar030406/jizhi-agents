import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { fetchEvidence } from '@/lib/generation/evidence-grounding';
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
    expect(await fetchEvidence('q', undefined, undefined, onFailure)).toBeNull();
    expect(await fetchLearnerBlueprint('goal', {}, onFailure)).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('HTTP 500：触发 onFailure 且返回 null', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const onFailure = vi.fn();
    expect(await fetchEvidence('q', undefined, undefined, onFailure)).toBeNull();
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

  // 证据桥屏级重试（WO-L1 根因修复的一半）：引擎按域检索器冷启动 3.4~13.2s 实测，
  // 首次超时后引擎仍在后台把检索器建完，立刻重试命中缓存。语义锁两条：
  // 只重试一次；两次都失败才算失败（onFailure 恰好一次）。
  test('证据桥网络异常：重试一次，两次都失败才触发 onFailure', async () => {
    const mock = vi.fn().mockRejectedValue(new DOMException('t', 'TimeoutError'));
    global.fetch = mock;
    const onFailure = vi.fn();
    expect(await fetchEvidence('q', undefined, undefined, onFailure)).toBeNull();
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
    const bundle = await fetchEvidence('q', undefined, undefined, onFailure);
    expect(bundle?.chunks).toHaveLength(1);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();
  });

  test('200 但零命中：正常降级，不触发 onFailure', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ data: { chunks: [] } }), { status: 200 }));
    const onFailure = vi.fn();
    expect(await fetchEvidence('q', undefined, undefined, onFailure)).toBeNull();
    expect(onFailure).not.toHaveBeenCalled();
  });
});
