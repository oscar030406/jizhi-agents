'use client';

/**
 * 数据与隐私说明 (/privacy)
 *
 * 不是通用隐私政策模板——每一条都来自对本仓库的实际核查：
 * localStorage/IndexedDB 的键由 grep 逐个确认，出本机的请求体由
 * lib/generation/learner-profile.ts、evidence-grounding.ts 与 app/api/** 读出，
 * 服务端 key 是否回传前端由 lib/server/provider-config.ts:getServerProviders 核实。
 * 核查结论同步在 docs/05-evidence/openmaic_compliance.md。
 *
 * 页面上的"清除本机学习数据"按钮是真删：删完把实际删掉的键名与 IndexedDB 结果
 * 如实报出来，删不掉（被其他标签页占用）也如实说。
 *
 * 2026-08-15：原第六（培训机构接入指引）、第七（脱敏工具实时演示）、第八（已知风险）
 * 三节移出本页，内容整份保留在 docs/05-evidence/privacy-onboarding-and-risks-20260815.md。
 * 学习者要看的是自己的数据去哪了，接入方的操作清单和我们的风险台账不该占这个页面。
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Database,
  Download,
  Eraser,
  FileText,
  Loader2,
  Network,
  ShieldCheck,
  Trash2,
  UserCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SiteHeader } from '@/components/site-header';
import { cn } from '@/lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// 事实核查结果：本机存了什么
// ─────────────────────────────────────────────────────────────────────────────

interface DataRow {
  item: string;
  content: string;
  where: string;
  keep: string;
  leaves: string;
  requiresLearningStore?: boolean;
  browserOnlyWithoutLearningStore?: boolean;
}

/**
 * 账户系统上线后新增的数据项（2026-08-04）。
 *
 * 这页的可信度全靠"写的和跑的一致"——账户与服务端持久化上线那天，
 * 页面若还写着"没有账号体系""未开启服务端持久化"，就是当场自证不可信。
 * 所以这些行按运行时实际配置动态拼接，不是写死的文案。
 */
const ACCOUNT_DATA: DataRow[] = [
  {
    item: '账户凭据',
    content:
      '用户名 + 密码（密码经 scrypt 加盐哈希后存储，服务端也读不到明文）；不收集手机号、邮箱、真实姓名',
    where: '平台账户库',
    keep: '账户存在期间；可在本页删除',
    leaves: '否（只在本服务与数据库之间）',
  },
  {
    item: '登录会话',
    content: '随机会话 token（httpOnly cookie，浏览器脚本读不到）',
    where: '平台会话库 + 浏览器安全 Cookie',
    keep: '30 天后失效，并在下一次账户请求时清理；退出或删户立即失效',
    leaves: '否',
  },
  {
    item: '账户学习档案',
    content: '领域、学习目标、背景与能力档位；支持同一账户的多份学习档案',
    where: '平台学习档案 + 当前浏览器工作副本',
    keep: '账户存在期间；可随时修改或随账户删除',
    leaves: '派生后的教学指令随生成请求发往模型服务商',
  },
  {
    item: '账户名下的课程与学习记录',
    content: '你生成的课程、场景、答题与运行记录，按账户分区存储',
    where: '平台课程与学习记录库',
    keep: '课程或账户存在期间；删课或删户时清理',
    leaves: '否（生成过程中的模型调用另见第三节）',
    requiresLearningStore: true,
  },
];

