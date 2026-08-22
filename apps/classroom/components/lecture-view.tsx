'use client';

/**
 * 讲义视图（同课双形态 lite）——把当前课程渲染成流式讲义：
 * 每场景 = 标题 + 板书内容（text 元素按版面序）+ 讲解（speech 拼段）+ 摘录块。
 *
 * 讲义流评测方向性占优（开卷 1.40 vs 幻灯片 1.15）但未显著——全量转正不做，
 * lite 版提供阅读形态与演示差异点。渲染只读 stage store，零生成调用。
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, BookOpen } from 'lucide-react';

import {
  parseExcerptFromHtml,
  ExcerptBlockView,
} from '@/components/slide-renderer/components/element/TextElement/ExcerptBlock';
import { useLectureViewStore } from '@/lib/store/lecture-view';
import { useStageStore } from '@/lib/store';
import type { Scene } from '@/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';

function sceneTextElements(scene: Scene): PPTElement[] {
  // SlideContent = { type:'slide', canvas: Slide }——元素在 canvas.elements
  // （PPTist 结构）；容错老数据的顶层 elements。
  const content = scene.content as
    | { elements?: PPTElement[]; canvas?: { elements?: PPTElement[] } }
    | undefined;
  const elements = Array.isArray(content?.canvas?.elements)
    ? content.canvas.elements
    : Array.isArray(content?.elements)
      ? content.elements
      : [];
  return elements
    .filter((el): el is PPTElement & { content: string } => {
      const e = el as { type?: string; content?: unknown };
      return e.type === 'text' && typeof e.content === 'string';
    })
    .sort((a, b) => {
      const ay = (a as { top?: number }).top ?? 0;
      const by = (b as { top?: number }).top ?? 0;
      return ay - by || (((a as { left?: number }).left ?? 0) - ((b as { left?: number }).left ?? 0));
    });
}

function speechParagraphs(scene: Scene): string[] {
  return (scene.actions ?? [])
    .filter((a) => (a as { type?: string }).type === 'speech')
    .map((a) => String((a as { text?: unknown }).text ?? '').trim())
    .filter(Boolean);
}

const SCENE_TYPE_NOTE: Record<string, string> = {
  quiz: '【知识检查】本节配套测验在课堂放映中完成。',
  interactive: '【交互教具】本节为动手环节，切回放映模式操作。',
  pbl: '【项目实践】本节为项目制环节，切回放映模式参与。',
};

export function LectureView() {
  const open = useLectureViewStore((s) => s.open);
  const close = useLectureViewStore((s) => s.close);
  const scenes = useStageStore((s) => s.scenes);
  const stageTitle = useStageStore((s) => s.stage?.name ?? '');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open || typeof document === 'undefined') return null;

  // portal 到 body：canvas 区祖先带 transform/opacity（motion 动画层），
  // fixed 定位与 z-index 会被关进那个 stacking context，聊天/花名册兄弟层
  // 照样盖上来（实测截图验证过）。portal 是唯一稳的全屏 overlay 出路。
  return createPortal(
    <div className="fixed inset-0 z-50 bg-background overflow-y-auto" data-testid="lecture-view">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 backdrop-blur px-6 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="size-4 text-primary" />
          讲义视图 · 同一门课的阅读形态
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="关闭讲义视图"
          className="rounded-full p-2 hover:bg-muted transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      <article className="mx-auto max-w-3xl px-6 py-10 leading-relaxed">
        <h1 className="text-2xl font-bold mb-8">{stageTitle}（讲义）</h1>
        {scenes.map((scene, i) => {
          const texts = sceneTextElements(scene);
          const speeches = speechParagraphs(scene);
          const typeNote = SCENE_TYPE_NOTE[scene.type as string];
          return (
            <section key={scene.id ?? i} className="mb-12">
              <h2 className="text-xl font-semibold mb-4 border-b border-border pb-2">
                {i + 1}. {scene.title}
              </h2>
              {typeNote ? (
                <p className="text-sm text-muted-foreground italic">{typeNote}</p>
              ) : (
                texts.map((el, j) => {
                  const html = (el as { content: string }).content;
                  const excerpt = parseExcerptFromHtml(html);
                  if (excerpt)
                    return (
                      <div key={j} className="my-4">
                        <ExcerptBlockView block={excerpt} />
                      </div>
                    );
                  return (
                    <div
                      key={j}
                      className="lecture-slide-text my-2 [&_p]:my-1"
                      // 课件内容来自我们自己的生成链（受控 HTML），与幻灯片渲染同源
                      dangerouslySetInnerHTML={{ __html: html }}
                    />
                  );
                })
              )}
              {speeches.length > 0 && (
                <div className="mt-4 rounded-lg border-l-2 border-primary/40 bg-muted/40 px-4 py-3 space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">讲解</p>
                  {speeches.map((s, k) => (
                    <p key={k} className="text-[15px]">
                      {s}
                    </p>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </article>
    </div>,
    document.body,
  );
}
