/**
 * 课程审核账单表。按判错数降序——管理者第一眼要看到判官在哪门课抓得最狠。
 *
 * 徽标四色微条复用 scene-audit-badge 的四档语义（pass / caveat / revised / flagged）。
 * caveat 是「超出资料覆盖、已标注」，不是错误；revised 是「判错后已修订」。
 * 把四档压成一个通过率会让 caveat 和 flagged 变成同一件事，那是假的。
 */

import Link from 'next/link';

import type { CourseAudit } from '@/lib/server/admin-overview';
import type { CoverageRow } from '@/lib/server/knowledge-map';

const VERDICT_STYLE: Record<string, { readonly bg: string; readonly label: string }> = {
  pass: { bg: 'bg-emerald-500', label: '通过' },
  caveat: { bg: 'bg-amber-400', label: '超资料覆盖（已标注）' },
  revised: { bg: 'bg-sky-500', label: '判错后已修订' },
  flagged: { bg: 'bg-rose-500', label: '打回待人工' },
};

function VerdictBar({ verdicts }: { readonly verdicts: CourseAudit['verdicts'] }) {
  const total = Object.values(verdicts).reduce((a, b) => a + b, 0);
  if (!total) return <span className="text-[10px] text-muted-foreground">未审</span>;
  return (
    <span
      className="flex h-1.5 w-24 overflow-hidden rounded-full bg-muted"
      title={Object.entries(verdicts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${VERDICT_STYLE[k]?.label ?? k} ${n}`)
        .join(' · ')}
    >
      {Object.entries(verdicts).map(([k, n]) =>
        n > 0 ? (
          <span
            key={k}
            className={VERDICT_STYLE[k]?.bg ?? 'bg-muted-foreground'}
            style={{ width: `${(n / total) * 100}%` }}
          />
        ) : null,
      )}
    </span>
  );
}

/**
 * 生成时长这一格。**并发数必须一起给**：实测 32 个 job 里只有 5 个独占运行，
 * 其余与最多 5 个 job 时间区间重叠。只印「76 分」会被读成「一门课要 76 分钟」。
 */
function GeneratedCell({ course }: { readonly course: CourseAudit }) {
  if (!course.generatedMs) return <>—</>;
  const mins = Math.round(course.generatedMs / 60000);
  const n = course.concurrentJobs ?? 0;
  return (
    <span
      title={
        n > 0
          ? `实际经过 ${mins} 分；同期另有 ${n} 个生成任务，不能当作单门课程独占耗时`
          : `实际经过 ${mins} 分；本次没有其他生成任务重叠`
      }
    >
      {mins} 分
      {n > 0 && <span className="ml-0.5 text-[10px] text-muted-foreground">×{n + 1}并发</span>}
    </span>
  );
}

export function AdminCourseTable({
  courses,
  coverage = [],
}: {
  readonly courses: readonly CourseAudit[];
  /**
   * 覆盖率 run。设计稿 §2 区 B 点名要这一列——**只对 run 里记的那门课出数**：
   * 有的 run 测的课已被重生成版取代（见 `CoverageRow.courseStillOnWall`），
   * 那条数字不属于现在这门课，给它就是串账。
   */
  readonly coverage?: readonly CoverageRow[];
}) {
  if (courses.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
        课程墙是空的，没有课就没有审核账单。先在首页生成一门课程，
        这里会按判错数降序把每门课列出来。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card shadow-card">
      {/* 列宽显式给：课程名占一半，数字列各自压到刚够——
          原来十列全靠 auto 分宽，标题被挤成两行、数字列却空着半格 */}
      <table className="w-full min-w-[820px] text-sm tabular-nums">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          {['断言', '判错', '存疑', '引用源', '覆盖率', '审核耗时', '生成时长'].map((k) => (
            <col key={k} className="w-[7.4%]" />
          ))}
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-5 py-3 font-medium">课程</th>
            <th className="px-3 py-3 font-medium whitespace-nowrap">场景</th>
            <th className="px-3 py-3 font-medium whitespace-nowrap">徽标分布</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">断言</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">判错</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">存疑</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">引用源</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">覆盖率</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">审核耗时</th>
            <th className="px-3 py-3 text-right font-medium whitespace-nowrap">生成时长</th>
          </tr>
        </thead>
        <tbody>
          {courses.map((c) => {
            // 只认 run 里记的那门课。不做「同主题就算」的模糊匹配——
            // 那正是 08-13 那次两个数字打架的成因。
            const cov = coverage.find((r) => r.courseId === c.id);
            return (
              <tr
                key={c.id}
                className="border-b border-border/60 last:border-0 hover:bg-accent/50 transition-colors"
              >
                <td className="px-5 py-3.5">
                  <Link
                    href={`/admin/course/${c.id}`}
                    className="font-medium hover:text-purple-600 transition-colors"
                  >
                    {c.title}
                  </Link>
                </td>
                <td className="px-3 py-3.5 tabular-nums text-muted-foreground whitespace-nowrap">
                  {c.auditedScenes}/{c.sceneCount}
                </td>
                <td className="px-3 py-3.5">
                  <VerdictBar verdicts={c.verdicts} />
                </td>
                <td className="px-3 py-3.5 text-right tabular-nums">{c.claims}</td>
                <td className="px-3 py-3.5 text-right tabular-nums font-medium">{c.incorrect}</td>
                <td className="px-3 py-3.5 text-right tabular-nums text-muted-foreground">
                  {c.uncertain}
                </td>
                <td className="px-3 py-3.5 text-right tabular-nums text-muted-foreground">
                  {c.sources}
                </td>
                <td
                  className="px-3 py-3.5 text-right tabular-nums text-muted-foreground"
                  title={
                    cov
                      ? `金标 ${cov.topic}：${Math.round(cov.coverage * cov.total)}/${cov.total} 个知识点`
                      : '这门课没有金标知识点清单，覆盖率没测过——不补 0 也不补估计值'
                  }
                >
                  {cov ? `${(cov.coverage * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="px-3 py-3.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {c.durationMs ? `${Math.round(c.durationMs / 60000)} 分` : '—'}
                </td>
                <td className="px-3 py-3.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  <GeneratedCell course={c} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
