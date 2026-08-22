'use client';

/**
 * 课程 → 域 的归属表（客户端读取）。
 *
 * 归属主从：**运行时推导（`/api/course-domains`，现读磁盘）为主，打包快照为首帧兜底**。
 * 快照是构建时的世界——投币新建的课不在里面，只读快照的话新域的课全部隐形。
 *
 * 抽成 hook 是因为它现在有两个消费方（首页「本域课程」卡、最近学习列表），
 * 各写一份 fetch 迟早会长歪：一处改了兜底顺序、另一处没改，两张卡显示不同的课。
 * 「同一个概念在多处各有一份判据」是这个项目今天已经踩了五次的坑。
 */
import { useEffect, useState } from 'react';

import rawCourseDomains from '@/data/course-domains.json';

export type CourseDomainEntry = { domain?: string; corpus?: string };

const SNAPSHOT = rawCourseDomains as Record<string, CourseDomainEntry>;

/**
 * @param injected 测试注入用。给了就不发请求，也不用快照。
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

  return injected ?? runtime ?? SNAPSHOT;
}

/**
 * 这门课属不属于当前画像选定的域。
 *
 * 判据与「本域课程」卡同源。三条规则：
 *  - 画像没选库（跟随培训领域）→ 全部可见，不过滤
 *  - 归属表里没有这门课 → **算可见**。宁可多显示也不要让刚生成的课凭空消失——
 *    归属表是异步推导的，新课有一段时间不在表里。
 *  - 有记录 → 按 corpus 比对
 */
export function belongsToDomain(
  courseId: string,
  corpus: string | undefined,
  domains: Record<string, CourseDomainEntry>,
): boolean {
  const want = corpus?.trim();
  if (!want) return true;
  const entry = domains[courseId];
  if (!entry) return true;
  return (entry.corpus ?? entry.domain ?? '') === want;
}
