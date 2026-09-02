import { cookies } from 'next/headers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusOwnership, corpusVisibilityFor, orgForAccount } from '@/lib/accounts/org-store';
import { accountForSession } from '@/lib/accounts/store';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError } from '@/lib/server/api-response';

const log = createLogger('Corpus Access');

const SERVICE_ORG_HEADER = 'x-jizhi-service-org';
const SERVICE_CORPUS_HEADER = 'x-jizhi-service-corpus';

export type InternalCorpusServiceAccess =
  | { attempted: false }
  | { attempted: true; ok: false; response: Response }
  | { attempted: true; ok: true; orgId: string; corpus: string };

function tokenMatches(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function isLoopbackRequest(request: NextRequest): boolean {
  const host = request.nextUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * engine -> classroom 的服务身份。任一服务 header 出现就必须完整通过本分支，
 * 失败绝不回退浏览器 cookie；header 里的 org/corpus 只是声明，最终以归属表为准。
 */
export async function authorizeInternalCorpusService(
  request: NextRequest,
  expectedCorpus: string,
): Promise<InternalCorpusServiceAccess> {
  const providedToken = request.headers.get('x-internal-token');
  const providedOrg = request.headers.get(SERVICE_ORG_HEADER);
  const providedCorpus = request.headers.get(SERVICE_CORPUS_HEADER);
  const declaredOrg = providedOrg?.trim() ?? '';
  const declaredCorpus = providedCorpus?.trim() ?? '';
  const attempted = providedToken !== null || providedOrg !== null || providedCorpus !== null;
  if (!attempted) return { attempted: false };

  const expectedToken = process.env.GROUNDING_TOKEN ?? '';
  if (
    !providedToken ||
    !expectedToken ||
    !declaredOrg ||
    !declaredCorpus ||
    !tokenMatches(providedToken, expectedToken)
  ) {
    return {
      attempted: true,
      ok: false,
      response: apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '内部服务鉴权失败。'),
    };
  }
  if (!isLoopbackRequest(request)) {
    return {
      attempted: true,
      ok: false,
      response: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '内部服务调用来源无效。'),
    };
  }
  if (declaredCorpus !== expectedCorpus) {
    return {
      attempted: true,
      ok: false,
      response: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '内部服务知识库范围不匹配。'),
    };
  }

  try {
    const owner = (await corpusOwnership()).get(expectedCorpus);
    if (!owner || owner !== declaredOrg) {
      return {
        attempted: true,
        ok: false,
        response: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '内部服务无权访问该知识库。'),
      };
    }
    return { attempted: true, ok: true, orgId: declaredOrg, corpus: expectedCorpus };
  } catch {
    log.warn('internal corpus ownership resolution failed');
    return {
      attempted: true,
      ok: false,
      response: apiError(API_ERROR_CODES.INTERNAL_ERROR, 503, '暂时无法确认知识库归属。'),
    };
  }
}

/** 请求级知识库权限闸：解析失败一律拒绝，绝不退回全量视图。 */
export async function requireCorpusVisible(corpus?: string, options?: { manage?: boolean }) {
  try {
    const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
    if (options?.manage && (!account || account.role !== 'manager')) {
      return {
        ok: false as const,
        response: apiError(
          API_ERROR_CODES.UNAUTHORIZED,
          403,
          '只有所属机构管理者可以管理该知识库。',
        ),
      };
    }
    const visible = await corpusVisibilityFor(account?.id ?? null);
    if (corpus !== undefined && !visible(corpus)) {
      return {
        ok: false as const,
        response: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '当前账户无权访问该知识库。'),
      };
    }
    if (options?.manage) {
      const org = await orgForAccount(account!.id);
      if (!org || org.memberRole !== 'owner') {
        return {
          ok: false as const,
          response: apiError(
            API_ERROR_CODES.UNAUTHORIZED,
            403,
            '只有所属机构管理者可以管理该知识库。',
          ),
        };
      }
      const owner = corpus === undefined ? null : (await corpusOwnership()).get(corpus);
      if (owner !== org.id) {
        return {
          ok: false as const,
          response: apiError(
            API_ERROR_CODES.UNAUTHORIZED,
            403,
            '只有所属机构管理者可以管理该知识库。',
          ),
        };
      }
      return { ok: true as const, account, org, visible };
    }
    return { ok: true as const, account, visible };
  } catch (error) {
    log.warn(`corpus access resolution failed: ${String(error)}`);
    return {
      ok: false as const,
      response: apiError(API_ERROR_CODES.INTERNAL_ERROR, 503, '暂时无法确认知识库访问权限。'),
    };
  }
}
