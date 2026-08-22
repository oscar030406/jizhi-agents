'use client';

/**
 * Multi-agent decision banner — the visible end of the analyse → generate →
 * verify → decide loop. After grading, the feedback-decision agent routes the
 * learner and this shows what it decided and, expandable, *why* (which
 * thresholds the score crossed). The reasoning is the point: an adaptive system
 * that cannot explain its routing is indistinguishable from a random one.
 */

import { useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Repeat, CheckCircle2, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AdaptiveDecision } from '@/app/api/adaptive/quiz-decision/route';

const DECISION_META: Record<
  AdaptiveDecision['decision'],
  { icon: typeof ArrowDownCircle; label: string; tone: string; ring: string }
> = {
  /* 学径语义粉彩（globals.css 增量 token，亮/暗双值自动切换）：
     黄=挑战/降档警示、蓝=进度/补充、绿=通过/进阶；保持路线用中性 token。 */
  downgrade_explanation: {
    icon: ArrowDownCircle,
    label: '降维解释',
    tone: 'text-yellow-deep',
    ring: 'border-yellow-deep/30 bg-yellow-soft',
  },
  add_practice: {
    icon: Repeat,
    label: '补充练习',
    tone: 'text-blue-deep',
    ring: 'border-blue-deep/30 bg-blue-soft',
  },
  advance_challenge: {
    icon: ArrowUpCircle,
    label: '进阶挑战',
    tone: 'text-green-deep',
    ring: 'border-green-deep/30 bg-green-soft',
  },
  keep_route: {
    icon: CheckCircle2,
    label: '保持路线',
    tone: 'text-muted-foreground',
    ring: 'border-border bg-muted/40',
  },
};

/** 决策名（4 个取值）→ 中文。查不到不许把原值裸渲出去。 */
function decisionLabel(value: string): string {
  return DECISION_META[value as AdaptiveDecision['decision']]?.label ?? '其他路线';
}

/**
 * `next_action` 不是枚举，是**自由文本**，所以这里不能只做「查表翻译」。
 *
 * 三条产出路径：
 * 1. 确定性路径 `feedback_decision_agent.py:84/94/102` —— 3 句写死的中文；
 * 2. 冲突仲裁改写 `decision_negotiation.py:57-62`（ACTION_TEXT）—— 4 句写死的中文；
 * 3. 模型路径 `feedback_decision_agent.py:53-56` —— 只校验非空，模型写什么就是什么。
 *    第 3 条实测会吐英文下划线代号：`data/demo_runs/03-low-score-followup.json:1116`
 *    的 `provide_step_by_step_guide`、`04-high-score-followup.json:1296` 的
 *    `introduce_fault_injection_and_evaluation_constraints`，核验员在界面上抓到的
 *    `reexplain_concept` / `review_fundamentals` 也是这一路。
 *
 * 取值集合无上界，映射表天然补不全，所以判据反过来写：**只放行人话**。
 * 中文原样显示；不含中文的先查别名表；再查不到就按 `decision`（这个才是引擎校验过的
 * 四值枚举，见 `feedback_decision_agent.py:7`）说一句中性的话。
 */
const ACTION_ALIAS: Record<string, string> = {
  reexplain_concept: '换个说法，把这个概念再讲一遍',
  review_fundamentals: '先回去把打底的概念过一遍',
  provide_step_by_step_guide: '拆成几步，一步一步带着走一遍',
  introduce_fault_injection_and_evaluation_constraints: '加上出错场景和评测约束，做一次更完整的练习',
};

const ACTION_FALLBACK: Record<AdaptiveDecision['decision'], string> = {
  downgrade_explanation: '换个更简单的说法重讲，再配两道小练习',
  add_practice: '难度不变，针对没答稳的地方再练一轮',
  advance_challenge: '往上加一道更综合的题',
  keep_route: '按现在的节奏继续往下学',
};

const HAS_CHINESE = /[一-鿿]/;

function nextActionText(decision: AdaptiveDecision): string {
  const raw = String(decision.next_action ?? '').trim();
  if (HAS_CHINESE.test(raw)) return raw;
  return ACTION_ALIAS[raw] ?? ACTION_FALLBACK[decision.decision] ?? ACTION_FALLBACK.keep_route;
}

