'use client';

/**
 * /path 页非 AI 域的注记，由 components/path/domain-learning-path.tsx 挂。
 *
 * 域级路径上线前这里说的是「本页只覆盖 AI 领域，回首页看该领域课程」——那句话现在不
 * 成立了：非 AI 域看到的就是自己域的路径。改说两条路径的区别，口径直接用引擎返回的
 * caliber 原文，不在前端另写一份说法（写第二份，迟早和引擎对不上）。
 *
 * corpus 由挂载方传入而不是自己再读一遍画像：挂载方走到这一步时已经判过域，
 * 自己读第二遍除了多一次 localStorage 往返，还会多一帧「注记比路径晚一拍出现」。
 *
 * 所有库都显示引擎根据本域索引与前置图生成的路径。
 */
import { Info } from 'lucide-react';
import { domainLabel } from '@/lib/knowledge/domain-labels';

export function DomainPathNotice({ corpus, caliber }: { corpus: string; caliber?: string }) {
  if (!corpus) return null;

  return (
    <div
      role="note"
      className="mb-6 mt-4 flex w-full items-start gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground"
    >
      <Info className="mt-0.5 size-4 shrink-0" />
      <span>
        这条路径由机器排出：概念与前置关系取自「{domainLabel(corpus)}」接入时跑的流水线，
        {caliber ? `口径：${caliber}。` : '边未经人工复核，只作推荐，不拦人。'}
      </span>
    </div>
  );
}
