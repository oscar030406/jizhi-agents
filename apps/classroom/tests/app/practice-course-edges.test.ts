import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectsForCourse } from '@/components/skills/practice-projects';
import practiceData from '@/data/practice-projects.json';

/**
 * 实操项目 ↔ 课程的策展边（data/practice-projects.json 的 courseIds）。
 *
 * 这条边是人工判的（学完这门课能不能上手做这个项目），不是自动匹配，所以机器只能守
 * 一件事：**指过去的课必须真实存在**。课程墙是冻结的策展物，删/换一门课时若没同步
 * 这份边，课堂「动手做」区块会挂到一个不存在的 id 上——那是一条 404 链接，
 * 页面本身不会报错，只有这条测试会。
 */

const CLASSROOMS_DIR = join(process.cwd(), 'data', 'classrooms');
const projects = (practiceData as { projects: Array<{ id: string; courseIds: string[] }> }).projects;

const onDiskCourseIds = new Set(
  readdirSync(CLASSROOMS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, '')),
);

describe('项目 → 课程的策展边', () => {
  it('每个项目都有 courseIds 字段', () => {
    const missing = projects.filter((p) => !Array.isArray(p.courseIds));
    expect(missing.map((p) => p.id)).toEqual([]);
  });

  it('courseIds 里的每个 id 都真实存在于 data/classrooms/', () => {
    const dangling = projects.flatMap((p) =>
      p.courseIds.filter((id) => !onDiskCourseIds.has(id)).map((id) => `${p.id} → ${id}`),
    );
    expect(dangling).toEqual([]);
  });

  it('单个项目内不重复挂同一门课', () => {
    const dupes = projects
      .filter((p) => new Set(p.courseIds).size !== p.courseIds.length)
      .map((p) => p.id);
    expect(dupes).toEqual([]);
  });
});

describe('反向索引 projectsForCourse', () => {
  it('课程 id 能反查回声明了它的项目', () => {
    for (const p of projects) {
      for (const courseId of p.courseIds) {
        expect(projectsForCourse(courseId).map((x) => x.id)).toContain(p.id);
      }
    }
  });

  it('没有项目挂靠的课返回空数组（课堂里据此整块不渲染）', () => {
    const linked = new Set(projects.flatMap((p) => p.courseIds));
    const unlinked = [...onDiskCourseIds].filter((id) => !linked.has(id));
    // 缺口清单是策展事实，不是错误；这里只钉「查不到就是空」，不钉缺口有多少。
    for (const id of unlinked) expect(projectsForCourse(id)).toEqual([]);
  });

  it('不存在的课程 id 返回空数组', () => {
    expect(projectsForCourse('no-such-course')).toEqual([]);
  });
});

describe('课程侧覆盖', () => {
  it('至少有一门课挂上了项目（边不能整体失效）', () => {
    const linked = new Set(projects.flatMap((p) => p.courseIds));
    expect(linked.size).toBeGreaterThan(0);
  });
});
