'use client';

/**
 * 个人控制台：账户名下随身携带的东西。
 *
 * 当前收录（2026-08-04 用户定调「个性化档案肯定在，然后生成课历史」）：
 * ① 个性化档案（服务端账户字段，登录即同步）
 * ② 生成课历史（文档存储按 learnerKey 分区，登录后天然就是「我的课」）
 * ③ 学习足迹小结（从课程与审核记录里直接算，不新引数据源）
 *
 * 未登录时不渲染业务区，只给登录引导——这页的全部内容都属于某个账户。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ShieldCheck, UserCog, Loader2, Clock } from 'lucide-react';

import { useAccountStore } from '@/lib/store/account';
import { conceptLabel } from '@/lib/knowledge/concept-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import { listStages, type StageListItem } from '@/lib/utils/stage-storage';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { SiteHeader } from '@/components/site-header';
import { EmptyState } from '@/components/ui/empty-state';

const log = createLogger('Console');

/**
 * 可见的键盘焦点圈（WCAG 2.4.7）。全局 `* { outline-ring/50 }` 画出来是 0.56px、
 * alpha 0.2 的蓝，对比度 1.6–1.8:1，达不到 1.4.11 的 3:1。`--ring` 自带 0.4 alpha
 * 压不上去，改用不透明的 `--primary`：实测亮色 6.94:1、暗色 3.57:1。
 */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary';

/** 卡片配方与 /agents 对齐：圆角 xl、亮色靠阴影分层、暗色靠 card 抬亮一档 + 半透明白描边。 */
const CARD = 'rounded-xl border border-border bg-card p-5 shadow-card dark:shadow-none';

interface StoredProfile {
  domain?: string;
  education?: string;
  identity?: string;
  currentDifficulty?: string;
  conceptMastery?: Record<string, number>;
  [key: string]: unknown;
}

function readLocalProfile(): StoredProfile | null {
  try {
    const raw = localStorage.getItem('learnerProfile');
    return raw ? (JSON.parse(raw) as StoredProfile) : null;
  } catch {
    return null;
  }
}

