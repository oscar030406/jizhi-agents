import { describe, expect, it } from 'vitest';

import {
  MAX_WHITEBOARD_VIEWPORT_RATIO,
  MIN_WHITEBOARD_VIEWPORT_RATIO,
  normalizeWhiteboardViewportRatio,
} from '@/lib/whiteboard/viewport';

describe('whiteboard viewport ratio (height/width)', () => {
  it('normalizes an inverted 16:9 ratio to a 1000 x 562.5 landscape sheet', () => {
    const ratio = normalizeWhiteboardViewportRatio(16 / 9);

    expect(ratio).toBe(9 / 16);
    expect(1000 * ratio).toBe(562.5);
  });

  it('keeps the canonical 9/16 landscape ratio unchanged', () => {
    expect(normalizeWhiteboardViewportRatio(9 / 16)).toBe(9 / 16);
  });

  it('clamps implausible ratios into the [0.4, 1] landscape band', () => {
    expect(normalizeWhiteboardViewportRatio(0.1)).toBe(MIN_WHITEBOARD_VIEWPORT_RATIO);
    expect(normalizeWhiteboardViewportRatio(1)).toBe(MAX_WHITEBOARD_VIEWPORT_RATIO);
  });

  it('falls back to the canonical 16:9 ratio for non-finite persisted values', () => {
    expect(normalizeWhiteboardViewportRatio(Number.NaN)).toBe(9 / 16);
    expect(normalizeWhiteboardViewportRatio(Number.POSITIVE_INFINITY)).toBe(9 / 16);
  });
});