const LOCAL_DATA: DataRow[] = [
  {
    item: '学习者画像',
    content: '领域 / 学历档 / 角色自述 / 能力档位 / 学习偏好 / 时间预算的浏览器工作副本',
    where: '当前浏览器',
    keep: '无自动过期，直到手动清除；删户后浏览器副本仍需单独清除',
    leaves: '派生指令随生成请求发往模型服务商',
  },
  {
    item: '匿名学习者标识',
    content: 'anon:<随机 UUID>，仅用于把当前浏览器的答题记录分区，不与任何账号绑定',
    where: '当前浏览器',
    keep: '无过期，直到手动清除',
    leaves: '否；未登录标识不发送到平台服务端',
  },
  {
    item: '答题记录',
    content: '每题作答、判分结果、尝试 id、场景运行事件',
    where: '当前浏览器的学习记录库',
    keep: '无过期，直到手动清除',
    leaves: '仅正确率数值发往平台多智能体引擎做反馈决策',
    browserOnlyWithoutLearningStore: true,
  },
  {
    item: '课堂进度与运行标记',
    content: '当前场景指针、播放游标、PBL 事件水位线、文档迁移标记与存储代次计数',
    where: '当前浏览器',
    keep: '无过期，直到手动清除',
    leaves: '否',
  },
  {
    item: '课程内容',
    content: '生成的大纲、场景、动作脚本、审核指纹',
    where: '当前浏览器的课程库',
    keep: '无过期，在课堂列表中逐门删除',
    leaves: '否（生成过程本身经过模型服务商）',
    browserOnlyWithoutLearningStore: true,
  },
  {
    item: '输入框草稿',
    content: '首页需求输入、PBL 对话输入的未提交文本（学习者手输内容原文）',
    where: '当前浏览器',
    keep: '提交后清除，未提交则常驻',
    leaves: '提交时作为提示词发往模型服务商',
  },
  {
    item: '平台模型连接信息',
    content:
      '平台下发的可用模型与端点；平台不会向浏览器下发服务端密钥，当前学习界面也不要求学习者填写密钥',
    where: '当前浏览器',
    keep: '无过期，清除浏览器站点数据即可清掉',
    leaves: '调用时随请求发往本应用服务端，再转发给对应服务商',
  },
  {
    item: '界面偏好',
    content: '主题、最近课堂展开状态等',
    where: '当前浏览器',
    keep: '无过期',
    leaves: '否',
  },
  {
    item: '编辑锁 / 会话指针',
    content: '多标签页编辑互斥标记、Agent 会话 id',
    where: '当前浏览器',
    keep: '无过期',
    leaves: '否',
  },
];

/** 「清除本机学习数据」的作用域：只清学习相关键，不动 API Key 与界面偏好。 */
const CLEAR_EXACT_KEYS = [
  'learnerProfile',
  'maic:device:runtime.learnerKey',
  'maic-agent-threads',
  'maic-agent-active-session',
  'requirementDraft',
  'pblChatDraft',
];

const CLEAR_PREFIXES = [
  'quizDraft:',
  'quizAnswers:',
  'quizResults:',
  'quizAttemptId:',
  // device 域是 BrowserKVStore 的机器本地命名空间，实际内容是学习者标识、课堂进度
  // 指针、播放游标、PBL 水位线与迁移标记（含 document-storage-generation）——
  // 都是学习数据，不是界面偏好（theme/locale 等是独立的顶层键，不在这里）。
  'maic:device:',
  // 刻意不清 'maic:account:'：本部署无任何代码写入 account 域（未接 kvPersistStorage，
  // 所有 kv 调用都显式传 'device'）。按 @openmaic/storage 的约定，account 域将来承载
  // 服务商/模型配置与画像——把它一起删会违背本页「不动 API Key 与模型设置」的承诺。
  'maic-editor:edit-lock:',
];

const RUNTIME_DB_NAME = 'maic-runtime';

type DbOutcome = 'deleted' | 'blocked' | 'error' | 'unavailable';

interface ClearResult {
  keys: string[];
  localStorage: 'cleared' | 'unavailable';
  db: DbOutcome;
}

function collectKeys(): string[] {
  const hits = new Set<string>();
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    if (CLEAR_EXACT_KEYS.includes(key) || CLEAR_PREFIXES.some((p) => key.startsWith(p))) {
      hits.add(key);
    }
  }
  return [...hits].sort();
}

function deleteRuntimeDb(): Promise<DbOutcome> {
  if (typeof indexedDB === 'undefined') return Promise.resolve('unavailable');
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(RUNTIME_DB_NAME);
    } catch {
      resolve('error');
      return;
    }
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => resolve('error');
    // 其他标签页仍持有连接时不会删除——如实报告，不假装成功。
    req.onblocked = () => resolve('blocked');
  });
}

