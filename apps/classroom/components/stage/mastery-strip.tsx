'use client';

/**
 * 课堂内掌握条——DeepTutor MasteryPathStrip 的提炼：学习现场常驻一行
 * 「这门课我掌握到哪了 + 下一步该做什么」，不用切去学情报告才看得见。
 *
 * 数据全部本机即得：本课场景 → 概念键（与证据归拢同一套 resolveConcept 判据），
 * 画像缓存三张表 → 快照，策略层出计数与下一步。不读账本（那是报告页的深度视图，
 * 侧栏每次渲染都拉账本太重）；定性门因此不在这里参与，报告页有全量。
 * 没有任何快照（全新学习者）就整条不渲染——空数据不摆架子。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { resolveConcept } from '@/lib/evidence/scene-concepts';
import {
  masteryMap,
  nextObjective,
  snapshotsFromProfile,
  type MasterySnapshot,
} from '@/lib/evidence/policy';
import { conceptLabel } from '@/lib/knowledge/concept-labels';

export function MasteryStrip({
  scenes,
}: {
  readonly scenes: ReadonlyArray<{ id: string; title: string }>;
}) {
  const [snapshots, setSnapshots] = useState<Record<string, MasterySnapshot> | null>(null);
  useEffect(() => {
    // 画像在 localStorage，仅客户端可读；交卷后重挂载会拿到新值。
    setSnapshots(snapshotsFromProfile(loadLearnerProfile()));
  }, [scenes.length]);

  if (!snapshots || Object.keys(snapshots).length === 0) return null;

  const keys = [
    ...new Set(
      scenes.map(
        (s) => resolveConcept({ sceneId: s.id, sceneTitle: s.title })?.concept ?? s.title.trim(),
      ),
    ),
  ].filter(Boolean);
  const covered = keys.filter((k) => snapshots[k]);
  if (covered.length === 0) return null;

  const map = masteryMap(keys, Object.fromEntries(covered.map((k) => [k, snapshots[k]])));
  const step = nextObjective(keys, snapshots);
  const stepText =
    step.action === 'review'
      ? `复习「${conceptLabel(step.key)}」`
      : step.action === 'probe'
        ? `试探「${conceptLabel(step.key)}」`
        : step.action === 'practice'
          ? `练「${conceptLabel(step.key)}」`
          : '本课已全部过门';

  return (
    <Link
      href="/report"
      className="mx-3 mb-1 block rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground transition-colors hover:bg-accent"
      title="点开学情报告看证据与复习排期"
    >
      <span className="tabular-nums">
        掌握 {map.counts.mastered}/{map.counts.total}
      </span>
      <span className="mx-1.5 text-border">·</span>
      <span className="text-foreground/80">{stepText}</span>
    </Link>
  );
}