export default function ConsolePage() {
  const { enabled, account, loading, refresh } = useAccountStore();
  const [courses, setCourses] = useState<StageListItem[] | null>(null);
  const [profile, setProfile] = useState<StoredProfile | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadCourses = useCallback(async () => {
    try {
      const list = await listStages();
      setCourses(list.sort((a, b) => b.updatedAt - a.updatedAt));
    } catch (error) {
      log.warn(`课程清单读取失败：${String(error)}`);
      setCourses([]);
    }
  }, []);

  useEffect(() => {
    if (!account) return;
    setProfile(readLocalProfile());
    void loadCourses();
  }, [account, loadCourses]);

  const mastery = useMemo(() => {
    const m = profile?.conceptMastery ?? {};
    const entries = Object.entries(m).filter(([, v]) => typeof v === 'number');
    return entries.sort((a, b) => (b[1] as number) - (a[1] as number));
  }, [profile]);

  if (loading) {
    return (
      <div
        className="flex min-h-screen items-center justify-center gap-2 bg-background text-sm text-muted-foreground"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" />
        正在确认登录状态…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 与 /agents /privacy 同一个顶栏：返回 + 语言 + 主题（原本这页只有一个手写返回链接） */}
      <SiteHeader localized={false} maxWidth="max-w-4xl" />

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">我的控制台</h1>

        {!enabled && (
          /* 本部署关掉账户时这页原来只剩一句话。空态说清数据在哪、下一步去哪。 */
          <EmptyState
            title="本部署未启用账户系统"
            hint="学习者画像、生成的课程与答题记录都只保存在当前这个浏览器里，没有跨设备同步。画像在首页右上角「学习者画像」里改，课程在首页的最近课堂里进。"
          />
        )}

        {!enabled && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            想知道本机具体存了哪些键、什么时候清，看{' '}
            <Link
              href="/privacy"
              className={cn('rounded-sm text-blue-deep underline underline-offset-4', FOCUS_RING)}
            >
              数据与隐私
            </Link>
            。
          </p>
        )}

        {enabled && !account && (
          <div className="rounded-xl border border-border bg-card p-6 shadow-card dark:shadow-none">
            <p className="text-sm font-medium">先登录才能看到你的东西</p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              登录后，学习者画像与你生成的课程会保存在账户上，换设备继续用；
              未登录时数据只留在当前浏览器。点右上角「登录 / 注册」，用户名加密码即可，
              不需要手机号。
            </p>
          </div>
        )}

        {account && (
          <>
            <p className="-mt-3 text-sm text-muted-foreground">
              {account.displayName} · 注册于 {new Date(account.createdAt).toLocaleDateString()}
            </p>

            {/* 个性化档案 */}
            <section className={CARD}>
              <div className="flex items-center gap-2">
                <UserCog className="size-4 text-purple-deep" />
                <h2 className="text-base font-medium">个性化档案</h2>
              </div>
              {profile ? (
                <>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {[
                      ['领域', profile.domain ? domainLabel(profile.domain) : ''],
                      ['学历', profile.education],
                      ['身份', profile.identity],
                      ['当前难度档', profile.currentDifficulty],
                    ]
                      .filter(([, v]) => !!v)
                      .map(([k, v]) => (
                        <span
                          key={k as string}
                          className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
                        >
                          {k} · {String(v)}
                        </span>
                      ))}
                  </div>
                  {mastery.length > 0 && (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        概念掌握度（测验交卷后回写，用于后续选段跳过已会内容）
                      </p>
                      {mastery.slice(0, 6).map(([concept, value]) => (
                        <div key={concept} className="flex items-center gap-2">
                          <span className="w-28 shrink-0 truncate text-xs">
                            {conceptLabel(concept)}
                          </span>
                          {/* 进度条只是右侧百分比数字的图形重复，读屏走数字即可 */}
                          <div aria-hidden className="h-1.5 flex-1 rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-primary"
                              style={{ width: `${Math.round((value as number) * 100)}%` }}
                            />
                          </div>
                          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                            {Math.round((value as number) * 100)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-4 text-xs text-muted-foreground">
                    改画像回首页右上角「学习者画像」，保存后自动同步到本账户。
                  </p>
                </>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  还没有画像。回首页点右上角「学习者画像」填写，生成课程时会据此调难度与讲解深度。
                </p>
              )}
            </section>

            {/* 生成课历史 */}
            <section className={CARD}>
              <div className="flex items-center gap-2">
                <BookOpen className="size-4 text-purple-deep" />
                <h2 className="text-base font-medium">我生成的课</h2>
                {courses && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    共 {courses.length} 门
                  </span>
                )}
              </div>

              {/* 骨架/转圈只认「确实在读」：courses 只有在 loadCourses 落地前才是 null，
                  读完没有课是 []，走下面的空态而不是一直转圈。 */}
              {courses === null ? (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  读取中…
                </div>
              ) : courses.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    title="这个账户还没有课程"
                    hint="回首页输入一句学习需求即可生成，生成的课自动归到本账户。"
                  />
                </div>
              ) : (
                <ul className="mt-4 space-y-2">
                  {courses.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/classroom/${c.id}`}
                        className={cn(
                          'flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent active:bg-secondary',
                          FOCUS_RING,
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{c.name}</p>
                          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="tabular-nums">{c.sceneCount} 页</span>
                            <Clock className="size-3.5" />
                            <span className="tabular-nums">
                              {new Date(c.updatedAt).toLocaleDateString()}
                            </span>
                          </p>
                        </div>
                        <span className="shrink-0 text-sm text-purple-deep">继续学习 →</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* 学习足迹（从已有数据直接算，不新引数据源） */}
            {courses && courses.length > 0 && (
              <section className={CARD}>
                <div className="flex items-center gap-2">
                  <ShieldCheck className="size-4 text-green-deep" />
                  <h2 className="text-base font-medium">学习足迹</h2>
                </div>
                {/* 375 下三列会把日期挤断行，所以移动端两列、日期独占一行 */}
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {[
                    ['课程', courses.length, false],
                    ['页面', courses.reduce((a, c) => a + c.sceneCount, 0), false],
                    [
                      '最近学习',
                      new Date(Math.max(...courses.map((c) => c.updatedAt))).toLocaleDateString(),
                      true,
                    ],
                  ].map(([label, value, wide]) => (
                    <div
                      key={label as string}
                      className={cn(
                        'rounded-lg bg-muted px-3 py-4 text-center',
                        wide && 'col-span-2 sm:col-span-1',
                      )}
                    >
                      <p className="text-xl font-semibold tabular-nums">{String(value)}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{label as string}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
