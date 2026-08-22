/**
 * 学习者档案切换（账户 A 档）。
 *
 * 上游没有真账户（server-auth 自注 DEVELOPMENT-ONLY），但 learner-key 分区
 * 机制完整：runtime 数据全部按 `runtime.learnerKey` 分区。本模块把「切档案」
 * 实现为：给匿名 key 起名字 + 切换时换 KV 里的 learnerKey + 按档案快照
 * 换入/换出画像 localStorage 键，然后 reload——learner-key.ts 官方注释写明
 * 「Identity changes mid-session belong in the application layer (reload)」，
 * 我们走的就是这条路。真登录未来落地时，RuntimeStore.mergeLearner 是迁移路径。
 *
 * Client-only（触 localStorage）。
 */

import { BrowserKVStore } from '@openmaic/storage';

import { LEARNER_KEY_KV_KEY } from './learner-key';

export interface LearnerAccount {
  key: string;
  name: string;
  createdAt: number;
}

const ACCOUNTS_KEY = 'maic.learnerAccounts';
/** 切档案时要按档案快照隔离的 localStorage 键（画像域，都是单键直读的存量代码） */
const SNAPSHOT_KEYS = ['learnerProfile', 'user-profile-storage'];

function readAccounts(): LearnerAccount[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((a) => a && typeof a.key === 'string') : [];
  } catch {
    return [];
  }
}

function writeAccounts(list: LearnerAccount[]): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

async function currentKey(): Promise<string> {
  const kv = new BrowserKVStore();
  return (await kv.get<string>(LEARNER_KEY_KV_KEY, 'device')) ?? '';
}

/** 档案清单；当前设备 key 若不在清单里（首个匿名用户）自动补一条「默认档案」。 */
export async function listAccounts(): Promise<{ accounts: LearnerAccount[]; current: string }> {
  const current = await currentKey();
  let accounts = readAccounts();
  if (current && !accounts.some((a) => a.key === current)) {
    accounts = [{ key: current, name: '默认档案', createdAt: Date.now() }, ...accounts];
    writeAccounts(accounts);
  }
  return { accounts, current };
}

function snapshotSuffix(key: string): string {
  return `@${key}`;
}

/** 把当前画像域快照存到旧档案名下，换入目标档案的快照。 */
function swapSnapshots(oldKey: string, newKey: string): void {
  for (const k of SNAPSHOT_KEYS) {
    const live = localStorage.getItem(k);
    if (oldKey) {
      if (live == null) localStorage.removeItem(k + snapshotSuffix(oldKey));
      else localStorage.setItem(k + snapshotSuffix(oldKey), live);
    }
    const incoming = localStorage.getItem(k + snapshotSuffix(newKey));
    if (incoming == null) localStorage.removeItem(k);
    else localStorage.setItem(k, incoming);
  }
}

/** 切到指定档案并 reload。key 必须已在清单里。 */
export async function switchAccount(key: string): Promise<void> {
  const { accounts, current } = await listAccounts();
  if (key === current) return;
  if (!accounts.some((a) => a.key === key)) throw new Error(`未知档案：${key}`);
  swapSnapshots(current, key);
  const kv = new BrowserKVStore();
  await kv.set(LEARNER_KEY_KV_KEY, key, 'device');
  window.location.reload();
}

/** 新建档案（全新分区，画像从空开始）并切过去。 */
export async function createAccount(name: string): Promise<void> {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `anon:${uuid}`;
  const accounts = readAccounts();
  writeAccounts([...accounts, { key, name: name.trim() || '新学习者', createdAt: Date.now() }]);
  const { current } = await listAccounts();
  swapSnapshots(current, key);
  const kv = new BrowserKVStore();
  await kv.set(LEARNER_KEY_KV_KEY, key, 'device');
  window.location.reload();
}

/** 重命名档案（不切换）。 */
export function renameAccount(key: string, name: string): void {
  writeAccounts(readAccounts().map((a) => (a.key === key ? { ...a, name: name.trim() || a.name } : a)));
}
