/**
 * 知识库归属（owner 专用）：把库认领到本机构（本机构学员才可见）或释放为公共库。
 *
 * 归属表存目录名字符串（选型论证：corpus 在磁盘上是目录、pg 无实体表）；
 * 无归属行 = 公共库 = 人人可见，存量三库因此零迁移。
 */

import type { NextRequest } from 'next/server';

import { corpusOwnership, orgForAccount, setCorpusOrg } from '@/lib/accounts/org-store';
import { isValidCorpusName, releaseCorpusOwnerMarker } from '@/lib/server/knowledge-center';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgCorpora API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const access = await requireCorpusVisible();
  if (!access.ok) return access.response;
  if (!access.account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');
  const org = await orgForAccount(access.account.id).catch(() => null);
  if (!org || org.memberRole !== 'owner') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以查看知识库归属。');
  }
  try {
    const ownership = await corpusOwnership();
    return apiSuccess({
      ownership: Object.fromEntries([...ownership].filter(([corpus]) => access.visible(corpus))),
    });
  } catch (error) {
    log.warn(`read corpus ownership failed: ${String(error)}`);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 503, '知识库归属暂时无法读取。');
  }
}

export async function POST(req: NextRequest) {
  const access = await requireCorpusVisible();
  if (!access.ok) return access.response;
  if (!access.account) return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。');
  const org = await orgForAccount(access.account.id);
  if (!org || org.memberRole !== 'owner') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理知识库归属。');
  }
  const body = (await req.json().catch(() => ({}))) as { corpus?: string; action?: string };
  const corpus = String(body.corpus ?? '').trim();
  if (!corpus || !isValidCorpusName(corpus)) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '知识库名不合法。');
  }
  if (body.action === 'claim') {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      409,
      '知识库归属只由成功的入库任务自动建立，公共系统知识库不能手工认领。',
    );
  }
  if (body.action !== 'release') {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'action 需为 release。');
  }
  try {
    if ((await corpusOwnership()).get(corpus) !== org.id) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只能释放本机构知识库。');
    }
    const result = await setCorpusOrg(corpus, null, org.id);
    if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
    if (!(await releaseCorpusOwnerMarker(corpus, org.id))) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只能释放本机构知识库。');
    }
    log.info(`corpus ${corpus} ${body.action} by org ${org.id}`);
    return apiSuccess({ corpus, action: body.action });
  } catch (error) {
    log.warn(`release corpus ownership failed: ${String(error)}`);
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 503, '知识库归属暂时无法释放。');
  }
}
