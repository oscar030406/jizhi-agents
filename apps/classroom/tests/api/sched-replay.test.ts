import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ accountForSession: vi.fn() }));

vi.mock('@/lib/accounts/store', () => ({ accountForSession: mocks.accountForSession }));

const FLAGS = ['SCHED_K', 'SCHED_POLICY', 'SCHED_L_MS', 'SCHED_G_MS', 'SCHED_RECORD', 'SCHED_CELL'];

function post(body: unknown) {
  return new NextRequest('http://localhost/api/sched-replay', {
    method: 'POST',
    headers: { cookie: 'jizhi_session=session-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const job = { jobId: 7, student: 3, serviceMs: 120, predictedCostS: 0.5, limitMs: 61_000 };

beforeEach(() => {
  vi.resetModules();
  mocks.accountForSession.mockResolvedValue({ id: 'acct-1', username: 'simu_s0003' });
});

afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe('调度回放路由', () => {
  it('派发器关着时不存在', async () => {
    const { POST } = await import('@/app/api/sched-replay/route');
    const response = await POST(post(job));
    expect(response.status).toBe(404);
    expect(mocks.accountForSession).not.toHaveBeenCalled();
  });

  it('没有会话就拒绝', async () => {
    process.env.SCHED_K = '1';
    mocks.accountForSession.mockResolvedValue(null);
    const { POST } = await import('@/app/api/sched-replay/route');
    expect((await POST(post(job))).status).toBe(401);
  });

  it('开着时排队、占槽到派发时刻加注入时长，并把 jobId 与账号记进逐 job 记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sched-replay-'));
    process.env.SCHED_K = '1';
    process.env.SCHED_POLICY = 'fcfs';
    process.env.SCHED_L_MS = '61000';
    process.env.SCHED_G_MS = '300000';
    process.env.SCHED_CELL = 'route-test';
    process.env.SCHED_RECORD = join(dir, 'jobs.jsonl');
    const { POST } = await import('@/app/api/sched-replay/route');

    const response = await POST(post(job));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobId: 7 });

    const [line] = (await readFile(join(dir, 'jobs.jsonl'), 'utf-8')).trim().split('\n');
    const record = JSON.parse(line);
    expect(record).toMatchObject({
      cell: 'route-test',
      jobClass: 'codebench',
      jobId: 7,
      student: 3,
      account: 'simu_s0003',
      requestedMs: 120,
      limitMs: 61_000,
      predictedCostS: 0.5,
    });
    // 槽位从派发占到「派发 + 注入时长」的绝对截止时刻：不多出定时器粒度那 15.6 ms
    const holdingMs = (record.completeUs - record.dispatchUs) / 1000;
    expect(holdingMs).toBeGreaterThanOrEqual(120);
    expect(holdingMs).toBeLessThan(123);
  });
});
