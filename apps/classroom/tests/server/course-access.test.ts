import { describe, expect, it } from 'vitest';

import { canReadCourse, courseVisibleToOrg, type CourseReader } from '@/lib/server/course-access';

function course(
  origin?: { corpus?: string; domain?: string },
  profile?: { corpus?: string; domain?: string },
  ownerOrgId?: string,
) {
  return {
    ...(ownerOrgId ? { ownerOrgId } : {}),
    stage: { origin },
    generation: profile ? { profile } : undefined,
  };
}

describe('courseVisibleToOrg', () => {
  const ownership = new Map([
    ['private-a', 'org-a'],
    ['private-b', 'org-b'],
  ]);

  it('keeps legacy and unowned courses public', () => {
    expect(courseVisibleToOrg(course(), null, ownership)).toBe(true);
    expect(courseVisibleToOrg(course({ corpus: 'public-corpus' }), null, ownership)).toBe(true);
  });

  it('prioritizes persisted course organization over public corpus semantics', () => {
    const owned = course({ corpus: 'public-corpus' }, undefined, 'org-a');
    expect(courseVisibleToOrg(owned, null, ownership)).toBe(false);
    expect(courseVisibleToOrg(owned, 'org-b', ownership)).toBe(false);
    expect(courseVisibleToOrg(owned, 'org-a', ownership)).toBe(true);
  });

  it('allows a private course only inside its owning organization', () => {
    const privateCourse = course({ corpus: 'private-a' });
    expect(courseVisibleToOrg(privateCourse, null, ownership)).toBe(false);
    expect(courseVisibleToOrg(privateCourse, 'org-b', ownership)).toBe(false);
    expect(courseVisibleToOrg(privateCourse, 'org-a', ownership)).toBe(true);
  });

  it('uses domain only when the same metadata source has no corpus', () => {
    expect(courseVisibleToOrg(course({ domain: 'private-a' }), null, ownership)).toBe(false);
    expect(
      courseVisibleToOrg(course({ corpus: 'public-corpus', domain: 'private-a' }), null, ownership),
    ).toBe(true);
  });

  it('fails closed when persisted metadata points at private corpora from different orgs', () => {
    const conflicted = course({ corpus: 'private-a' }, { corpus: 'private-b' });
    expect(courseVisibleToOrg(conflicted, 'org-a', ownership)).toBe(false);
    expect(courseVisibleToOrg(conflicted, 'org-b', ownership)).toBe(false);
  });
});

describe('canReadCourse', () => {
  const ownership = new Map([['private-a', 'org-a']]);
  const reader = (
    memberRole: CourseReader['memberRole'],
    assignedCourseIds: string[] = [],
  ): CourseReader => ({
    accountId: memberRole ? `${memberRole}-a` : null,
    orgId: memberRole ? 'org-a' : null,
    memberRole,
    assignedCourseIds: new Set(assignedCourseIds),
  });

  it('机构 owner 可读本机构课程，普通 member 只读明确指派课程', () => {
    const privateCourse = course({ corpus: 'private-a' });
    expect(canReadCourse('course-a', privateCourse, reader('owner'), ownership)).toBe(true);
    expect(canReadCourse('course-a', privateCourse, reader('member'), ownership)).toBe(false);
    expect(
      canReadCourse('course-a', privateCourse, reader('member', ['course-a']), ownership),
    ).toBe(true);
  });

  it('存量公共课仍可匿名浏览，但机构 member 登录后只进入机构明确指派的课程', () => {
    const legacyPublic = course({ corpus: 'public-corpus' });
    expect(canReadCourse('legacy', legacyPublic, reader(null), ownership)).toBe(true);
    expect(canReadCourse('legacy', legacyPublic, reader('owner'), ownership)).toBe(true);
    expect(canReadCourse('legacy', legacyPublic, reader('member'), ownership)).toBe(false);
    expect(canReadCourse('legacy', legacyPublic, reader('member', ['legacy']), ownership)).toBe(
      true,
    );
  });
});
