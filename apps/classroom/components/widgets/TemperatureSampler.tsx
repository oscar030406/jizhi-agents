'use client';

import { useMemo, useState } from 'react';
import type { TemperatureTemplateParams } from '@/lib/types/widgets';

/** 温度采样器：拖温度看下一个词的概率分布变形，点采样按分布抽词。
 * 候选词与 logit 全预制可审计；组件只做 softmax 与抽样。 */

function softmax(logits: number[], tau: number): number[] {
  const scaled = logits.map((x) => x / tau);
  const m = Math.max(...scaled);
  const exps = scaled.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export default function TemperatureSampler({ params }: { params: TemperatureTemplateParams }) {
  const [tau, setTau] = useState(1.0);
  const [samples, setSamples] = useState<string[]>([]);
  const probs = useMemo(
    () => softmax(params.candidates.map((c) => c.logit), tau),
    [params.candidates, tau],
  );

  const sample = () => {
    let r = Math.random();
    let picked = params.candidates[params.candidates.length - 1].token;
    for (let i = 0; i < probs.length; i += 1) {
      if (r < probs[i]) {
        picked = params.candidates[i].token;
        break;
      }
      r -= probs[i];
    }
    setSamples((s) => [...s.slice(-11), picked]);
  };

  return (
    <div className="space-y-4">
      <p className="text-sm">
        上文：<span className="font-medium">{params.context}</span>
        <span className="text-muted-foreground/70">＿＿</span>
      </p>
      <div className="space-y-1.5">
        {params.candidates.map((c, i) => (
          <div key={c.token} className="flex items-center gap-2 text-xs">
            <span className="w-14 shrink-0 truncate text-right font-mono">{c.token}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-black/5 dark:bg-white/10">
              <div
                className="h-full rounded bg-green-deep/60 transition-all"
                style={{ width: `${(probs[i] * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="w-14 shrink-0 font-mono text-muted-foreground">
              {(probs[i] * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="min-w-48 flex-1 text-xs text-muted-foreground">
          温度 τ = {tau.toFixed(1)}（低温保守，高温放飞）
          <input
            type="range"
            min={0.1}
            max={2}
            step={0.1}
            value={tau}
            onChange={(e) => setTau(Number(e.target.value))}
            className="mt-1 w-full"
          />
        </label>
        <button
          type="button"
          onClick={sample}
          className="rounded-md border border-green-deep/40 bg-green-soft px-3 py-1.5 text-sm transition hover:brightness-95"
        >
          按分布采样一次
        </button>
      </div>
      {samples.length > 0 && (
        <p className="text-xs text-muted-foreground">
          采样记录：
          {samples.map((s, i) => (
            <span
              key={i}
              className="ml-1 rounded bg-black/5 px-1.5 py-0.5 font-mono dark:bg-white/10"
            >
              {s}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
