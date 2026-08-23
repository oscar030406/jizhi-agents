/**
 * 匿名进度并进账号：合并规则本体（纯函数，零 IO）。
 *
 * ## 要合的是哪两份东西
 *
 * 未登录时学习者的进度只有一个落点：localStorage 的 `learnerProfile` 单键
 * （键名见 lib/evidence/profile-bridge.ts 的 `PROFILE_KEY`，生成链、导学、控制台、
 * 学情报告都就地读它）。里面既有用户自己填的静态字段（domain / corpus / education /
 * 五维档位…），也有 `refreshDerivedProfile()` 从证据账本折叠出来、写在**全局单键**上
 * 的三张概念表（conceptMastery / conceptConfidence / conceptRecall）。
 *
 * 账号那份是服务端 `accounts.profile` 里当前档案的扁平字段（`readProfile` →
 * `activeFields`），登录响应里原样带回来。两份形状相同，所以按字段合。
 *
 * ## 「较新」按什么判
 *
 * **唯一判据是 `derivedFrom.at`**（ISO 字符串，`refreshDerivedProfile()` 每次重算都写，
 * 见 profile-bridge.ts）。整份画像里再没有第二个时间戳——静态字段是表单直填的，
 * 没有人给它们记过修改时间，所以对静态字段谈「较新」是无中生有。于是分两类处理：
 *
 * - **三张概念表**：逐概念键比。两边都有这个概念 → 只有当两边的 `derivedFrom.at`
 *   都解析得出、且本地严格晚于账号时，才用本地的值；否则一律保留账号的。
 *   只有一边有这个概念 → 直接收下（这不是冲突，是补齐）。
 * - **静态字段**：账号侧有值就不动，本地只填空位。账号是画像的单一真源
 *   （lib/accounts/profiles.ts 的口径），拿一份没有时间戳、可能是上一个用这台
 *   浏览器的人留下的本地值去覆盖服务端，风险远大于收益。
 *
 * 判不出时间戳（字段缺失、不是字符串、Date.parse 得 NaN）、两边时间戳相等，
 * 都按「保留账号侧」处理。这条是安全侧：宁可这次没并进来（下次交卷会重算），
 * 也不能用本地的把服务器上的真实学习记录盖掉。
 *
 * ## 为什么不在这里做 IO
 *
 * 调用方（lib/store/account.ts）要在登录那一下读 localStorage、POST 上行、
 * 写标记、失败弹告知。那些都是有副作用的一次性动作，混进来就没法单测冲突规则了。
 */

/** 画像字段本体。宽类型，与 lib/accounts/profiles.ts 的 `ProfileFields` 同口径。 */
export type ProfileFields = Record<string, unknown>;

/** 由证据账本折叠出来的三张概念表。键=概念名，值=0-1 的数。 */
const CONCEPT_MAPS = ['conceptMastery', 'conceptConfidence', 'conceptRecall'] as const;

/** 画像里唯一带时间戳的字段。`{ evidenceCount, at }`，见 profile-bridge.ts。 */
const STAMP_FIELD = 'derivedFrom';

export interface MergeOutcome {
  /** 合并结果。可直接写回 localStorage 并上行到账号。 */
  fields: ProfileFields;
  /** 本地带进来的概念（`表名.概念名`）。空数组＝概念表没有任何变化。 */
  adoptedConcepts: string[];
  /** 本地填进账号空位的静态字段名。 */
  adoptedFields: string[];
}

