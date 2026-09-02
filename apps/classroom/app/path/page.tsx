import type { Metadata } from 'next';

import { DomainLearningPath } from '@/components/path/domain-learning-path';
import { SiteHeader } from '@/components/site-header';

export const metadata: Metadata = { title: '学习路径 · 集智' };
export const dynamic = 'force-dynamic';

export default function PathPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader localized={false} maxWidth="max-w-5xl" />
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-6 sm:px-6">
        <DomainLearningPath />
      </main>
    </div>
  );
}
