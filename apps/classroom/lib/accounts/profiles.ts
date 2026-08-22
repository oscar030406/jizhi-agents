/**
 * 多学习者档案：信封结构、迁移与纯函数操作（无 I/O，可单测）。
 *
 * ## 为什么塞进现有的 profile JSON 而不是加表
 *
 * 账户存储有两条后端：本机走文件（`file-store.ts`），线上走 PostgreSQL
 * （`accounts.profile` 是 JSON 列）。两边都只是「存一坨 JSON」，所以把多档案
 * 的信封整个塞进那坨 JSON 里，**两端零 schema 迁移**，也不用担心两条后端
 * 结构分叉——它们存的是同一个形状。
 *
 * ## 为什么要有这个模块（2026-08-18 用户点名的四条不满的根因）
 *
 * 「切换档案」原来由 `lib/runtime/learner-accounts.ts` 实现，那是**登录体系上线之前**
 * 的方案：给匿名 learnerKey 起名字，切换 = 换 localStorage 快照 + reload。
 * 该文件自己的注释写着「真登录未来落地时，RuntimeStore.mergeLearner 是迁移路径」——
 * 真登录落地了，这条路径没走。后果是四条连锁：
 *
 * 1. **换不了**：切档案只改本地快照，服务端 `profile` 不动；登录时 `lib/store/account.ts`
 *    又把服务端画像写回同一个 localStorage 键，**下次刷新覆盖回去**。
 * 2. **编不了**：没有编辑界面，也没有 `/api/profile` 写口。
 * 3. **换库无效**：`corpus` 是画像字段，生成链从画像读；本地改了服务端没改，刷新即回退。
 * 4. **职责不清**：首页读本地快照、`/report` 读服务端，两个数据源天然不一致。
 *
 * 所以本模块让**服务端成为画像单一真源**，前端退化成它的视图。
 *
 * ## 兼容
 *
 * 旧账户存的是扁平画像（`{domain, education, ...}`，无 `__v`）。`toEnvelope()` 把它
 * 包成一个名叫「默认档案」的条目，**字段一个不动**。`activeFields()` 反过来把信封
 * 拆回扁平画像——所有既有读取方（`readProfile` 的调用方、生成链、report 页）
 * 拿到的东西与改动前逐字相同，不需要跟着改。
 */

/** 画像字段本体。故意用宽类型：字段集由前端表单与引擎共同决定，这里不做白名单。 */
export type ProfileFields = Record<string, unknown>;

export interface ProfileEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  fields: ProfileFields;
}

export interface ProfileEnvelope {
  __v: 2;
  activeId: string;
  profiles: ProfileEntry[];
}

export const DEFAULT_PROFILE_NAME = '默认档案';
/** 一个账户最多几份档案。防手滑刷爆存储，不是产品限制。 */
export const MAX_PROFILES = 8;

function nowIso(): string {
  return new Date().toISOString();
}

/** 稳定 id：不依赖 crypto，便于在任何运行时与测试里复现。 */
function newId(existing: readonly ProfileEntry[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((p) => p.id));
  while (taken.has(`p${n}`)) n += 1;
  return `p${n}`;
}

export function isEnvelope(value: unknown): value is ProfileEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __v?: unknown }).__v === 2 &&
    Array.isArray((value as { profiles?: unknown }).profiles)
  );
}

/**
 * 任何历史形态 → 信封。三种输入：已是信封（原样）、扁平旧画像（包成一条）、
 * 空（给一份空的默认档案，让「还没填画像」也是一个可编辑的对象而不是 null）。
 */
export function toEnvelope(stored: unknown): ProfileEnvelope {
  if (isEnvelope(stored)) return stored;
  const ts = nowIso();
  const fields =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as ProfileFields) : {};
  return {
    __v: 2,
    activeId: 'p1',
    profiles: [{ id: 'p1', name: DEFAULT_PROFILE_NAME, createdAt: ts, updatedAt: ts, fields }],
  };
}

