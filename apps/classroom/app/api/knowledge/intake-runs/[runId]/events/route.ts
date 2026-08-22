/**
 * 接入 run 的事件增量拉取。`?since=<上次的 nextSeq>`，返回体与引擎
 * `GET /api/domain-intake/runs/{id}/events` 同形。
 *
 * 读的是引擎数据目录里的 `events.jsonl` 本身，不转发给引擎进程——run 结束后的回放
 * 因此在引擎停机时照常可用。轮询而不是 SSE：接入 run 是分钟级批处理，事件本来就落盘，
 * 掉线重连只是把游标再传一次。
 *
 * 权限与 `/admin` 同一道：管理者账号才给。语料路径、退回清单是机构内部信息。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { isValidRunId, readRunEvents } from '@/lib/server/intake-runs';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '接入 run 接口只对管理者账号开放。');
  }
  const { runId } = await params;
  if (!isValidRunId(runId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'run 编号不合法。');
  }
  const since = Number(req.nextUrl.searchParams.get('since') ?? 0);
  const payload = await readRunEvents(runId, Number.isFinite(since) ? Math.max(0, since) : 0);
  if (!payload) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, `没有这个接入 run：${runId}`);
  }
  return apiSuccess(payload);
}
