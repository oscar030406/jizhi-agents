'use client';

import { useState } from 'react';
import type { BpeTemplateParams } from '@/lib/types/widgets';

/** BPE 合并步进器：一步一步看词表怎么把字符合并成子词。步骤全预制可审计。 */

export default function BpeMergeStepper({ params }: { params: BpeTemplateParams }) {
  const [step, setStep] = useState(0);
  const last = params.steps.length - 1;
  const tokens = params.steps[step] ?? [];

  return (
    <div className="space-y-4">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5">
        {tokens.map((t, i) => (
          <span
            key={`${step}-${i}`}
            className="rounded-md border border-blue-deep/40 bg-blue-deep/10 px-2.5 py-1 font-mono text-sm"
          >
            {t}
          </span>
        ))}
      </div>
      <p className="min-h-8 text-xs text-muted-foreground">
        第 {step + 1}/{params.steps.length} 步：{params.captions[step] ?? ''}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          className="rounded-md border border-border px-3 py-1.5 text-sm transition hover:bg-muted disabled:opacity-40"
        >
          ← 上一步
        </button>
        <button
          type="button"
          disabled={step === last}
          onClick={() => setStep((s) => Math.min(last, s + 1))}
          className="rounded-md border border-blue-deep/40 bg-blue-deep/10 px-3 py-1.5 text-sm text-blue-deep transition hover:brightness-95 disabled:opacity-40"
        >
          合并一次 →
        </button>
        <button
          type="button"
          onClick={() => setStep(0)}
          className="ml-auto rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted"
        >
          重置
        </button>
      </div>
    </div>
  );
}
