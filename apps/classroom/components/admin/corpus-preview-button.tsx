'use client';

/**
 * 「以此库视角预览学习端」——兑现设计方案 §7.1 的承诺。
 *
 * 2026-08-21 审计发现文档承诺了「管理员可在知识库详情页一键切换至该知识库视角，
 * 对学习端内容进行预览」，但这个功能从来没实现过。
 *
 * 行为：点一下设一个 30 分钟的预览 cookie，然后开新标签进学习端首页。
 * `/api/profile` 读到 cookie 就把返回的 `fields.corpus` 覆盖成这个库——首页、
 * 路径卡、课程墙读的都是那个接口，一处覆盖处处生效。
 *
 * **不动真画像**：只写 cookie，账户里那份画像一个字节没改；预览态下
 * `/api/profile` 的写入路径直接 409，防止学习端的自动保存把预览值当成用户的真实选择。
 */
import { useState } from 'react';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { domainLabel } from '@/lib/knowledge/domain-labels';

export function CorpusPreviewButton({ corpus }: { corpus: string }) {
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = async (body: { corpus: string | null }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/preview-corpus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `设置失败（HTTP ${res.status}）`);
        return false;
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const enter = async () => {
    if (!(await call({ corpus }))) return;
    setPreviewing(true);
    // 开新标签，管理端这一页留着好退出预览
    window.open('/', '_blank', 'noopener');
  };

  const exit = async () => {
    if (await call({ corpus: null })) setPreviewing(false);
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={enter}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
        >
          <Eye className="size-3.5" />
          以此库视角预览学习端
          <ExternalLink className="size-3 text-muted-foreground" />
        </button>
        {previewing && (
          <button
            type="button"
            onClick={exit}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            <EyeOff className="size-3.5" />
            退出预览
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {previewing
          ? `预览中：学习端会按「${domainLabel(corpus)}」的视角显示。预览是只读的——这期间学习端不写画像，改画像要先退出。30 分钟后自动失效。`
          : '开新标签进入学习端，按这个库的视角看首页、学习路径与课程墙。只改你自己浏览器里的视角，不动任何人的画像。'}
      </p>
      {error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
