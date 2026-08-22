/**
 * 锁住「边跑边落盘、且屏序不乱」这个组合。
 *
 * 背景：批量造课原来用 `mapWithConcurrency`（barrier），整门课跑完才进落盘循环，
 * 于是生成中课堂根本不存在——评委得对着进度条干等（实测 7 屏 2416 秒）。
 * 改成 `lazyBoundedMap` + 顺序 await 之后，第 1 屏一好就落盘，后面的继续在后台跑。
 *
 * 这个组合有两个都容易写错的性质，各锁一条：
 *   ① **增量**：第 1 项落盘时，后面的还没跑完（不是等齐了再一起落）；
 *   ② **保序**：谁先跑完不影响落盘顺序，落的永远是输入顺序。
 * 只测其中一条会漏——barrier 版满足②不满足①，无序并发落盘满足①不满足②。
 */
import { describe, expect, it } from 'vitest';
import { lazyBoundedMap } from '@/lib/utils/concurrency';

/** 把微任务队列彻底排空。两个 `await Promise.resolve()` 不够——
 *  信号量把 fn 包了一层 Promise，加上落盘循环自己的 await，链路有好几跳。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 手动控制何时 resolve，用来精确摆布「谁先跑完」。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('有序追加落盘', () => {
  it('第一项一完成就能落盘，不等后面的', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const persisted: string[] = [];

    const pending = lazyBoundedMap([0, 1, 2], 3, async (i) => gates[i].promise);

    // 后台跑着落盘循环：按序 await，每拿到一项立刻落
    const draining = (async () => {
      for (const p of pending) persisted.push((await p) as string);
    })();

    gates[0].resolve('第1屏');
    await flush();

    // 关键断言：此刻 2、3 屏都还没完成，但第 1 屏已经落盘了
    expect(persisted).toEqual(['第1屏']);

    gates[1].resolve('第2屏');
    gates[2].resolve('第3屏');
    await draining;
    expect(persisted).toEqual(['第1屏', '第2屏', '第3屏']);
  });

  it('完成顺序打乱也不影响落盘顺序', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const persisted: string[] = [];
    const pending = lazyBoundedMap([0, 1, 2], 3, async (i) => gates[i].promise);
    const draining = (async () => {
      for (const p of pending) persisted.push((await p) as string);
    })();

    // 倒着完成：第 3 屏最快，第 1 屏最慢
    gates[2].resolve('第3屏');
    gates[1].resolve('第2屏');
    await flush();
    expect(persisted).toEqual([]); // 第 1 屏没好，后面的不许插队

    gates[0].resolve('第1屏');
    await draining;
    expect(persisted).toEqual(['第1屏', '第2屏', '第3屏']);
  });

  it('中间一屏失败被跳过，剩下的照落且不错位', async () => {
    // 生产里失败屏由 catch 吞成 undefined（只兜可重试那类），落盘循环 continue 跳过
    const pending = lazyBoundedMap([0, 1, 2], 3, async (i) =>
      i === 1 ? undefined : `第${i + 1}屏`,
    );
    const persisted: string[] = [];
    for (const p of pending) {
      const v = await p;
      if (!v) continue;
      persisted.push(v);
    }
    expect(persisted).toEqual(['第1屏', '第3屏']);
  });
});
