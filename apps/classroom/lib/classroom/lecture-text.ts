/**
 * 从 slide 场景抽讲义纯文本——导师考核「讲义驱动探问」的数据源。
 *
 * 元素读取口径与 lecture-scene-view 一致（content.canvas.elements 里的 text 元素，
 * 兼容顶层 elements 的旧数据），去 HTML 标签后按版面序（top,left）拼接，
 * 截 3000 字与引擎侧 LECTURE_TEXT_CAP 对齐。
 */

import type { Scene } from '@/lib/types/stage';

const LECTURE_TEXT_CAP = 3000;

export function sceneLectureText(scene: Scene | null | undefined): string {
  if (!scene) return '';
  const content = scene.content as
    | { canvas?: { elements?: unknown[] }; elements?: unknown[] }
    | undefined;
  const elements = Array.isArray(content?.canvas?.elements)
    ? content.canvas.elements
    : Array.isArray(content?.elements)
      ? content.elements
      : [];
  const text = elements
    .filter((el): el is { type: string; content: string; top?: number; left?: number } => {
      const e = el as { type?: string; content?: unknown };
      return e.type === 'text' && typeof e.content === 'string';
    })
    .sort((a, b) => (a.top ?? 0) - (b.top ?? 0) || (a.left ?? 0) - (b.left ?? 0))
    .map((e) => e.content.replace(/<[^>]*>/g, ' '))
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.slice(0, LECTURE_TEXT_CAP);
}
