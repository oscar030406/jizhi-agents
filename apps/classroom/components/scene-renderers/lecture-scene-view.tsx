'use client';

/**
 * 讲义场景渲染器——slide 场景在学习者端的唯一形态（2026-08-03 用户裁决：
 * 取消幻灯片放映，主画布直接呈现讲义；教具/测验/PBL 场景照旧，按场景序列
 * 与讲义节自然交错）。
 *
 * 数据源：主路径是讲义 md 转出的单栏 DSL（lib/generation/md-to-elements.ts，
 * top 递增假布局，线性化零交错）；回退路径（槽位模板/自由版面）仍是真幻灯片
 * DSL，按版面序（top,left）线性化。摘录块复用 ExcerptBlockView。
 * 讲解（speech）不进正文——由 agent 讨论区同步播讲、右侧笔记栏留档。
 * spotlight/laser 等画布动作是 fire-and-forget 写 canvasStore，此形态下
 * 无叠加层消费，天然静默，不需要过滤。
 *
 * 评测依据：讲义形态开卷 1.40 vs 幻灯片 1.15（docs/05-evidence/eval_rerun 第5节），
 * 用户两轮实测批幻灯片版面后定案。
 *
 * 朱批层（public-site-redesign §0-bis 评点本）：判官核验过的断言画朱砂细
 * 下划线，点开眉批卡看判定与理由。批注在挂载后叠加（DOMParser 仅浏览器有，
 * 且首帧保持与 SSR 输出一致避免水合冲突）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  parseExcerptFromHtml,
  ExcerptBlockView,
} from '@/components/slide-renderer/components/element/TextElement/ExcerptBlock';
import { annotateClaimsInHtml } from '@/lib/generation/claim-annotate';
import { ExternalAidsForScene } from '@/components/aids/external-aid-card';
import {
  PracticeCard,
  projectsForCourse,
  usePublishedPractice,
} from '@/components/skills/practice-projects';
import { useCourseDomains } from '@/lib/knowledge/use-course-domains';
import { useStageStore } from '@/lib/store';
import type { AuditClaim } from '@/lib/generation/hallucination-audit';
import type { Scene } from '@/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';

interface LectureSceneViewProps {
  readonly scene: Scene;
}

interface PositionedBlock {
  html: string;
  top: number;
  left: number;
  mono: boolean;
  /** image 元素的 src（http/data URL）——讲义流里按序渲染成插图 */
  imageSrc?: string;
}