/**
 * 判定是谁做的，如实写。
 *
 * 这里原来无条件写「多智能体协同决策」——**那是假话**，两层：
 * 1. 默认 `AGENT_GENERATION_MODE=deterministic`，跑的是确定性规则，不是模型；
 * 2. 即使走模型，做判定的也是**单个** FeedbackDecisionAgent，没有多方出建议、
 *    没有冲突仲裁。设计稿 §7.4 自己写着「我们现在只有流水线，没有协商结构」。
 *
 * 赛题(3)② 要的恰恰是「一次可见的协同决策，不是 if-else 阈值分支」。真做出协商之前，
 * 这里只能说到 agent 级。**协商结构做出来之前不要把这行字改回去。**
 */
const ENGINE_LABEL: Record<NonNullable<AdaptiveDecision['engine']>, string> = {
  llm: '模型判定',
  deterministic: '规则判定',
};

export function AdaptiveDecisionBanner({
  decision,
  scorePercent,
  onAct,
  acting,
  error,
  insertedLabel,
  onJump,
}: {
  decision: AdaptiveDecision;
  scorePercent: number;
  onAct?: () => void;
  acting?: boolean;
  /** Why acting on the decision failed. Shown verbatim — never swallow it. */
  error?: string;
  /** Set once a remediation scene actually landed in the classroom. */
  insertedLabel?: string;
  onJump?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const negotiation = decision.negotiation;
  const meta = DECISION_META[decision.decision] ?? DECISION_META.keep_route;
  const Icon = meta.icon;
  const actionable = decision.decision !== 'keep_route';

  return (
    <div
      data-testid="adaptive-decision-banner"
      className={cn('rounded-xl border px-4 py-3 space-y-2', meta.ring)}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn('size-5 shrink-0 mt-0.5', meta.tone)} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">
            反馈决策 Agent：<span className={meta.tone}>{meta.label}</span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {ENGINE_LABEL[decision.engine ?? 'deterministic']} · 正确率 {scorePercent}% · 难度 →{' '}
              {decision.updated_difficulty}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{nextActionText(decision)}</p>
        </div>
        {actionable && onAct && !insertedLabel && (
          <button
            type="button"
            disabled={acting}
            onClick={onAct}
            className={cn(
              'shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition',
              'hover:bg-white/70 dark:hover:bg-white/10 disabled:opacity-50',
            )}
          >
            {acting ? '生成中…' : `执行：${meta.label}`}
          </button>
        )}
      </div>

      {insertedLabel && (
        <p className="text-xs text-green-deep">
          {insertedLabel}
          {onJump && (
            <button
              type="button"
              onClick={onJump}
              className="ml-2 underline underline-offset-2 hover:no-underline"
            >
              跳转过去
            </button>
          )}
        </p>
      )}

      {error && <p className="text-xs text-red-deep">执行失败：{error}</p>}

      {negotiation?.conflict && negotiation.arbitration && (
        <div className="rounded-lg border border-dashed border-border/70 bg-background/40 px-3 py-2 space-y-1.5">
          <p className="text-[11px] font-medium">
            两路信号不一致，已仲裁
            <span className="ml-1.5 font-normal text-muted-foreground">
              {ENGINE_LABEL[negotiation.arbitration.engine]}
            </span>
          </p>
          <ul className="space-y-1 text-[11px] text-muted-foreground">
            {negotiation.proposals.map((p) => (
              <li key={p.source}>
                <span className="text-foreground/80">{p.source}</span>（{p.signal}）主张{' '}
                {decisionLabel(p.decision)} · {p.difficulty}
                <ul className="pl-3 opacity-80">
                  {p.basis.map((b, i) => (
                    <li key={i}>← {b}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="text-[11px]">
            <span className="font-medium">裁决</span>：采信{' '}
            {decisionLabel(negotiation.arbitration.decision)}
            ，推翻 {decisionLabel(negotiation.arbitration.overruled)}
            <span className="block text-muted-foreground">{negotiation.arbitration.rationale}</span>
          </p>
        </div>
      )}

      {decision.because.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition"
          >
            <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
            决策依据（{decision.because.length} 条）
          </button>
          {open && (
            <ul className="mt-1.5 space-y-1 pl-4 text-[11px] text-muted-foreground">
              {decision.because.map((b, i) => (
                <li key={i}>← {b}</li>
              ))}
              <li className="pt-1 opacity-70">{decision.explanation}</li>
              {negotiation?.reference && (
                // 参考信号也要露出来，连同「它为什么不算数」——藏起来下一个人就会拿它当判据
                <li className="pt-1 opacity-70">
                  ← {negotiation.reference.source} {negotiation.reference.rating} →{' '}
                  {negotiation.reference.difficulty}（{negotiation.reference.note}）
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
