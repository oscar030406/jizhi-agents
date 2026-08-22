'use client';

import { useState } from 'react';
import type { ProcessStepperParams } from '@/lib/types/widgets';

/** 步进流程：点步骤或按「下一步」走完一条管线，看每步做什么、往下传什么。
 * 与 bpe_merge_stepper 的分工：那个走的是 token 序列的合并状态，这个走的是
 * 有名字、有说明、有中间产物的流程步骤，主题无关。 */

export default function ProcessStepper({ params }: { params: ProcessStepperParams }) {
  const [i, setI] = useState(0);
  const last = params.steps.length - 1;
  const step = params.steps[i];

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap items-center gap-1">
        {params.steps.map((s, idx) => (
          <li key={idx} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setI(idx)}
              aria-current={idx === i ? 'step' : undefined}
              className={`rounded-md border px-2.5 py-1 text-xs transition ${
                idx === i
                  ? 'border-blue-deep bg-blue-deep/15 font-semibold text-blue-deep'
                  : idx < i
                    ? 'border-border bg-muted text-muted-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {idx + 1}. {s.title}
            </button>
            {idx < last && <span className="text-xs text-muted-foreground/50">→</span>}
          </li>
        ))}
      </ol>

      <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
        <p className="text-sm font-medium">
          第 {i + 1}/{params.steps.length} 步：{step.title}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.detail}</p>
        {step.carries && (
          <p className="mt-2 border-t border-border pt-2 font-mono text-[11px] text-green-deep">
            ↓ 交给下一步：{step.carries}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={i === 0}
          onClick={() => setI((n) => Math.max(0, n - 1))}
          className="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-40"
        >
          ← 上一步
        </button>
        <button
          type="button"
          disabled={i === last}
          onClick={() => setI((n) => Math.min(last, n + 1))}
          className="rounded-md border border-blue-deep/40 bg-blue-deep/10 px-3 py-1.5 text-sm text-blue-deep transition hover:brightness-95 disabled:opacity-40"
        >
          下一步 →
        </button>
        <button
          type="button"
          onClick={() => setI(0)}
          className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
        >
          回到第 1 步
        </button>
      </div>
    </div>
  );
}
