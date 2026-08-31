/**
 * 域级实操项目：管理端读初稿全文（GET）/ 发起起草（POST）。
 *
 * 角色闸与 intake-runs 桥同一道（manager 才给），过闸带 GROUNDING_TOKEN 调引擎。
 * 起草是同步长请求：引擎要跑 GitHub 实时搜索 + 两轮模型调用（实测 1-2 分钟），
 * 桥超时放 240s；失败把引擎的报错文案原样透传（网络不通/限流/模型未启用都要
 * 让管理员看见，不许静默成空结果）。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('PracticeScoutDraft API');
// 引擎侧实测：主域一次起草 286 秒（未认证 GitHub 配额下每轮搜索要等 6.5 秒，
// 三轮降词 + 十四次 README + 两次模型调用）。原来这里卡 240 秒，桥先放弃、
// 管理员看到「超时」，而引擎四十多秒后照常把初稿写盘了——稿子在，人却以为失败。
const DRAFT_TIMEOUT_MS = 480_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 500;

async function managerGate() {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '实操项目起草只对管理者账号开放。');
  }
  return null;
}

function engineBase() {
  return process.env.GROUNDING_URL?.replace(/\/$/, '') ?? '';
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ corpus: string }> },
) {
  const denied = await managerGate();
  if (denied) return denied;
  const { corpus } = await params;
  const base = engineBase();
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '未配置引擎地址（GROUNDING_URL）。');
  }
  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}`, {
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, `引擎返回 HTTP ${resp.status}`);
    }
    return apiSuccess({ draft: body });
  } catch (error) {
    log.warn(`read draft failed for ${corpus}: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '引擎不可达。');
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ corpus: string }> },
) {
  const denied = await managerGate();
  if (denied) return denied;
  const { corpus } = await params;
  const base = engineBase();
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '未配置引擎地址（GROUNDING_URL）。');
  }
  const payload = await req.json().catch(() => ({}));
  try {
    const resp = await fetch(
      `${base}/api/practice-scout/${encodeURIComponent(corpus)}/draft`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        },
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(DRAFT_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    const body = (await resp.json().catch(() => ({}))) as { detail?: string };
    if (!resp.ok) {
      log.warn(`draft HTTP ${resp.status} for ${corpus}: ${body.detail ?? ''}`);
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        502,
        body.detail || `引擎返回 HTTP ${resp.status}`,
      );
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