/** `derivedFrom.at` 解析成毫秒；判不出返回 null（缺失、非字符串、非法日期都算判不出）。 */
function stampOf(fields: ProfileFields | null | undefined): number | null {
  const at = (fields?.[STAMP_FIELD] as { at?: unknown } | undefined)?.at;
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

/** 只收数值项。画像来自 localStorage / JSON 列，形状不可信，非数不进合并。 */
function asNumberMap(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 静态字段「算不算填了」。0 是合法档位，只有 undefined / null / 空串算空位。 */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * 合并匿名期的本地进度与账号侧进度。判据与取舍见文件头。
 *
 * 两边都空返回空对象；只有一边有数据就返回那一边。调用方用 `adoptedConcepts` /
 * `adoptedFields` 判断「本地到底有没有东西并进来」，都空就没必要上行一次网络请求。
 */
export function mergeLearnerProfile(
  local: ProfileFields | null | undefined,
  account: ProfileFields | null | undefined,
): MergeOutcome {
  const fields: ProfileFields = { ...(account ?? {}) };
  const adoptedConcepts: string[] = [];
  const adoptedFields: string[] = [];
  if (!local) return { fields, adoptedConcepts, adoptedFields };

  const localAt = stampOf(local);
  const accountAt = stampOf(account);
  // 三个条件缺一不可：两边都读得出时间戳，且本地严格更晚。相等不算更新
  // （同一秒内的两份分不出先后，按安全侧留账号的）。
  const localWins = localAt !== null && accountAt !== null && localAt > accountAt;

  for (const key of CONCEPT_MAPS) {
    const mine = asNumberMap(local[key]);
    const theirs = asNumberMap(account?.[key]);
    if (!mine && !theirs) continue;
    const merged: Record<string, number> = { ...(theirs ?? {}) };
    for (const [concept, value] of Object.entries(mine ?? {})) {
      const collides = merged[concept] !== undefined;
      if (collides && (!localWins || merged[concept] === value)) continue;
      merged[concept] = value;
      adoptedConcepts.push(`${key}.${concept}`);
    }
    // 两边都没有真正的概念时不要凭空写一张空表出去
    if (Object.keys(merged).length === 0 && account?.[key] === undefined) continue;
    fields[key] = merged;
  }

  for (const [key, value] of Object.entries(local)) {
    if ((CONCEPT_MAPS as readonly string[]).includes(key) || key === STAMP_FIELD) continue;
    if (isPresent(fields[key]) || !isPresent(value)) continue;
    fields[key] = value;
    adoptedFields.push(key);
  }

  // derivedFrom 是「这份画像由几条证据算出来」的缓存，合并后它的 evidenceCount
  // 已经不精确了——不修它，下一次交卷 refreshDerivedProfile() 从账本整体重算。
  // 这里只保证时间戳单调：取较新那一份，判不出就留账号的，账号没有才用本地的。
  const stamp = localWins ? local[STAMP_FIELD] : (account?.[STAMP_FIELD] ?? local[STAMP_FIELD]);
  if (stamp !== undefined) fields[STAMP_FIELD] = stamp;

  return { fields, adoptedConcepts, adoptedFields };
}

/**
 * 「这个账号已经并过一次」的标记键。
 *
 * 按账号 id 分键，沿用 lib/runtime/learner-accounts.ts 的 `@key` 后缀约定。
 * 为什么要标记：合并是一次性迁移，不是每次进站都跑的同步。没有标记的话，
 * 同一台浏览器反复登录会把同一份本地残留一次次往账号里灌。
 */
export function mergeDoneKey(accountId: string): string {
  return `maic.learnerMerged@${accountId}`;
}

/** 存储读写在这里收口，好让调用方和测试用同一套判定，不各写各的键名。 */
export function alreadyMerged(storage: Pick<Storage, 'getItem'>, accountId: string): boolean {
  try {
    return storage.getItem(mergeDoneKey(accountId)) !== null;
  } catch {
    // 隐私模式等读不到存储：当作没并过。宁可多试一次（幂等的，规则本身不会
    // 重复累加），也不要因为读不出标记就永远不并。
    return false;
  }
}

/**
 * 合并没能落到服务端时，把待并的那份**原始本地画像**寄存在这里，下次登录重试。
 *
 * 为什么必须另起一个键：失败后我们不动 `learnerProfile`（那是这些进度当时唯一的
 * 落点），但 `useAccountStore.refresh()` 每次页面加载都会用服务端画像覆盖它
 * （`lib/store/account.ts` 的 `refresh()`）——不寄存一份，下一次刷新这些进度就真没了。
 * 寄存的是原始本地画像而不是合并结果：重试时账号那侧可能已经变了，
 * 拿原始的重新按规则合一次才准。
 */
export function mergePendingKey(accountId: string): string {
  return `maic.learnerMergePending@${accountId}`;
}

export function markMerged(storage: Pick<Storage, 'setItem'>, accountId: string): void {
  try {
    storage.setItem(mergeDoneKey(accountId), new Date().toISOString());
  } catch {
    /* 标记写不进去不该拦住已经成功的合并 */
  }
}