function textFlow(scene: Scene): PositionedBlock[] {
  const content = scene.content as
    | { canvas?: { elements?: PPTElement[] }; elements?: PPTElement[] }
    | undefined;
  const elements = Array.isArray(content?.canvas?.elements)
    ? content.canvas.elements
    : Array.isArray(content?.elements)
      ? content.elements
      : [];
  return elements
    .filter((el) => {
      const e = el as { type?: string; content?: unknown; src?: unknown };
      if (e.type === 'text' && typeof e.content === 'string') return true;
      // 图片元素也进阅读流（回退路径生成的幻灯片可能带 PDF 插图，
      // 只认已解析出真实 URL 的，占位 id（img_1/gen_img_x）跳过）
      return (
        e.type === 'image' &&
        typeof e.src === 'string' &&
        (e.src.startsWith('data:') || e.src.startsWith('http') || e.src.startsWith('/'))
      );
    })
    .map((el) => {
      const e = el as unknown as {
        type: string;
        content?: string;
        src?: string;
        top?: number;
        left?: number;
        defaultFontName?: string;
      };
      if (e.type === 'image') {
        return { html: '', top: e.top ?? 0, left: e.left ?? 0, mono: false, imageSrc: e.src };
      }
      const content = e.content ?? '';
      return {
        html: content,
        top: e.top ?? 0,
        left: e.left ?? 0,
        // 代码块判定：defaultFontName 或首个 <p> 自身 style 是等宽。
        // 不能全文 sniff——含行内 <code>（自带 font-family: Consolas）的普通
        // 段落会被误判成代码块，整段套深底、行内浅底衬变"涂黑"（用户实拍）。
        mono:
          /consolas|monospace|courier/i.test(e.defaultFontName ?? '') ||
          /^<p[^>]*font-family:\s*(consolas|monospace|courier)/i.test(content.trim()),
      };
    })
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

const VERDICT_META: Record<AuditClaim['verdict'], { label: string; cls: string; barCls: string }> =
  {
    supported: { label: '审核智能体核验过', cls: 'text-annot-zhu', barCls: 'border-annot-zhu' },
    uncertain: {
      label: '教材覆盖之外 · 存疑',
      cls: 'text-annot-zhe',
      barCls: 'border-annot-zhe',
    },
    incorrect: { label: '审核判定有误', cls: 'text-red-deep', barCls: 'border-red-deep' },
  };

interface MarginNoteState {
  index: number;
  top: number;
  left: number;
}

/** 眉批卡：点开被朱批的句子后浮在其下方。数据全部来自真实审核记录。 */
function MarginNote({
  claim,
  sources,
  onClose,
}: {
  readonly claim: AuditClaim;
  readonly sources?: Array<{ source_id: string; title: string }>;
  readonly onClose: () => void;
}) {
  const meta = VERDICT_META[claim.verdict];
  const titleOf = (id: string) => sources?.find((s) => s.source_id === id)?.title;
  return (
    <div
      className={`w-80 max-w-[85vw] rounded-lg border-l-[3px] ${meta.barCls} border border-border bg-popover p-3 shadow-dropdown`}
      role="dialog"
      aria-label="审核批注"
    >
      <div className="flex items-start justify-between gap-2">
        <p className={`text-xs font-semibold ${meta.cls}`}>{meta.label}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭批注"
          className="-mr-1 -mt-1 rounded px-1.5 text-sm leading-none text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground">{claim.reason}</p>
      {claim.verdict === 'incorrect' && claim.fix && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          修正表述：{claim.fix}
        </p>
      )}
      {(claim.sourceIds?.length ?? 0) > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {claim.sourceIds!.map((id) => {
            const title = titleOf(id);
            return (
              <span
                key={id}
                className="rounded border border-blue-deep/40 px-1.5 py-px font-mono text-[10px] text-blue-deep"
                title={title ? `《${title}》` : undefined}
              >
                {title ? `《${title}》 ${id}` : id}
              </span>
            );
          })}
        </div>
      )}
      {claim.decidedBy && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          {claim.decidedBy === 'consensus' ? '两个审核智能体一致' : '审核分歧，仲裁裁决'}
        </p>
      )}
    </div>
  );
}

/**
 * 「动手做」区块 —— 课程收尾处挂本课对口的站外实操项目。
 *
 * 挂载点选在**全课最后一张讲义页的正文末尾**，理由三条：
 *   1. 判据是「学完这门课能上手做什么」，位置就该在讲完之后，不在中途抢注意力；
 *   2. 讲义页是全课唯一的滚动阅读流，往下滚到底就是它，不需要额外的入口；
 *   3. 结课页（ClassroomCompletePage）看着更合适，但它挂在 isCourseComplete 上，
 *      而课程墙上的课是落盘读入的：outlines 为空、generationComplete=false，
 *      那一页对这 23 门课根本不出现（本单实测，见报告「新发现」）。
 * 取最后一张**讲义**页而不是最后一个场景：4 门课以测验收尾（评测入门/线代/
 * 训练全流程/大模型入门），挂在最后一个场景上这 4 门就没有了。
 *
 * 项目只取本课所属 corpus 的引擎发布结果。域未解析、加载失败或没有发布结果时
 * 不会退回 AI 示例卡，避免外域课程被另一领域内容污染。
 */
