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
    adoptServerProfile(data.profile);
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
