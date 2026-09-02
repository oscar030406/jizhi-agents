/**
 * 学习者档案接口：列表 / 新建 / 改名改字段 / 删除 / 切换。
 *
 * ## 为什么要有这个路由
 *
 * 画像原来只随 `/api/auth` 一起吐出来，**没有独立写口**——前端想改画像、换知识库
 * 都无处可去，于是「切换档案」只能在 localStorage 里自己玩（`lib/runtime/learner-accounts.ts`），
 * 而服务端画像纹丝不动，登录刷新又把本地改动覆盖回去。用户 2026-08-18 抓到的四条
 * （换不了 / 编不了 / 换库无效 / 报告与画像对不上）都是这一个断点的下游。
 *
 * 现在服务端是画像的单一真源：这里读写，前端只做视图。
 *
 * ## 契约
 *
 * - `GET`  → `{ profiles: [{id,name,createdAt,updatedAt}], activeId, fields }`
 *   `fields` 是**当前档案**的扁平画像，与 `/api/auth` 里那个 `profile` 同一个东西。
 * - `POST` → `{ action: 'create'|'update'|'delete'|'activate', ... }`，成功回与 GET 同形。
 *
 * 全部动作都要登录态；未登录一律 401，不给匿名兜底——匿名画像是旧世界的东西，
 * 再留一条就又会长出第二套真源。
 */

import { NextRequest, NextResponse } from 'next/server';

import { accountForSession, readProfileEnvelope, writeProfileEnvelope } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import {
  activateProfile,
  activeFields,
  createProfile,
  deleteProfile,
  updateProfile,
  type ProfileEnvelope,
} from '@/lib/accounts/profiles';
import { PREVIEW_CORPUS_COOKIE } from '@/app/api/admin/preview-corpus/route';
import { createLogger } from '@/lib/logger';
import { requireCorpusVisible } from '@/lib/server/corpus-access';
import { corpusOf } from '@/lib/generation/learner-profile';

const log = createLogger('Profile API');

export const runtime = 'nodejs';

/** 对外视图：档案列表不带 fields（列表页用不上，少传一份画像全文）。 */
function view(env: ProfileEnvelope) {
  return {
    profiles: env.profiles.map(({ id, name, createdAt, updatedAt }) => ({
      id,
      name,
      createdAt,
      updatedAt,
    })),
    activeId: env.activeId,
    fields: activeFields(env),
  };
}

async function requireAccount(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return accountForSession(token);
}

export async function GET(req: NextRequest) {
  const account = await requireAccount(req);
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const env = await readProfileEnvelope(account.id);
  if (!env) return NextResponse.json({ error: '读不到档案' }, { status: 500 });

  // 管理端「以此库视角预览学习端」（§7.1）：只覆盖返回值，**不碰盘上的画像**。
  // 覆盖放在这里而不是前端，是为了让整站都跟着变——首页、路径卡、课程墙读的都是
  // 这个接口，一处覆盖处处生效，不用在每个消费方各判一次预览态。
  const preview = req.cookies.get(PREVIEW_CORPUS_COOKIE)?.value;
  const base = view(env);
  if (preview) {
    const access = await requireCorpusVisible(preview);
    if (!access.ok) return access.response;
    return NextResponse.json({
      ...base,
      fields: { ...(base.fields ?? {}), corpus: preview },
      previewCorpus: preview,
    });
  }
  const storedCorpus = corpusOf(base.fields);
  if (storedCorpus) {
    const access = await requireCorpusVisible(storedCorpus);
    if (!access.ok) {
      // 机构切换后，旧画像可能仍指向原机构私有库。GET 只净化响应副本，让当前
      // 指派继续定域；盘上历史保留，POST 对不可见库仍按下面的写入闸严格拒绝。
      if (access.response.status !== 403) return access.response;
      return NextResponse.json({
        ...base,
        fields: { ...(base.fields ?? {}), domain: null, corpus: null },
        profileCorpusUnavailable: storedCorpus,
      });
    }
  }
  return NextResponse.json(base);
}

export async function POST(req: NextRequest) {
  const account = await requireAccount(req);
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });

  // 预览态下拒绝写画像。学习端那个 800ms 防抖的自动保存不知道自己在预览里，
  // 不拦的话管理员看一眼别人的库，被预览者的真实画像就被改成了那个库。
  // 预览是只读视角，要改画像先退出预览。
  if (req.cookies.get(PREVIEW_CORPUS_COOKIE)?.value) {
    return NextResponse.json(
      { error: '正在以某个知识库的视角预览学习端，此时不写入画像；要改画像请先退出预览。' },
      { status: 409 },
    );
  }

  let body: {
    action?: string;
    id?: string;
    name?: string;
    fields?: Record<string, unknown>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const env = await readProfileEnvelope(account.id);
  if (!env) return NextResponse.json({ error: '读不到档案' }, { status: 500 });

  // 纯函数在 `lib/accounts/profiles.ts` 里，全部返回 {ok} 判别式——
  // 这里只负责鉴权、分发、落盘，不重复实现任何校验。
  const result = (() => {
    switch (body.action) {
      case 'create':
        return createProfile(env, body.name ?? '', body.fields ?? {});
      case 'update':
        return updateProfile(env, body.id ?? env.activeId, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.fields !== undefined ? { fields: body.fields } : {}),
        });
      case 'delete':
        return deleteProfile(env, body.id ?? '');
      case 'activate':
        return activateProfile(env, body.id ?? '');
      default:
        return { ok: false as const, message: `未知动作：${String(body.action)}` };
    }
  })();

  if (!result.ok) {
    // 400 而不是 500：这些都是用户输入问题（重名、空名、删最后一份、id 不存在），
    // 不是服务端故障。前端照着 message 直接显示即可。
    return NextResponse.json({ error: result.message }, { status: 400 });
  }

  const targetId =
    body.action === 'create'
      ? result.env.activeId
      : body.action === 'update'
        ? (body.id ?? env.activeId)
        : undefined;
  const targetCorpus = corpusOf(
    result.env.profiles.find((profile) => profile.id === targetId)?.fields,
  );
  const corpora = new Set([targetCorpus, corpusOf(activeFields(result.env))].filter(Boolean));
  for (const corpus of corpora) {
    const access = await requireCorpusVisible(corpus as string);
    if (!access.ok) return access.response;
  }

  await writeProfileEnvelope(account.id, result.env);
  log.info(`${account.username}: profile ${body.action} ok (${result.env.profiles.length} 份档案)`);
  return NextResponse.json(view(result.env));
}
