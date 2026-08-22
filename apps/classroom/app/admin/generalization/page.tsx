/**
 * 领域泛化对比。
 *
 * 用户 08-16 的原话是「我都不知道你到底测试了几个领域以及效果如何，你得让人知道你拿了
 * 什么资料扔进去」。所以这一页只回答两个问题，一栏一个域：
 *   1. 扔进去的是什么资料——仓库、篇数、许可原文、切片规模，逐行指回磁盘字段；
 *   2. 换了库之后这条链还转不转——⑥⑦ 体检的分子分母。
 *
 * 口径纪律（红线 `docs/05-evidence/external-claims-redlines-20260813.md` §5）：
 * 体检的分母全是个位数，与主语料那三个对外指标**不是一回事**，两块必须分开摆、
 * 各写各的口径，同框比就是造假。页面上每个体检数字都带 n，且带
 *「小样本体检，非对外指标」这句限定。
 *
 * 服务端组件：要读引擎数据目录下的四类产物文件，放客户端等于把语料清单推给浏览器。
 * 交互只有几个 <details>，不值得上客户端。
 */

import Link from 'next/link';
import { ArrowLeft, ShieldAlert } from 'lucide-react';

import { SiteHeader } from '@/components/site-header';
import { CARD_RECIPE_STATIC } from '@/components/home/course-card';
import { readHeadlineMetrics } from '@/lib/server/admin-overview';

import { managerAccount } from '../knowledge/guard';
import { RunArtifacts } from './run-artifacts';
import {
  readGeneralizationPanels,
  readOtherCorpora,
  readRunArtifacts,
  redactCaliber,
  type Checkup,
  type DomainPanel,
  type RunArtifact,
} from './data';

export const dynamic = 'force-dynamic';

/** 这句限定语与引擎侧 `domain_intake.SMALL_SAMPLE_NOTE` 是同一句，改要一起改。 */
const SMALL_SAMPLE_NOTE = '小样本体检，非对外指标';

/**
 * 脚注里每个未上屏语料的一句话定性。
 *
 * 原来这四个混成一句「规模不足以支撑一门课」，当场就能被推翻——课程墙上那两门课
 * 正是拿 rag-adv 和 vecdb 生成的（`data/classrooms/c3HH74qwAH.json`、`sVnMPbeeXn.json`）。
 * 所以分开写：前两个是 AI 大类内部的课程扩展语料（有课，但不跨大类），
 * 后两个才是流水线跑通时的先期小样。没登记的库走默认那句，不替它下结论。
 */
const OTHER_CORPUS_NOTES: Record<string, string> = {
  vecdb: 'AI 大类内部的课程扩展语料，课程墙上已有课程用它生成，不跨大类。',
  'rag-adv': 'AI 大类内部的课程扩展语料，课程墙上已有课程用它生成，不跨大类。',
  'pv-ops': '接入流水线跑通时建的先期小样，规模不足以支撑一门课。',
  'cold-chain-ops': '接入流水线跑通时建的先期小样，规模不足以支撑一门课。',
};

/** 一域一色，全页冷色三支。 */
const TONES: Record<string, { soft: string; deep: string }> = {
  ai: { soft: 'bg-purple-soft', deep: 'text-purple-deep' },
  iotdb: { soft: 'bg-blue-soft', deep: 'text-blue-deep' },
  odoo: { soft: 'bg-green-soft', deep: 'text-green-deep' },
};

function tone(corpus: string) {
  return TONES[corpus] ?? { soft: 'bg-muted', deep: 'text-foreground' };
}

