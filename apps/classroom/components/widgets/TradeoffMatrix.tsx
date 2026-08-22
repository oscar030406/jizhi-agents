'use client';

import { useMemo, useState } from 'react';
import type { TradeoffMatrixParams } from '@/lib/types/widgets';

/** 取舍矩阵：勾掉自己不在意的维度，选项按剩下维度的平均分实时重排。
 * 打分公式写在界面上（选中维度 rating 的平均），学生能手算复核——
 * 教的是「没有最优解，只有你在意什么」，不是让组件替他选。 */

export default function TradeoffMatrix({ params }: { params: TradeoffMatrixParams }) {
  const [on, setOn] = useState<boolean[]>(() => params.dimensions.map(() => true));
  const activeCount = on.filter(Boolean).length;

  const ranked = useMemo(() => {
    const scored = params.options.map((o) => {
      const picked = o.cells.filter((_, d) => on[d]);
      const score = picked.length
        ? picked.reduce((s, c) => s + c.rating, 0) / picked.length
        : 0;
      return { ...o, score };
    });
    // 一个维度都没勾时不排序，保留原顺序——排一个全 0 的榜是误导
    return activeCount ? [...scored].sort((a, b) => b.score - a.score) : scored;
  }, [params.options, on, activeCount]);

  const best = activeCount ? ranked[0].score : -1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">我在意：</span>
        {params.dimensions.map((d, i) => (
          <button
            key={d}
            type="button"
            aria-pressed={on[i]}
            onClick={() => setOn((s) => s.map((v, j) => (j === i ? !v : v)))}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
              on[i]
                ? 'border-blue-deep bg-blue-deep/10 text-blue-deep'
                : 'border-border text-muted-foreground/60 line-through'
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-xs">
          <thead>
            <tr>
              <th className="border-b border-border px-2 py-1.5 text-left font-medium">方案</th>
              {params.dimensions.map((d, i) => (
                <th
                  key={d}
                  className={`border-b border-border px-2 py-1.5 text-left font-medium ${
                    on[i] ? '' : 'text-muted-foreground/40'
                  }`}
                >
                  {d}
                </th>
              ))}
              <th className="border-b border-border px-2 py-1.5 text-right font-medium">得分</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((o) => (
              <tr
                key={o.name}
                className={
                  activeCount && o.score === best ? 'bg-green-soft/60' : undefined
                }
              >
                <td className="border-b border-border px-2 py-1.5 font-medium">{o.name}</td>
                {o.cells.map((c, i) => (
                  <td
                    key={i}
                    className={`border-b border-border px-2 py-1.5 align-top ${
                      on[i] ? 'text-muted-foreground' : 'text-muted-foreground/35'
                    }`}
                  >
                    <span className="mr-1 font-mono">{'●'.repeat(c.rating)}</span>
                    {c.text}
                  </td>
                ))}
                <td className="border-b border-border px-2 py-1.5 text-right font-mono">
                  {activeCount ? o.score.toFixed(2) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        {activeCount
          ? '得分 = 勾选维度的评分平均（●越多这一维越好），绿色 = 当前口味下的最优解。取消一个维度再看排名怎么翻。'
          : '一个维度都没勾——没有偏好就没有最优解，先勾一个你在意的。'}
      </p>
    </div>
  );
}
