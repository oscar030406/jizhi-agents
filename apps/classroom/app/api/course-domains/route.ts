/**
 * 每门课的知识域归属——运行时推导的对外口。
 *
 * 真源是 `lib/server/course-domains.ts` 现读课程存储算出的结果：课程自记
 * corpus/domain 优先，其次才用引用前缀多数；没有证据就返回 unknown。
 * 不保留构建期快照，新生成的课因此会立即进入所属领域视图。
 */
import { type NextRequest, NextResponse } from 'next/server';

import { corpusOwnership } from '@/lib/accounts/org-store';
import { canReadCourse, courseReaderForRequest } from '@/lib/server/course-access';
import { readCourseDomains } from '@/lib/server/course-domains';
import { readClassroom } from '@/lib/server/classroom-storage';

export const dynamic = 'force-dynamic'; // 新课随时生成，归属不许命中构建期缓存

export async function GET(request: NextRequest) {
  try {
    // 先解出权限，再读课程总表；权限源失败时不碰全量课程元数据。
    const [ownership, reader] = await Promise.all([
      corpusOwnership(),
      courseReaderForRequest(request),
    ]);
    const domains = await readCourseDomains();
    const visible = await Promise.all(
      Object.entries(domains).map(async ([id, row]) => {
        const course = await readClassroom(id).catch(() => null);
        return course && canReadCourse(id, course, reader, ownership) ? ([id, row] as const) : null;
      }),
    );
    return NextResponse.json(Object.fromEntries(visible.filter((row) => row !== null)));
  } catch {
    return NextResponse.json({ error: '课程可见性暂时无法确认。' }, { status: 503 });
  }
}
