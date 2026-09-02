import type { NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/accounts/session';
import { assignmentsOf, orgForAccount } from '@/lib/accounts/org-store';
import { accountForSession } from '@/lib/accounts/store';

type CourseAccessMetadata = {
  ownerOrgId?: unknown;
  stage?: { origin?: { corpus?: unknown; domain?: unknown } };
  generation?: { profile?: { corpus?: unknown; domain?: unknown } };
};

export interface CourseReader {
  accountId: string | null;
  orgId: string | null;
  memberRole: 'owner' | 'member' | null;
  assignedCourseIds: ReadonlySet<string>;
}

export async function courseReaderForSession(sessionToken?: string): Promise<CourseReader> {
  const account = await accountForSession(sessionToken);
  if (!account) {
    return { accountId: null, orgId: null, memberRole: null, assignedCourseIds: new Set() };
  }
  const org = await orgForAccount(account.id);
  if (!org) {
    return { accountId: account.id, orgId: null, memberRole: null, assignedCourseIds: new Set() };
  }
  const assignments = org.memberRole === 'member' ? await assignmentsOf(org.id, account.id) : [];
  return {
    accountId: account.id,
    orgId: org.id,
    memberRole: org.memberRole,
    assignedCourseIds: new Set(assignments.map((assignment) => assignment.courseId)),
  };
}

export function courseReaderForRequest(
  request: Pick<NextRequest, 'cookies'>,
): Promise<CourseReader> {
  return courseReaderForSession(request.cookies.get(SESSION_COOKIE)?.value);
}

export async function viewerOrgId(request: Pick<NextRequest, 'cookies'>): Promise<string | null> {
  const account = await accountForSession(request.cookies.get(SESSION_COOKIE)?.value);
  return account ? ((await orgForAccount(account.id))?.id ?? null) : null;
}

function selectedCorpus(source?: { corpus?: unknown; domain?: unknown }): string | null {
  const corpus = typeof source?.corpus === 'string' ? source.corpus.trim() : '';
  if (corpus) return corpus;
  const domain = typeof source?.domain === 'string' ? source.domain.trim() : '';
  return domain || null;
}

/** 课程自己声明的全部 corpus；多值代表持久化元数据冲突，调用方应 fail closed。 */
export function courseCorpora(course: CourseAccessMetadata): ReadonlySet<string> {
  return new Set(
    [selectedCorpus(course.stage?.origin), selectedCorpus(course.generation?.profile)].filter(
      (corpus): corpus is string => corpus !== null,
    ),
  );
}

/** 无归属行沿用存量公共课语义；命中私有归属时只允许唯一所属机构访问。 */
export function courseVisibleToOrg(
  course: CourseAccessMetadata,
  orgId: string | null,
  ownership: ReadonlyMap<string, string>,
): boolean {
  const ownerOrgId = typeof course.ownerOrgId === 'string' ? course.ownerOrgId.trim() : '';
  if (ownerOrgId) return orgId === ownerOrgId;

  const corpora = courseCorpora(course);
  const privateOwners = new Set<string>();
  for (const corpus of corpora) {
    const owner = ownership.get(corpus);
    if (owner) privateOwners.add(owner);
  }
  return (
    privateOwners.size === 0 ||
    (privateOwners.size === 1 && orgId !== null && privateOwners.has(orgId))
  );
}

/**
 * 学习者读课程的唯一判定：先过机构/知识库隔离，再落实到定向指派。
 * 存量公共课继续允许匿名浏览；机构 member 登录后只进入本机构明确指派的课程。
 */
export function canReadCourse(
  courseId: string,
  course: CourseAccessMetadata,
  reader: CourseReader,
  ownership: ReadonlyMap<string, string>,
): boolean {
  if (!courseVisibleToOrg(course, reader.orgId, ownership)) return false;
  if (reader.memberRole === 'owner') return true;
  if (reader.memberRole === 'member') return reader.assignedCourseIds.has(courseId);
  return courseVisibleToOrg(course, null, ownership);
}
