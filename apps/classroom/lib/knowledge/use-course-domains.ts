'use client';

/**
 * 课程 → 域 的归属表（客户端读取）。
 *
 * 唯一来源是当前会话下的 `/api/course-domains`。接口负责课程权限过滤；客户端不能
 * 回退构建期快照，否则机构切换或指派变化后会重新露出旧领域映射。
 *
 * 抽成 hook 是因为它现在有两个消费方（首页「本域课程」卡、最近学习列表），
 * 各写一份 fetch 迟早会长歪：一处改了兜底顺序、另一处没改，两张卡显示不同的课。
 * 「同一个概念在多处各有一份判据」是这个项目今天已经踩了五次的坑。
 */
import { useEffect, useState } from 'react';

export type CourseDomainEntry = { domain?: string; corpus?: string };

const EMPTY_COURSE_DOMAINS: Record<string, CourseDomainEntry> = {};

/**
 * @param injected 测试注入用。给了就不发请求。
 */
export function useCourseDomains(
  injected?: Record<string, CourseDomainEntry>,
): Record<string, CourseDomainEntry> {
  const [runtime, setRuntime] = useState<Record<string, CourseDomainEntry> | null>(null);

  useEffect(() => {
    if (injected) return;
    let alive = true;
    fetch('/api/course-domains')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data && typeof data === 'object')
          setRuntime(data as Record<string, CourseDomainEntry>);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [injected]);

  return injected ?? runtime ?? EMPTY_COURSE_DOMAINS;
}

/**
 * 这门课属不属于当前画像选定的域。
 *
 * 判据与「本域课程」卡同源。画像没选库时不筛；选了域以后，课程必须有
 * 同域归属记录才可见。新课在写入 origin 后才进入学习者视图，未知归属不放行。
 */
export function belongsToDomain(
  courseId: string,
  corpus: string | undefined,
  domains: Record<string, CourseDomainEntry>,
): boolean {
  const want = corpus?.trim();
  if (!want) return true;
  const entry = domains[courseId];
  if (!entry) return false;
  return (entry.corpus ?? entry.domain ?? '') === want;
}
