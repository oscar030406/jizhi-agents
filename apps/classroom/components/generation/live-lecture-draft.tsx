'use client';

/**
 * 造课直播 · 讲义成稿面板（2026-08-04 提速批三段「边生成边读」）。
 *
 * 订阅讲义流式草稿 store（scene-content SSE 增量），等待期把正在生成的
 * 讲义正文实时渲染给用户——等待时间即阅读时间。多份草稿并发时展示
 * 最新一份未完成的（并行预取场景在后台静默写，主展位跟着当前场景走）。
 */

import { useEffect, useMemo, useRef } from 'react';
import { motion } from 'motion/react';
import { Streamdown } from 'streamdown';
// 数学插件：讲义 md 满地 $..$/$$..$$，不开 math 就是 LaTeX 裸奔（用户两次实拍）
import { math } from '@streamdown/math';
import { BookOpenText } from 'lucide-react';
import { useLectureDraftStore } from '@/lib/store/lecture-draft';

export function LiveLectureDraft() {
  const drafts = useLectureDraftStore((s) => s.drafts);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => {
    const list = Object.values(drafts).filter((d) => d.md.trim().length > 0);
    if (list.length === 0) return null;
    return list.find((d) => !d.done) ?? list[list.length - 1];
  }, [drafts]);

  // 增量到达时贴底——用户手动上滚超过一屏则不打扰
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [active?.md]);

  if (!active) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mx-auto w-full max-w-2xl text-left"
    >
      <div className="mb-2 flex items-center gap-2 px-1">
        <BookOpenText className="w-4 h-4 text-purple-500" />
        <span className="text-sm font-medium text-muted-foreground">
          讲义正在成稿 · {active.title}
        </span>
        {!active.done && (
          <span className="inline-block w-1.5 h-4 bg-purple-400 animate-pulse rounded-sm" />
        )}
      </div>
      <div
        ref={scrollRef}
        className="max-h-72 overflow-y-auto rounded-xl border border-border bg-card/80 px-5 py-4 text-sm leading-relaxed shadow-card scrollbar-hide"
      >
        <Streamdown plugins={{ math }} className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {active.md}
        </Streamdown>
      </div>
    </motion.div>
  );
}
