import { cookies } from 'next/headers';

import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusOwnership, corpusVisibilityFor, orgForAccount } from '@/lib/accounts/org-store';
import { accountForSession } from '@/lib/accounts/store';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError } from '@/lib/server/api-response';

const log = createLogger('Corpus Access');

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
