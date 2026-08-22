/**
 * 管理端「以此库视角预览学习端」的开关。
 *
 * 兑现设计方案 §7.1 的承诺：「管理员可在知识库详情页一键切换至该知识库视角，
 * 对学习端内容进行预览」。2026-08-21 审计发现这个功能从来没实现过。
 *
 * ## 为什么用 cookie 而不是 query 参数
 *
 * 预览要在学习端**整站**生效（首页、路径卡、课程墙都按该库的视角显示），
 * 一个 query 参数只能带到第一个页面，点一下就丢。cookie 走一次设置、全站有效、
 * 退出预览再清掉。
 *
 * ## 「别动真画像」怎么保证
 *
 * 这里只写 cookie，**一个字节都不写进账户画像**。`/api/profile` 读到这个 cookie 时
 * 覆盖返回的 `fields.corpus`，但写入路径（`action: 'update'` 那些）在预览态下
 * 拒改 corpus——否则学习端那个 800ms 防抖的自动保存会把预览值当成用户的真实选择
 * 落进账户里，管理员看一眼别人的库，别人的画像就被改了。
 *
 * 只给 manager。cookie 短时（30 分钟）自动过期，忘了退出也不会一直挂着。
 */
import { NextRequest, NextResponse } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createLogger } from '@/lib/logger';

const log = createLogger('PreviewCorpus API');

export const dynamic = 'force-dynamic';

/** 预览态 cookie 名。`/api/profile` 认这个键。 */
export const PREVIEW_CORPUS_COOKIE = 'preview-corpus';
const MAX_AGE_SECONDS = 30 * 60;

/** 库名判据与引擎侧一致（`domain_intake.py`：小写字母数字与 - _，1-32 位）。 */
const CORPUS_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

async function requireManager(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const account = await accountForSession(token);
  return account && account.role === 'manager' ? account : null;
}

export async function POST(req: NextRequest) {
  const manager = await requireManager(req);
  if (!manager) {
    return NextResponse.json({ error: '仅管理员可用' }, { status: 403 });
  }

  let corpus: unknown;
  try {
    ({ corpus } = (await req.json()) as { corpus?: unknown });
  } catch {
    return NextResponse.json({ error: '请求体不是 JSON' }, { status: 400 });
  }

  // corpus 为空 = 退出预览
  if (corpus === null || corpus === undefined || corpus === '') {
    const res = NextResponse.json({ ok: true, previewCorpus: null });
    res.cookies.delete(PREVIEW_CORPUS_COOKIE);
    log.info(`Manager ${manager.id} exited corpus preview`);
    return res;
  }

  if (typeof corpus !== 'string' || !CORPUS_RE.test(corpus)) {
    return NextResponse.json({ error: '库名不合法' }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, previewCorpus: corpus });
  res.cookies.set(PREVIEW_CORPUS_COOKIE, corpus, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  log.info(`Manager ${manager.id} entered corpus preview: ${corpus}`);
  return res;
}

export async function GET(req: NextRequest) {
  const manager = await requireManager(req);
  if (!manager) return NextResponse.json({ error: '仅管理员可用' }, { status: 403 });
  return NextResponse.json({
    previewCorpus: req.cookies.get(PREVIEW_CORPUS_COOKIE)?.value ?? null,
  });
}
