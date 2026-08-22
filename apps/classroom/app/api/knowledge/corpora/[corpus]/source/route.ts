/**
 * 按需读一个知识库原件的正文与它切出的块（管理端「原件与处理过程」的弹层用）。
 *
 * 只读：不写盘、不调引擎。数据全在引擎数据目录（主域）或接入时记下的原件目录（扩展域），
 * 引擎停机时照常返回。
 *
 * 两道闸，缺一不可：
 * 1. **角色**：与 `/admin` 同一道，管理者账号才给——原件路径与正文是机构内部信息。
 * 2. **路径**：`file` 只能落在这个库自己的原件根目录里，根目录由服务端现算，
 *    调用方指不了；越界与非文本扩展名一律 404（见 `lib/server/knowledge-source.ts`
 *    的 `readSourceFile`）。这里不重复一套判断，免得两处口径漂移。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { readSourceFile } from '@/lib/server/knowledge-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ corpus: string }> },
) {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '原件接口只对管理者账号开放。');
  }

  const { corpus } = await params;
  const file = req.nextUrl.searchParams.get('file');
  if (!file) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '要指定 file（相对原件目录的路径）。');
  }

  const detail = await readSourceFile(corpus, file);
  if (!detail) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      404,
      '读不到这个原件：路径不在该库的原件目录内、格式不是可读文本，或文件已不在盘上。',
    );
  }
  return apiSuccess({ file: detail });
}
