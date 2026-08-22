/**
 * 落盘失败必须让人看见（同族第十二例）。
 *
 * `saveToStorage()` 失败时**返回 false 并只 log.error**，不抛。
 * 而生成预览页原本 `await store.saveToStorage()` 之后不看返回值、直接跳课堂——
 * 课在内存里能正常看、能翻页、能答题，关掉标签页就没了，界面上一切正常。
 *
 * 排查这条花了半宿：服务端盘上查无（预期，客户端课本来就不进公共课程墙）、
 * 文档库里也没有（真问题），而日志里连一行异常都没有。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('落盘失败不许静默', () => {
  it('生成预览页检查 saveToStorage 的返回值', () => {
    const src = read('app/generation-preview/page.tsx');
    // 关键：saveToStorage 返回 boolean 而不是抛异常，不看返回值 = 失败无感
    expect(src).toMatch(/const saved = await store\.saveToStorage\(\)/);
    expect(src).toMatch(/if \(!saved\)/);
    expect(src).toContain('关掉页面后可能找不回来');
  });

  it('服务端骨架落盘失败会进进度消息', () => {
    const src = read('lib/server/classroom-generation.ts');
    expect(src).toContain('skeletonPersistError');
    expect(src).toMatch(/没能存到服务器上/);
  });

  it('saveToStorage 的契约是返回 boolean，不是抛异常', () => {
    // 这条钉住上面两条断言的前提。哪天它改成抛异常，
    // 调用方的 if (!saved) 就成了永远不进的死分支，这条测试会提醒。
    const src = read('lib/store/stage.ts');
    expect(src).toMatch(/saveToStorage: \(\) => Promise<boolean>/);
    expect(src).toMatch(/log\.error\('Failed to save to storage:', error\);\s*\n\s*return false;/);
  });
});
