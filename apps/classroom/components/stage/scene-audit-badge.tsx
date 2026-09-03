'use client';

/**
 * Per-scene hallucination-audit badge + verdict popover.
 *
 * Green shield = all claims verified; amber = flagged then revised; red =
 * issues remain (or the audit itself failed — honesty over silence). Clicking
 * opens the claim-level verdict trail so the control is inspectable, not a
 * vibe.
 */

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldX, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  arbiterLabel,
  judgePanelLabel,
  maskJudgeVerdict,
  modelDetailRows,
} from '@/components/agents/judge-labels';
import { domainLabel } from '@/lib/knowledge/domain-labels';
import type { VerificationMeta } from '@/lib/generation/content-verify';
import type { SceneAudit } from '@/lib/generation/hallucination-audit';

const VERDICT_STYLE: Record<
  SceneAudit['verdict'],
  { icon: typeof ShieldCheck; badge: string; label: string }
> = {
  pass: {
    icon: ShieldCheck,
    badge: 'text-emerald-600 dark:text-emerald-400',
    label: '事实审核通过',
  },
  caveat: {
    icon: ShieldAlert,
    badge: 'text-amber-600 dark:text-amber-400',
    label: '部分断言超出资料覆盖（已标注）',
  },
  revised: {
    icon: ShieldCheck,
    badge: 'text-sky-600 dark:text-sky-400',
    label: '审核标记错误后已修订',
  },
  flagged: {
    icon: ShieldX,
    badge: 'text-red-600 dark:text-red-400',
    label: '存在错误断言或审核未完成',
  },
};

const CLAIM_STYLE: Record<string, string> = {
  supported: 'text-emerald-600 dark:text-emerald-400',
  uncertain: 'text-amber-600 dark:text-amber-400',
  incorrect: 'text-red-600 dark:text-red-400',
};

const CLAIM_LABEL: Record<string, string> = {
  supported: '✓ 核实',
  uncertain: '? 存疑',
  incorrect: '✗ 有误',
};

const DECIDED_BY_LABEL: Record<string, string> = {
  consensus: '双审核共识',
  arbitration: '仲裁定谳',
};

const ARBITER_LABEL: Record<string, string> = {
  supported: '核实',
  uncertain: '存疑',
  incorrect: '有误',
  unresolved: '未决',
};

/** Claim-level provenance: source_id chips, title on hover. Nothing rendered when uncited. */
function SourceChips({ ids, sources }: { ids?: string[]; sources?: SceneAudit['sources'] }) {
  if (!ids?.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <span
          key={id}
          title={sources?.find((s) => s.source_id === id)?.title ?? '来源标题未随本次审核返回'}
          className="rounded border border-sky-300/70 bg-sky-50 px-1 text-[9px] font-mono leading-4 text-sky-700 dark:border-sky-800/60 dark:bg-sky-950/40 dark:text-sky-300"
        >
          {id}
        </span>
      ))}
    </span>
  );
}

/**
 * Cross-validation trail. `undefined` = single judge, so nothing is claimed;
 * `[]` = the panel ran and agreed, which is said out loud instead of being
 * dressed up as a debate.
 */
