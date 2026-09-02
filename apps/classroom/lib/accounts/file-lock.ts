import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 文件账户与机构数据共用一把进程内锁。两个 JSON 文件仍各自原子替换，但所有
 * 跨文件的“检查后写入”都在同一临界区内完成，不再允许删户与入组/指派穿插。
 */
const lockContext = new AsyncLocalStorage<boolean>();
let tail: Promise<void> = Promise.resolve();

export async function withAccountFilesLock<T>(operation: () => Promise<T>): Promise<T> {
  if (lockContext.getStore()) return operation();

  const previous = tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => gate);
  tail = next;
  await previous.catch(() => undefined);

  try {
    return await lockContext.run(true, operation);
  } finally {
    release();
    if (tail === next) tail = Promise.resolve();
  }
}
