import { describe, expect, it } from 'vitest';

import { courseVisibleToOrg } from '@/lib/server/course-access';

function course(
  origin?: { corpus?: string; domain?: string },
  profile?: { corpus?: string; domain?: string },
) {
  return {
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
