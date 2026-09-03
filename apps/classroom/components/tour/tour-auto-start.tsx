'use client';

/**
 * 挂在页面里：首次到访（或 URL 带 ?tour=<id>）时自动开跑对应引导。
 * 页面渲染完再起（等锚点的逻辑在 startTour 里），卸载时把跑着的引导收掉。
 */

import { useEffect } from 'react';

import { activeTour, isTourDone, requestedTour, startTour, stopTour } from './tour';
import type { TourId } from './tour-steps';

export function TourAutoStart({ id }: { readonly id: TourId }) {
  useEffect(() => {
    const requested = requestedTour();
    if (requested ? requested !== id : isTourDone(id)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!cancelled) void startTour(id, { force: true });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (activeTour() === id) stopTour();
    };
  }, [id]);
  return null;
}
