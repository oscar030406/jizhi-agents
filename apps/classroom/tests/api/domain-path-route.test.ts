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

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const req = {} as NextRequest;
const params = { params: Promise.resolve({ corpus: 'smart-manufacturing' }) };

async function get() {
  const { GET } = await import('@/app/api/domain-path/[corpus]/route');
  return GET(req, params);
}

const originalFetch = globalThis.fetch;
const originalUrl = process.env.GROUNDING_URL;

describe('GET /api/domain-path/[corpus]', () => {
  beforeEach(() => {
    process.env.GROUNDING_URL = 'http://engine.test';
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
  });

  it('引擎在线：拆掉 ApiResponse 信封，路径本体包进 { path }', async () => {
    const payload = {
      corpus: 'smart-manufacturing',
      label: '智能制造：ROS2 与 S7-1200 PLC',
      source: 'intake',
      stages: [{ index: 1, title: '第 1 阶', concepts: [{ name: 'PID控制器', depth: 0 }] }],
      caliber: '阶段由前置图拓扑深度分档',
    };
    globalThis.fetch = vi.fn(async (url: unknown) => {
      expect(String(url)).toBe(
        'http://engine.test/internal/v1/personalize/domain-path/smart-manufacturing',
      );
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
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('别的机构的库：403，且不打引擎', async () => {
    // 学习端一共三个取数口（domains / skills / 这条），隔离轴要列全——
    // 少挡一个口，私有教材的概念表与目录结构就从这里漏出去。
    vi.resetModules(); // 前面的用例已经把路由模块拉进注册表，不重置的话 doMock 不生效
    process.env.GROUNDING_URL = 'http://engine.test';
    vi.doMock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
    vi.doMock('@/lib/accounts/store', () => ({ accountForSession: async () => null }));
    vi.doMock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'sid' }));
    vi.doMock('@/lib/accounts/org-store', () => ({
      corpusVisibilityFor: async () => (c: string) => c !== 'smart-manufacturing',
    }));
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
  });

  it('公共库：闸放行，照常打引擎', async () => {
    vi.resetModules(); // 前面的用例已经把路由模块拉进注册表，不重置的话 doMock 不生效
    process.env.GROUNDING_URL = 'http://engine.test';
    vi.doMock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
    vi.doMock('@/lib/accounts/store', () => ({ accountForSession: async () => null }));
    vi.doMock('@/lib/accounts/session', () => ({ SESSION_COOKIE: 'sid' }));
    vi.doMock('@/lib/accounts/org-store', () => ({
      corpusVisibilityFor: async () => () => true,
    }));
    globalThis.fetch = vi.fn(async () =>
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