function DebatePanel({ audit }: { audit: SceneAudit }) {
  if (!audit.debate) return null;
  if (audit.debate.length === 0) {
    return (
      <p className="mb-2 rounded-md border border-emerald-300/60 bg-emerald-50/70 px-2 py-1.5 text-[10px] text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300">
        交叉验证：本场景两个审核智能体判定完全一致，无需仲裁。
      </p>
    );
  }
  return (
    <div className="mb-2 rounded-md border border-violet-300/60 bg-violet-50/70 px-2 py-1.5 dark:border-violet-800/50 dark:bg-violet-950/30">
      <p className="text-[11px] font-bold text-violet-700 dark:text-violet-300">
        仲裁 {audit.debate.length} 条分歧
        {audit.arbiterModel ? ` · 终审 ${arbiterLabel(audit.arbiterModel)}` : ' · 未配置仲裁模型'}
      </p>
      <ul className="mt-1 space-y-1.5 max-h-40 overflow-y-auto">
        {audit.debate.map((d, i) => (
          <li key={i} className="text-[10px] leading-snug">
            <span className="text-gray-700 dark:text-gray-300">{d.claim}</span>
            <span className="block text-gray-500 dark:text-gray-400">
              审核分歧：{d.judgeVerdicts.map(maskJudgeVerdict).join('；')}
            </span>
            <span className="block text-gray-500 dark:text-gray-400">作者答辩：{d.defense}</span>
            <span className="block font-medium text-violet-700 dark:text-violet-300">
              终审：{ARBITER_LABEL[d.arbiterVerdict] ?? d.arbiterVerdict} —— {d.rationale}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Claim-level re-retrieval trail. Failed rescues are shown alongside successful
 * ones on purpose: "we queried the corpus directly for this claim and it still
 * isn't there" is a stronger statement about coverage than silence, and hiding
 * it would make the step look more effective than it is.
 */
function RescuePanel({ audit }: { audit: SceneAudit }) {
  if (!audit.rescued?.length) return null;
  const recovered = audit.rescued.filter((r) => r.after !== r.before);
  return (
    <div className="mb-2 rounded-md border border-sky-300/60 bg-sky-50/70 px-2 py-1.5 dark:border-sky-800/50 dark:bg-sky-950/30">
      <p className="text-[11px] font-bold text-sky-700 dark:text-sky-300">
        断言级二次检索 {audit.rescued.length} 条 · 改判 {recovered.length} 条
      </p>
      <p className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
        场景级检索按标题取证据，可能召不回具体公式/数字所在的段落；这些断言用**断言原文**
        重新检索了一次知识库。
      </p>
      <ul className="mt-1 space-y-1 max-h-36 overflow-y-auto">
        {audit.rescued.map((r, i) => (
          <li key={i} className="text-[10px] leading-snug">
            <span className="text-gray-700 dark:text-gray-300">{r.claim}</span>
            <span
              className={cn(
                'block',
                r.after === 'supported'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : r.after === 'incorrect'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-gray-500 dark:text-gray-400',
              )}
            >
              存疑 → {CLAIM_LABEL[r.after] ?? r.after}（新检索到 {r.evidenceCount} 条证据）
              {r.reason ? ` —— ${r.reason}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerificationPanel({ verification }: { verification?: VerificationMeta }) {
  if (!verification) return null;
  const codeTotal =
    verification.codePassed + verification.codeFailed + verification.codeUnverifiable;
  const unknown = verification.codeUnverifiable + (verification.arithmeticUnverifiable ?? 0);
  const failed =
    verification.codeFailed + verification.arithmeticChecked - verification.arithmeticPassed;
  return (
    <div
      data-testid="scene-verification-summary"
      className={cn(
        'mb-2 rounded-md border px-2 py-1.5 text-[10px]',
        failed > 0
          ? 'border-red-300/60 bg-red-50/70 text-red-700 dark:border-red-800/50 dark:bg-red-950/30 dark:text-red-300'
          : unknown > 0
            ? 'border-amber-300/60 bg-amber-50/70 text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300'
            : 'border-emerald-300/60 bg-emerald-50/70 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-300',
      )}
    >
      <p className="font-bold">机械验算</p>
      <p>
        {codeTotal > 0 ? `代码 ${verification.codePassed}/${codeTotal} 已验证` : '无代码候选'}
        {' · '}数值 {verification.arithmeticPassed}/{verification.arithmeticChecked} 复核通过
        {unknown > 0 ? ` · ${unknown} 项未执行或不可安全解析` : ''}
      </p>
    </div>
  );
}

export function SceneAuditBadge({
  audit,
  verification,
}: {
  audit?: SceneAudit;
  verification?: VerificationMeta;
}) {
  const [open, setOpen] = useState(false);
  // 侧栏与场景列表都是 overflow-hidden，绝对定位的弹窗会被裁掉右侧大半。
  // 改为 fixed 定位：打开时记下按钮位置，并把左边界夹进视口。
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  if (!audit) return null;
  const style = VERDICT_STYLE[audit.verdict];
  const Icon = style.icon;
  // 旧记录只有单数 judgeModel，新记录是 judgeModels 数组——统一成数组再交给口径函数
  const judgeModels = audit.judgeModels?.length ? audit.judgeModels : [audit.judgeModel];

  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        data-testid="scene-audit-badge"
        data-tour="claim-badge"
        title={`${style.label} · ${audit.totalClaims} 条断言，${audit.flaggedCount} 条被标记`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          const width = 320;
          const vw = typeof window === 'undefined' ? width : window.innerWidth;
          setAnchor({ left: Math.max(8, Math.min(r.left, vw - width - 8)), top: r.bottom + 4 });
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        // 命中区实测只有 14×14（图标本身），达不到 2.5.8 AA 的 24×24。
        // 用「负外边距 + 等量内边距」把命中区撑到 26×26 而版面占位不变——
        // 徽标挤在场景标题右边，真长大 10px 会把标题挤掉一截。
        className={cn('inline-flex items-center -m-1.5 p-1.5 rounded', style.badge)}
      >
        <Icon className="w-3.5 h-3.5" />
      </button>

      {open && (
        <div
          data-testid="scene-audit-panel"
          onClick={(e) => e.stopPropagation()}
          style={anchor ? { position: 'fixed', left: anchor.left, top: anchor.top } : undefined}
          className="absolute left-0 top-5 z-50 w-80 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-3 shadow-xl text-left"
        >
          <div className="flex items-center justify-between gap-2 mb-2">
            {/* 判官小图：这一栏说的是「谁在审」，给它一张脸。纯装饰——
                判词本身在下面的文字里，读屏跳过它不丢信息。 */}
            <span className={cn('text-xs font-bold flex items-center gap-1.5', style.badge)}>
              <img
                src="/agents/ashen-a-bust.png"
                alt=""
                aria-hidden
                className="-my-1 size-8 shrink-0 select-none"
              />
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {style.label}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              aria-label="关闭审核详情"
              // 同上：12×12 的关闭图标撑到 24×24 命中区，位置不动
              className="-m-1.5 p-1.5 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {/* Gate ruling — what the verdict actually changed */}
          {audit.decision && (
            <div
              className={cn(
                'mb-2 rounded-md border px-2 py-1.5',
                audit.decision === 'block_pending_review'
                  ? 'border-red-300/60 bg-red-50/70 dark:border-red-800/50 dark:bg-red-950/30'
                  : audit.decision === 'publish_with_warnings'
                    ? 'border-amber-300/60 bg-amber-50/70 dark:border-amber-800/50 dark:bg-amber-950/30'
                    : 'border-emerald-300/60 bg-emerald-50/70 dark:border-emerald-800/50 dark:bg-emerald-950/30',
              )}
            >
              <p className="text-[11px] font-bold">
                门禁裁决：
                {audit.decision === 'block_pending_review'
                  ? '拦截·转人工复核'
                  : audit.decision === 'publish_with_warnings'
                    ? '带风险标记放行'
                    : '直接放行'}
              </p>
              <p className="text-[10px] text-gray-600 dark:text-gray-400 mt-0.5">
                {audit.rationale}
              </p>
            </div>
          )}

          <DebatePanel audit={audit} />
          <RescuePanel audit={audit} />
          <VerificationPanel verification={verification} />

          <p className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">
            {judgeModels.length > 1
              ? `交叉验证 · ${judgePanelLabel(judgeModels)}`
              : `独立审核 · ${judgePanelLabel(judgeModels)}`}{' '}
            · {audit.rounds} 轮 · {(audit.durationMs / 1000).toFixed(1)}s · 断言 {audit.totalClaims}{' '}
            条 / 标记 {audit.flaggedCount} 条
            <br />
            {audit.grounded ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                已接地 ·{' '}
                {/* 取材哪本书要写出来：换了知识库，页面上得看得出换了。
                    没记来源的旧场景照旧只说「受控知识库」，不补猜。 */}
                {audit.corpus ? `取材《${domainLabel(audit.corpus)}》· ` : '受控知识库 '}
                {audit.evidenceCount} 条证据
              </span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">
                未接地 · 审核智能体凭通用知识判定（知识库未命中或引擎离线）
              </span>
            )}
          </p>

          {/* 完整模型串默认收起：日常看课不需要，被追问时点开有据可查 */}
          <details data-testid="scene-audit-models" className="mb-2">
            <summary className="cursor-pointer text-[10px] text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
              详情：本场景用到的模型
            </summary>
            <ul className="mt-1 space-y-0.5">
              {modelDetailRows(judgeModels, audit.arbiterModel).map((row) => (
                <li key={row.role} className="text-[10px] leading-snug">
                  <span className="text-gray-600 dark:text-gray-300">{row.role}</span>
                  <span className="ml-1 font-mono text-gray-500 dark:text-gray-400 break-all">
                    {row.model}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          {audit.claims.length === 0 ? (
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {audit.verdict === 'flagged'
                ? '审核服务未能完成本场景核验，未拦截播放。'
                : '本场景无事实性断言（流程/互动类内容）。'}
            </p>
          ) : (
            <ul className="space-y-1.5 max-h-56 overflow-y-auto">
              {audit.claims.map((c, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span className={cn('font-bold mr-1', CLAIM_STYLE[c.verdict])}>
                    {CLAIM_LABEL[c.verdict]}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300">{c.claim}</span>
                  <SourceChips ids={c.sourceIds} sources={audit.sources} />
                  {c.decidedBy && (
                    <span className="ml-1 text-[9px] text-gray-500 dark:text-gray-400">
                      · {DECIDED_BY_LABEL[c.decidedBy]}
                    </span>
                  )}
                  {c.verdict !== 'supported' && (
                    <span className="block pl-3 text-gray-500 dark:text-gray-400">
                      {c.reason}
                      {c.fix ? ` → ${c.fix}` : ''}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </span>
  );
}
