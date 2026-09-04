'use client';

import { useId, useMemo, useRef, useEffect } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import TemplateWidgetHost from '@/components/widgets/TemplateWidgetHost';
import { ExternalAidsForScene } from '@/components/aids/external-aid-card';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly sceneId: string;
}

/**
 * 交互场景分发：模板教具（widgetConfig.type === 'template'）走站内 React 组件
 * 确定性渲染，不进 iframe 池；其余（旧课程数据的 LLM 生成 HTML / 外链 URL）
 * 保持原 iframe keep-alive 路径。
 */
export function InteractiveRenderer({ content, sceneId }: InteractiveRendererProps) {
  if (content.widgetConfig?.type === 'template') {
    return (
      <div className="h-full w-full overflow-auto p-6">
        <div className="mx-auto max-w-3xl">
          <TemplateWidgetHost config={content.widgetConfig} />
          {/* 站内模板教具之后再给外部成品：同一个概念，先自己练一遍再看人家怎么画。
              iframe 那条分支不挂——那边的 iframe 由 InteractiveIframeHost 按矩形浮在
              槽位上，往槽位里加内容会顶偏它的定位。 */}
          <ExternalAidsForScene sceneId={sceneId} />
        </div>
      </div>
    );
  }
  return <IframeInteractive content={content} sceneId={sceneId} />;
}

/**
 * Placeholder for an interactive scene. The actual iframe lives in the stable
 * `InteractiveIframeHost` (keyed by sceneId) so it survives remounts (#619);
 * this component only (1) registers the scene's content in the keep-alive pool,
 * (2) marks it active/visible while mounted, and (3) reports its on-screen rect
 * so the host can position the iframe over this slot. On unmount it hides the
 * iframe but never evicts it — that preserves the document for a zero-reload
 * return on the next mount.
 */
function IframeInteractive({ content, sceneId }: InteractiveRendererProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  // Unique per mounted placeholder instance — its visibility ownership token, so
  // a stale unmount during the mode cross-fade can't hide a newer instance.
  const owner = useId();
  const mount = useInteractiveIframePool((s) => s.mount);
  const setRect = useInteractiveIframePool((s) => s.setRect);
  const claim = useInteractiveIframePool((s) => s.claim);
  const release = useInteractiveIframePool((s) => s.release);
  const setActive = useInteractiveIframePool((s) => s.setActive);

  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  // Register / activate / claim visibility while mounted; release (keep-alive) on
  // unmount. A content change re-runs this and rebuilds the iframe — the only
  // intended reload path.
  useEffect(() => {
    mount(sceneId, {
      srcDoc: patchedHtml,
      src: patchedHtml ? undefined : content.url,
    });
    setActive(sceneId);
    claim(sceneId, owner);
    return () => release(sceneId, owner);
  }, [sceneId, owner, patchedHtml, content.url, mount, setActive, claim, release]);

  // 教具停留 → **信号**（不是证据）。教具是 sandbox iframe，父页面拿得到「停了多久」，
  // 拿不到「他这样操作对不对」——四个子盒里只填得满「来源」，按设计稿 §4.4 那张表
  // 就是信号。硬造一个「停留久=掌握了」是伪造判定，别改。
  //
  // 信号不进履历、不进画像，只进权重：某节停留极短且随后答错，说明那次作答置信度低
  // （`weight.ts` 的 `lowDwell` 乘 0.6）。升格路径写在 `from-widget.ts` 文件头。
  const enteredAtRef = useRef<number>(0);
  useEffect(() => {
    enteredAtRef.current = Date.now();
    const enteredIso = new Date().toISOString();
    return () => {
      const dwellMs = Date.now() - enteredAtRef.current;
      void (async () => {
        try {
          const { appendSignal } = await import('@/lib/evidence');
          const { widgetSignalDraft } = await import('@/lib/evidence/from-widget');
          const draft = widgetSignalDraft({
            interactionId: `widget:${sceneId}:${enteredAtRef.current}`,
            sceneId,
            dwellMs,
            at: enteredIso,
          });
          if (draft) await appendSignal(draft);
        } catch {
          // 信号写不进不影响任何东西——它本来就只是给权重加个修饰。
        }
      })();
    };
  }, [sceneId]);

  // Track this slot's screen rect for the host. rAF loop mirrors useTrackedRect:
  // one getBoundingClientRect read resolves canvas scale, viewport offset and
  // scroll, following the box through every resize / layout change.
  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const node = slotRef.current;
      if (node) {
        const r = node.getBoundingClientRect();
        setRect(sceneId, { left: r.left, top: r.top, width: r.width, height: r.height });
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [sceneId, setRect]);

  return <div ref={slotRef} className="w-full h-full" aria-hidden />;
}