/** 当前档案的扁平字段——既有读取方看到的东西，与多档案改造前逐字相同。 */
export function activeFields(env: ProfileEnvelope): ProfileFields | null {
  const hit = env.profiles.find((p) => p.id === env.activeId) ?? env.profiles[0];
  if (!hit) return null;
  // 空档案返回 null 而不是 {}：既有代码用 `profile ? ... : ...` 判「填没填」，
  // 给个空对象会让「没填画像」被当成「填了一份空画像」。
  return Object.keys(hit.fields).length > 0 ? hit.fields : null;
}

export function activeEntry(env: ProfileEnvelope): ProfileEntry | null {
  return env.profiles.find((p) => p.id === env.activeId) ?? env.profiles[0] ?? null;
}

export function createProfile(
  env: ProfileEnvelope,
  name: string,
  fields: ProfileFields = {},
): { ok: true; env: ProfileEnvelope; id: string } | { ok: false; message: string } {
  const clean = name.trim();
  if (!clean) return { ok: false, message: '档案名不能为空' };
  if (clean.length > 24) return { ok: false, message: '档案名最多 24 个字' };
  if (env.profiles.length >= MAX_PROFILES) {
    return { ok: false, message: `最多 ${MAX_PROFILES} 份档案，删掉不用的再建` };
  }
  if (env.profiles.some((p) => p.name === clean)) {
    return { ok: false, message: '已有同名档案' };
  }
  const ts = nowIso();
  const id = newId(env.profiles);
  return {
    ok: true,
    id,
    // 新建即切换：建了不切等于没建，用户还得再点一次。
    env: {
      ...env,
      activeId: id,
      profiles: [...env.profiles, { id, name: clean, createdAt: ts, updatedAt: ts, fields }],
    },
  };
}

export function updateProfile(
  env: ProfileEnvelope,
  id: string,
  patch: { name?: string; fields?: ProfileFields },
): { ok: true; env: ProfileEnvelope } | { ok: false; message: string } {
  const idx = env.profiles.findIndex((p) => p.id === id);
  if (idx < 0) return { ok: false, message: '档案不存在' };
  const name = patch.name?.trim();
  if (name !== undefined) {
    if (!name) return { ok: false, message: '档案名不能为空' };
    if (name.length > 24) return { ok: false, message: '档案名最多 24 个字' };
    if (env.profiles.some((p) => p.name === name && p.id !== id)) {
      return { ok: false, message: '已有同名档案' };
    }
  }
  const next = [...env.profiles];
  next[idx] = {
    ...next[idx],
    ...(name !== undefined ? { name } : {}),
    // 字段整体替换而不是浅合并：表单提交的就是完整画像，
    // 合并会让「清空某一项」永远生效不了。
    ...(patch.fields !== undefined ? { fields: patch.fields } : {}),
    updatedAt: nowIso(),
  };
  return { ok: true, env: { ...env, profiles: next } };
}

export function deleteProfile(
  env: ProfileEnvelope,
  id: string,
): { ok: true; env: ProfileEnvelope } | { ok: false; message: string } {
  if (env.profiles.length <= 1) return { ok: false, message: '至少保留一份档案' };
  const rest = env.profiles.filter((p) => p.id !== id);
  if (rest.length === env.profiles.length) return { ok: false, message: '档案不存在' };
  return {
    ok: true,
    // 删掉的正好是当前档案时落到第一份，不留悬空 activeId。
    env: { ...env, activeId: env.activeId === id ? rest[0].id : env.activeId, profiles: rest },
  };
}

export function activateProfile(
  env: ProfileEnvelope,
  id: string,
): { ok: true; env: ProfileEnvelope } | { ok: false; message: string } {
  if (!env.profiles.some((p) => p.id === id)) return { ok: false, message: '档案不存在' };
  return { ok: true, env: { ...env, activeId: id } };
}
