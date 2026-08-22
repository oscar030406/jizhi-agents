/**
 * L3 整课完成庆祝的一次性状态机（设计规格 3.2.5 / 4「微庆祝时刻」，配方②）。
 *
 * 规则写死：每门课的全屏庆祝（纸屑 + 循环动效）只播一次。之后再进完成页
 * 只渲染静态成果摘要。防重放靠两层：localStorage（跨会话）+ 模块内存
 * （localStorage 不可用时兜底，同会话内仍只播一次）。
 */

export type CelebrationPhase = 'play' | 'settled';

const memoryClaims = new Set<string>();

const keyFor = (courseId: string) => `courseCelebration:${courseId}`;

export interface CelebrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Claim the one-shot celebration for a course. First call per course returns
 * 'play' and burns the claim; every later call returns 'settled'.
 */
export function claimCourseCelebration(
  courseId: string,
  storage?: CelebrationStorage | null,
): CelebrationPhase {
  if (!courseId) return 'settled';
  const store =
    storage !== undefined ? storage : typeof localStorage === 'undefined' ? null : localStorage;

  if (memoryClaims.has(courseId)) return 'settled';

  let persisted = false;
  if (store) {
    try {
      if (store.getItem(keyFor(courseId)) != null) persisted = true;
      else store.setItem(keyFor(courseId), String(Date.now()));
    } catch {
      /* 隐私模式等写入失败：退化到内存防重放 */
    }
  }
  memoryClaims.add(courseId);
  return persisted ? 'settled' : 'play';
}

/** Test-only: reset the in-memory claim set. */
export function resetCelebrationMemory(): void {
  memoryClaims.clear();
}
