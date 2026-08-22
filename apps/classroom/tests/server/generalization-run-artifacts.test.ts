/**
 * 泛化页「体检产物点开看」的读取层。跑的是真的引擎数据目录：
 * 这一层要守的是**路径闸**与**脱敏**，用假目录测等于测我自己写的假规则。
 *
 * 盘上没有 run 目录时用例自己跳过并说明，不假装通过。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRunArtifacts } from '@/app/admin/generalization/data';

const RUNS = path.join(
  process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data'),
  'knowledge_base',
  'intake_runs',
);

/** 盘上任意一轮带 trial_courses 产物的 run 目录名。没有就返回 null。 */
async function someRunId(): Promise<string | null> {
  let names: string[];
  try {
    names = (await fs.readdir(RUNS)).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const files = await fs.readdir(path.join(RUNS, name, 'trial_courses'));
      if (files.includes('REPORT.md')) return name;
    } catch {
      /* 不是 run 目录，或这一轮没跑到试跑站 */
    }
  }
  return null;
}

describe('体检产物的路径闸', () => {
  it('穿不出 intake_runs 目录', async () => {
    for (const runId of [
      '../../../package.json',
      '..\\..\\package.json',
      '20260817T214656-186918/../../..',
      '/etc/passwd',
      'D:/UserData/Desktop/挑战杯/apps/classroom',
      '.',
      '..',
      '',
    ]) {
      expect(await readRunArtifacts(runId), `${runId} 不该读出东西`).toEqual([]);
    }
  });

  it('只给 REPORT.md 与 kc_misses，两档课程正文不上屏', async () => {
    const runId = await someRunId();
    if (!runId) {
      console.warn('跳过：盘上没有带 trial_courses 产物的 run 目录');
      return;
    }
    const arts = await readRunArtifacts(runId);
    expect(arts.map((a) => a.name)).toContain('REPORT.md');
    // 60 KB 的课程正文与事件流不该被塞进弹层。
    expect(arts.some((a) => /^(beginner|advanced)\.json$/.test(a.name))).toBe(false);
    expect(arts.every((a) => a.text.length > 0)).toBe(true);
  });

  it('产物里那台机器的绝对路径不上屏', async () => {
    const runId = await someRunId();
    if (!runId) {
      console.warn('跳过：盘上没有带 trial_courses 产物的 run 目录');
      return;
    }
    for (const a of await readRunArtifacts(runId)) {
      // kc_misses.json 的 course 字段原文是 `D:\\UserData\\Desktop\\…`，截到 run 目录那一截为止。
      expect(a.text, `${a.name} 漏了本机绝对路径`).not.toMatch(/[A-Za-z]:(\\\\|[\\/])/);
    }
  });
});
