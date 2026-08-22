/**
 * 全局指标带：metrics.json 的口径数字 + 课程墙实时汇总。
 *
 * 口径纪律是这套系统的卖点，大屏上不许出现脱离口径的裸数字——所以口径不是 tooltip，
 * 是常驻的展开块，评委点得开、截得下。
 *
 * 08-13 补的一条：**影响判断的数字必须页面直接可见**（样本量 n、置信区间、样本来源），
 * hover / 展开只承载「这个指标怎么算的」。台账里 value 是裸小数的（幻觉率 0.021、
 * 拦截率 0.083），卡上只有一个百分数，n 和区间都在口径原文里——把口径里带分母的那一句
 * 提到卡面上顶住。
 *
 * 08-16 改的是**这句话印几行**：原来主数字下面挂两段（台账补充 + 口径开头），
 * 适配准确率那张卡光可见小字就 141 字，一屏四张卡等于四段说明书。现在卡面只留
 * 一句限定语，挑的是**带分母/区间的那一句**，数字行自己已经带了分母就不再重复印。
 *
 * 08-16 退单修复：上一版把台账 value 分隔符后面那截（`detail`）在「数字行已带分母」
 * 这条分支上**整段丢了**——适配准确率的精确二项检验那句、覆盖率的六门逐门数字，
 * 全页 DOM 里都搜不到。现在 detail 只要没当上卡面那句限定语，就原样进折叠。
 * 卡面收紧的是**印几行**，不是**留几个字**：一个字都不删。
 */

import type { MetricEntry } from '@/lib/server/admin-overview';
import { redactCaliber } from '@/lib/metrics/redact-caliber';

import { Caliber } from './caliber';

const LABELS: Record<string, string> = {
  api_hallucination_v2: '幻觉率（真实 LLM 断言级）',
  adaptation_accuracy_2a: '画像-难度适配准确率',
  kc_coverage_v1: '核心知识点覆盖率',
  api_interception_v2: '仲裁拦截率',
};

