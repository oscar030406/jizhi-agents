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
import { Database, Eraser, FileText, Loader2, Network, ShieldCheck, UserCog } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    where: '服务端 PostgreSQL：accounts 表',
    keep: '直到你要求删除账户',
    leaves: '否（只在本服务与数据库之间）',
  },
  {
    item: '登录会话',
    content: '随机会话 token（httpOnly cookie，浏览器脚本读不到）',
    where: '服务端 account_sessions 表 + 浏览器 cookie',
    keep: '30 天，或退出登录时立即失效',
    leaves: '否',
  },
  {
    item: '账户名下的课程与学习记录',
    content: '你生成的课程、场景、答题与运行记录，按账户分区存储',
    where: '服务端 PostgreSQL：document_stages / document_scenes / runtime_*',
    keep: '直到你删除课程或账户',
    leaves: '否（生成过程中的模型调用另见第三节）',
  },
];

const LOCAL_DATA: DataRow[] = [
  {
    item: '学习者画像',
    content: '领域 / 学历档 / 角色自述 / 5 项 0–4 自评档位 / 学习偏好 / 时间预算',
    where: '浏览器 localStorage：learnerProfile',
    keep: '无过期，直到手动清除',
    leaves: '派生指令随生成请求发往模型服务商',
  },
  {
    item: '匿名学习者标识',
    content: 'anon:<随机 UUID>，仅用于把本机答题记录分区，不与任何账号绑定',
    where: 'localStorage：maic:device:runtime.learnerKey',
    keep: '无过期，直到手动清除',
    leaves: '开启服务端持久化时随请求上行，用于把未登录访客的数据分区；不与任何账号绑定',
  },
  {
    item: '答题记录',
    content: '每题作答、判分结果、尝试 id、场景运行事件',
    where:
      'IndexedDB：maic-runtime（sessions / records）；迁移期旧键 quizDraft: / quizAnswers: / quizResults: / quizAttemptId:',
    keep: '无过期，直到手动清除',
    leaves: '仅正确率数值发往本机引擎做反馈决策',
  },
  {
    item: '课堂进度与运行标记',
    content: '当前场景指针、播放游标、PBL 事件水位线、文档迁移标记与存储代次计数',
    where:
      'localStorage：maic:device:editor-current-scene:* / playback-cursor:* / runtime.pblDrain.* / document-migration:* / document-storage-generation',
    keep: '无过期，直到手动清除',
    leaves: '否',
  },
  {
    item: '课程内容',
    content: '生成的大纲、场景、动作脚本、审核指纹',
    where: 'IndexedDB：maic-documents（stages / scenes / outlines）',
    keep: '无过期，在课堂列表中逐门删除',
    leaves: '否（生成过程本身经过模型服务商）',
  },
  {
    item: '输入框草稿',
    content: '首页需求输入、PBL 对话输入的未提交文本（学习者手输内容原文）',
    where: 'localStorage：requirementDraft / pblChatDraft',
    keep: '提交后清除，未提交则常驻',
    leaves: '提交时作为提示词发往模型服务商',
  },
  {
    item: '模型与服务商配置',
    content: '服务端下发的可用模型与端点（学习者端只读，不再填写 API Key）',
    where: 'localStorage：settings-storage（及旧键 providersConfig / llmModel / ttsModel）',
    keep: '无过期，清除浏览器站点数据即可清掉',
    leaves: '调用时随请求发往本应用服务端，再转发给对应服务商',
  },
  {
    item: '界面偏好',
    content: '主题、最近课堂展开状态等',
    where: 'localStorage：theme_v2 / locale / recentClassroomsOpen / maic.learnerAccounts',
    keep: '无过期',
    leaves: '否',
  },
  {
    item: '编辑锁 / 会话指针',
    content: '多标签页编辑互斥标记、Agent 会话 id',
    where: 'localStorage：maic-editor:edit-lock:* / maic-agent-threads / maic-agent-active-session',
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
  deleted: `IndexedDB「${RUNTIME_DB_NAME}」（答题与运行记录）已删除。`,
  blocked: `IndexedDB「${RUNTIME_DB_NAME}」未能删除：本课堂仍被其他标签页占用。关闭其他标签页后再点一次。`,
  error: `IndexedDB「${RUNTIME_DB_NAME}」删除失败（浏览器拒绝了请求）。`,
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

  // 本部署到底开没开账户与服务端持久化——问运行时，不写死。
  // 账户看 /api/auth 的 enabled（服务端按数据库配置回答）；
  // 持久化看构建期注入的 NEXT_PUBLIC_PERSISTENCE（bootstrap.ts 的同一个开关）。
  const [accountsOn, setAccountsOn] = useState<boolean | null>(null);
  const persistenceOn = process.env.NEXT_PUBLIC_PERSISTENCE === '1';
  useEffect(() => {
    fetch('/api/auth', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { enabled?: boolean }) => setAccountsOn(!!d.enabled))
      .catch(() => setAccountsOn(false));
  }, []);
  const dataRows = accountsOn ? [...ACCOUNT_DATA, ...LOCAL_DATA] : LOCAL_DATA;

  const handleClear = async () => {
    setClearing(true);
    setResult(null);
    let keys: string[] = [];
    try {
      keys = collectKeys();
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // localStorage 不可用（隐私模式/被策略禁用）时按"没有可清的键"处理
      keys = [];
    }
    const db = await deleteRuntimeDb();
    setResult({ keys, db });
    setClearing(false);
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
              <p className="font-medium">本系统目前未收集任何真实学员数据。</p>
              <p>
                开发、评测与演示使用的全部画像均为团队构造的合成用例，不对应任何自然人；
                {accountsOn
                  ? '账户只收用户名与密码（密码经加盐哈希存储），不收集姓名、学号、手机号、邮箱、身份证等字段。'
                  : '系统没有账号体系，不存在姓名、学号、手机号、邮箱、身份证等字段。'}
                本页描述的是「你现在使用它时」数据的实际去向。
              </p>
            </div>
          </div>
        </div>

        {/* 1. 数据清单 */}
        <Section
          icon={Database}
          title="一、收集了什么、存在哪、留多久"
          description={
            persistenceOn
              ? '本部署已开启服务端持久化：登录后，课程与学习记录按账户存在服务器数据库里；未登录时数据只在你这台机器的浏览器中。'
              : '本部署未开启服务端持久化（NEXT_PUBLIC_PERSISTENCE 未设置），所有学习数据只在你这台机器的浏览器里。'
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
                  <th className="py-2 font-medium">是否离开本机</th>
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
            服务端（Next.js 进程）不落任何学习数据库，只有控制台日志：记录场景标题、生成计数、
            审核裁决理由与错误信息，未发现打印画像字段或输入原文的调用。
          </p>
        </Section>

        {/* 2. 出本机的数据 */}
        <Section
          icon={Network}
          title="二、哪些数据会离开本机、发给谁"
          description="只有两个外发方向，都不含身份信息。"
        >
          <ol className="space-y-3 list-decimal list-inside">
            <li>
              <span className="font-medium text-foreground">大模型服务商</span>
              （由你在设置里选择，本机默认配置为硅基流动）：收到的是
              <em className="not-italic font-mono text-xs"> 你输入的学习需求文本 </em>、
              由画像换算出的
              <em className="not-italic font-mono text-xs"> 讲法指令段 </em>
              （难度档、支架深度、类比领域、代码/图示配额）、
              <em className="not-italic font-mono text-xs"> 受控知识库的证据块 </em>
              以及生成/审核提示词。画像以「档位数字 + 角色描述」形态进入提示词， 例如「本科 ·
              后端开发转 Agent 应用 · 推荐难度 L3」，不含任何身份标识。
            </li>
            <li>
              <span className="font-medium text-foreground">我方多智能体引擎（ai-service）</span>
              ：仅监听内网回环地址、由课堂服务经内部令牌代理访问，不对公网开放，
              数据不出本部署。{/* 具体地址来自 GROUNDING_URL，不在文案里写死——
              写死过 127.0.0.1:8001，引擎一换机这页就成假话（2026-08-28 清查 M5）。 */}三个端点各自只收必要字段—— 学情诊断收 9
              个画像字段（目标、背景描述、5 个档位、偏好、时长）；
              证据检索收检索词、返回条数与语料库名；反馈决策收正确率与难度档
              （接口另可接逐概念得分，当前测验场景只发正确率）。 引擎按白名单过滤入参、算完即返，
              <strong>不落盘</strong>， 日志只记 traceId 与异常类型。
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
          title="三、学习者画像为什么不含身份信息"
          description="这是结构性的：schema 里就没有身份字段，不是靠运行时过滤。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-muted-foreground">画像包含的全部字段</p>
              <ul className="space-y-1 font-mono text-sm text-foreground">
                <li>domain / education / role（枚举 + 一句自述）</li>
                <li>programming_level 0–4</li>
                <li>python_level 0–4</li>
                <li>agent_level 0–4</li>
                <li>rag_level 0–4</li>
                <li>engineering_level 0–4</li>
                <li>learning_preference（偏好自述）</li>
                <li>time_budget_hours（数字）</li>
              </ul>
            </div>
            <div className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-muted-foreground">系统里不存在的字段</p>
              <ul className="space-y-1 text-sm text-foreground">
                <li>姓名 / 昵称 / 头像</li>
                <li>学号 / 工号 / 身份证号</li>
                <li>手机号 / 邮箱 / 住址</li>
                <li>所在院校 / 班级 / 部门</li>
                <li>位置、设备指纹、生物特征</li>
              </ul>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                本机唯一的标识是随机 UUID（anon:…），仅用于把答题记录分区，重装浏览器即失效。
              </p>
            </div>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            我们另外写了一个脱敏函数
            <span className="font-mono text-xs"> lib/privacy/redact.ts</span>
            （手机号、邮箱、身份证、带标签的学号工号、API Key、绝对路径等 12 类， 自检命令{' '}
            <span className="font-mono text-xs">node lib/privacy/redact.check.mjs</span>）。
            它接在两处：一是统一日志出口
            <span className="font-mono text-xs"> lib/logger.ts</span>
            ——服务端与浏览器端经它写出的每一行日志，落到控制台之前先过一遍脱敏，
            例如接口把你填的学习目标原样写进日志的那类语句；二是「导出实操指南」 下载的
            Markdown，里面的画像摘要行会脱敏。
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            以下情况不经过脱敏：绕开这个出口直接 <span className="font-mono text-xs">console</span>{' '}
            打印的少数语句；课件正文（实操课里的路径、邮箱多半是教学素材，抹掉指南就没法用了）；
            错误对象的堆栈帧（只脱敏消息首行，帧保留以便排障）；
            发给大模型服务商的请求内容，那条链路的口径见第二节。
          </p>
        </Section>

        {/* 4. 用户控制权 */}
        <Section
          icon={Eraser}
          title="四、你的控制权：查看与清除"
          description="全部数据在你本机，随时可查可删。"
        >
          <p>
            <span className="font-medium">查看：</span>
            浏览器开发者工具 → Application → Local Storage / IndexedDB，
            按上表的键名即可看到原始内容；学情诊断结果可在{' '}
            <Link href="/report" className={INLINE_LINK}>
              学情报告
            </Link>{' '}
            页看到人类可读版本。
          </p>
          <p>
            <span className="font-medium">清除：</span>
            下面这个按钮会删除画像、匿名标识、答题记录（含 IndexedDB
            <span className="font-mono text-xs"> maic-runtime</span>）、课堂进度指针（
            <span className="font-mono text-xs">maic:device:*</span>
            ，含当前场景、播放游标与迁移标记）、输入草稿与会话指针。
            <strong className="text-foreground">不会动本机缓存的模型配置与界面偏好</strong>
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
              清除本机学习数据
            </Button>
            {result ? (
              <span className="text-sm text-muted-foreground">操作已执行，结果如下。</span>
            ) : null}
          </div>

          {result ? (
            <div
              className={cn(
                'space-y-2 rounded-md border p-3 text-sm',
                result.db === 'deleted'
                  ? 'border-green-deep/20 bg-green-soft'
                  : 'border-yellow-deep/20 bg-yellow-soft',
              )}
            >
              <p className="font-medium text-foreground">
                已删除 {result.keys.length} 个 localStorage 键
                {result.keys.length === 0 ? '（本机本来就没有这些数据）' : '：'}
              </p>
              {result.keys.length > 0 ? (
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
          description="与 docs/05-evidence/data_compliance.md 同一口径。"
        >
          <ul className="space-y-2 list-disc list-inside">
            <li>
              入库切片全部来自开源许可来源（CC BY-NC-SA / MIT / Apache-2.0），
              逐条许可记录在引擎仓库的
              <span className="font-mono text-xs"> data/knowledge_base/ATTRIBUTION.md </span>与
              <span className="font-mono text-xs"> sources_manifest.csv</span>。
            </li>
            <li>
              在售版权教材<strong>只做书目背书与人工策展参照，不切片入库</strong>
              （教材登记制 TEXTBOOK_REGISTRY 标注口径）。
            </li>
            <li>
              岗位调研使用公开招聘信息的研究用二手数据集，只做聚合统计，
              不含求职者个人信息，原始数据集不进提交包。
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
          核查对象为本仓库当前代码。完整核查记录见 docs/05-evidence/openmaic_compliance.md；
          接入真实学员数据的操作清单与已知风险清单见
          docs/05-evidence/privacy-onboarding-and-risks-20260815.md。
        </p>
      </div>
    </div>
  );
}
