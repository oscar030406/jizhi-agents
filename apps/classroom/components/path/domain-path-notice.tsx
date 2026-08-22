'use client';

/**
 * 域范围注记条（域工作区）：画像选了非 AI 知识库时，在「AI 域专属」页面顶部
 * 说明当前域与该页数据的覆盖关系，并给出去处。AI 库/未选库时不渲染任何东西。
 *
 * 为什么需要它：学习路径、岗位技能图谱、实操项目都是 AI 领域的教研产物。
 * 画像切库之后这些页的数据不会（也不应假装）跟着变——不加说明，学习者会以为
 * 换库没生效（被抓过的线上问题）。server/client 页面都可挂：本组件自己读画像。
 *
 * scope 文案由挂载页传入，保证「页面叫什么，注记就说什么」，不出现两套称呼。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { domainLabel } from '@/lib/knowledge/domain-labels';

export function DomainScopeNotice({
  scope,
  className,
}: {
  /** 本页数据的名称，如「学习路径」「岗位技能图谱与实操项目」 */
  scope: string;
  className?: string;
}) {
  const [corpus, setCorpus] = useState<string>('');
  useEffect(() => {
    setCorpus(loadLearnerProfile().corpus?.trim() ?? '');
  }, []);

  if (!corpus || corpus === 'ai') return null;

  return (
    <div
      role="note"
      className={
        className ??
        'mx-auto mb-6 flex w-full max-w-5xl items-start gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground'
      }
    >
      <Info className="mt-0.5 size-4 shrink-0" />
      <span>
        本页{scope}覆盖人工智能应用开发领域。你的画像当前选择的知识库是
        「{domainLabel(corpus)}」——该领域按课程逐门学习，
        <Link href="/" className="mx-1 text-foreground underline underline-offset-2">
          回首页查看该领域课程
        </Link>
        ，或在画像里把知识库换回「跟随培训领域」。
      </span>
    </div>
  );
}

/** /path 页的既有挂载点，保持原名导出（挂载处不用改）。 */
export function DomainPathNotice() {
  return <DomainScopeNotice scope="学习路径" />;
}
