/**
 * 知识库中心的展示件：语料库卡片与入库管线五站。
 *
 * 两条纪律落在这里：
 * 1. **字段拿不到就不渲染**——`null` 一律跳过，不出「—」以外的占位，更不出估算值。
 * 2. **亮灯只代表「这一站的产物文件在盘上」**，不代表质量。所以每站都把产物路径与
 *    mtime 摆在灯旁边，看的人能自己去磁盘核。没有进度百分比：没有任务系统就没有进度。
 */

import Link from 'next/link';

import { domainLabel, hasDomainLabel } from '@/lib/knowledge/domain-labels';
import type { CorpusFitness, CorpusOverview, PipelineStation } from '@/lib/server/knowledge-center';

const BACKEND_LABEL: Record<CorpusOverview['backend'], string> = {
  vector: '向量检索 bge-m3',
  tfidf: 'TF-IDF 检索',
  none: '未建库',
};

/** 时间统一按 UTC 显示：这几个 mtime 来自服务器文件系统，本地化会让两个人看到不同的数。 */
export function stamp(iso: string | null): string | null {
  return iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : null;
}

function Chip({
  ok,
  label,
  tone = 'gate',
}: {
  readonly ok: boolean;
  readonly label: string;
  readonly tone?: 'gate' | 'warn';
}) {
  const on =
    tone === 'warn'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${ok ? on : 'bg-muted text-muted-foreground'}`}
    >
      {ok ? '✓' : '✗'} {label}
    </span>
  );
}

/**
 * 适配性灯的三档。灯只回答一件事：这批素材够不够铺一门课。**不参与任何拦截**——
 * 红灯的库照样能选、能生成，页面只是提前说一声。理由与算式在详情页展开看。
 */
const FITNESS_LIGHT: Record<CorpusFitness['light'], { label: string; dot: string; text: string }> =
  {
    green: {
      label: '素材够',
      dot: 'bg-emerald-500',
      text: 'text-emerald-700 dark:text-emerald-300',
    },
    yellow: { label: '勉强够', dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-300' },
    red: { label: '素材不够', dot: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-300' },
  };

export function FitnessLight({
  fitness,
  withWhy = false,
}: {
  readonly fitness: CorpusFitness;
  readonly withWhy?: boolean;
}) {
  const tone = FITNESS_LIGHT[fitness.light];
  return (
    <span className={`inline-flex items-baseline gap-1.5 text-[11px] ${tone.text}`}>
      <span
        className={`mt-[3px] size-2 shrink-0 self-start rounded-full ${tone.dot}`}
        aria-hidden
      />
      <span className="font-medium">{tone.label}</span>
      {withWhy && fitness.why.length > 0 && (
        <span className="text-muted-foreground">{fitness.why.join('；')}</span>
      )}
    </span>
  );
}

export function CorpusCard({ corpus }: { readonly corpus: CorpusOverview }) {
  const built = corpus.stations.filter((s) => s.built).length;
  const updated = stamp(corpus.updatedAt);
  return (
    <Link
      href={`/admin/knowledge/${corpus.corpus}`}
      className="block rounded-2xl border border-border bg-card p-4 shadow-card transition-colors hover:border-purple-400/60"
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        {/* 中文名优先，id 降为下面一行小字（复算路径要用它，不能抹）。没登记中文名的库
            （开放集，接入链随时会造新的）就只印 id，不编一个——与详情页同一条口径。 */}
        <h3
          className={
            hasDomainLabel(corpus.corpus) ? 'text-sm font-medium' : 'font-mono text-sm font-medium'
          }
        >
          {domainLabel(corpus.corpus)}
        </h3>
        <span
          className={
            corpus.available
              ? 'rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-200'
              : 'rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground'
          }
        >
          {BACKEND_LABEL[corpus.backend]}
        </span>
      </div>

      {hasDomainLabel(corpus.corpus) && (
        <p className="mb-2 font-mono text-[10px] text-muted-foreground">{corpus.corpus}</p>
      )}

      {corpus.scope && <p className="mb-2 text-[11px] text-muted-foreground">{corpus.scope}</p>}

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
        {corpus.chunks !== null && (
          <div>
            <dt className="text-[10px] text-muted-foreground">证据块</dt>
            <dd className="text-sm tabular-nums">{corpus.chunks}</dd>
          </div>
        )}
        {corpus.fitness && (
          <div>
            <dt className="text-[10px] text-muted-foreground">语料适配性</dt>
            <dd className="text-sm">
              <FitnessLight fitness={corpus.fitness} />
            </dd>
          </div>
        )}
        <div>
          <dt className="text-[10px] text-muted-foreground">入库管线</dt>
          <dd className="text-sm tabular-nums">
            {built} / {corpus.stations.length} 站已有处理结果
          </dd>
        </div>
        {corpus.concepts !== null && (
          <div>
            <dt className="text-[10px] text-muted-foreground">概念词表</dt>
            <dd className="text-sm tabular-nums">{corpus.concepts}</dd>
          </div>
        )}
        {/* 就绪度的两个字段（工单交付物 1 点名）：节级前置边条数、金标目录有没有建。
            金标那格的「未建」不是占位数，是与详情页第五站一致的事实。 */}
        {corpus.clauses !== null && (
          <div>
            <dt className="text-[10px] text-muted-foreground">前置边（节级）</dt>
            <dd className="text-sm tabular-nums">{corpus.clauses}</dd>
          </div>
        )}
        <div>
          <dt className="text-[10px] text-muted-foreground">覆盖率金标</dt>
          <dd className="text-sm tabular-nums">
            {corpus.goldFiles ? `${corpus.goldFiles} 个主题文件` : '未建'}
          </dd>
        </div>
        {updated && (
          <div>
            <dt className="text-[10px] text-muted-foreground">最近更新</dt>
            <dd className="text-[11px] tabular-nums">{updated}</dd>
          </div>
        )}
      </dl>

      {corpus.gates ? (
        <div className="flex flex-wrap gap-1.5">
          <Chip ok={corpus.gates.retrievable} label="可检索" />
          <Chip ok={corpus.gates.vocabulary} label="概念词表" />
          <Chip ok={corpus.gates.graph} label="前置图" />
          <Chip ok={corpus.gates.itemMapping} label="测项映射" />
          {corpus.license?.unknown && (
            <Chip ok={false} tone="warn" label={`许可 ${corpus.license.spdx} 待人工确认`} />
          )}
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          暂无就绪度报告。该库可能建立较早，或尚未完成当前接入流程；
          点开详情可查看五站的实际处理状态。
        </p>
      )}
    </Link>
  );
}

export function StationRow({ station }: { readonly station: PipelineStation }) {
  const updated = stamp(station.updatedAt);
  return (
    <li className="relative pl-7">
      <span
        className={`absolute left-0 top-1 size-3.5 rounded-full border-2 ${
          station.built ? 'border-emerald-500 bg-emerald-500/25' : 'border-border bg-muted'
        }`}
        aria-hidden
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className={`text-sm font-medium ${station.built ? '' : 'text-muted-foreground'}`}>
          {station.label}
        </h3>
        {station.built ? (
          station.detail && <span className="text-xs text-muted-foreground">{station.detail}</span>
        ) : (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            未建
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{station.what}</p>
      <p className="mt-1 text-[10px] text-muted-foreground/80">
        {station.built ? '系统已接收' : '等待处理'}
        {updated && <span className="ml-2 tabular-nums">最近处理时间 {updated}</span>}
      </p>
      {/* 扩展位：这一站的事件流（谁在什么时候跑了哪条命令、跑成什么样）挂在这里。
          现在没有任务系统，产物文件的 mtime 就是这一站唯一能拿到的「上次更新」。 */}
    </li>
  );
}
