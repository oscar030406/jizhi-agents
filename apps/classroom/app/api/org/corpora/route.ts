/**
 * 知识库归属（owner 专用）：把库认领到本机构（本机构学员才可见）或释放为公共库。
 *
 * 归属表存目录名字符串（选型论证：corpus 在磁盘上是目录、pg 无实体表）；
 * 无归属行 = 公共库 = 人人可见，存量三库因此零迁移。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusOwnership, orgForAccount, setCorpusOrg } from '@/lib/accounts/org-store';
import { isValidCorpusName } from '@/lib/server/knowledge-center';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgCorpora API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // 归属总表对管理端只读展示用（谁家占了哪个库）；owner 之外也可读——无敏感数据。
  const ownership = await corpusOwnership();
  return apiSuccess({ ownership: Object.fromEntries(ownership) });
}

export async function POST(req: NextRequest) {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');
  const org = await orgForAccount(account.id);
  if (!org || org.memberRole !== 'owner') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理知识库归属。');
  }
  const body = (await req.json().catch(() => ({}))) as { corpus?: string; action?: string };
  const corpus = String(body.corpus ?? '').trim();
  if (!corpus || !isValidCorpusName(corpus)) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '知识库名不合法。');
  }
  if (body.action !== 'claim' && body.action !== 'release') {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'action 需为 claim 或 release。');
  }
  const result = await setCorpusOrg(corpus, body.action === 'claim' ? org.id : null, org.id);
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
  log.info(`corpus ${corpus} ${body.action} by org ${org.id}`);
  return apiSuccess({ corpus, action: body.action });
}
