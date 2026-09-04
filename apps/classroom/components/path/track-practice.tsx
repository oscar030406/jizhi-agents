'use client';

import Link from 'next/link';

import {
  PracticeCard,
  projectsForCourse,
  usePublishedPractice,
} from '@/components/skills/practice-projects';

export function TrackPractice({
  corpus,
  courseIds,
  courseTitles = {},
  showStatus = true,
}: {
  corpus: string;
  /** 传入时只显示与这些课程关联的项目；省略时显示当前领域全部发布项目。 */
  courseIds?: readonly string[];
  courseTitles?: Record<string, string>;
  showStatus?: boolean;
}) {
  const state = usePublishedPractice(corpus);

  if (state.kind === 'loading') {
    return showStatus ? (
      <p className="mt-4 text-xs text-muted-foreground">正在读取本领域已发布的实操项目…</p>
    ) : null;
  }
  if (state.kind !== 'ready') {
    return showStatus ? (
      <div className="mt-4 rounded-lg border border-border bg-card px-4 py-3">
        <p className="text-sm font-medium">
          {state.kind === 'missing' ? '实操项目尚未生成或发布' : '实操项目状态暂时不可用'}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{state.reason}</p>
      </div>
    ) : null;
  }

  const projects = courseIds
    ? [
        ...new Map(
          courseIds
            .flatMap((courseId) => projectsForCourse(state.projects, courseId))
            .map((project) => [project.id, project]),
        ).values(),
      ]
    : state.projects;
  if (!projects.length) return null;

  return (
    <section className="mt-4 rounded-xl border border-border bg-card/60 p-4">
      <p className="text-sm font-medium">
        {courseIds ? '学到这里可以动手' : '本领域实操项目'}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          引擎生成、管理者审核后发布；完成标准可在
          <Link href="/skills" className="mx-1 underline underline-offset-2">
            岗位技能页
          </Link>
          查看
        </span>
      </p>
      <div className="mt-3 space-y-2">
        {projects.map((project) => (
          <PracticeCard key={project.id} project={project} courseTitles={courseTitles} corpus={corpus} />
        ))}
      </div>
    </section>
  );
}
