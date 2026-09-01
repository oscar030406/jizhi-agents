import { useEffect, useState, type RefObject } from 'react';

const NEAR_VIEWPORT_MARGIN_PX = 200;

export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setVisible(true));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root: null, rootMargin: `${NEAR_VIEWPORT_MARGIN_PX}px 0px`, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}
