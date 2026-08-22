'use client';

import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { parseExcerptFromHtml, ExcerptBlockView } from './ExcerptBlock';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

/**
 * Base text element component (read-only)
 * Renders static text content with styling
 */
export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  // 拼装模式注入的教材摘录（📖 固定格式）→ 摘录块；仅渲染层转换，不改存储
  const excerptBlock =
    typeof elementInfo.content === 'string' ? parseExcerptFromHtml(elementInfo.content) : null;

  return (
    <div
      className="base-element-text absolute"
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{
          transform: `rotate(${elementInfo.rotate}deg)`,
          backgroundColor: elementInfo.fill,
          opacity: elementInfo.opacity,
        }}
      >
        <div
          className="element-content relative p-[10px] leading-[1.5] break-words"
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            // 摘录块按元素盒定高（配合块内 flex 布局裁正文保出处行）；
            // 普通文本维持 auto——上游行为，改了会影响既有排版。
            height: excerptBlock
              ? `${elementInfo.height}px`
              : elementInfo.vertical
                ? `${elementInfo.height}px`
                : 'auto',
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          {excerptBlock ? (
            <div
              className={`text relative h-full ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
            >
              <ExcerptBlockView block={excerptBlock} />
            </div>
          ) : (
            <div
              className={`text ProseMirror-static relative ${target === 'thumbnail' ? 'pointer-events-none' : ''}`}
              dangerouslySetInnerHTML={{ __html: elementInfo.content }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
