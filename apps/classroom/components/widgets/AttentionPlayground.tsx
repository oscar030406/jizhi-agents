'use client';

import { useMemo, useState } from 'react';
import type { AttentionTemplateParams } from '@/lib/types/widgets';

/** 注意力热区：点选 query token，看它对每个 token 的注意力权重；拖温度滑块看 softmax 锐化。
 * 参数全预制（tokens + 原始相容性分数矩阵），组件只做确定性数学——可审计，无现场生成。 */

function softmax(row: number[], tau: number): number[] {
  const scaled = row.map((x) => x / tau);
  const m = Math.max(...scaled);
  const exps = scaled.map((x) => Math.exp(x - m));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

export default function AttentionPlayground({ params }: { params: AttentionTemplateParams }) {
  const [focus, setFocus] = useState(params.focusDefault ?? 0);
  const [tau, setTau] = useState(1.0);
  const weights = useMemo(
    () => softmax(params.scores[focus] ?? params.scores[0], tau),
    [params.scores, focus, tau],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {params.tokens.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setFocus(i)}
            className={`rounded-md border px-2.5 py-1 font-mono text-sm transition ${
              i === focus
                ? 'border-blue-deep bg-blue-deep/15 font-semibold text-blue-deep'
                : 'border-border hover:bg-muted'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        query = <span className="font-mono font-medium">{params.tokens[focus]}</span>
        ，下方是它对每个 token 的注意力权重（softmax 后，和为 1）：
      </p>
      <div className="space-y-1.5">
        {params.tokens.map((t, j) => (
          <div key={j} className="flex items-center gap-2 text-xs">
            <span className="w-16 shrink-0 truncate text-right font-mono">{t}</span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-black/5 dark:bg-white/10">
              <div
                className="h-full rounded bg-blue-deep/70 transition-all"
                style={{ width: `${(weights[j] * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="w-12 shrink-0 font-mono text-muted-foreground">
              {weights[j].toFixed(3)}
            </span>
          </div>
        ))}
      </div>
      <label className="block text-xs text-muted-foreground">
        温度 τ = {tau.toFixed(1)}（越小分布越尖，注意力越集中）
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.1}
          value={tau}
          onChange={(e) => setTau(Number(e.target.value))}
          className="mt-1 w-full"
        />
      </label>
    </div>
  );
}