function CoursePracticeBlock({ scene }: { readonly scene: Scene }) {
  const scenes = useStageStore((s) => s.scenes);
  const courseDomains = useCourseDomains();
  const lastLectureId = useMemo(() => {
    for (let i = scenes.length - 1; i >= 0; i--) {
      if (scenes[i].type === 'slide') return scenes[i].id;
    }
    return null;
  }, [scenes]);
  const isLastLecture = scene.id === lastLectureId;
  const courseDomain = courseDomains[scene.stageId];
  const corpus = isLastLecture ? (courseDomain?.corpus ?? courseDomain?.domain ?? null) : null;
  const practiceState = usePublishedPractice(corpus);
  const projects = useMemo(
    () =>
      practiceState.kind === 'ready'
        ? projectsForCourse(practiceState.projects, scene.stageId)
        : [],
    [practiceState, scene.stageId],
  );
  if (!isLastLecture || !corpus) return null;

  if (practiceState.kind !== 'ready') {
    if (practiceState.kind === 'loading') return null;
    return (
      <section className="mt-10 border-t border-border pt-6" data-testid="course-practice-status">
        <h2 className="text-lg font-semibold tracking-tight">动手做</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{practiceState.reason}</p>
      </section>
    );
  }
  if (projects.length === 0) return null;

  return (
    <section className="mt-10 border-t border-border pt-6" data-testid="course-practice-block">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold tracking-tight">动手做</h2>
        <span className="text-xs text-muted-foreground">这门课学完可以上手的项目，做完有作品</span>
      </div>
      <div className="mt-3 space-y-2">
        {projects.map((p) => (
          <PracticeCard key={p.id} project={p} corpus={corpus} />
        ))}
      </div>
    </section>
  );
}

