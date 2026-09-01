/**
 * 知识库中心的数据接口（`/admin/knowledge` 页的同一份数据，给客户端用）。
 *
 * 页面本身是服务端组件，直接调 `lib/server/knowledge-center.ts`，不经这条路由——
 * 这里存在是为了后续要在浏览器里刷新状态的场景（上传后重查、流水线 run 视图）。
 *
 * 数据全部来自引擎数据目录里的产物文件，不经引擎进程，所以引擎停机时这条路由照常返回。
 * 只读：不写盘、不触发任何任务。
 *
 * 权限与 `/admin` 同一道：管理者账号才给；通过后仍只返回公共库与本机构私有库。
 * 语料路径、许可状态、就绪度是机构内部信息。
 */

import { cookies } from 'next/headers';

import { corpusVisibilityFor } from '@/lib/accounts/org-store';
import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { readCorpora } from '@/lib/server/knowledge-center';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '知识库接口只对管理者账号开放。');
  }
  const visible = await corpusVisibilityFor(account.id);
  const corpora = (await readCorpora()).filter((corpus) => visible(corpus.corpus));
  return apiSuccess({ corpora });
}
