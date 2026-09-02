/**
 * GET /api/domain-path/[corpus]：域级学习路径的桥。
 *
 * 只钉一件事，但这件事是本轮返工的病根：**引擎不可达不许被压成「这个域没有路径」**。
 * 两者在学习端是完全不同的结论——前者是服务故障（刷新可能就好了），后者是数据事实
 * （这个库还没跑过接入流水线）。桥回空路径的话，学员看到的是被编出来的后者。
 * 所以这里锁死：引擎没起 → success=false 且响应里没有 path 字段。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const access = vi.hoisted(() => ({
  requireCorpusVisible: vi.fn(),
}));
const profiles = vi.hoisted(() => ({ readProfile: vi.fn() }));
const blueprints = vi.hoisted(() => ({ fetchLearnerBlueprint: vi.fn() }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/server/corpus-access', () => ({
  requireCorpusVisible: access.requireCorpusVisible,
}));
vi.mock('@/lib/accounts/store', () => ({ readProfile: profiles.readProfile }));
vi.mock('@/lib/generation/learner-profile', () => ({
  fetchLearnerBlueprint: blueprints.fetchLearnerBlueprint,
}));

const req = {} as NextRequest;

async function get(corpus = 'smart-manufacturing') {
  const { GET } = await import('@/app/api/domain-path/[corpus]/route');
  return GET(req, { params: Promise.resolve({ corpus }) });
}

const originalFetch = globalThis.fetch;
const originalUrl = process.env.GROUNDING_URL;

describe('GET /api/domain-path/[corpus]', () => {
  beforeEach(() => {
    process.env.GROUNDING_URL = 'http://engine.test';
    access.requireCorpusVisible.mockResolvedValue({
      ok: true,
      account: { id: 'acct-learner' },
      visible: () => true,
    });
    profiles.readProfile.mockResolvedValue({
      domain: 'ai',
      corpus: 'ai',
      education: '本科',
      conceptMastery: { PID控制器: 0.82 },
      conceptMasteryByDomain: {
        ai: { rag: 0.9 },
        'smart-manufacturing': { plc_scan_cycle: 0.82 },
      },
      conceptConfidence: { rag: 0.95 },
      conceptConfidenceByDomain: {
        ai: { rag: 0.95 },
        'smart-manufacturing': { plc_scan_cycle: 0.67 },
      },
      conceptRecall: { rag: 0.91 },
      conceptRecallByDomain: {
        ai: { rag: 0.91 },
        'smart-manufacturing': { plc_scan_cycle: 0.61 },
      },
      currentDifficulty: 'L4',
      currentDifficultyByDomain: { ai: 'L4', 'smart-manufacturing': 'L2' },
      eloRating: 1600,
      eloRatingByDomain: { ai: 1600, 'smart-manufacturing': 1040 },
    });
    blueprints.fetchLearnerBlueprint.mockResolvedValue({
      mastery_vector: { plc_scan_cycle: 0.82 },
      weak_concepts: [],
      recommended_difficulty: 'L2',
      learning_risks: [],
      diagnosis_summary: '',
      blueprint: null,
    });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GROUNDING_URL = originalUrl;
    vi.restoreAllMocks();
  });

  it('没配引擎地址：显式报错，不回空路径', async () => {
    delete process.env.GROUNDING_URL;
    const res = await get();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; path?: unknown };
    expect(body.success).toBe(false);
    expect(body.path).toBeUndefined();
  });

  it('引擎不可达：502 + 报错文案，不冒充「该域没有路径」', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await get();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; path?: unknown; error: string };
    expect(body.success).toBe(false);
    expect(body.path).toBeUndefined();
    expect(body.error).toContain('学习路径服务');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('引擎在线：拆掉 ApiResponse 信封，路径本体包进 { path }', async () => {
    const payload = {
      corpus: 'smart-manufacturing',
      label: '智能制造：ROS2 与 S7-1200 PLC',
      source: 'intake',
      stages: [{ index: 1, title: '第 1 阶', concepts: [{ name: 'PID控制器', depth: 0 }] }],
      caliber: '阶段由前置图拓扑深度分档',
    };
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(
        'http://engine.test/internal/v1/personalize/domain-path/smart-manufacturing',
      );
      expect(init?.method).toBe('POST');
      const sent = JSON.parse(String(init?.body)) as {
        corpus: string;
        profile: {
          domain: string;
          corpus: string;
          education: string;
          conceptMastery?: unknown;
          conceptConfidence?: unknown;
          conceptRecall?: unknown;
          currentDifficulty?: string;
          eloRating?: number;
        };
        masteryVector: Record<string, number>;
        masteryCorpus: string;
        conceptMastery?: unknown;
      };
      expect(sent).toMatchObject({
        corpus: 'smart-manufacturing',
        profile: {
          domain: 'smart-manufacturing',
          corpus: 'smart-manufacturing',
          education: '本科',
          conceptMastery: { plc_scan_cycle: 0.82 },
          conceptConfidence: { plc_scan_cycle: 0.67 },
          conceptRecall: { plc_scan_cycle: 0.61 },
          currentDifficulty: 'L2',
          eloRating: 1040,
        },
        masteryVector: { plc_scan_cycle: 0.82 },
        masteryCorpus: 'smart-manufacturing',
      });
      expect(sent).not.toHaveProperty('conceptMastery');
      // 引擎那侧是 `ApiResponse(data=...)`，桥必须拆到 data
      return new Response(JSON.stringify({ code: 'SUCCESS', data: payload, traceId: 't1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; path: typeof payload };
    expect(body.success).toBe(true);
    expect(body.path).toEqual(payload);
    expect(blueprints.fetchLearnerBlueprint).toHaveBeenCalledWith(
      'smart-manufacturing',
      expect.objectContaining({
        domain: 'smart-manufacturing',
        corpus: 'smart-manufacturing',
        education: '本科',
      }),
    );
    expect(blueprints.fetchLearnerBlueprint.mock.calls[0]?.[1]).toHaveProperty('conceptMastery', {
      plc_scan_cycle: 0.82,
    });
  });

  it('同源诊断桥失败：路径结构照常返回，并显式标注本次未个性化', async () => {
    blueprints.fetchLearnerBlueprint.mockRejectedValue(new Error('学情诊断桥不可达'));
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              corpus: 'smart-manufacturing',
              source: 'intake',
              stages: [{ index: 1, title: '第 1 阶', concepts: [{ id: 'plc', name: 'PLC' }] }],
              personalization: { matched_mastery: 0 },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.path.stages).toHaveLength(1);
    expect(body.path.personalization.mastery_available).toBe(false);
    expect(body.path.personalization.reason).toContain('学情诊断暂时不可用');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('AI 主域不再把手工路径送进引擎', async () => {
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('http://engine.test/internal/v1/personalize/domain-path/ai');
      const sent = JSON.parse(String(init?.body)) as {
        corpus: string;
        curatedPath?: unknown;
      };
      expect(sent.corpus).toBe('ai');
      expect(sent).not.toHaveProperty('curatedPath');
      return new Response(
        JSON.stringify({
          data: {
            corpus: 'ai',
            source: 'index-graph',
            stages: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const res = await get('ai');
    expect(res.status).toBe(200);
    expect((await res.json()).path.source).toBe('index-graph');
  });

  // source=none 是引擎的正常回答（该库没跑过接入流水线），桥不许把它改写成错误：
  // 「没有路径」和「取不到路径」在页面上是两种不同的终态。
  it('引擎说这个域没有路径：照样是 success，reason 原样透传', async () => {
    const payload = { corpus: 'odoo', source: 'none', reason: '该库没有概念表', stages: [] };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'SUCCESS', data: payload, traceId: 't2' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const res = await get();
    const body = (await res.json()) as { success: boolean; path: { reason: string } };
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.path.reason).toBe('该库没有概念表');
  });

  // 引擎答了 200 却没放 data（信封空）：这是上游异常，不是「该域没有路径」。
  it('信封里没有 data：报错，不当成空路径', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'SUCCESS', data: null, traceId: 't3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const res = await get();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; path?: unknown };
    expect(body.success).toBe(false);
    expect(body.path).toBeUndefined();
  });
});

describe('机构可见性闸', () => {
  const originalUrl2 = process.env.GROUNDING_URL;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.GROUNDING_URL = originalUrl2;
    vi.restoreAllMocks();
  });

  it('别的机构的库：403，且不打引擎', async () => {
    // 学习端一共三个取数口（domains / skills / 这条），隔离轴要列全——
    // 少挡一个口，私有教材的概念表与目录结构就从这里漏出去。
    process.env.GROUNDING_URL = 'http://engine.test';
    access.requireCorpusVisible.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ success: false }), { status: 403 }),
    });
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const { GET } = await import('@/app/api/domain-path/[corpus]/route');
    const res = await GET({} as NextRequest, {
      params: Promise.resolve({ corpus: 'smart-manufacturing' }),
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.success).toBe(false);
    expect(body).not.toHaveProperty('path');
    expect(spy).not.toHaveBeenCalled();
    expect(access.requireCorpusVisible).toHaveBeenCalledWith('smart-manufacturing');
  });

  it('公共库：闸放行，照常打引擎', async () => {
    process.env.GROUNDING_URL = 'http://engine.test';
    access.requireCorpusVisible.mockResolvedValue({ ok: true, account: null, visible: () => true });
    profiles.readProfile.mockResolvedValue(null);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { corpus: 'iotdb', source: 'intake', stages: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    const { GET } = await import('@/app/api/domain-path/[corpus]/route');
    const res = await GET({} as NextRequest, { params: Promise.resolve({ corpus: 'iotdb' }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.path.corpus).toBe('iotdb');
  });
});
