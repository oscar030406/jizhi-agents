'use client';

/** 顶栏里的「重看引导」：本页有引导就原地重放，否则跳到带 ?tour= 的目标页。 */

import Link from 'next/link';

import { cn } from '@/lib/utils';
import { startTour } from './tour';
import type { TourId } from './tour-steps';

export function ReplayTourLink({
  id,
  href,
  className,
}: {
  readonly id: TourId;
  /** 引导不在本页时跳去哪（带上 ?tour=<id>） */
  readonly href?: string;
  readonly className?: string;
}) {
  const cls = cn(
    'rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground',
    className,
  );
  if (href) {
    return (
      <Link href={`${href}${href.includes('?') ? '&' : '?'}tour=${id}`} className={cls}>
        重看引导
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => void startTour(id, { force: true })} className={cls}>
      重看引导
    </button>
  );
}
