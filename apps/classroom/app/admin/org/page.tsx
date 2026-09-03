/**
 * 管理端 · 机构管理页（面向企业供给能力的账户层，2026-08-30）。
 *
 * 覆盖 owner 的四件事：建机构、发邀请码（含轮换）、看/移出成员、知识库归属。
 * 服务端只做角色闸（manager 才进），数据全走 /api/org* 客户端拉取——
 * 与 admin/knowledge 的「服务端读盘」不同，这页的数据源全在账户存储，
 * 走 API 让 file/pg 双后端行为一致。
 */

import { SiteHeader } from '@/components/site-header';
import { OrgPanel } from '@/components/admin/org-panel';

import { Denied, managerAccount } from '../knowledge/guard';

export const dynamic = 'force-dynamic';

export default async function OrgAdminPage() {
  if (!(await managerAccount())) return <Denied />;
  return (
    <>
      <SiteHeader backHref="/admin" backLabel="返回管理端" maxWidth="max-w-4xl" />
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <header className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">机构管理</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            多机构隔离：每位管理者一个机构，学员凭邀请码加入；归属到机构的知识库只对本机构学员可见，
            公共库对所有人开放。学员的课程与学情数据按账户隔离，机构层只管「谁能看到哪些库」与成员名册。
          </p>
        </header>
        <OrgPanel />
      </main>
    </>
  );
}
