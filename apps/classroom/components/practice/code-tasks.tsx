'use client';

/**
 * 里程碑的代码任务：骨架里留 TODO，学习者自己填，交给教练判；三级提示，看过参考实现再交
 * 最高记「部分正确」。任务按顺序解锁不强制——做过的人可以直接跳，但默认停在第一个没过的。
 * 引擎无状态：判分时把任务原文一起回传。进度由宿主（带练页）保存。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, Lightbulb, Loader2, XCircle } from 'lucide-react';

import type { CodeTask, CodeTasksPayload, CodeVerdict } from '@/app/api/practice-guide/[action]/route';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type TasksState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; payload: CodeTasksPayload }
  | { kind: 'failed'; message: string };

const HINT_LABEL = ['方向提示', '分步或伪代码', '参考实现'];
const VERDICT_META: Record<CodeVerdict['verdict'], { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  correct: { label: '过关', tone: 'text-green-deep', icon: CheckCircle2 },
  partial: { label: '差一点', tone: 'text-yellow-deep', icon: Lightbulb },
  incorrect: { label: '还没到位', tone: 'text-red-deep', icon: XCircle },
};

export function CodeTasks({
  corpus,
  projectId,
  milestone,
  doneTaskIds,
  onTaskPassed,
  onActiveTask,
}: {
  readonly corpus: string;
  readonly projectId: string;
  readonly milestone: number;
  /** 这一段里已过关的任务 id */
  readonly doneTaskIds: string[];
  readonly onTaskPassed: (taskId: string) => void;
  /** 当前选中的任务，给旁边的伴学教练做上下文 */
  readonly onActiveTask?: (task: CodeTask | null) => void;
}) {
  const [state, setState] = useState<TasksState>({ kind: 'idle' });
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/practice-guide/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus, projectId, milestone }),
      });
      const body = (await res.json().catch(() => null)) as (CodeTasksPayload & { message?: string }) | null;
      if (!res.ok || !body?.tasks) {
        setState({ kind: 'failed', message: body?.message ?? '代码任务没取到。' });
        return;
      }
      setState({ kind: 'ready', payload: body });
    } catch (error) {
      setState({ kind: 'failed', message: String(error) });
    }
  }, [corpus, projectId, milestone]);

  // 换里程碑时清掉上一段的任务，回到「开始拆任务」；不自动拉——拆一次要一分钟，由学习者点。
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setState({ kind: 'idle' });
      setPicked(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [milestone]);

  const tasks = useMemo(() => (state.kind === 'ready' ? state.payload.tasks : []), [state]);
  const firstOpen = tasks.find((t) => !doneTaskIds.includes(t.id))?.id;
  const activeId = picked ?? firstOpen ?? tasks[0]?.id ?? null;
  const active = useMemo(() => tasks.find((t) => t.id === activeId) ?? null, [tasks, activeId]);

  useEffect(() => {
    onActiveTask?.(active);
  }, [active, onActiveTask]);

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="code-tasks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">自己写：这一段的代码任务</p>
        {state.kind === 'ready' && (
          <span className="text-xs text-muted-foreground">
            {tasks.filter((t) => doneTaskIds.includes(t.id)).length} / {tasks.length} 过关 · 姿态档 {state.payload.tier}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        骨架里的 TODO 留给你填，写完交给教练判。卡住先要提示：第一级指方向，第二级给分步，第三级是参考实现，看过第三级再交最高记「差一点」。
      </p>

      {state.kind === 'idle' && (
        <Button size="sm" className="mt-3" onClick={load}>
          按我的画像拆这一段的代码任务
        </Button>
      )}
      {state.kind === 'loading' && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          正在拆任务。第一次要一分钟左右，之后同一档直接打开。
        </p>
      )}
      {state.kind === 'failed' && (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">{state.message}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={load}>
            再试一次
          </Button>
        </div>
      )}

      {state.kind === 'ready' && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[200px_1fr]">
          <ol className="space-y-1">
            {tasks.map((t, i) => {
              const done = doneTaskIds.includes(t.id);
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(t.id)}
                    aria-current={t.id === activeId ? 'step' : undefined}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm',
                      t.id === activeId ? 'bg-purple-soft text-purple-deep' : 'hover:bg-accent',
                    )}
                  >
                    {done ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-deep" />
                    ) : (
                      <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="min-w-0 leading-snug">
                      {i + 1}. {t.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {active && (
            <TaskEditor
              key={`${milestone}-${active.id}`}
              corpus={corpus}
              task={active}
              passed={doneTaskIds.includes(active.id)}
              onPassed={() => onTaskPassed(active.id)}
            />
          )}
        </div>
      )}
    </section>
  );
}