const DB_MESSAGE: Record<DbOutcome, string> = {
  deleted: '当前浏览器的答题与运行记录已删除。',
  blocked: '答题与运行记录未能删除：本课堂仍被其他标签页占用。关闭其他标签页后再点一次。',
  error: '答题与运行记录删除失败（浏览器拒绝了请求）。',
  unavailable: '当前浏览器不提供 IndexedDB，无运行记录可清。',
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 可见的键盘焦点圈（WCAG 2.4.7）。全局 `* { outline-ring/50 }` 实测只画出 0.56px、
 * alpha 0.2 的蓝，与底色 1.6–1.8:1，达不到 1.4.11 的 3:1。`--ring` 自带 0.4 alpha
 * 压不上去，这里改用不透明的 `--primary`：实测亮色 6.94:1、暗色 3.57:1。
 */
const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary';

/** 正文里的行内链接：blue-deep 亮色 5.68:1、暗色 7.64:1，都过 4.5:1。 */
const INLINE_LINK = `rounded-sm text-blue-deep underline underline-offset-4 ${FOCUS_RING}`;

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Icon className="size-4 shrink-0 text-blue-deep" />
          {title}
        </CardTitle>
        {description ? (
          <CardDescription className="leading-relaxed">{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

export default function PrivacyPage() {
  const [clearing, setClearing] = useState(false);
  const [result, setResult] = useState<ClearResult | null>(null);
  const [currentAccount, setCurrentAccount] = useState<{ username: string } | null | undefined>(
    undefined,
  );
  const [serverLearningData, setServerLearningData] = useState<boolean | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [accountMessage, setAccountMessage] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/auth', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as {
          account?: { username?: unknown } | null;
          capabilities?: { serverLearningData?: unknown };
        };
      })
      .then((data) => {
        setServerLearningData(data.capabilities?.serverLearningData === true);
        setCurrentAccount(
          data.account && typeof data.account.username === 'string'
            ? { username: data.account.username }
            : null,
        );
      })
      .catch((error) => {
        setCurrentAccount(undefined);
        setServerLearningData(undefined);
        setAuthError(`账户状态读取失败：${error instanceof Error ? error.message : String(error)}`);
      });
  }, []);
  const persistenceOn = serverLearningData === true;
  const dataRows = [...ACCOUNT_DATA, ...LOCAL_DATA].filter(
    (row) =>
      (!row.requiresLearningStore || persistenceOn) &&
      (!row.browserOnlyWithoutLearningStore || serverLearningData === false),
  );

  const handleClear = async () => {
    setClearing(true);
    setResult(null);
    let keys: string[] = [];
    let localStorage: ClearResult['localStorage'] = 'cleared';
    try {
      keys = collectKeys();
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      keys = [];
      localStorage = 'unavailable';
    }
    const db = await deleteRuntimeDb();
    setResult({ keys, localStorage, db });
    setClearing(false);
  };

  const handleDeleteAccount = async () => {
    setDeletingAccount(true);
    setAccountMessage(null);
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: deletePassword }),
      });
      const payload = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`,
        );
      }
      setDeletePassword('');
      setCurrentAccount(null);
      setAccountMessage({
        kind: 'success',
        text: persistenceOn
          ? '账户、全部登录会话以及平台保存的名下课程和学习记录已删除。本浏览器数据可继续用下方按钮清除。'
          : '账户与全部登录会话已删除。本浏览器中的课程和学习记录可继续用下方按钮清除。',
      });
    } catch (error) {
      setAccountMessage({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeletingAccount(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* 共享极简顶栏：返回 + 主题（components/site-header.tsx） */}
      <SiteHeader localized={false} maxWidth="max-w-4xl" />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        {/* 页头 */}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">数据与隐私</h1>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            本页内容来自对本系统代码的逐项核查。
          </p>
        </div>

        {/* 诚实声明 */}
        <div className="rounded-xl border border-green-deep/20 bg-green-soft p-4">
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-green-deep" />
            <div className="space-y-1 text-sm leading-relaxed text-green-deep">
              <p className="font-medium">平台不要求提交真实身份资料。</p>
              <p>
                注册只需要用户名与密码（密码经加盐哈希存储），不要求姓名、学号、手机号、邮箱或身份证。
                学习目标和角色自述是自由文本，请不要主动填写与学习无关的身份信息。本页描述的是平台当前实际处理的数据。
              </p>
            </div>
          </div>
        </div>

        {authError ? (
          <div className="rounded-md border border-red-deep/20 bg-red-soft p-3 text-sm text-red-deep">
            {authError}
          </div>
        ) : null}

        {/* 1. 数据清单 */}
        <Section
          icon={Database}
          title="一、收集了什么、存在哪、留多久"
          description={
            serverLearningData === undefined
              ? '平台正在确认当前账户、课程与学习记录的保存范围。'
              : persistenceOn
                ? '登录后，课程与学习记录由平台按账户保存；未登录时数据只留在当前浏览器。'
                : '平台保存账户与学习档案；课程和答题运行记录只留在当前浏览器，换浏览器或清除站点数据后不会保留。'
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">数据项</th>
                  <th className="py-2 pr-3 font-medium">内容</th>
                  <th className="py-2 pr-3 font-medium">存在哪</th>
                  <th className="py-2 pr-3 font-medium">保留多久</th>
                  <th className="py-2 font-medium">是否发给外部</th>
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row) => (
                  <tr key={row.item} className="border-b border-border-subtle align-top">
                    <td className="py-2 pr-3 font-medium whitespace-nowrap">{row.item}</td>
                    <td className="py-2 pr-3 leading-relaxed">{row.content}</td>
                    <td className="py-2 pr-3 font-mono break-all text-muted-foreground">
                      {row.where}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">{row.keep}</td>
                    <td className="py-2">{row.leaves}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            平台运行日志只记录场景标题、生成计数、审核裁决理由与错误类型，不记录画像字段或输入原文。
          </p>
        </Section>

        {/* 2. 离开浏览器的数据 */}
        <Section
          icon={Network}
          title="二、哪些数据会离开当前浏览器、发给谁"
          description="只发送完成教学所需的内容，不发送账户密码或服务端密钥。"
        >
          <ol className="space-y-3 list-decimal list-inside">
            <li>
              <span className="font-medium text-foreground">大模型服务</span>
              （由平台统一管理；平台不会向浏览器下发服务端密钥，当前学习界面也不要求学习者填写密钥）：收到的是
              <em className="not-italic font-mono text-xs"> 你输入的学习需求文本 </em>、
              由画像换算出的
              <em className="not-italic font-mono text-xs"> 讲法指令段 </em>
              （难度档、支架深度、类比领域、代码/图示配额）、
              <em className="not-italic font-mono text-xs"> 受控知识库的证据块 </em>
              以及生成/审核提示词。画像以「档位数字 + 角色描述」形态进入提示词， 例如「本科 ·
              后端开发转 Agent 应用 · 推荐难度 L3」，不含任何身份标识。
            </li>
            <li>
              <span className="font-medium text-foreground">平台多智能体引擎</span>
              ：由课堂服务在平台内部调用。学情诊断只接收学习目标、背景与能力档位；证据检索只接收检索词和当前知识库；
              反馈决策只接收答题结果与当前难度。引擎按白名单过滤输入，处理完成后不保存请求正文。
            </li>
            <li>
              <span className="font-medium text-foreground">无第三方统计</span>
              ：依赖清单中没有任何埋点/分析 SDK（无 Sentry、无 GA、无 PostHog）。
            </li>
          </ol>
        </Section>

        {/* 3. 画像的最小化设计 */}
        <Section
          icon={UserCog}
          title="三、学习档案如何减少身份信息"
          description="教学只使用领域、目标、背景与能力档位；注册和画像都不要求真实身份资料。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-muted-foreground">教学档案使用的信息</p>
              <ul className="space-y-1 text-sm text-foreground">
                <li>培训领域、学习目标与学历档位</li>
                <li>角色背景与已有经验</li>
                <li>编程、工具与工程能力档位</li>
                <li>学习偏好与可投入时间</li>
              </ul>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-muted-foreground">平台不要求的字段</p>
              <ul className="space-y-1 text-sm text-foreground">
                <li>真实姓名 / 头像</li>
                <li>学号 / 工号 / 身份证号</li>
                <li>手机号 / 邮箱 / 住址</li>
                <li>所在院校 / 班级 / 部门</li>
                <li>位置、设备指纹、生物特征</li>
              </ul>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                未登录时使用随机 UUID（anon:…）分区当前浏览器的答题记录；登录后改用账户随机
                id，用户名不进入教学提示词。
              </p>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            平台日志出口会遮盖手机号、邮箱、身份证、学号工号、密钥和绝对路径等敏感格式；
            导出的实操指南也会先对画像摘要做同样处理。
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            课件正文和发往模型服务的教学请求不经过日志脱敏；请不要在学习需求或课程资料中主动填写与教学无关的身份信息。
          </p>
        </Section>

        {/* 4. 用户控制权 */}
        <Section
          icon={Eraser}
          title="四、你的控制权：导出、删除与浏览器清除"
          description="服务端账户数据可下载、可凭当前密码删除；浏览器数据单独清除。"
        >
          <p>
            <span className="font-medium">查看：</span>
            登录后可下载账户、档案与机构关系
            {persistenceOn ? '，以及服务端课程和运行记录' : ''}的 JSON 副本（不含密码哈希和会话
            token）。 浏览器侧数据也可在开发者工具 → Application → Local Storage / IndexedDB
            查看；学情诊断结果可在{' '}
            <Link href="/report" className={INLINE_LINK}>
              学情报告
            </Link>{' '}
            页看到人类可读版本。
          </p>
          <div className="space-y-3 rounded-md border border-border p-3">
            {authError ? (
              <p className="text-red-deep">账户控制暂不可用：无法确认当前登录状态。</p>
            ) : currentAccount === undefined ? (
              <p className="text-muted-foreground">正在读取当前账户状态……</p>
            ) : currentAccount === null ? (
              <p className="text-muted-foreground">登录后可导出或删除当前账户。</p>
            ) : (
              <>
                <p className="font-medium text-foreground">当前账户：{currentAccount.username}</p>
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className={cn('gap-2', FOCUS_RING)}
                    onClick={() => window.location.assign('/api/account/export')}
                  >
                    <Download className="size-4" />
                    导出当前账户数据
                  </Button>
                </div>
                <div className="space-y-2 border-t border-border-subtle pt-3">
                  <label htmlFor="delete-account-password" className="font-medium text-foreground">
                    删除账户前再次输入当前密码
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      id="delete-account-password"
                      type="password"
                      autoComplete="current-password"
                      value={deletePassword}
                      onChange={(event) => setDeletePassword(event.target.value)}
                      className={cn('sm:max-w-xs', FOCUS_RING)}
                    />
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={deletingAccount || deletePassword.length === 0}
                      onClick={handleDeleteAccount}
                      className={cn('gap-2 text-red-deep', FOCUS_RING)}
                    >
                      {deletingAccount ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                      删除账户及服务端名下数据
                    </Button>
                  </div>
                  <p className="text-muted-foreground">
                    此操作会注销全部会话并删除账户档案、名下课程和学习记录。机构所有者仍有成员时会被拒绝，须先移出全部成员。
                  </p>
                </div>
              </>
            )}
            {accountMessage ? (
              <p
                className={cn(
                  'rounded-md border p-2',
                  accountMessage.kind === 'success'
                    ? 'border-green-deep/20 bg-green-soft text-green-deep'
                    : 'border-red-deep/20 bg-red-soft text-red-deep',
                )}
              >
                {accountMessage.text}
              </p>
            ) : null}
          </div>
          <p>
            <span className="font-medium">只清当前浏览器：</span>
            下面这个按钮会删除画像、匿名标识、答题记录、课堂进度、播放游标、输入草稿与会话指针。
            <strong className="text-foreground">
              不会动当前浏览器保存的平台连接信息与界面偏好
            </strong>
            （清除浏览器站点数据可一并清掉），
            <strong className="text-foreground">也不会删已生成的课程内容</strong>
            （在课堂列表里逐门删除，避免误删作品）。
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button
              onClick={handleClear}
              disabled={clearing}
              variant="destructive"
              // destructive 变体的 text-destructive 压在自己的 10% 红底上实测 4.07:1，
              // 差一点到 4.5:1。就地换成本仓库的 red-deep（同一套语义红），量到 6.2:1。
              // 根在 --destructive 这个 token，全站按钮都受影响，要改得动 globals.css。
              className={cn('gap-2', FOCUS_RING, 'text-red-deep')}
            >
              {clearing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Eraser className="size-4" />
              )}
              清除当前浏览器的学习数据
            </Button>
            {result ? (
              <span className="text-sm text-muted-foreground">操作已执行，结果如下。</span>
            ) : null}
          </div>

          {result ? (
            <div
              className={cn(
                'space-y-2 rounded-md border p-3 text-sm',
                result.db === 'deleted' && result.localStorage === 'cleared'
                  ? 'border-green-deep/20 bg-green-soft'
                  : 'border-yellow-deep/20 bg-yellow-soft',
              )}
            >
              {result.localStorage === 'unavailable' ? (
                <p className="font-medium text-foreground">
                  localStorage 清除失败：浏览器隐私策略拒绝访问。
                </p>
              ) : (
                <p className="font-medium text-foreground">
                  已删除 {result.keys.length} 个 localStorage 键
                  {result.keys.length === 0 ? '（当前浏览器原本没有这些数据）' : '：'}
                </p>
              )}
              {result.localStorage === 'cleared' && result.keys.length > 0 ? (
                <ul className="space-y-0.5 font-mono text-xs break-all text-foreground">
                  {result.keys.map((key) => (
                    <li key={key}>· {key}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-foreground">{DB_MESSAGE[result.db]}</p>
              <p className="text-muted-foreground">
                页面上已打开的课堂可能仍在内存里持有旧状态，刷新后即为清除后的状态。
              </p>
            </div>
          ) : null}
        </Section>

        {/* 5. 语料来源 */}
        <Section
          icon={FileText}
          title="五、受控知识库的语料来源与版权口径"
          description="来源、许可与使用边界均按知识库接入记录展示。"
        >
          <ul className="space-y-2 list-disc list-inside">
            <li>
              入库切片全部来自开源许可来源（CC BY-NC-SA / MIT /
              Apache-2.0）。逐条来源、许可与原文由平台随接入记录保存； 所属机构管理者可在{' '}
              <Link href="/admin/knowledge" className={INLINE_LINK}>
                知识库页面
              </Link>{' '}
              查看。
            </li>
            <li>
              在售版权教材<strong>只做书目背书与人工策展参照，不切片入库</strong>
              （教材登记制 TEXTBOOK_REGISTRY 标注口径）。
            </li>
            <li>
              岗位能力数据只使用机构管理者接入的岗位 / 技能清单及其随库资料；
              未提供就明确标注未覆盖，不采集招聘网站数据。
            </li>
            <li>当前为比赛非商用场景；若未来商用，NC 类语料需重新评估或替换。</li>
            <li>
              生成内容逐句过引用门禁与独立审核，未过闸不上架并显式标注； 页面明示 AI
              生成属性与审核指纹。
            </li>
          </ul>
        </Section>

        {/* 原来是 gray-400/gray-500，实测亮色 2.49:1、暗色 4.16:1，两边都不过 4.5:1 */}
        {/* break-words 是必需的：这条路径在 375 下不加就撑出 32px 横向滚动 */}
        <p className="pb-4 text-sm leading-relaxed break-words text-muted-foreground">
          核查对象为平台当前运行版本。如需完整核查记录、真实学员数据接入清单或风险清单，请联系平台维护人员。
        </p>
      </div>
    </div>
  );
}
