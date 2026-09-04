'use client';

/**
 * 伴学教练：做项目时随时问。带着当前里程碑、当前代码任务、README 与知识库证据回答，
 * 默认给思路和最小片段，连问两次同一处才给完整实现。引用教材的句子带 source_id。
 * 历史存在本组件里、每轮全量回传（引擎无状态），换里程碑不清空——问题往往跨段。
 */

import { useRef, useState } from 'react';
import { Loader2, MessageSquareText, Send } from 'lucide-react';

import type { CoachReply } from '@/app/api/practice-guide/[action]/route';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type Msg = { role: 'user' | 'assistant'; content: string; cited?: string[] };

export function CoachChat({
  corpus,
  projectId,
  milestone,
  taskId,
  taskTitle,
}: {
  readonly corpus: string;
  readonly projectId: string;
  readonly milestone: number;
  readonly taskId: string | null;
  readonly taskTitle: string | null;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const ask = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setBusy(true);
    setNote('');
    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: 'user', content: message }]);
    setDraft('');
    try {
      const res = await fetch('/api/practice-guide/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus, projectId, milestone, taskId: taskId ?? '', history, message }),
      });
      const body = (await res.json().catch(() => null)) as (CoachReply & { message?: string }) | null;
      if (!res.ok || !body?.reply) {
        setNote(body?.message ?? '教练这次没答上来，再问一次。');
        return;
      }
      setMessages((m) => [...m, { role: 'assistant', content: body.reply, cited: body.cited }]);
      window.requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
    } catch {
      setNote('教练服务暂时不可用。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="coach-chat">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <MessageSquareText className="size-4 text-purple-deep" />
        问教练
      </p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        哪一行不会写、报错看不懂，直接问。教练知道你在第 {milestone} 段
        {taskTitle ? `、正在做「${taskTitle}」` : ''}，先给思路，连问两次再给完整代码。
      </p>
      <div ref={listRef} className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">比如：这个 TODO 该填什么？这个报错是什么意思？为什么要先切块再向量化？</p>
        )}
        {messages.map((m, i) => (
          <div
            key={`${i}-${m.role}`}
            className={cn(
              'rounded-lg px-3 py-2 text-sm leading-relaxed',
              m.role === 'user' ? 'ml-8 bg-purple-soft/60' : 'mr-4 bg-muted/60',
            )}
          >
            <pre className="whitespace-pre-wrap font-sans">{m.content}</pre>
            {m.cited && m.cited.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">引用教材：{m.cited.join('、')}</p>
            )}
          </div>
        ))}
        {busy && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            教练在想
          </p>
        )}
      </div>
      {note && <p className="mt-2 text-xs text-yellow-deep">{note}</p>}
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask();
          }}
          rows={2}
          placeholder="问一句。Ctrl+Enter 发送"
          disabled={busy}
        />
        <Button size="sm" onClick={ask} disabled={busy || !draft.trim()} aria-label="发送">
          <Send className="size-3.5" />
        </Button>
      </div>
    </section>
  );
}