function TaskEditor({
  corpus,
  task,
  passed,
  onPassed,
}: {
  readonly corpus: string;
  readonly task: CodeTask;
  readonly passed: boolean;
  readonly onPassed: () => void;
}) {
  const [code, setCode] = useState(task.skeleton);
  const [hintsUsed, setHintsUsed] = useState(0);
  const [grading, setGrading] = useState(false);
  const [verdict, setVerdict] = useState<CodeVerdict | null>(null);
  const [note, setNote] = useState('');

  const submit = async () => {
    setGrading(true);
    setNote('');
    try {
      const res = await fetch('/api/practice-guide/grade', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corpus, task, code, hintsUsed }),
      });
      const body = (await res.json().catch(() => null)) as (CodeVerdict & { message?: string }) | null;
      if (!res.ok || !body?.verdict) {
        setNote(body?.message ?? '教练这次没判出来，稍后再交一次。');
        return;
      }
      setVerdict(body);
      if (body.verdict === 'correct') onPassed();
    } catch {
      setNote('教练服务暂时不可用。');
    } finally {
      setGrading(false);
    }
  };

  const meta = verdict ? VERDICT_META[verdict.verdict] : null;

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <p className="text-sm font-medium">{task.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{task.brief}</p>
        {task.expected_output && (
          <p className="mt-1 text-xs text-muted-foreground">跑起来应看到：{task.expected_output}</p>
        )}
      </div>
      <Textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        rows={Math.min(24, Math.max(10, task.skeleton.split('\n').length + 2))}
        className="font-mono text-xs leading-relaxed"
        aria-label={`${task.title} 的代码`}
        disabled={passed}
      />
      <div className="text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">教练会看这几点</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {task.criteria.map((c, i) => (
            <li key={`${i}-${c.slice(0, 10)}`}>{c}</li>
          ))}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!passed && (
          <Button size="sm" onClick={submit} disabled={grading || code.trim().length < 8}>
            {grading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                判分中
              </>
            ) : (
              '交给教练判'
            )}
          </Button>
        )}
        {[0, 1, 2].map((level) => (
          <Button
            key={level}
            size="sm"
            variant="outline"
            disabled={level > hintsUsed || passed}
            onClick={() => setHintsUsed((h) => Math.max(h, level + 1))}
            title={level > hintsUsed ? '先看上一级提示' : undefined}
          >
            <Lightbulb className="size-3.5" />
            {level + 1}. {HINT_LABEL[level]}
          </Button>
        ))}
      </div>
      {hintsUsed > 0 && (
        <ol className="space-y-2 rounded-lg bg-muted/50 px-3 py-2.5 text-xs leading-relaxed">
          {task.hints.slice(0, hintsUsed).map((h, i) => (
            <li key={`${i}-${h.slice(0, 8)}`}>
              <span className="font-medium">{HINT_LABEL[i]}：</span>
              {i === 2 ? <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono">{h}</pre> : h}
            </li>
          ))}
          {hintsUsed >= 3 && <li className="text-yellow-deep">看过参考实现了，这一题最高记「差一点」。</li>}
        </ol>
      )}

      {passed && !verdict && (
        <p className="flex items-center gap-1.5 text-sm text-green-deep">
          <CheckCircle2 className="size-4" />
          这一题已过关
        </p>
      )}
      {verdict && meta && (
        <div className="rounded-lg border border-border-subtle px-3 py-2.5 text-sm" data-testid="task-verdict">
          <p className={cn('flex items-center gap-1.5 font-medium', meta.tone)}>
            <meta.icon className="size-4" />
            {meta.label}
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
            {verdict.because.map((b, i) => (
              <li key={`${i}-${b.slice(0, 10)}`}>{b}</li>
            ))}
          </ul>
          {verdict.problems.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-red-deep">
              {verdict.problems.map((p, i) => (
                <li key={`${i}-${p.slice(0, 10)}`}>{p}</li>
              ))}
            </ul>
          )}
          {verdict.next && <p className="mt-1.5 text-xs leading-relaxed">{verdict.next}</p>}
        </div>
      )}
      {note && <p className="text-xs text-yellow-deep">{note}</p>}
      {task.bridge && <p className="text-xs leading-relaxed text-muted-foreground">接下一步：{task.bridge}</p>}
    </div>
  );
}
