import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const homeSource = readFileSync(join(process.cwd(), 'app', 'home-view.tsx'), 'utf-8');
const courseDomainsSource = readFileSync(
  join(process.cwd(), 'lib', 'knowledge', 'use-course-domains.ts'),
  'utf-8',
);

describe('首页有效领域边界', () => {
  it('继续课程、路径卡和示例词只消费指派优先的有效领域', () => {
    expect(homeSource).toContain('useEffectiveDomainContext(learnerProfile, profileReady)');
    expect(homeSource).toContain('domainContextState.context.assignment');
    expect(homeSource).toContain('domainContextState.context.courseIds');
    expect(homeSource).toContain('assignedCourseIds.includes(course.id)');
    expect(homeSource).toContain('<PathOrDomainCard');
    expect(homeSource).toContain('corpus={effectiveDomain}');
    expect(homeSource).not.toContain('<DomainCoursesCard');
    expect(homeSource).not.toContain('learnerProfile.corpus');
    expect(homeSource).not.toContain('classrooms[0]');
  });

  it('有指派但课程域缺失时显示明确阻断态', () => {
    expect(homeSource).toContain('机构指派课程的领域尚未确认');
    expect(homeSource).toContain('不会改用旧画像或其它领域内容');
  });

  it('课程归属 hook 不再导入或返回构建期快照', () => {
    expect(courseDomainsSource).not.toContain('@/data/course-domains.json');
    expect(courseDomainsSource).not.toContain('SNAPSHOT');
  });
});
