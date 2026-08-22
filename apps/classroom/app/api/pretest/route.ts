/**
 * Pretest calibration proxy.
 *
 * Self-assessment correlates only r≈.29 with measured ability, so the profile
 * popover offers an optional 6-question pretest: self-rating is the prior, the
 * tested level corrects it (covariate-initialization precedent: Park 2019).
 * GET fetches per-dimension questions (no answers), POST grades and returns
 * {dim: {self, tested, corrected, evidence}}.
 *
 * Degrades to 204 when the engine is unreachable — calibration is optional,
 * the profile keeps working on self-report alone.
 */

import { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import { apiSuccess } from '@/lib/server/api-response';


// 代理引擎实时状态，必须每次真去问。`fetch` 上的 `cache: 'no-store'` 只管住对引擎那一跳，
// 管不住 Next 对 GET 路由处理器自身的缓存（2026-08-19 在 /api/skills 上实测踩过：
// 引擎侧数据都换了，走代理拿到的还是旧的）。
export const dynamic = 'force-dynamic';

const log = createLogger('Pretest');

export interface PretestQuestion {
  id: string;
  dim: string;
  question: string;
  options: Record<string, string>;
}

export interface PretestDimResult {
  self: number;
  tested: number;
  corrected: number;
  evidence: string;
}

function engineBase(): string | null {
  const base = process.env.GROUNDING_URL;
  return base ? base.replace(/\/$/, '') : null;
}

export async function GET(req: NextRequest) {
  const base = engineBase();
  if (!base) return new Response(null, { status: 204 });
  try {
    const dims = req.nextUrl.searchParams.get('dims') ?? 'agent,rag,engineering';
    const perDim = req.nextUrl.searchParams.get('per_dim') ?? '2';
    const url = `${base}/internal/v1/personalize/pretest?dims=${encodeURIComponent(dims)}&per_dim=${encodeURIComponent(perDim)}`;
    const resp = await fetch(url, {
      headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!resp.ok) return new Response(null, { status: 204 });
    const payload = (await resp.json()) as { data?: { questions?: PretestQuestion[] } };
    if (!payload.data?.questions?.length) return new Response(null, { status: 204 });
    return apiSuccess({ questions: payload.data.questions });
  } catch (err) {
    log.warn(`Pretest questions unavailable: ${String(err)}`);
    return new Response(null, { status: 204 });
  }
}

export async function POST(req: NextRequest) {
  const base = engineBase();
  if (!base) return new Response(null, { status: 204 });
  try {
    const body = (await req.json()) as {
      answers: Record<string, string>;
      self_levels: Record<string, number>;
    };
    const resp = await fetch(`${base}/internal/v1/personalize/pretest/grade`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ answers: body.answers ?? {}, self_levels: body.self_levels ?? {} }),
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
    if (!resp.ok) return new Response(null, { status: 204 });
    const payload = (await resp.json()) as { data?: Record<string, PretestDimResult> };
    if (!payload.data) return new Response(null, { status: 204 });
    log.info(`Pretest graded: ${Object.keys(payload.data).join(', ')}`);
    return apiSuccess({ results: payload.data });
  } catch (err) {
    log.warn(`Pretest grading unavailable: ${String(err)}`);
    return new Response(null, { status: 204 });
  }
}
