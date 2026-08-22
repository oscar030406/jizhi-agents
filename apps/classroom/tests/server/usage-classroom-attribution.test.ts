import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { usageAttribution } from '@/lib/ai/usage-context';
import { recordUsage } from '@/lib/server/usage-storage';

/**
 * token 账要能落到「哪一门课」上。
 *
 * 管理端设计稿 §1.2 从 2026-08-10 就记着这条限制：usage 记录里没有 classroomId，
 * 做不了按课成本归因。08-14 复审（H7）时字段仍然没有。
 *
 * 补的方式是异步上下文而不是给 `callLLM(params, source)` 加参数——
 * 全库 23 个调用点、16 个文件，其中大部分（web-search / verify-model / quiz-grade）
 * 根本不属于任何课程。这里钉住三件事：包了就带、没包就不带、**不带时字段整个不落盘**。
 */

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'usage-attr-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LLM = {
  kind: 'llm' as const,
  source: 'generate-classroom-scene',
  providerId: 'p',
  modelId: 'm',
  modelString: 'p:m',
  usage: {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  },
};

/**
 * `usageDir(baseDir)` 直接返回 baseDir（不再拼 `usage/`），月份文件名用 **UTC**。
 * 第一版这两处都写错了——按本地月份去 `baseDir/usage/` 找，跨月或跨时区必红。
 */
function rowsIn(baseDir: string): Record<string, unknown>[] {
  const now = new Date();
  const file = join(
    baseDir,
    `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}.jsonl`,
  );
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('usage 的课程归因', () => {
  it('在上下文里落账就带上 classroomId', async () => {
    const baseDir = tmpDir();
    await usageAttribution.run({ classroomId: 'course-abc' }, () =>
      recordUsage({ ...LLM, classroomId: 'course-abc' }, { baseDir }),
    );
    expect(rowsIn(baseDir)[0].classroomId).toBe('course-abc');
  });

  it('不在上下文里时字段**整个不落盘**，不是落一个空值', async () => {
    // 空字段会让读的人以为「归因失败了」，而 web-search / quiz-grade 这类调用
    // 本来就不属于任何课程——它们没有课可归，不是归错了。
    const baseDir = tmpDir();
    await recordUsage(LLM, { baseDir });
    const row = rowsIn(baseDir)[0];
    expect('classroomId' in row).toBe(false);
  });

  it('空串按「没有」处理，不落一个空字段', async () => {
    const baseDir = tmpDir();
    await recordUsage({ ...LLM, classroomId: '' }, { baseDir });
    expect('classroomId' in rowsIn(baseDir)[0]).toBe(false);
  });

  it('上下文互不串台：一门课的账不会落到另一门上', async () => {
    const baseDir = tmpDir();
    await Promise.all([
      usageAttribution.run({ classroomId: 'a' }, () =>
        recordUsage({ ...LLM, classroomId: 'a' }, { baseDir }),
      ),
      usageAttribution.run({ classroomId: 'b' }, () =>
        recordUsage({ ...LLM, classroomId: 'b' }, { baseDir }),
      ),
    ]);
    expect(rowsIn(baseDir).map((r) => r.classroomId).sort()).toEqual(['a', 'b']);
  });
});