export function LectureSceneView({ scene }: LectureSceneViewProps) {
  const blocks = useMemo(() => textFlow(scene), [scene]);
  const claims = scene.audit?.claims;
  const sources = scene.audit?.sources;

  // 朱批只在挂载后叠加：DOMParser 是浏览器 API，且首帧必须与 SSR 输出
  // 一字不差（dangerouslySetInnerHTML 的水合比较是字符串级）。
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载后才可安全使用 DOMParser
  useEffect(() => setMounted(true), []);
  const annotated = useMemo(() => {
    if (!mounted || !claims?.length) return null;
    return blocks.map((b) =>
      b.imageSrc || b.mono || parseExcerptFromHtml(b.html)
        ? b.html
        : annotateClaimsInHtml(b.html, claims),
    );
  }, [mounted, blocks, claims]);

  const articleRef = useRef<HTMLElement>(null);
  const [note, setNote] = useState<MarginNoteState | null>(null);

  useEffect(() => {
    if (!note) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNote(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [note]);

  // 跨行内标签的断言会被切成多枚同号 span，:hover 只亮鼠标那一枚——
  // 委托 mouseover/out 把同号 span 一起点亮（data-annot-open 复用打开态样式）
  const setGroupHover = (e: React.MouseEvent, on: boolean) => {
    const hit = (e.target as Element).closest?.('[data-annot]');
    if (!hit || !articleRef.current) return;
    const idx = hit.getAttribute('data-annot');
    articleRef.current.querySelectorAll(`[data-annot="${idx}"]`).forEach((s) => {
      if (on) s.setAttribute('data-annot-open', 'true');
      else if (note?.index !== Number(idx)) s.removeAttribute('data-annot-open');
    });
  };

  const placeNote = (index: number, hit?: Element | null) => {
    const article = articleRef.current;
    const anchor = hit ?? article?.querySelector(`[data-annot="${index}"]`);
    if (!article || !anchor) return;
    const a = article.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    setNote({
      index,
      top: r.bottom - a.top + 6,
      left: Math.max(0, Math.min(r.left - a.left, a.width - 340)),
    });
  };

  // 文字重排（窗口缩放、侧栏拖宽）后眉批卡的像素坐标失效——
  // 观察 article 尺寸变化，重新按锚点句定位。
  const noteIndex = note?.index;
  useEffect(() => {
    if (noteIndex === undefined || !articleRef.current) return;
    const reposition = () => placeNote(noteIndex);
    const ro = new ResizeObserver(reposition);
    ro.observe(articleRef.current);
    window.addEventListener('resize', reposition);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reposition);
    };
  }, [noteIndex]);

  const handleClick = (e: React.MouseEvent) => {
    const hit = (e.target as Element).closest?.('[data-annot]');
    if (!hit || !articleRef.current) {
      setNote(null);
      return;
    }
    const index = Number(hit.getAttribute('data-annot'));
    if (!Number.isFinite(index)) return;
    placeNote(index, hit);
  };

  /** 朱批句的键盘入口：它是 span，回车/空格要自己接（WCAG 2.1.1）。 */
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const hit = (e.target as Element).closest?.('[data-annot]');
    if (!hit || !articleRef.current) return;
    const index = Number(hit.getAttribute('data-annot'));
    if (!Number.isFinite(index)) return;
    e.preventDefault(); // 空格默认滚屏
    placeNote(index, hit);
  };

  return (
    <div className="h-full w-full overflow-y-auto bg-background" data-testid="lecture-scene">
      {/* 讲义主体靠左（2026-08-03 定稿：右侧留给对话/导学/笔记三栏），不居中 */}
      {/* 排版三处实测改动（2026-08-13）。学习者盯这一屏的时间最长，先量再改：
          - 375px 下 `pl-10 pr-8` 固定吃掉 72px，占 345px 画布的 21%，
            每行只剩 **17 个汉字**（合理区间 35–45）。窄屏换成 px-4，19.5 字/行。
            1440 下 43 字/行本来就在区间上沿，桌面尺寸保持不动。
          - 行距 1.625 是拉丁文的取值。Linear / Vercel / shadcn 三家正文都是 16/24=1.5，
            但汉字字面大、没有升降部留白，中文要在此基础上抬一档 → 1.75。 */}
      <article
        ref={articleRef}
        className="relative max-w-3xl px-4 py-8 leading-[1.75] md:pl-10 md:pr-8 md:py-10"
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onMouseOver={(e) => setGroupHover(e, true)}
        onMouseOut={(e) => setGroupHover(e, false)}
      >
        {blocks.map((b, i) => {
          if (b.imageSrc) {
            return (
              <img
                key={i}
                src={b.imageSrc}
                alt=""
                className="my-5 max-w-full rounded-lg border border-border"
              />
            );
          }
          const excerpt = parseExcerptFromHtml(b.html);
          if (excerpt) {
            return (
              <div key={i} className="my-5">
                <ExcerptBlockView block={excerpt} />
              </div>
            );
          }
          if (b.mono) {
            return (
              <div
                key={i}
                className="my-4 rounded-lg bg-[#332f2b] px-4 py-3 text-[#e8e4dd] text-[13px] leading-relaxed overflow-x-auto [&_p]:my-0.5"
                dangerouslySetInnerHTML={{ __html: b.html }}
              />
            );
          }
          return (
            <div
              key={i}
              // 课件内容来自我们自己的生成链（受控 HTML），与原幻灯片渲染同源
              // 段内 `<p>` 间距原来是 6px = 行高的 23%，段落连成一片读不出分段。
              // 抬到 12px（行高的一半）。块间距 my-3(12px) 抬到 my-6(24px)——
              // 「同区块内的块间距 24px」是 Linear/Vercel/Stripe 三家实测的共同档位。
              className="lecture-block my-6 [&_p]:my-3 [&_strong]:font-semibold [&_h1]:text-xl [&_h2]:text-lg"
              dangerouslySetInnerHTML={{ __html: annotated?.[i] ?? b.html }}
            />
          );
        })}
        {blocks.length === 0 && <p className="text-sm text-muted-foreground">本节暂无讲义内容。</p>}
        <ExternalAidsForScene sceneId={scene.id} />
        <CoursePracticeBlock scene={scene} />
        {note && claims?.[note.index] && (
          <div className="absolute z-20" style={{ top: note.top, left: note.left }}>
            <MarginNote
              claim={claims[note.index]}
              sources={sources}
              onClose={() => setNote(null)}
            />
          </div>
        )}
      </article>
    </div>
  );
}
