/**
 * /api/compare 异步 job 流：POST 创建任务立即返回 jobId，
 * 引擎调用在 next/server after() 回调里后台跑，GET ?job= 轮询状态与结果。
 *
 * WO-D3 起 POST 要求登录（未登录 401），GET 保持只读不鉴权。
 * 这里把账户查询打桩：登录态由 `signedIn` 开关控制。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const afterCallbacks: Array<() => unknown> = [];

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      afterCallbacks.push(fn);
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

let signedIn = true;

vi.mock('@/lib/accounts/store', () => ({
  accountForSession: vi.fn(async () =>
    signedIn ? { id: 'acc_1', username: 'u', displayName: 'u', role: 'learner' } : null,
  ),
}));

const engineFetch = vi.fn();

async function postCompare(body: unknown) {
  const { POST } = await import('@/app/api/compare/route');
  const request = new Request('http://localhost/api/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: 'jizhi_session=t' },
    body: JSON.stringify(body),
  });
  return POST(request as unknown as NextRequest);
}

async function getCompare(jobId: string) {
  const { GET } = await import('@/app/api/compare/route');
  const request = new Request(`http://localhost/api/compare?job=${jobId}`);
  return GET(request as unknown as NextRequest);
}

const VALID_BODY = {
  learningGoal: '完成 RAG 文档问答 Agent',
  profiles: [{ preset_id: 'zero_beginner' }, { preset_id: 'backend_to_agent' }],
};

describe('/api/compare 异步 job 流', () => {
  beforeEach(() => {
    vi.resetModules();
    signedIn = true;
    afterCallbacks.length = 0;
    engineFetch.mockReset();
    vi.stubGlobal('fetch', engineFetch);
    process.env.GROUNDING_URL = 'http://engine.test';
    // 进程内 job Map 挂在 globalThis 上，跨用例清掉
    delete (globalThis as Record<string, unknown>).__compareJobs;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GROUNDING_URL 未配置时返回 503，不创建任务', async () => {
    delete process.env.GROUNDING_URL;
    const res = await postCompare(VALID_BODY);
    expect(res.status).toBe(503);
    expect(afterCallbacks).toHaveLength(0);
  });

  it('未登录 POST 返回 401，不创建任务；GET 深链仍可读', async () => {
    signedIn = false;
    const res = await postCompare(VALID_BODY);
    expect(res.status).toBe(401);
    // 语义是「没登录」不是「凭证错」——别退回 INVALID_CREDENTIALS
    expect((await res.json()).errorCode).toBe('UNAUTHORIZED');
    expect(afterCallbacks).toHaveLength(0);
    // GET 不鉴权：先用登录态造一个 job，再以未登录身份轮询
    signedIn = true;
    const created = await (await postCompare(VALID_BODY)).json();
    signedIn = false;
    const poll = await getCompare(created.jobId);
    expect(poll.status).toBe(200);
    expect((await poll.json()).status).toBe('queued');
  });

  it('缺 learningGoal 或 profiles 不足两个时返回 400', async () => {
    const res = await postCompare({ learningGoal: '', profiles: [] });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('POST 创建任务立即返回 jobId；引擎成功后 GET 拿到结果', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let resolveEngine!: (v: Response) => void;
    engineFetch.mockReturnValue(new Promise<Response>((r) => (resolveEngine = r)));

    const res = await postCompare(VALID_BODY);
    expect(res.status).toBe(202);
    const created = await res.json();
    expect(created.jobId).toBeTruthy();
    expect(created.status).toBe('queued');
    // 引擎调用被排进 after 回调，POST 本身不等它
    expect(afterCallbacks).toHaveLength(1);

    const running = afterCallbacks[0]!() as Promise<void>;
    // 引擎未返回前轮询是 running
    let poll = await (await getCompare(created.jobId)).json();
    expect(poll.status).toBe('running');
    expect(poll.done).toBe(false);

    resolveEngine(
      new Response(JSON.stringify({ data: { learning_goal: 'g', entries: [1, 2] } }), {
        status: 200,
      }),
    );
    await running;

    poll = await (await getCompare(created.jobId)).json();
    expect(poll.status).toBe('succeeded');
    expect(poll.done).toBe(true);
    expect(poll.result.entries).toHaveLength(2);
    // 引擎超时 20 分钟：必须罩得住页面标注的 14–18 分钟（WO-D3）
    const signal = engineFetch.mock.calls[0]![1]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenCalledWith(20 * 60 * 1000);
    timeoutSpy.mockRestore();
  });

  it('引擎失败时 job 落为 failed 并带真实错误', async () => {
    engineFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    const created = await (await postCompare(VALID_BODY)).json();
    await afterCallbacks[0]!();

    const poll = await (await getCompare(created.jobId)).json();
    expect(poll.status).toBe('failed');
    expect(poll.error).toContain('500');
  });

  it('GET 未知 jobId 返回 404、缺参数返回 400', async () => {
    expect((await getCompare('nope')).status).toBe(404);
    const { GET } = await import('@/app/api/compare/route');
    const res = await GET(new Request('http://localhost/api/compare') as unknown as NextRequest);
    expect(res.status).toBe(400);
  });
});