interface Totals {
  courses: number;
  scenes: number;
  audited: number;
  claims: number;
  incorrect: number;
  uncertain: number;
  incorrectRate: number | null;
  groundedRate: number | null;
  /** 跨课去重后的教材引用源数。设计稿 §2 区 A 点名要，逐课相加会重复计数。 */
  distinctSources: number;
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(2)}%`;
}

/**
 * 台账 value 的两种写法：「85.2%（…）——rubric v4 …」与「汇总 48/50 = 96.0%（…）；逐门：…」。
 * 第一个分隔符之前是对外主数字，之后是补充明细。两截都要留在卡面上。
 */
export function splitValue(value: string): { head: string; detail: string } {
  const i = value.search(/——|；/);
  if (i < 0) return { head: value, detail: '' };
  return { head: value.slice(0, i).trim(), detail: value.slice(i).replace(/^(——|；)/, '').trim() };
}

/** 这段文字里带没带分母、样本量或置信区间——卡面那唯一一句要的就是这个。 */
function carriesDenominator(s: string): boolean {
  return /n\s*=|CI|\d+\s*\/|\/\s*\d+/.test(s);
}

/** 主数字里那个百分数拎出来当图表意义上的 figure；拎不出来（前缀太长）就整句加粗印着 */
export function splitFigure(head: string): { pre: string; figure: string; post: string } | null {
  const m = head.match(/[\d.]+\s*%/);
  if (!m || m.index === undefined || m.index > 12) return null;
  return {
    pre: head.slice(0, m.index).trim(),
    figure: m[0],
    post: head.slice(m.index + m[0].length).trim(),
  };
}

/**
 * 卡面上唯一那句限定语。
 *
 * 顺序：数字行（含 pre/post）已经带了分母或区间就不再补一句；否则先看台账自己写的
 * 补充明细，再退回口径原文里第一句带分母/区间的话。返回空串 = 这张卡不需要限定语。
 * 挑句子不改写句子——印出来的每个字都是台账原文。
 */
export function qualifierLine(value: string, caliber: string): string {
  const { head, detail } = splitValue(value);
  const fig = splitFigure(head);
  if (fig && carriesDenominator(`${fig.pre} ${fig.post}`)) return '';
  if (detail && carriesDenominator(detail)) return detail;
  const sentences = caliber.split('。').map((s) => s.trim()).filter(Boolean);
  const pick = sentences.find(carriesDenominator) ?? sentences[0];
  return pick ? `${pick}。` : detail;
}

function MetricCard({ metric }: { readonly metric: MetricEntry }) {
  const { head, detail } = splitValue(metric.value);
  const fig = splitFigure(head);
  // 卡面这句可能是从 caliber 里挑的，同样要脱敏（caliber 里有模型全串）
  const qualifier = redactCaliber(qualifierLine(metric.value, metric.caliber));
  // 没当上卡面那句的 detail 一律进折叠——收起来可以，删掉不行
  const foldedDetail = detail && detail !== qualifier ? detail : '';
  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
      <p className="text-xs text-muted-foreground">{LABELS[metric.id] ?? metric.id}</p>
      {fig ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
          {fig.pre && <span className="text-xs text-muted-foreground">{fig.pre}</span>}
          {/* 大数字不上 tabular-nums：等宽数字在这个字号下会显得松散 */}
          <span className="text-[40px] font-medium leading-none tracking-[-0.02em]">
            {fig.figure}
          </span>
          {fig.post && (
            <span className="text-xs leading-snug text-muted-foreground">{fig.post}</span>
          )}
        </p>
      ) : (
        <p className="mt-2 text-base font-medium leading-snug">{head}</p>
      )}
      {qualifier && (
        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">{qualifier}</p>
      )}
      <Caliber summary="展开口径原文与复算命令">
        {foldedDetail && <p>{redactCaliber(foldedDetail)}</p>}
        <p>{redactCaliber(metric.caliber)}</p>
        {metric.source && (
          <p className="rounded-lg bg-muted px-2 py-1.5 font-mono text-[10px] leading-relaxed">
            {redactCaliber(metric.source)}
          </p>
        )}
      </Caliber>
    </div>
  );
}

export function MetricBand({
  metrics,
  totals,
}: {
  readonly metrics: readonly MetricEntry[];
  readonly totals: Totals;
}) {
  return (
    <div className="space-y-4">
      {metrics.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
          读不到 metrics.json（引擎数据目录不可达），这里先空着，不拿旧值顶。
          把 <code className="mx-1 font-mono">ENGINE_DATA_DIR</code> 指到引擎的 data 目录后这里出数。
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {metrics.map((m) => (
            <MetricCard key={m.id} metric={m} />
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
        <p className="text-xs text-muted-foreground">课程墙实时汇总</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
          {[
            ['课程', String(totals.courses)],
            ['场景已审', `${totals.audited} / ${totals.scenes}`],
            ['核验断言', totals.claims.toLocaleString()],
            ['判错 / 存疑', `${totals.incorrect} / ${totals.uncertain}`],
            ['判错占比', pct(totals.incorrectRate)],
            ['接地场景占比', pct(totals.groundedRate)],
            ['引用源（跨课去重）', String(totals.distinctSources)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[11px] text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-xl font-medium leading-none tabular-nums tracking-tight">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <Caliber summary="展开口径：这些汇总怎么算的">
          <p>每次打开当场从课程文件算，不读缓存。</p>
          <p>
            这里的「判错占比」走的是<strong className="font-medium">课程审核链</strong>口径，与上面的幻觉率（评测链）
            不可直接对比：两者的分母不是同一批断言。分母就在同一格里：核验断言 {totals.claims.toLocaleString()} 条 /
            已审场景 {totals.audited} 个。
          </p>
        </Caliber>
      </div>
    </div>
  );
}
