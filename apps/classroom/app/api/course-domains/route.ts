/**
 * 每门课的知识域归属——运行时推导的对外口。
 *
 * 真源是 `lib/server/course-domains.ts` 现读磁盘算出的结果（路径课判 ai →
 * 课程自记 corpus → 引用前缀多数 → 兜底 ai）。打包进客户端的
 * `data/course-domains.json` 自此降级为**首帧快照兜底**：运行时拉到本口
 * 的结果后覆盖之。此前推导模块写好、经与脚本产物逐门对账，却无人调用——
 * 域课程卡一直读着构建时的旧快照，新生成的课在域卡上隐形。
 */
import { NextResponse } from 'next/server';

import { readCourseDomains } from '@/lib/server/course-domains';
import { requireCorpusVisible } from '@/lib/server/corpus-access';

export const dynamic = 'force-dynamic'; // 新课随时生成，归属不许命中构建期缓存

export async function GET() {
  const access = await requireCorpusVisible();
  if (!access.ok) return access.response;
  const domains = await readCourseDomains();
  return NextResponse.json(
    Object.fromEntries(Object.entries(domains).filter(([, row]) => access.visible(row.domain))),
  );
}
