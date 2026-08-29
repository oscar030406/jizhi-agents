'use client';

/**
 * 单库详情页的「实操项目」区：GitHub 实搜起草 → 管理员逐条勾选 → 发布。
 *
 * 与 7.3「模型起草、管理员确认」同一理念的实操侧落地：
 * - 起草是同步长请求（引擎跑 GitHub 搜索 + 两轮模型，实测 1-2 分钟），按钮转圈等；
 * - 事实字段（星数/许可/链接/最近提交）来自 GitHub API 实拉数据，模型只写推荐语——
 *   卡片上把 provenance 摆出来就是让管理员核得动；
 * - 发布语义是「勾选集合整体生效」：没勾的下架，全不勾 = 全部下架。
 */

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface ScoutProject {
  id: string;
  name: string;
  org: string;
  level: 'starter' | 'advanced' | 'portfolio';
  difficulty: number;
  hours: string;
  prereq: string;
  cost: string;
  networkNote: string;
  why: string;
  acceptance: string;
  deliverable: string;
  resumeAdvice: string;
  links: Array<{ label: string; url: string }>;
  approved?: boolean;
  provenance?: { stars?: number; license?: string; pushed_at?: string; matched_keyword?: string };
}

interface ScoutDraft {
  status: 'none' | 'draft' | 'published';
  generated_at?: string;
  model?: string;
  keywords?: string[];
  projects: ScoutProject[];
}

const LEVEL_LABEL: Record<ScoutProject['level'], string> = {
  starter: '第一个项目',
  advanced: '进阶',
  portfolio: '作品级',
};

export function PracticeScoutPanel({ corpus }: { readonly corpus: string }) {
  const [draft, setDraft] = useState<ScoutDraft | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'load' | 'draft' | 'approve' | null>('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const applyDraft = useCallback((doc: ScoutDraft) => {
    setDraft(doc);
    // 已发布的保持勾选；新初稿默认全勾（管理员做减法比做加法省事）
    const ids = doc.projects
      .filter((p) => (doc.status === 'published' ? p.approved : true))
      .map((p) => p.id);
    setChecked(new Set(ids));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(`/api/practice-scout/${corpus}/draft`, { cache: 'no-store' });
        const body = await resp.json();
        if (!alive) return;
        if (resp.ok && body?.draft) applyDraft(body.draft as ScoutDraft);
        else if (!resp.ok) setError(body?.error?.message ?? '读取失败');
      } catch {
        if (alive) setError('读取初稿失败（引擎可能不在线）');
      } finally {
        if (alive) setBusy(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [corpus, applyDraft]);

  const runDraft = async () => {
    setBusy('draft');
    setError('');
    setNotice('');
    try {
      const resp = await fetch(`/api/practice-scout/${corpus}/draft`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await resp.json();
      if (!resp.ok) {
        setError(body?.error?.message ?? `起草失败（HTTP ${resp.status}）`);
      } else {
        applyDraft(body.draft as ScoutDraft);
        setNotice('初稿已生成——逐条核对仓库链接后勾选发布。');
      }
    } catch {
      setError('起草请求中断（网络或引擎超时），可重试。');
    } finally {
      setBusy(null);
    }
  };

  const publish = async () => {
    setBusy('approve');
    setError('');
    setNotice('');
    try {
      const resp = await fetch(`/api/practice-scout/${corpus}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectIds: [...checked] }),
      });
      const body = await resp.json();
      if (!resp.ok) {
        setError(body?.error?.message ?? '发布失败');
      } else {
        applyDraft(body.draft as ScoutDraft);
        setNotice(
          checked.size === 0 ? '已全部下架。' : `已发布 ${checked.size} 个项目，学习端立即可见。`,
        );
      }
    } catch {
      setError('发布请求失败，可重试。');
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-sm font-medium">实操项目</h2>
      <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
        从 GitHub 实时搜索该领域的真实开源项目，由模型分级起草推荐卡（星数、许可、链接均为
        API 实拉数据，模型只写推荐语）。初稿不会自动上线：逐条核对后勾选发布，学习端才展示。
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={runDraft} disabled={busy !== null}>
          {busy === 'draft' ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          {busy === 'draft'
            ? '正在搜索与起草（约 1-2 分钟）…'
            : draft && draft.status !== 'none'
              ? '重新起草'
              : '搜索并起草初稿'}
        </Button>
        {draft && draft.projects.length > 0 && (
          <Button size="sm" className="gap-1.5 text-xs" onClick={publish} disabled={busy !== null}>
            {busy === 'approve' ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            发布勾选的 {checked.size} 项
          </Button>
        )}
        {draft?.status === 'published' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
            已发布 {draft.projects.filter((p) => p.approved).length} 项
          </span>
        )}
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {notice && <p className="mb-3 text-xs text-muted-foreground">{notice}</p>}

      {busy === 'load' ? (
        <p className="text-xs text-muted-foreground">读取中…</p>
      ) : !draft || draft.projects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-xs leading-relaxed text-muted-foreground">
          还没有实操项目初稿。点「搜索并起草初稿」发起：引擎会按领域范围生成搜索词、
          调 GitHub 公开 API 拉真实仓库、由模型筛选分级后回到这里等待审核。
        </p>
      ) : (
        <ul className="space-y-3">
          {draft.projects.map((p) => (
            <li key={p.id} className="rounded-xl border border-border bg-card p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="mt-1 size-4 shrink-0 accent-primary"
                />
                <div className="min-w-0 flex-1 space-y-1.5 text-xs leading-relaxed">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-px text-[10px] font-medium">
                      {LEVEL_LABEL[p.level]}
                    </span>
                    <span className="font-medium text-sm">{p.name}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {'★'.repeat(p.difficulty)}
                      {'☆'.repeat(Math.max(0, 5 - p.difficulty))} · {p.hours}
                    </span>
                  </div>
                  <p>{p.why}</p>
                  <p className="text-muted-foreground">
                    <span className="font-medium">验收：</span>
                    {p.acceptance} · <span className="font-medium">产出：</span>
                    {p.deliverable}
                  </p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
                    <span>{p.org}</span>
                    {p.provenance?.license && <span>许可 {p.provenance.license}</span>}
                    {p.provenance?.pushed_at && <span>最近提交 {p.provenance.pushed_at}</span>}
                    {p.links[0] && (
                      <a
                        href={p.links[0].url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-blue-deep underline underline-offset-2 hover:no-underline"
                      >
                        核对仓库 <ExternalLink className="size-3" />
                      </a>
                    )}
                  </p>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
