/**
 * 管理端三个展示件的服务端渲染检查——喂**真**聚合数据，看会不会崩。
 *
 * 为什么是这个形态：本机没配 PERSISTENCE_DATABASE_URL，`/admin` 页会停在
 * 「未配置数据库」那一屏，浏览器里看不到真正的大屏。路由本身编译通过、返回 200
 * 已经由 dev server 证过；剩下没验的是**展示件遇到真数据形状会不会炸**
 * （字段缺失、除零、空数组）。用 renderToStaticMarkup 把这一半补上。
 *
 * 视觉验收仍然缺，要等有数据库的环境。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AdminCourseTable } from '@/components/admin/course-table';
import { CoveragePanel, DifficultySupply } from '@/components/admin/coverage-panel';
import { tierLabel } from '@/components/admin/difficulty-scale';
import { DomainIntakeTable } from '@/components/admin/domain-intake-table';
import { KnowledgeMap } from '@/components/admin/knowledge-map';
import { MetricBand, splitFigure, splitValue } from '@/components/admin/metric-band';
import {
  readAllCourseAudits,
  readDomainIntakes,
  readHeadlineMetrics,
  rollup,
} from '@/lib/server/admin-overview';
import {
  readCoverageRuns,
  readDifficultySupply,
  readDomainMaps,
} from '@/lib/server/knowledge-map';

/**
 * 课程表的两列（覆盖率、生成时长）——设计稿 §2 区 B 点名要、之前一直缺。
 *
 * 生成时长那一列的要点不是「有没有数」，是**并发标记有没有跟着出来**：
 * 实测 32 个 job 里只有 5 个独占运行，其余与最多 5 个 job 时间重叠。
 * 只印「76 分」会被读成「一门课要 76 分钟」，那是错的。
 */
describe('课程表补的两列', () => {
  it('覆盖率只对 run 里记的那门课出数，其余「—」', async () => {
    const [courses, coverage] = await Promise.all([readAllCourseAudits(), readCoverageRuns()]);
    if (courses.length === 0) return;
    const html = renderToStaticMarkup(
      <AdminCourseTable courses={courses} coverage={coverage} />,
    );
    expect(html).toContain('覆盖率');
    // 没有金标的课必须落到「—」，不补 0 也不补估计值
    const withCov = courses.filter((c) => coverage.some((r) => r.courseId === c.id));
    if (withCov.length < courses.length) expect(html).toContain('—');
  });

  it('不传 coverage 时整列都是「—」，不炸', () => {
    const html = renderToStaticMarkup(
      <AdminCourseTable
        courses={[
          {
            id: 'x', title: 'x', sceneCount: 1, createdAt: '', claims: 1, incorrect: 0,
            uncertain: 0, grounded: 1, sources: 1, sourceIds: ['s'],
            verdicts: { pass: 1, caveat: 0, revised: 0, flagged: 0 },
            auditedScenes: 1, durationMs: 0,
          },
        ]}
      />,
    );
    expect(html).toContain('—');
  });

  it('生成时长带并发标记——只给分钟数会被读成单课成本', () => {
    const html = renderToStaticMarkup(
      <AdminCourseTable
        courses={[
          {
            id: 'x', title: 'x', sceneCount: 1, createdAt: '', claims: 1, incorrect: 0,
            uncertain: 0, grounded: 1, sources: 1, sourceIds: ['s'],
            verdicts: { pass: 1, caveat: 0, revised: 0, flagged: 0 },
            auditedScenes: 1, durationMs: 0,
            generatedMs: 76 * 60_000, concurrentJobs: 4,
          },
        ]}
      />,
    );
    expect(html).toContain('76 分');
    expect(html).toContain('×5并发');
    expect(html).toContain('不能当单课成本读');
  });

  it('独占运行时不挂并发标记', () => {
    const html = renderToStaticMarkup(
      <AdminCourseTable
        courses={[
          {
            id: 'x', title: 'x', sceneCount: 1, createdAt: '', claims: 1, incorrect: 0,
            uncertain: 0, grounded: 1, sources: 1, sourceIds: ['s'],
            verdicts: { pass: 1, caveat: 0, revised: 0, flagged: 0 },
            auditedScenes: 1, durationMs: 0,
            generatedMs: 30 * 60_000, concurrentJobs: 0,
          },
        ]}
      />,
    );
    expect(html).toContain('30 分');
    expect(html).not.toContain('并发');
    expect(html).toContain('独占运行');
  });
});

