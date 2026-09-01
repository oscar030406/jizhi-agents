'use client';

/**
 * 账户会话（客户端）。
 *
 * 服务端 `/api/auth` 是唯一真源：身份从 httpOnly cookie 解出，前端只缓存展示态。
 * 登录/登出后一律 reload——持久化分区（learnerKey）由服务端会话决定，
 * 内存里的课程/运行时状态属于旧分区，换人必须重挂载（与 learner-accounts.ts
 * 的既有口径一致：Identity changes mid-session belong in the application layer）。
 */

import { create } from 'zustand';

import { createLogger } from '@/lib/logger';
import {
  alreadyMerged,
  markMerged,
  mergeLearnerProfile,
  mergePendingKey,
  type ProfileFields,
} from '@/lib/learner/merge-learner';

const log = createLogger('Account');

/** 与服务端 lib/accounts/store.ts 的 AccountRole 同源；两处改要一起改。 */
export type AccountRole = 'learner' | 'manager';

export interface AccountInfo {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  createdAt: string;
}

/** 角色决定登录后落到哪一端。这是两个 C 端之间唯一的桥。 */
export const ROLE_HOME: Record<AccountRole, string> = {
  learner: '/console',
  manager: '/admin',
};

/** 登录后把服务端档案写回本地，让既有的单键直读代码（learnerProfile）无感知。 */
const PROFILE_KEY = 'learnerProfile';

/**
 * 换身份（注册 / 登录 / 登出）时把本地画像对齐到服务端：**有档案就覆盖，没有就删**。
 *
 * 「没有就删」是这次修的那半边。原来写的是 `if (data.profile) setItem(...)`，
 * 空档案走不进这个分支——而 `activeFields()` 对空档案刻意返回 null
 * （lib/accounts/profiles.ts），所以全新注册的账号恒走 falsy 分支，本地那份
 * 原封不动地活过了注册。本地那份里有 `conceptMastery`：它由
 * `refreshDerivedProfile()` 写在**全局单键**上，不随 learnerKey 分区
 * （lib/evidence/profile-bridge.ts），于是匿名期做的测验分数跟着浏览器走进了
 * 新账号的学情卡——工单里的「llm_basics 0.40」就是这么来的。
 *
 * 删掉掌握度不心疼：它是导出量，下一次交卷/判分 `refreshDerivedProfile()` 会按
 * 当前身份的证据账本重算（账本本来就按 learnerKey 分区，算出来的是这个人自己的）。
 *
 * 只在换身份这一下调用。别挂到 `refresh()` 上——那个每页加载都跑一次，
 * 已登录用户没在服务端存过档案时会被反复清空，把刚算出来的掌握度也一起清掉。
 */
export function adoptServerProfile(profile: unknown): void {
  try {
    if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    else localStorage.removeItem(PROFILE_KEY);
  } catch {
    /* 隐私模式等写不进去，不阻断 */
  }
}

/**
 * 登录那一刻：把匿名期存在浏览器里的进度并进这个账号。**每个账号只做一次。**
 *
 * ## 为什么挂在这里
 *
 * 这是「首次带上会话 cookie」的那一下：`/api/auth` 刚发完 `Set-Cookie`，响应里带着
 * `account` 和账号侧画像，而本地那份匿名画像还没被任何东西覆盖——再往后一步就是
 * `window.location.reload()`，重挂载后 `refresh()` 会用服务端画像盖掉本地，
 * 匿名进度就没了。所以合并只有这一个时机。
 *
 * ## 为什么只在 login、不在 register
 *
 * 注册那条路刻意不并。2026-08-21 的工单就是「全新注册的账号首页显示 llm_basics 0.40」——
 * 上一个用这台浏览器的人留下的掌握度活过了注册。修法是注册时按服务端为准清空本地
 * （`adoptServerProfile`），tests/accounts/new-account-mastery.test.tsx 钉着这个行为。
 * 登录不一样：这个账号是谁、之前学过什么，服务端说了算，本地那份只是补充。
 *
 * ## 只做一次怎么保证
 *
 * 成功后按账号 id 写 `maic.learnerMerged@<id>` 标记（`mergeDoneKey`），下次登录直接跳过。
 * 刷新页面本来就走不到这里——这个函数只在 `submit()` 里被调用，刷新走的是 `refresh()`。
 * 标记是给「反复登录同一个账号」兜底的。
 *
 * ## 失败了会怎样
 *
 * 不静默。三件事一起做：本地那份**不覆盖**（它是这些进度当时唯一的落点）、
 * 原始本地画像寄存到 `mergePendingKey` 等下次登录重试、弹窗告诉用户没并进去。
 * 表面成功实际丢数据是这个项目最不能接受的一种失败。
 */
