import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '@/app/api/tutor/route';

/**
 * `/api/tutor` 的字段改名那一跳：客户端 `lectureHistory` → 引擎 `lecture_history`。
 *
 * 引擎无状态，「第二问降维还是推进」全靠这个数组。改名掉了 = 引擎按空历史算 =
 * 第二问被标成「探测提问」、理由行写「这是本节第一问」（摸底 §2.6 的画面）。
 * 这一跳没有别的测试盖到：引擎侧的 `tests/test_tutor_lecture.py` 直接构造
 * `lecture_history`，`scripts/tutor_cross_course_probe.py` 直接打引擎端口，
 * 两个都跳过了这层代理。
 */

const ORIGINAL_URL = process.env.GROUNDING_URL;
let upstreamBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  process.env.GROUNDING_URL = 'http://engine.test';
  upstreamBodies = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBodies.push(JSON.parse(String(init?.body ?? '{}')));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { mode: 'ask', question: 'Q', decision_type: 'simplify' } }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_URL === undefined) delete process.env.GROUNDING_URL;
  else process.env.GROUNDING_URL = ORIGINAL_URL;
});

describe('/api/tutor 转发', () => {
  it('lectureHistory 原样改名成 lecture_history 交给引擎', async () => {
    const history = [{ question: 'Q/K/V 分别起什么作用？', answer: '不知道', verdict: 'incorrect' }];
    const res = await POST(
      new NextRequest('http://localhost/api/tutor', {
        method: 'POST',
        body: JSON.stringify({
          lectureText: '注意力机制有三个核心变量。',
          sceneTitle: 'Q/K/V 核心概念',
          lectureHistory: history,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upstreamBodies).toHaveLength(1);
    expect(
      upstreamBodies[0].lecture_history,
      '这个数组是引擎唯一的多轮状态，丢了第二问就退回「第一问」',
    ).toEqual(history);
  });
});