describe('管理端展示件渲染', () => {
  it('指标带：真 metrics.json + 真汇总', async () => {
    const [metrics, courses] = await Promise.all([readHeadlineMetrics(), readAllCourseAudits()]);
    const html = renderToStaticMarkup(<MetricBand metrics={metrics} totals={rollup(courses)} />);
    expect(html).toContain('课程墙实时汇总');
    if (metrics.length > 0) {
      // 口径原文必须真的渲染出来，不是只渲染了数字
      expect(html).toContain('展开口径');
      expect(html.length).toBeGreaterThan(1000);
    }
  });

  it('指标带：读不到 metrics 时空着，不拿旧值顶', () => {
    const html = renderToStaticMarkup(
      <MetricBand
        metrics={[]}
        totals={{
          courses: 0, scenes: 0, audited: 0, claims: 0, incorrect: 0, uncertain: 0,
          incorrectRate: null, groundedRate: null, distinctSources: 0,
        }}
      />,
    );
    expect(html).toContain('不拿旧值顶');
    expect(html).toContain('—'); // 占比显示破折号而不是 0.00%
  });

  it('课程表：真课程数据', async () => {
    const courses = await readAllCourseAudits();
    const html = renderToStaticMarkup(<AdminCourseTable courses={courses} />);
    if (courses.length === 0) {
      expect(html).toContain('课程墙是空的');
      return;
    }
    expect(html).toContain(courses[0].title);
    expect(html).toContain('/admin/course/');
    // 判错与存疑必须是两列
    expect(html).toContain('判错');
    expect(html).toContain('存疑');
  });

  it('领域接入表：真就绪度报告', async () => {
    const intakes = await readDomainIntakes();
    const html = renderToStaticMarkup(<DomainIntakeTable intakes={intakes} />);
    if (intakes.length === 0) {
      expect(html).toContain('ingest_domain.py');
      return;
    }
    expect(html).toContain(intakes[0].domain);
    expect(html).toContain('闸一 词表');
    // 软前置的免责必须在页面上，不能只写在代码注释里
    expect(html).toContain('未经人工签字');
  });

  /**
   * 指标卡的拆句是这一屏唯一有分支的逻辑：拆错了，样本量与置信区间就掉进展开块里，
   * 卡面上只剩一个裸百分数——正是 08-13 定的规矩要挡的那种展示。
   */
  it('指标卡拆句：主数字与样本量都留在卡面', async () => {
    const a = splitValue('85.2%（95% CI 77.8–92.6%，n=108，下界未达 85%）——rubric v4 三判官全量多数决');
    expect(a.head).toBe('85.2%（95% CI 77.8–92.6%，n=108，下界未达 85%）');
    expect(a.detail).toContain('rubric v4');
    expect(splitFigure(a.head)).toMatchObject({ figure: '85.2%', post: '（95% CI 77.8–92.6%，n=108，下界未达 85%）' });

    const b = splitValue('汇总 48/50 = 96.0%（6 门金标课）；逐门：RAG 9/9');
    expect(splitFigure(b.head)).toMatchObject({ pre: '汇总 48/50 =', figure: '96.0%' });
    expect(b.detail).toContain('逐门');

    // 裸小数走 formatMetricValue 之后只剩「2.1%」，没有可拆的补充
    expect(splitValue('2.1%')).toEqual({ head: '2.1%', detail: '' });
    expect(splitFigure('2.1%')).toMatchObject({ figure: '2.1%', pre: '', post: '' });

    // 真台账：适配准确率的对外写法必须原样出现在渲染结果里
    const metrics = await readHeadlineMetrics();
    const adaptation = metrics.find((m) => m.id === 'adaptation_accuracy_2a');
    if (adaptation) {
      const html = renderToStaticMarkup(
        <MetricBand
          metrics={[adaptation]}
          totals={{
            courses: 0, scenes: 0, audited: 0, claims: 0, incorrect: 0, uncertain: 0,
            incorrectRate: null, groundedRate: null, distinctSources: 0,
          }}
        />,
      );
      expect(html).toContain('n=108');
      expect(html).toContain('95% CI 77.8–92.6%');
    }
  });

  it('学习路径图：真前置图，难度档全都有颜色', async () => {
    const maps = await readDomainMaps();
    if (maps.length === 0) {
      console.warn('跳过：读不到 prereq_graph.json');
      return;
    }
    for (const m of maps) {
      const html = renderToStaticMarkup(<KnowledgeMap map={m} />);
      expect(html).toContain('第 1 层');
      // 每个有难度档的节点都得落在色阶上——L4 曾经掉进 currentColor 兜底里
      for (const tier of new Set(m.nodes.map((n) => n.difficulty))) {
        if (tier === '—') continue;
        expect(html).toContain(`fill-blue-`);
        // 上屏的是转写过的档位名（`tierLabel`：L3 → 「3 级」），不是内部档位码
        expect(html).toMatch(new RegExp(`>${tierLabel(tier)} · 前置`));
        expect(html).not.toMatch(new RegExp(`>${tier} · 前置`));
      }
      expect(html).toContain(`${m.edges.filter((e) => e.reviewed).length}/${m.edges.length} 条经人工签字`);
    }
  });

  it('覆盖缺口：冻结金标与事后补的草稿金标分组', async () => {
    const rows = await readCoverageRuns();
    const html = renderToStaticMarkup(<CoveragePanel rows={rows} />);
    if (rows.length === 0) {
      expect(html).toContain('compute_kc_coverage.py');
      return;
    }
    for (const r of rows) expect(html).toContain(r.courseName || r.topic);
    // 非 frozen-v1 的行必须被标出来，不能和冻结金标混在一张表里
    if (rows.some((r) => r.status !== 'frozen-v1')) {
      expect(html).toContain('不是生成前冻结的');
    }
  });

  it('难度供给：给出分母，且不借判词四色', async () => {
    const tiers = await readDifficultySupply();
    const html = renderToStaticMarkup(<DifficultySupply tiers={tiers} />);
    expect(html).toContain('不是「资源难度匹配曲线」');
    if (tiers.length === 0) {
      expect(html).toContain('concept_graph.json');
      return;
    }
    const total = tiers.reduce((a, t) => a + t.concepts.length, 0);
    expect(html).toContain(`/ ${total} 个概念`);
    expect(html).not.toContain('bg-sky-500');
  });
});
