'use client';

import { useMemo, useState } from 'react';
import type { RagTemplateParams } from '@/lib/types/widgets';

/** RAG 检索沙盘：改 query 看召回排序实时变化。语料块预制可审计；
 * 打分是透明的字符二元组重叠（Dice 系数）——公式就写在界面上，学生能手算验证。 */

function bigrams(s: string): Set<string> {
  // 大小写归一：用户实测输入小写「rag是什么」对上语料里的大写「RAG」全部
  // miss、整版 score 0.000，只有预设按钮（恰好大写）有效（2026-08-10 实拍）。
  const clean = s.toLowerCase().replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < clean.length - 1; i += 1) grams.add(clean.slice(i, i + 2));
  return grams;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach((g) => {
    if (b.has(g)) hit += 1;
  });
  return (2 * hit) / (a.size + b.size);
}

export default function RagRetrievalPlayground({ params }: { params: RagTemplateParams }) {
  const [query, setQuery] = useState(params.suggestedQueries[0] ?? '');
  const ranked = useMemo(() => {
    const q = bigrams(query);
    return params.chunks
      .map((c) => ({ ...c, score: dice(q, bigrams(c.title + c.text)) }))
      .sort((a, b) => b.score - a.score);
  }, [params.chunks, query]);
  const top = ranked.filter((c) => c.score > 0).slice(0, 2);

  return (
    <div className="space-y-4">
      <div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入问题，看哪些知识块被召回…"
          className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {params.suggestedQueries.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuery(q)}
              className="rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground transition hover:bg-muted"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
      <ul className="space-y-1.5">
        {ranked.map((c, rank) => (
          <li
            key={c.id}
            className={`rounded-lg border px-3 py-2 text-xs transition ${
              top.some((t) => t.id === c.id)
                ? 'border-green-deep/50 bg-green-soft/60'
                : 'border-border opacity-70'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">
                #{rank + 1} {c.title}
                <span className="ml-1 font-mono text-muted-foreground/70">[{c.id}]</span>
              </span>
              <span className="font-mono text-muted-foreground">score {c.score.toFixed(3)}</span>
            </div>
            <p className="mt-1 line-clamp-2 text-muted-foreground">{c.text}</p>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground/70">
        绿色 = 进入上下文的 top-2 召回。打分公式：query 与知识块的字符二元组 Dice 重叠
        2·|A∩B|/(|A|+|B|)——真实系统换成向量相似度，机制同构：换 query、召回变、答案的证据就变。
      </p>
    </div>
  );
}
