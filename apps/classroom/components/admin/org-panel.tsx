'use client';

/**
 * 机构管理面板：建机构 → 邀请码 → 成员名册 → 知识库归属，一页四区。
 *
 * 邀请码是入组的唯一信道（无邮箱/手机号体系），所以给了复制按钮和轮换——
 * 码泄露就轮换，旧码全体作废。成员移出只解除归属关系，不动其账户与学习数据。
 * 知识库归属区列出全部在架库：本机构认领的可释放，公共且无主的可认领，
 * 他机构占用的只读展示——归属即学习端可见性，这里是隔离的开关面板。
 */

import { useCallback, useEffect, useState } from 'react';
import { Building2, Copy, Loader2, RefreshCw, UserMinus } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface OrgInfo {
  id: string;
  name: string;
  role: 'owner' | 'member';
  memberCount: number;
  inviteCode: string | null;
}

interface Member {
  accountId: string;
  username: string;
  displayName: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

interface CorpusRow {
  corpus: string;
  label: string;
  eligible: boolean;
}

export function OrgPanel() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [corpora, setCorpora] = useState<CorpusRow[]>([]);
  const [ownership, setOwnership] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    try {
      const [orgResp, ownResp, domResp] = await Promise.all([
        fetch('/api/org', { cache: 'no-store' }),
        fetch('/api/org/corpora', { cache: 'no-store' }),
        fetch('/api/domains', { cache: 'no-store' }),
      ]);
      const orgBody = await orgResp.json();
      setOrg(orgBody?.org ?? null);
      const ownBody = await ownResp.json();
      setOwnership(ownBody?.ownership ?? {});
      const domBody = await domResp.json();
      const entries = (domBody?.entries ?? {}) as Record<string, { label?: string; eligible?: boolean }>;
      setCorpora(
        Object.entries(entries).map(([corpus, e]) => ({
          corpus,
          label: e.label || corpus,
          eligible: e.eligible !== false,
        })),
      );
      if (orgBody?.org?.role === 'owner') {
        const mResp = await fetch('/api/org/members', { cache: 'no-store' });
        const mBody = await mResp.json();
        setMembers(mBody?.members ?? []);
      }
    } catch {
      setError('读取机构信息失败');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<Response>, okNotice?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const resp = await fn();
      const body = await resp.json();
      if (!resp.ok) setError(body?.error?.message ?? body?.error ?? `操作失败（HTTP ${resp.status}）`);
      else {
        if (okNotice) setNotice(okNotice);
        await reload();
      }
    } catch {
      setError('网络错误，可重试');
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) {
    return <p className="text-sm text-muted-foreground">读取中…</p>;
  }

  if (!org) {
    return (
      <section className="rounded-2xl border border-border bg-card p-6 shadow-card">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Building2 className="size-4" /> 创建机构
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          创建后你将成为机构所有者，获得邀请码；学员凭码加入，你接入的知识库可归属到机构，
          只对本机构学员开放。
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="机构名称（2-40 字）"
            className="h-9 w-64 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <Button
            size="sm"
            disabled={busy || name.trim().length < 2}
            onClick={() =>
              act(
                () =>
                  fetch('/api/org', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'create', name }),
                  }),
                '机构已创建',
              )
            }
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : '创建'}
          </Button>
        </div>
        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </section>
    );
  }

  const mine = (corpus: string) => ownership[corpus] === org.id;
  const unowned = (corpus: string) => !(corpus in ownership);

  return (
    <div className="space-y-8">
      {/* ── 机构与邀请码 ── */}
      <section className="rounded-2xl border border-border bg-card p-6 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="size-4" /> {org.name}
            <span className="rounded-full bg-muted px-2 py-px text-[10px]">
              {org.role === 'owner' ? '所有者' : '成员'} · {org.memberCount} 人
            </span>
          </h2>
        </div>
        {org.role === 'owner' && org.inviteCode && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">学员邀请码</span>
            <code className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 font-mono text-sm tracking-wider">
              {org.inviteCode}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 text-xs"
              onClick={() => {
                void navigator.clipboard?.writeText(org.inviteCode ?? '');
                setNotice('邀请码已复制');
              }}
            >
              <Copy className="size-3.5" /> 复制
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1 text-xs"
              disabled={busy}
              onClick={() =>
                act(
                  () =>
                    fetch('/api/org', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'rotate' }),
                    }),
                  '已换新码，旧码全部失效',
                )
              }
            >
              <RefreshCw className="size-3.5" /> 轮换
            </Button>
            <span className="text-[11px] text-muted-foreground">泄露就轮换：旧码即刻全体作废</span>
          </div>
        )}
      </section>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

      {/* ── 成员名册 ── */}
      {org.role === 'owner' && (
        <section className="rounded-2xl border border-border bg-card p-6 shadow-card">
          <h2 className="text-sm font-medium">成员名册</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            移出只解除机构归属，学员的账户与学习记录不受影响。
          </p>
          <table className="mt-4 w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] text-muted-foreground">
                <th className="pb-2 font-medium">昵称</th>
                <th className="pb-2 font-medium">用户名</th>
                <th className="pb-2 font-medium">角色</th>
                <th className="pb-2 font-medium">加入时间</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.accountId} className="border-t border-border-subtle">
                  <td className="py-2">{m.displayName}</td>
                  <td className="py-2 font-mono text-xs">{m.username}</td>
                  <td className="py-2 text-xs">{m.role === 'owner' ? '所有者' : '学员'}</td>
                  <td className="py-2 text-xs tabular-nums">
                    {new Date(m.joinedAt).toLocaleDateString('zh-CN')}
                  </td>
                  <td className="py-2 text-right">
                    {m.role !== 'owner' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1 text-xs"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              fetch(`/api/org/members?accountId=${encodeURIComponent(m.accountId)}`, {
                                method: 'DELETE',
                              }),
                            `已移出 ${m.displayName}`,
                          )
                        }
                      >
                        <UserMinus className="size-3.5" /> 移出
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {members.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-xs text-muted-foreground">
                    还没有成员——把上方邀请码发给学员，登录后在首页画像区输入即可加入。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      {/* ── 知识库归属 ── */}
      {org.role === 'owner' && (
        <section className="rounded-2xl border border-border bg-card p-6 shadow-card">
          <h2 className="text-sm font-medium">知识库归属</h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            归属到本机构 = 只有本机构学员可见；公共 = 所有学习者可见。他机构的库不可操作。
          </p>
          <ul className="mt-4 space-y-2">
            {corpora.map((c) => {
              const owner = ownership[c.corpus];
              const state = mine(c.corpus) ? 'mine' : unowned(c.corpus) ? 'public' : 'other';
              return (
                <li
                  key={c.corpus}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className="text-sm font-medium">{c.label}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted-foreground">{c.corpus}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-muted px-2 py-px text-[10px]">
                      {state === 'mine' ? '本机构' : state === 'public' ? '公共' : '其他机构'}
                    </span>
                    {state === 'mine' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              fetch('/api/org/corpora', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ corpus: c.corpus, action: 'release' }),
                              }),
                            `「${c.label}」已释放为公共库`,
                          )
                        }
                      >
                        释放为公共
                      </Button>
                    )}
                    {state === 'public' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              fetch('/api/org/corpora', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ corpus: c.corpus, action: 'claim' }),
                              }),
                            `「${c.label}」已归属本机构`,
                          )
                        }
                      >
                        归属本机构
                      </Button>
                    )}
                    {state === 'other' && <span className="text-[11px] text-muted-foreground">{owner}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
