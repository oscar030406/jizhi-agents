import type { NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/lib/accounts/session';
import { orgForAccount } from '@/lib/accounts/org-store';
import { accountForSession } from '@/lib/accounts/store';

type CourseAccessMetadata = {
  ownerOrgId?: unknown;
  stage?: { origin?: { corpus?: unknown; domain?: unknown } };
  generation?: { profile?: { corpus?: unknown; domain?: unknown } };
};

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

/** 无归属行沿用存量公共课语义；命中私有归属时只允许唯一所属机构访问。 */
export function courseVisibleToOrg(
  course: CourseAccessMetadata,
  orgId: string | null,
  ownership: ReadonlyMap<string, string>,
): boolean {
  const ownerOrgId = typeof course.ownerOrgId === 'string' ? course.ownerOrgId.trim() : '';
  if (ownerOrgId) return orgId === ownerOrgId;

  const corpora = new Set(
    [selectedCorpus(course.stage?.origin), selectedCorpus(course.generation?.profile)].filter(
      (corpus): corpus is string => corpus !== null,
    ),
  );
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