async function mergeAnonymousProgress(accountId: string, serverProfile: unknown): Promise<void> {
  if (alreadyMerged(localStorage, accountId)) {
    adoptServerProfile(serverProfile);
    return;
  }

  const pendingKey = mergePendingKey(accountId);
  let local: ProfileFields | null = null;
  try {
    // 上次没并成的那份优先：本地实时那份可能已经被 refresh() 用服务端画像盖过了。
    local = JSON.parse(localStorage.getItem(pendingKey) ?? localStorage.getItem(PROFILE_KEY) ?? 'null');
  } catch {
    local = null; // 本地那份是坏 JSON：当作没有，退回「以服务端为准」
  }

  const { fields, adoptedConcepts, adoptedFields } = mergeLearnerProfile(
    local,
    (serverProfile ?? null) as ProfileFields | null,
  );
  if (adoptedConcepts.length === 0 && adoptedFields.length === 0) {
    // 本地没带来任何东西，没必要为一份和服务端等价的画像发一次写请求。
    adoptServerProfile(serverProfile);
    try {
      localStorage.removeItem(pendingKey);
    } catch {
      /* 存储不可用，标记与寄存都尽力而为 */
    }
    markMerged(localStorage, accountId);
    return;
  }

  // 先上行再落本地：账号是画像的单一真源（lib/accounts/profiles.ts），
  // 服务端没收下就不算「并进账号」了，本地写成功只会让人以为并成了。
  const res = await postAuth({ action: 'save-profile', profile: fields }).catch(() => null);
  if (!res?.ok) {
    const why = res ? `服务端返回 HTTP ${res.status}` : '网络不通';
    log.error(`匿名进度并入账号失败（${why}），本地那份已保留，下次登录重试`);
    try {
      if (local) localStorage.setItem(pendingKey, JSON.stringify(local));
    } catch {
      /* 存储不可用：寄存不了也不能再往下走成功流程 */
    }
    // 阻塞式提示：紧接着就是整页 reload，toast 活不到用户看见。
    window.alert(
      `本地进度没能并进你的账号（${why}）。\n` +
        `当前浏览器中的 ${adoptedConcepts.length} 项学习记录仍已保留，下次登录会自动重试。`,
    );
    return;
  }

  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(fields));
    localStorage.removeItem(pendingKey);
  } catch {
    /* 隐私模式等写不进去，不阻断——服务端已经收下了 */
  }
  markMerged(localStorage, accountId);
  log.info(`匿名进度已并入账号：概念 ${adoptedConcepts.length} 项，字段 ${adoptedFields.length} 项`);
}

interface AccountState {
  /** 本部署是否启用账户系统（未配数据库时整套 UI 隐藏） */
  enabled: boolean;
  account: AccountInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
  submit: (
    action: 'login' | 'register',
    username: string,
    password: string,
    role: AccountRole,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  logout: () => Promise<void>;
  saveProfile: (profile: unknown) => Promise<void>;
}

async function postAuth(body: Record<string, unknown>): Promise<Response> {
  return fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const useAccountStore = create<AccountState>((set, get) => ({
  enabled: false,
  account: null,
  loading: true,

  refresh: async () => {
    try {
      const res = await fetch('/api/auth', { cache: 'no-store' });
      const data = (await res.json()) as {
        enabled?: boolean;
        account?: AccountInfo | null;
        profile?: unknown;
      };
      set({ enabled: !!data.enabled, account: data.account ?? null, loading: false });
      // 服务端有档案就覆盖本地（账户是真源）；没有则保留本地，等用户保存时上行。
      // 这里**不**走 adoptServerProfile：身份没换，每页加载清一次会把本机刚算出来的
      // 掌握度也清掉。清空只发生在换身份那一下（submit / logout）。
      if (data.account && data.profile) {
        try {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(data.profile));
        } catch {
          /* 隐私模式等写不进去，不阻断 */
        }
      }
    } catch {
      set({ loading: false });
    }
  },

  submit: async (action, username, password, role) => {
    const res = await postAuth({ action, username, password, role });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      profile?: unknown;
      account?: AccountInfo;
    };
    if (!res.ok) return { ok: false, message: data.error ?? '请求失败' };
    // 学习者登录：先把匿名期的本地进度并进账号，再走换身份那套。
    // 注册与管理者不并，理由见 mergeAnonymousProgress 的注释。
    if (action === 'login' && data.account?.role === 'learner') {
      await mergeAnonymousProgress(data.account.id, data.profile);
    } else {
      adoptServerProfile(data.profile);
    }
    // 换了分区，整页重挂载；管理者直接落到管理端，别让他先看一眼学习端再自己找路
    const home = ROLE_HOME[data.account?.role ?? 'learner'];
    if (data.account?.role === 'manager') window.location.assign(home);
    else window.location.reload();
    return { ok: true };
  },

  logout: async () => {
    await postAuth({ action: 'logout' }).catch(() => undefined);
    // 登出也是换身份：账户的画像别留给下一个用这台机器的人
    adoptServerProfile(null);
    window.location.reload();
  },

  saveProfile: async (profile) => {
    if (!get().account) return;
    await postAuth({ action: 'save-profile', profile }).catch(() => undefined);
  },
}));