function num(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 大数字 + 同屏一句限定语。限定语刻意必填：这一页不许出现脱离口径的裸数字。 */
function Figure({
  value,
  unit,
  label,
  caliber,
  deep,
}: {
  readonly value: string;
  readonly unit?: string;
  readonly label: string;
  readonly caliber: string;
  readonly deep: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-3xl font-medium tracking-[-0.02em] tabular-nums ${deep}`}>
        {value}
        {unit ? <span className="ml-1 text-base font-normal">{unit}</span> : null}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{caliber}</p>
    </div>
  );
}

/**
 * 判官没读到本库教材的那一轮：只说明白为什么不成立，一个数字都不印。
 *
 * 印出来更难看的原因不是难看，是错：那一轮里正文与判官都在凭模型自己的知识写和判，
 * 印在这一页上等于把「模型本来就知道时序数据库」冒充成「换库之后系统还教得动」。
 */
function VoidCheckup({ checkup }: { readonly checkup: Checkup }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
      <p className="text-xs font-medium">这一轮体检不成立</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        判官对照的资料池是 0 块——证据检索桥当时没通，正文与判官都没读到本库的教材，
        那一轮量到的是模型自己知道多少，不是换库之后这条链转不转。
        桥恢复后重跑一次，这一栏会自动换成新的一轮。
      </p>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">run {checkup.runId}</p>
    </div>
  );
}

function CheckupBlock({
  checkup,
  deep,
  artifacts,
}: {
  readonly checkup: Checkup;
  readonly deep: string;
  readonly artifacts: readonly RunArtifact[];
}) {
  const { hallucination: hall, personalization: pers, evidenceReady: er } = checkup;
  return (
    <div className="space-y-4">
      {hall ? (
        <Figure
          deep={deep}
          label="生成的断言里判为有据的"
          value={`${hall.supported}/${hall.checked}`}
          caliber={`判错 ${hall.incorrect} 条、存疑 ${hall.uncertain} 条。${
            // 接地数字必须与资料到位率同屏：桥失败的屏凭模型记忆写，判官那条链
            // 却照常有资料池（两条链独立），光看接地数看不出生成端断供。
            er ? `本轮资料到位 ${er.ready}/${er.total} 屏。` : ''
          }${SMALL_SAMPLE_NOTE}。`}
        />
      ) : null}
      {er && er.ready < er.total ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          有 {er.total - er.ready} 屏在生成时没拿到教材摘录（检索桥失败或零命中），
          正文凭模型自身知识写成——这些屏的接地数字量到的是管道故障，不是内容质量。
          逐屏原因在本轮 <code className="font-mono">trial_courses/REPORT.md</code>。
        </p>
      ) : null}
      {/* 覆盖那一格已撤下，撤因见 data.ts 的 `goldTotal` 注释。说明就摆在原先印数字的位置：
          读者在这一栏找不到覆盖数时，能就地读到为什么没有。
          带数字的那句由引擎写在 run 记录里，这里只转印，不在页面上另算一遍。 */}
      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          覆盖不给比率：
          {checkup.coverageReason ??
            `这一轮两档共生成 ${checkup.plannedScenes} 屏，主题「${checkup.goldTopic}」的金标有 ${
              checkup.goldTotal ?? '—'
            } 个知识成分，相除量到的是试跑规模与金标规模之比，不是覆盖能力。`}
          {/* 原来这里只印一段 `trial_courses/<档>_kc_misses.json` 文本，看着像链接却点不动。
              产物读得到就换成能点开的按钮；读不到才退回印路径，让人去服务器上找。 */}
          {artifacts.length > 0
            ? '没讲到的是哪几个，逐条落在本轮产物里，点开看：'
            : '没讲到的是哪几个，逐条落在本轮的 trial_courses/<档>_kc_misses.json（本机上读不到这一轮的产物目录）。'}
        </p>
        {artifacts.length > 0 ? (
          <div className="mt-2">
            <RunArtifacts runId={checkup.runId} artifacts={artifacts} />
          </div>
        ) : null}
      </div>
      {pers ? (
        <Figure
          deep={deep}
          label="同题两档，盲评判官猜对档位"
          value={pers.blindTotal ? `${pers.blindHit}/${pers.blindTotal}` : '未跑'}
          caliber={`判官看不到档位标签，只读正文猜写给谁。机械比对出的实质差异维度 ${pers.dimensions} 个。${SMALL_SAMPLE_NOTE}。`}
        />
      ) : null}
      {hall ? (
        <p className="rounded-lg bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          判官对照的资料 {hall.evidenceFromCorpus}/{hall.evidencePool} 块取自本库——
          换了库，判官手里的教材也跟着换，这是这次体检成立的前提。
        </p>
      ) : null}
    </div>
  );
}

function DomainColumn({
  panel,
  artifacts,
}: {
  readonly panel: DomainPanel;
  readonly artifacts: readonly RunArtifact[];
}) {
  const t = tone(panel.corpus);
  const cost = panel.checkup?.cost;
  return (
    <section className={`${CARD_RECIPE_STATIC} flex flex-col gap-5 p-5`}>
      <header>
        <span className={`inline-flex rounded-full px-2.5 py-1 text-[11px] ${t.soft} ${t.deep}`}>
          {panel.corpus === 'ai' ? '主语料' : '新接入的域'}
        </span>
        <h2 className="mt-2 text-lg font-medium tracking-[-0.01em]">{panel.label}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{panel.scope}</p>
        {panel.sourceFileDate ? (
          // 接入流水线没记接入时刻（readiness.json 里没有时间戳字段），只能给索引文件的
          // 落盘日期，所以这里写的是「语料入库」不是「接入于」。
          <p className="mt-1 text-[11px] text-muted-foreground">
            语料入库 {panel.sourceFileDate}（索引文件时间，流水线没记接入时刻）
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-2 gap-4">
        <Figure
          deep={t.deep}
          label="可检索证据块"
          value={num(panel.chunks)}
          caliber="索引文件的行数"
        />
        <Figure
          deep={t.deep}
          label="收进来的文档"
          value={num(panel.files)}
          caliber={panel.chars ? `正文 ${num(Math.round(panel.chars / 10000))} 万字` : '各来源策展后的篇数'}
        />
      </div>

      <div className="border-t border-border pt-4">
        {panel.checkup?.grounded ? (
          <CheckupBlock checkup={panel.checkup} deep={t.deep} artifacts={artifacts} />
        ) : panel.checkup ? (
          <VoidCheckup checkup={panel.checkup} />
        ) : panel.corpus === 'ai' ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            主语料不做换库体检——它的效果走的是另一套评测链，分母是几百，数字与口径单列在下方。
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            还没对这个库跑过换库体检。跑法与复算命令在本页最下方的折叠块里。
          </p>
        )}
      </div>

      {panel.checkup ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          体检 {panel.checkup.finishedAt.slice(0, 16).replace('T', ' ')} 跑完，
          耗时 {Math.round(panel.checkup.durationMs / 60000)} 分钟，
          生成 {panel.checkup.scenes}/{panel.checkup.plannedScenes} 屏
          {cost
            ? `；调用 ${cost.calls} 次，入 ${num(cost.inputTokens)} / 出 ${num(cost.outputTokens)} token（另盲评 ${num(cost.engineTokens)}）`
            : ''}
          。
        </p>
      ) : null}

      <details className="border-t border-border pt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground">扔进去的是什么资料</summary>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          许可一栏是原文照搬，含限定语；证据等级空着表示来源清单里没标级。
        </p>
        <ul className="mt-2 space-y-2">
          {panel.sources.map((s) => (
            <li key={s.name} className="border-t border-border/60 pt-2">
              <p className="font-mono text-[11px] break-all">
                {s.url ? (
                  <a href={s.url} className="underline underline-offset-2" target="_blank" rel="noreferrer">
                    {s.name}
                  </a>
                ) : (
                  s.name
                )}
                <span className="ml-2 font-sans text-muted-foreground">{s.docs} 篇</span>
                {s.grade ? <span className="ml-2 font-sans text-muted-foreground">证据等级 {s.grade}</span> : null}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{s.license || '许可未登记'}</p>
            </li>
          ))}
        </ul>
        {panel.corpus === 'ai' ? null : (
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            许可判定：{panel.license.spdx}
            {panel.license.unknown ? '（没找到许可声明，按未知处理）' : ''}。
            冻结金标 {panel.goldTopics} 个主题文件。
          </p>
        )}
      </details>
    </section>
  );
}

export default async function GeneralizationPage() {
  if (!(await managerAccount())) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24">
        <div className="rounded-2xl border border-border bg-card p-8 text-center shadow-card">
          <ShieldAlert className="mx-auto mb-3 size-8 text-amber-600" />
          <h1 className="mb-2 text-lg font-semibold">领域泛化</h1>
          <p className="text-sm text-muted-foreground">这一页只对管理者账号开放。请在首页右上角以「管理者」身份登录。</p>
          <Link
            href="/"
            className="mt-5 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs transition-colors hover:bg-accent"
          >
            <ArrowLeft className="size-3.5" />
            回首页
          </Link>
        </div>
      </main>
    );
  }

  const [panels, others, metrics] = await Promise.all([
    readGeneralizationPanels(),
    readOtherCorpora(),
    readHeadlineMetrics(),
  ]);
  const checked = panels.filter((p) => p.checkup);
  const external = metrics.filter((m) => m.id !== 'api_interception_v2');
  // 每轮体检的产物在服务端就读好（两类文件各 1–2 KB），弹层直接拿——
  // 页面本身已经在管理者闸后面，为这几 KB 另开一个接口等于多守一条读文件的路径。
  const artifacts = new Map(
    await Promise.all(
      checked.map(
        async (p) => [p.checkup!.runId, await readRunArtifacts(p.checkup!.runId)] as const,
      ),
    ),
  );

  return (
    <>
      <SiteHeader backHref="/admin" backLabel="回管理端" maxWidth="max-w-6xl" />
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <header className="mb-8 max-w-3xl">
          <h1 className="text-2xl font-semibold tracking-[-0.02em]">领域泛化</h1>
          {/* 08-18 降噪：原来这里还有一句「三栏并排：一栏主语料，另外两栏…每栏先说什么再说什么」——
              说的是版面自己就摆着的事，删掉不丢信息。下面那段口径限定一个字不动（红线 §5）。 */}
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            换一个领域的资料进来，这套系统还教不教得动。
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            体检是在新库上真跑一门课再逐条核：分母是个位数，只回答「换了库这条链还转不转」，
            不回答「换了库效果多好」。所以它不与主语料那三个对外指标同框——那三条单列在下方。
          </p>
        </header>

        <div className="mb-10 grid gap-5 lg:grid-cols-3">
          {panels.map((panel) => (
            <DomainColumn
              key={panel.corpus}
              panel={panel}
              artifacts={artifacts.get(panel.checkup?.runId ?? '') ?? []}
            />
          ))}
        </div>

        <section className="mb-10">
          <h2 className="text-sm font-medium">主语料的对外指标（另一套口径）</h2>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            下面三条跑在主语料上，分母是几百，判据与聚合规则都写在台账里。
            <strong className="font-medium">与上面的换库体检不可比</strong>：一个是几百条断言的评测链，
            一个是个位数分母的连通性体检，混着读会得出错误结论。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {external.length === 0 ? (
              <p className="text-xs text-muted-foreground">读不到指标台账（metrics.json）。</p>
            ) : (
              external.map((m) => (
                <div key={m.id} className={`${CARD_RECIPE_STATIC} p-4`}>
                  <p className="text-xs text-muted-foreground">{EXTERNAL_LABELS[m.id] ?? m.id}</p>
                  <p className="mt-1 text-3xl font-medium tracking-[-0.02em] tabular-nums text-purple-deep">
                    {headline(m.value, m.caliber).figure}
                  </p>
                  {/* 限定语与数字同屏：台账里 n、置信区间就写在主数字后面那一截，
                      折进 details 等于把「下界未达标」这类话藏起来。 */}
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {headline(m.value, m.caliber).rest}
                  </p>
                  {/* 口径原文照搬，只把模型全串与本机项目目录名抹掉（redactCaliber）——
                      这一页要当测试样例交出去，那两样不该跟着交。 */}
                  <details className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    <summary className="cursor-pointer">口径原文与复算命令</summary>
                    <p className="mt-1.5">{redactCaliber(m.caliber)}</p>
                    {m.source ? (
                      <pre className="mt-1.5 overflow-x-auto rounded-lg bg-muted/60 px-2.5 py-2 font-mono text-[11px]">
                        {redactCaliber(m.source)}
                      </pre>
                    ) : null}
                  </details>
                </div>
              ))
            )}
          </div>
        </section>

        <details className={`${CARD_RECIPE_STATIC} p-5 text-xs leading-relaxed`}>
          <summary className="cursor-pointer font-medium">体检怎么做的、怎么复算</summary>
          <div className="mt-3 space-y-3 text-muted-foreground">
            <p>
              一次体检 = 在指定的库上，用生成前就冻结的知识点清单当课题，
              给两档学习者画像各生成一门课（每档 2 屏），每屏生成完立刻交给判官逐条核。
              两档画像除等级字段外完全相同，差异只能来自档位。
            </p>
            <ul className="list-disc space-y-1 pl-4">
              <li>有据 x/n：判官对每条可核断言的判定，分母是这次生成出的断言总数。</li>
              <li>
                覆盖：不给比率。分母是冻结金标的全集，分子只来自 2 屏试跑课，
                而试跑大纲机械点名的知识成分是固定条数、不随领域变——相除量到的是试跑规模，
                不是覆盖能力。改成只列「没讲到的是哪几个」，落在每轮的{' '}
                <code className="font-mono">trial_courses/&lt;档&gt;_kc_misses.json</code>。
                2026-08-17 之前跑完的轮次，REPORT.md 里那一行还是旧口径的比率，按历史记录留档。
              </li>
              <li>盲评 x/n：判官读不到档位标签，只看正文猜这屏写给谁。</li>
              <li>成本读 classroom 的调用账本增量，账本没有单价字段，所以不折算成钱。</li>
            </ul>
            <p className="text-foreground">在 apps/agent-engine 下重跑（会调用生成与审核接口，按 token 计费）：</p>
            <pre className="overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-[11px]">
              python scripts/run_corpus_checkup.py iotdb
            </pre>
            <p>读这一页的原始产物（路径是服务器上的位置，点文件名就地看原文）：</p>
            {checked.length === 0 ? (
              <p>（还没有跑完的体检）</p>
            ) : (
              <ul className="space-y-2">
                {checked.map((p) => (
                  <li key={p.corpus}>
                    <p className="break-all font-mono text-[11px]">
                      data/knowledge_base/intake_runs/{p.checkup?.runId ?? ''}/trial_courses/
                    </p>
                    <div className="mt-1">
                      <RunArtifacts
                        runId={p.checkup?.runId ?? ''}
                        artifacts={artifacts.get(p.checkup?.runId ?? '') ?? []}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p>
              资料清单的字段来自 <code className="font-mono">knowledge_base/&lt;库&gt;_intake/readiness.json</code>
              与 <code className="font-mono">knowledge_base/sources_manifest.csv</code>；
              切片数是索引文件的行数。
            </p>
            {others.length > 0 ? (
              <div className="space-y-1.5">
                <p>盘上还有这几个库。它们都在 AI 大类内部或还没成规模，不是跨大类泛化，本页三栏不列：</p>
                <ul className="list-disc space-y-1 pl-4">
                  {others.map((o) => (
                    <li key={o.corpus}>
                      {o.label}（<code className="font-mono">{o.corpus}</code>，{o.chunks} 块）——
                      {OTHER_CORPUS_NOTES[o.corpus] ?? '接入流水线建的库，没做过泛化对照。'}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      </main>
    </>
  );
}

/**
 * 台账 value 拆成「大数字」与「跟着它的限定语」。
 *
 * 台账里三条的写法各不相同（裸小数 0.021、`85.2%（95% CI…）——rubric v4…`、
 * `汇总 48/50 = 96.0%（6 门金标课）；逐门：…`）。拆法：第一个百分数当数字，
 * 其余整段当限定语**留在卡面上**，不折进 details——n 与置信区间属于影响判断的数字。
 */
function headline(rawValue: string, rawCaliber = ''): { figure: string; rest: string } {
  const value = redactCaliber(rawValue);
  const caliber = redactCaliber(rawCaliber);
  const m = /[\d.]+\s*%/.exec(value);
  if (!m || m.index === undefined) return { figure: value.slice(0, 12), rest: value.slice(12) };
  const rest = (value.slice(0, m.index).replace(/[=＝]\s*$/, '') + value.slice(m.index + m[0].length))
    // 开括号与它的闭括号一起摘，只摘开括号会在卡面上留个孤儿右括号
    // （实测：「95% CI 77.8–92.6%，n=108，下界未达 85%）——rubric v4…」）。
    .replace(/^[（(]([^）)]*)[）)]/, '$1')
    .replace(/^——|^；/, '')
    .trim();
  // 台账里写成裸小数的那两条（幻觉率、拦截率）没有这一截，样本量与区间全在口径原文的
  // 头两句里——把那两句提上卡面，不让「n 是多少」只存在于折叠块中。
  const lead = caliber.split('。').filter(Boolean).slice(0, 2).join('。');
  return { figure: m[0], rest: rest || (lead ? `${lead}。` : '') };
}

/** 台账 id → 页面标题。与 `components/admin/metric-band.tsx` 那份同源，只取三条。 */
const EXTERNAL_LABELS: Record<string, string> = {
  api_hallucination_v2: '幻觉率（真实生成端，断言级）',
  adaptation_accuracy_2a: '画像-难度适配准确率',
  kc_coverage_v1: '核心知识点覆盖率',
};
