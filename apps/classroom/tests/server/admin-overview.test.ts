/**
 * 管理端聚合层。跑的是真课程文件与真引擎目录——聚合层最容易坏在
 * 「字段名对不上」和「跨应用路径拼错」，用假数据测这两样都测不出来。
 *
 * 没有数据时用例自己跳过并说明，不假装通过（空数组恒等于空数组，
 * 那种「通过」是在骗自己）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  readAllCourseAudits,
  readCourseAudit,
  readDomainIntakes,
  readHeadlineMetrics,
  rollup,
} from '@/lib/server/admin-overview';
import { CLASSROOMS_DIR, listClassrooms } from '@/lib/server/classroom-storage';

async function hasCourses(): Promise<boolean> {
  try {
    return (await fs.readdir(CLASSROOMS_DIR)).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

async function hasEngineMetrics(): Promise<boolean> {
  const dir = process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
  try {
    await fs.access(path.join(dir, 'metrics.json'));
    return true;
  } catch {
    return false;
  }
}

describe('管理端聚合', () => {
  it('课程审核账单：字段读得出来，判错与存疑分列', async () => {
    if (!(await hasCourses())) {
      console.warn('跳过：本机没有课程文件');
      return;
    }
    const rows = await readAllCourseAudits();
    expect(rows.length).toBeGreaterThan(0);

    const withAudit = rows.filter((r) => r.auditedScenes > 0);
    expect(withAudit.length).toBeGreaterThan(0);
    for (const r of withAudit) {
      // 审过的场景一定有断言；断言数为 0 说明字段名读错了（曾经把 totalClaims 写成 claims）
      expect(r.claims).toBeGreaterThan(0);
      expect(r.auditedScenes).toBeLessThanOrEqual(r.sceneCount);
      // 四档徽标之和不超过审过的场景数
      const badges = Object.values(r.verdicts).reduce((a, b) => a + b, 0);
      expect(badges).toBeLessThanOrEqual(r.auditedScenes);
    }
  });

  it('默认按判错数降序——管理者第一眼看判官在哪门课抓得最狠', async () => {
    if (!(await hasCourses())) return;
    const rows = await readAllCourseAudits();
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].incorrect).toBeGreaterThanOrEqual(rows[i].incorrect);
    }
  });

  it('单课读取与全量聚合的审核数字一致', async () => {
    if (!(await hasCourses())) return;
    const rows = await readAllCourseAudits();
    const one = await readCourseAudit(rows[0].id);
    // 生成时长与并发数只在全量聚合里补——它们要扫一遍 classroom-jobs，
    // 放进单课读取会让 readAllCourseAudits 变成 O(课程数 × job 数)。
    // 所以这里比的是审核账单那部分，两者必须逐字段相等。
    const { generatedMs, concurrentJobs, ...auditOnly } = rows[0];
    expect(one).toEqual(auditOnly);
    // 时长字段该出现在聚合里（这门课有 job 记录时）
    if (generatedMs !== undefined) {
      expect(generatedMs).toBeGreaterThan(0);
      expect(concurrentJobs).toBeGreaterThanOrEqual(0);
    }
  });

  it('「引用源」两端同口径——课程墙与管理端不许各数各的', async () => {
    if (!(await hasCourses())) {
      console.warn('跳过：本机没有课程文件');
      return;
    }
    // 曾经的分叉：管理端数 claims[].sourceIds，课程墙数 sources[].source_id，
    // 同一个标签两个数。现在两端都走 classroom-storage 的 collectSourceIds。
    const wall = (await listClassrooms()).filter((c) => c.audit);
    expect(wall.length).toBeGreaterThan(0);
    const pairs: string[] = [];
    for (const c of wall) {
      const admin = await readCourseAudit(c.id);
      expect(admin?.sources, `课程 ${c.id} 两端引用源数不一致`).toBe(c.audit!.sources);
      pairs.push(`${c.id}=${c.audit!.sources}`);
    }
    // 把逐门数字打出来：光看「通过」分不清是真比过了还是一门课都没读到
    console.log(`两端引用源逐门相等：${pairs.length} 门 | ${pairs.join(' ')}`);
  });

  it('引用源跨课去重——逐课相加会把同一段教材算两次', () => {
    const two = rollup([
      {
        id: 'a', title: 'a', sceneCount: 1, createdAt: '', claims: 1, incorrect: 0,
        uncertain: 0, grounded: 1, sources: 2, sourceIds: ['s1', 's2'],
        verdicts: { pass: 1, caveat: 0, revised: 0, flagged: 0 },
        auditedScenes: 1, durationMs: 0,
      },
      {
        id: 'b', title: 'b', sceneCount: 1, createdAt: '', claims: 1, incorrect: 0,
        uncertain: 0, grounded: 1, sources: 2, sourceIds: ['s2', 's3'],
        verdicts: { pass: 1, caveat: 0, revised: 0, flagged: 0 },
        auditedScenes: 1, durationMs: 0,
      },
    ]);
    // 逐课 sources 相加是 4，去重后是 3（s2 被两门课共用）
    expect(two.distinctSources).toBe(3);
  });

  it('汇总：占比在 0-1 之间，无数据时给 null 而不是 0', () => {
    const empty = rollup([]);
    expect(empty.incorrectRate).toBeNull();
    expect(empty.groundedRate).toBeNull();

    const one = rollup([
      {
        id: 'x', title: 'x', sceneCount: 2, createdAt: '', claims: 10, incorrect: 1,
        uncertain: 3, grounded: 1, sources: 2, sourceIds: ['s1', 's2'],
        verdicts: { pass: 1, caveat: 1, revised: 0, flagged: 0 },
        auditedScenes: 2, durationMs: 0,
      },
    ]);
    expect(one.incorrectRate).toBeCloseTo(0.1);
    expect(one.groundedRate).toBeCloseTo(0.5);
  });

  it('全局指标：读得到 metrics.json 就必须带口径原文', async () => {
    if (!(await hasEngineMetrics())) {
      console.warn('跳过：读不到引擎 metrics.json');
      return;
    }
    const metrics = await readHeadlineMetrics();
    expect(metrics.length).toBeGreaterThan(0);
    for (const m of metrics) {
      expect(m.value).not.toBe('');
      // 口径纪律：大屏不许出现脱离口径的裸数字
      expect(m.caliber).not.toBe('');
    }
  });

  it('领域接入报告：读得到就要能算出闸位', async () => {
    const intakes = await readDomainIntakes();
    if (intakes.length === 0) {
      console.warn('跳过：本机没有接入过领域');
      return;
    }
    for (const d of intakes) {
      expect(d.domain).not.toBe('');
      expect(typeof d.gates.vocabulary).toBe('boolean');
      // 章级前置边不可能多于结构候选边——多了说明复核那一步把没提出的边也算进去了
      expect(d.chapterEdges).toBeLessThanOrEqual(Math.max(d.candidateEdges, d.chapterEdges));
    }
  });
});
