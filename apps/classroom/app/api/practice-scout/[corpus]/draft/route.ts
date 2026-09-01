/**
 * 域级实操项目：管理端读初稿全文（GET）/ 发起起草（POST）。
 *
 * 角色闸与 intake-runs 桥同一道（manager 才给），过闸带 GROUNDING_TOKEN 调引擎。
 * 起草是同步长请求：引擎要跑 GitHub 实时搜索 + 两轮模型调用（实测 1-2 分钟），
 * 桥超时放 240s；失败把引擎的报错文案原样透传（网络不通/限流/模型未启用都要
 * 让管理员看见，不许静默成空结果）。
 */

import type { NextRequest } from 'next/server';

import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScoutDraft API');
// 引擎侧实测：主域一次起草 286 秒（未认证 GitHub 配额下每轮搜索要等 6.5 秒，
// 三轮降词 + 十四次 README + 两次模型调用）。原来这里卡 240 秒，桥先放弃、
// 管理员看到「超时」，而引擎四十多秒后照常把初稿写盘了——稿子在，人却以为失败。
const DRAFT_TIMEOUT_MS = 480_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 500;

function engineBase() {
  return process.env.GROUNDING_URL?.replace(/\/$/, '') ?? '';
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus, { manage: true });
  if (!access.ok) return access.response;
  const base = engineBase();
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操项目服务暂不可用。');
  }
  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      log.warn(
        `read draft HTTP ${resp.status} for ${corpus}: ${JSON.stringify(body).slice(0, 200)}`,
      );
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务返回异常。');
    }
    return apiSuccess({ draft: body });
  } catch (error) {
    log.warn(`read draft failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务暂不可用。');
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ corpus: string }> }) {
  const { corpus } = await params;
  const access = await requireCorpusVisible(corpus, { manage: true });
  if (!access.ok) return access.response;
  const base = engineBase();
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操项目服务暂不可用。');
  }
  const payload = await req.json().catch(() => ({}));
  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/draft`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    if (!resp.ok) {
      log.warn(`draft HTTP ${resp.status} for ${corpus}: ${body.detail ?? ''}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '实操项目服务未能完成起草。');
    }
    return apiSuccess({ draft: body });
  } catch (error) {
    log.warn(`draft failed for ${corpus}: ${String(error)}`);
    // 超时不等于失败：引擎是同步长任务，桥断开后它仍会把初稿写完。
    // 说死「失败」会让管理员重复发起，白烧一轮 GitHub 配额。
    return apiError(
      API_ERROR_CODES.UPSTREAM_ERROR,
      504,
      '起草仍在进行中（要实时搜十几个仓库并逐个读说明，通常三到五分钟）。稍后刷新本页即可看到初稿，不必重复发起。',
    );
  }
}
