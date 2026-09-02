import { corpusOwnership } from '@/lib/accounts/org-store';
import { canReadCourse, type CourseReader } from '@/lib/server/course-access';
import { readCourseDomains } from '@/lib/server/course-domains';
import { listClassrooms, readClassroom } from '@/lib/server/classroom-storage';

/** 发布与恢复都重新取这一刻真实可用的本域课程，客户端无权提交候选清单。 */
export async function currentPracticeCourses(
  corpus: string,
  owner: { accountId: string; orgId: string },
): Promise<Array<{ id: string; title: string }>> {
  const [domains, summaries, ownership] = await Promise.all([
    readCourseDomains(),
    listClassrooms({ learnerReleasedOnly: true }),
    corpusOwnership(),
  ]);
  const reader: CourseReader = {
    accountId: owner.accountId,
    orgId: owner.orgId,
    memberRole: 'owner',
    assignedCourseIds: new Set(),
  };
  return (
    await Promise.all(
      summaries
        .filter((summary) => domains[summary.id]?.domain === corpus)
        .map(async (summary) => {
          const course = await readClassroom(summary.id).catch(() => null);
          return course && canReadCourse(summary.id, course, reader, ownership)
            ? { id: summary.id, title: summary.title }
            : null;
        }),
    )
  ).filter((course): course is { id: string; title: string } => course !== null);
}
