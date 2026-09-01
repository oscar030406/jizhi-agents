import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from '@/lib/server/http-range';

describe('parseRangeHeader', () => {
  it('ignores missing and unsupported ranges', () => {
    expect(parseRangeHeader(null, 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('items=0-9', 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('bytes=0-9,20-29', 100)).toEqual({ kind: 'ignored' });
    expect(parseRangeHeader('bytes=-', 100)).toEqual({ kind: 'ignored' });
  });

  it('parses closed, open-ended, and suffix ranges', () => {
    expect(parseRangeHeader('bytes=10-19', 100)).toEqual({ kind: 'range', start: 10, end: 19 });
    expect(parseRangeHeader('bytes=10-', 100)).toEqual({ kind: 'range', start: 10, end: 99 });
    expect(parseRangeHeader('bytes=-20', 100)).toEqual({ kind: 'range', start: 80, end: 99 });
    expect(parseRangeHeader('bytes=-500', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
  });

  it('clamps ends and rejects unsatisfiable ranges', () => {
    expect(parseRangeHeader('bytes=0-999', 100)).toEqual({ kind: 'range', start: 0, end: 99 });
    expect(parseRangeHeader('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=50-40', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});
