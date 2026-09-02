'use client';

/**
 * 管理端单课页的「复核放行 / 撤回」控件。只在门禁把课挡成草稿时出现；
 * 放行后显示谁在何时放的，撤回让课程回到门禁判定。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ManualReleaseControl({
  courseId,
  eligible,
  protocol,
  reasons,
  manualRelease,
}: {
  courseId: string;
  eligible: boolean;
  protocol: string;
  reasons: string[];
  manualRelease: { by: string; at: string; note?: string } | null;
}) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: 'POST' | 'DELETE') {
    setBusy(true);
    setError(null);
    try {
      const res =
        method === 'POST'
          ? await fetch('/api/classroom/release', {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: courseId, note }),
            })
          : await fetch(`/api/classroom/release?id=${encodeURIComponent(courseId)}`, { method });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (manualRelease) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm">
        <p className="font-medium">人工复核放行</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {manualRelease.at.slice(0, 19).replace('T', ' ')} · 操作者 {manualRelease.by}
          {manualRelease.note ? ` · ${manualRelease.note}` : ''}
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => call('DELETE')}
          className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          撤回放行，回到门禁判定
        </button>
        {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
      </div>
    );
  }

  if (eligible) {
    return (
      <p className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
        已通过发布门（{protocol === 'scene-audit-legacy' ? '屏级审核协议' : '教学履约门禁'}），学习者可见。
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-amber-300/60 bg-amber-50/40 p-4 text-sm dark:bg-amber-900/10">
      <p className="font-medium">发布门当前拦截，课程以草稿保存</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        {reasons.slice(0, 8).map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <label className="mt-3 block text-xs text-muted-foreground">
        复核备注（可选）
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          placeholder="例如：判词已逐条核对，术语差异不影响教学"
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => call('POST')}
        className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
      >
        复核后放行给学习者
      </button>
      {error && <p className="mt-2 text-xs text-rose-700">{error}</p>}
    </div>
  );
}
