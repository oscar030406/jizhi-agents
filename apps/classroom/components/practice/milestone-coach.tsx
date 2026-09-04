'use client';

/**
 * 里程碑教练：一个里程碑做完，由导学智能体来问、来判，通过才算过关。
 *
 * 复用讲义驱动导学（/api/tutor 的 lectureText 分支）：把这个里程碑的目标、要搭什么、
 * 怎么做、验收标准、工程习惯拼成「讲义正文」，第一问直接用带练里程碑里预置的检查题
 * 与判分要点（生成时就定了，判分口径不漂），答得不到位可以让教练换一个问法再问。
 * 引擎无状态，历史在本组件里、每轮全量回传；提示阶梯与掌握度压档沿用导学面板那一套。
 */

import { useCallback, useState } from 'react';
import { CheckCircle2, Loader2, MessageCircleQuestion, RotateCcw, XCircle } from 'lucide-react';

import type { GuideMilestone } from '@/app/api/practice-guide/route';
import type { LectureExchange, LectureTutorTurn } from '@/app/api/tutor/route';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'asked' | 'grading' | 'asking' | 'passed' | 'offline';

const VERDICT_META: Record<string, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  correct: { label: '过关', tone: 'text-green-deep', icon: CheckCircle2 },
  partial: { label: '差一点', tone: 'text-yellow-deep', icon: MessageCircleQuestion },
  incorrect: { label: '还没到位', tone: 'text-red-deep', icon: XCircle },
};

/** 教练能看到的「这一段讲了什么」：只给里程碑本身，不给整份路线，问题才落在这一段上。 */
export function milestoneLectureText(m: GuideMilestone): string {
  return [
    `目标：${m.goal}`,
    `要搭什么：${m.build.join('；')}`,
    `怎么做：${m.how.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    `做到什么算完成：${m.acceptance}`,
    `这一段要练的工程习惯：${m.engineering_habit.title}。${m.engineering_habit.how}`,
    m.pitfalls.length ? `常见坑：${m.pitfalls.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function MilestoneCoach({
  milestone,
  projectName,
  passed,
  onPassed,
  tier = 'L2',
}: {
  readonly milestone: GuideMilestone;
  readonly projectName: string;
  /** 这一段此前已经过关（进度里有记录） */
  readonly passed: boolean;
  readonly onPassed: () => void;
  readonly tier?: string;
}) {
  const [status, setStatus] = useState<Status>(passed ? 'passed' : 'idle');
  const [question, setQuestion] = useState(milestone.check_question);
  const [points, setPoints] = useState<string[]>(milestone.expected_points);
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState<LectureExchange[]>([]);
  const [last, setLast] = useState<LectureTutorTurn | null>(null);
  const [note, setNote] = useState('');

  const lectureText = milestoneLectureText(milestone);

  const call = useCallback(
    async (payload: Record<string, unknown>): Promise<LectureTutorTurn | null> => {
      const res = await fetch('/api/tutor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lectureText,
          sceneTitle: milestone.title,
          courseTitle: projectName,
          recommendedDifficulty: tier,
          lectureHistory: history,
          ...payload,
        }),
      });
      if (res.status === 204) return null;
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: LectureTutorTurn } | LectureTutorTurn;
      const turn = ('data' in body ? body.data : body) as LectureTutorTurn | undefined;
      return turn && 'mode' in turn ? turn : null;
    },
    [history, lectureText, milestone.title, projectName, tier],
  );

  const submit = async () => {
    if (!answer.trim()) return;
    setStatus('grading');
    setNote('');
    const turn = await call({ question, expectedPoints: points, learnerAnswer: answer.trim() });
    if (!turn || turn.mode === 'unavailable') {
      setStatus('offline');
      setNote(turn?.because?.[0] ?? '导学服务暂时不可用，这一段先自己对照验收标准检查。');
      return;
    }
    setLast(turn);
    setHistory((h) => [...h, { question, answer: answer.trim(), verdict: turn.verdict, hints_used: 0 }]);
    if (turn.verdict === 'correct') {
      setStatus('passed');
      onPassed();
    } else {
      setStatus('asked');
    }
  };

  const reask = async () => {
    setStatus('asking');
    setNote('');
    const turn = await call({});
    if (!turn || turn.mode !== 'ask' || !turn.question) {
      setStatus('asked');
      setNote('教练没出出新题，先按上面这道再答一次。');
      return;
    }
    setQuestion(turn.question);
    setPoints(turn.expected_points ?? []);
    setAnswer('');
    setLast(null);
    setStatus('asked');
  };

  return (
    <section
      data-testid="milestone-coach"
      className="rounded-xl border border-border bg-card p-4 sm:p-5"
      aria-label="里程碑检查"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold">教练检查</p>
        {status === 'passed' && (
          <span className="inline-flex items-center gap-1 text-xs text-green-deep">
            <CheckCircle2 className="size-3.5" />
            这一段已过关
          </span>
        )}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        做完这一段再来答。教练按上面的验收标准和判分要点判，答对才记过关；答不上来可以换个问法，
        也可以先记着往下做。
      </p>

      {status === 'idle' && (
        <Button size="sm" className="mt-3" onClick={() => setStatus('asked')}>
          我做完了，开始检查
        </Button>
      )}

      {status !== 'idle' && (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm leading-relaxed">
            <span className="mr-1 font-medium">教练问：</span>
            {question}
          </div>

          {status !== 'passed' && (
            <>
              <Textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="用自己的话说你做了什么、为什么这么做；可以贴关键代码或运行结果。"
                rows={4}
                disabled={status === 'grading' || status === 'asking'}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={!answer.trim() || status === 'grading' || status === 'asking'}
                >
                  {status === 'grading' ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      判分中
                    </>
                  ) : (
                    '交给教练判'
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={reask}
                  disabled={status === 'grading' || status === 'asking'}
                >
                  {status === 'asking' ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      出题中
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-3.5" />
                      换个问法
                    </>
                  )}
                </Button>
              </div>
            </>
          )}

          {last && last.mode === 'verdict' && (
            <VerdictCard turn={last} />
          )}
          {note && <p className="text-xs text-yellow-deep">{note}</p>}
          {status === 'offline' && (
            <Button size="sm" variant="outline" onClick={() => setStatus('asked')}>
              再试一次
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

function VerdictCard({ turn }: { readonly turn: LectureTutorTurn }) {
  const meta = VERDICT_META[turn.verdict] ?? VERDICT_META.partial;
  const Icon = meta.icon;
  return (
    <div className="rounded-lg border border-border-subtle px-3 py-2.5 text-sm" data-testid="coach-verdict">
      <p className={cn('flex items-center gap-1.5 font-medium', meta.tone)}>
        <Icon className="size-4" />
        {meta.label}
      </p>
      {turn.because.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          {turn.because.map((b, i) => (
            <li key={`${i}-${b.slice(0, 12)}`}>{b}</li>
          ))}
        </ul>
      )}
      {turn.explanation && <p className="mt-1.5 text-xs leading-relaxed">{turn.explanation}</p>}
      {turn.quote && (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">对照这一段的原话：「{turn.quote}」</p>
      )}
    </div>
  );
}
