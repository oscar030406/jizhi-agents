import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimCourseCelebration,
  resetCelebrationMemory,
  type CelebrationStorage,
} from '@/lib/celebration/course-celebration';

function fakeStorage(initial: Record<string, string> = {}): CelebrationStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('claimCourseCelebration（L3 每课一次防重放）', () => {
  beforeEach(() => resetCelebrationMemory());

  it('首次进入返回 play，之后一律 settled（防重放）', () => {
    const storage = fakeStorage();
    expect(claimCourseCelebration('course-1', storage)).toBe('play');
    expect(claimCourseCelebration('course-1', storage)).toBe('settled');
    expect(claimCourseCelebration('course-1', storage)).toBe('settled');
  });

  it('跨会话防重放：storage 已有记录时直接 settled', () => {
    resetCelebrationMemory();
    const storage = fakeStorage({ 'courseCelebration:course-1': '123' });
    expect(claimCourseCelebration('course-1', storage)).toBe('settled');
  });

  it('不同课程互不影响', () => {
    const storage = fakeStorage();
    expect(claimCourseCelebration('course-a', storage)).toBe('play');
    expect(claimCourseCelebration('course-b', storage)).toBe('play');
    expect(claimCourseCelebration('course-a', storage)).toBe('settled');
  });

  it('storage 抛错时退化为会话内内存防重放，仍只播一次', () => {
    const broken: CelebrationStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(claimCourseCelebration('course-1', broken)).toBe('play');
    expect(claimCourseCelebration('course-1', broken)).toBe('settled');
  });

  it('空 courseId 不播庆祝', () => {
    expect(claimCourseCelebration('', fakeStorage())).toBe('settled');
  });
});
