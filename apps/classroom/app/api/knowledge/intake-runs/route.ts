/**
 * 发起一次领域接入 run：把管理端表单原样转给引擎的
 * `POST /api/domain-intake/runs`。
 *
 * 引擎自己没有角色系统，写入口的角色闸在这一层（与 `/admin` 同一道：manager 才给），
 * 过闸之后带 `GROUNDING_TOKEN` 调引擎，跟既有几条桥一模一样。
 *
 * 表单在这里**完全不解析**：请求流原样转给引擎（`body: req.body`）。
 * 引擎那边已经用 `Form(...)` 声明了字段与默认值，桥拆一遍等于开第二个真源；
 * 更要紧的是解析会把整包读进内存——393MB 的包曾把这个进程 OOM kill 掉。
 *
 * 引擎收下之后开后台线程跑链，这个响应只回 run 编号，页面拿它跳到观看端轮询。
 *
 * 投料有三种形态（挑文件 / 一个 zip / 一个仓库地址），合法性一律归引擎判，
 * 它的报错文案原样透传回前端——桥再写一份规则，两边迟早对不上。
 */

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession, accountsEnabled } from '@/lib/accounts/store';
import { corpusOwnership, orgForAccount } from '@/lib/accounts/org-store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { isValidCorpusName, readCorpus } from '@/lib/server/knowledge-center';
import { createLogger } from '@/lib/logger';

const log = createLogger('IntakeRuns API');
/** 引擎收文件 + 建 run 目录是同步的，跑链才在后台线程。上传几十 MB 时这一步要等一会儿。 */
const TIMEOUT_MS = 120_000;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!accountsEnabled()) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '本部署未启用账户，管理端接口不开放。');
  }
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '发起接入 run 只对管理者账号开放。');
  }

  const corpus = req.headers.get('x-jizhi-corpus')?.trim() ?? '';
  if (!corpus || !isValidCorpusName(corpus)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '库名只能用小写字母数字与 -_。');
  }

  const base = process.env.GROUNDING_URL;
  if (!base) {
    return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '知识库接入服务暂不可用，请稍后重试。');
  }
  const org = await orgForAccount(account.id);
  if (!org || org.memberRole !== 'owner') {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有所属机构管理者可以接入知识库。');
  }
  const owner = (await corpusOwnership()).get(corpus);
  if (owner && owner !== org.id) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '该知识库已归属其他机构。');
  }
  if (!owner && (await readCorpus(corpus))?.available) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      409,
      '这是公共系统知识库，机构不能认领或覆盖；请换一个新库名接入。',
    );
  }

  // **不解析 body，把请求流原样转给引擎。**
  //
  // 2026-08-22 验收第四坎：这里原本 `await req.formData()` 解析出 FormData、
  // 再交给 fetch 重新序列化——393MB 的包在 4G 机器上至少两份副本，进程被内核干掉：
  //
  //     jizhi-web.service: Main process exited, code=killed, status=9/KILL
  //     jizhi-web.service: Failed with result 'oom-kill'
  //
  // nginx 拿不到 upstream 响应，管理者看到 502。
  //
  // 桥不需要看文件内容，它是角色闸 + 转发。原先在这里做的两项校验（库名非空、
  // 三种投料至少给一个）**引擎本来就要做一遍**，删掉不丢覆盖，反而少一处会长歪的
  // 第二真源——引擎的报错文案原样透传回前端。
  //
  // 引擎那侧用 FastAPI 的 `UploadFile`，自带磁盘溢写，不会把整包驻留内存。
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/api/domain-intake/runs`, {
      method: 'POST',
      headers: {
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        // 引擎用它核对 multipart 里的 corpus，防止归属闸检查 A 库、实际却写 B 库。
        'x-jizhi-corpus': corpus,
        // 内部可信头：引擎在 run.json 第一次落盘时固化，后续日志授权不再随库归属漂移。
        'x-jizhi-owner-org': org.id,
        // multipart 边界在 content-type 里，不带过去引擎就认不出分段。
        ...(req.headers.get('content-type')
          ? { 'content-type': req.headers.get('content-type') as string }
          : {}),
      },
      body: req.body,
      // 流式请求体的必填项，少了它 Node fetch 会抛
      // `RequestInit: duplex option is required when sending a body`。
      duplex: 'half',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
    const body = (await resp.json().catch(() => ({}))) as {
      run_id?: string;
      detail?: string;
    };
    if (!resp.ok) {
      log.warn(`create run HTTP ${resp.status}: ${body.detail ?? ''}`);
      const detail = body.detail || `引擎返回 HTTP ${resp.status}`;
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        resp.status === 400 || resp.status === 413 ? resp.status : 502,
        `${detail}；本次没有创建知识库归属。`,
      );
    }
    return apiSuccess({ run: body });
  } catch (error) {
    log.warn(`create run failed: ${String(error)}`);
    return apiError(
      API_ERROR_CODES.UPSTREAM_ERROR,
      502,
      '接入状态暂未确认；系统没有预写知识库归属，请先查看接入记录再决定是否重试。',
    );
  }
}
