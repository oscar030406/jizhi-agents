import { describe, expect, it } from 'vitest';

import { projectsForCourse, type PracticeProject } from '@/components/skills/practice-projects';

function project(id: string, courseIds: string[], level: PracticeProject['level'] = 'starter') {
  return {
    id,
    name: id,
    org: 'example/repo',
    level,
    difficulty: 1,
    hours: '2 小时',
    jobIds: [],
    courseIds,
    prereq: '无',
    steps: ['准备环境', '运行项目', '按标准验收'],
    cost: '免费',
    networkNote: '',
    why: '用于课程实操',
    acceptance: '产物可运行',
    deliverable: '项目仓库',
    resumeAdvice: '记录结果',
    links: [],
    alternatives: [],
    firsthand: true,
  } satisfies PracticeProject;
}

describe('发布项目 → 课程的动态边', () => {
  it('只从调用方传入的当前领域项目中按 courseIds 反查', () => {
    const ai = [
      project('ai-starter', ['course-a']),
      project('ai-advanced', ['course-a'], 'advanced'),
    ];
    const manufacturing = [project('mfg-project', ['course-m'])];

    expect(projectsForCourse(ai, 'course-a').map((item) => item.id)).toEqual([
      'ai-starter',
      'ai-advanced',
    ]);
    expect(projectsForCourse(manufacturing, 'course-a')).toEqual([]);
  });

  it('没有动态发布边的课程返回空数组', () => {
    expect(projectsForCourse([project('p1', ['course-a'])], 'no-such-course')).toEqual([]);
  });
});
