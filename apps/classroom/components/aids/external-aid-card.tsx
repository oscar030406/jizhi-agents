'use client';

// 外部可视化教具的共享客户端与展示卡。
//
// 我们自己生成的互动教具做不过 transformer-explainer、CNN Explainer 这类被课堂用过
// 多年的成品，所以不硬做，改成把它们指给学习者。运行时唯一真源是引擎 teaching-aids
// 的已发布结果（管理员逐条审核过），前端不做任何兜底推荐。
//
// 两条边界写在这里，别绕开：
// 1. 只有 `embeddable`（起草时按演示站响应头实测：没有 X-Frame-Options、CSP 没限制
//    frame-ancestors）才给内嵌按钮。嵌不进去时 iframe 是一片空白，比给个链接更糟。
// 2. 内嵌的是第三方站点，必须当着学习者的面说清楚是谁家的、不是本站生成的。

import { useEffect, useState } from 'react';

import { pickPrimaryConcept, conceptVotesForScene } from '@/lib/evidence/scene-concepts';
import { useCourseDomains } from '@/lib/knowledge/use-course-domains';
import { useStageStore } from '@/lib/store';

export interface ExternalAid {
  id: string;
  /** 概念图里的概念 ID（llm_basics / rag / deep_learning …）。 */
  concept: string;
  name: string;
  what_it_shows: string;
  /** 课堂操作单，3–5 步。 */
  use_in_class: string[];
  duration_minutes: number;
  level: 'starter' | 'advanced';
  /** 仓库地址。 */
  url: string;
  /** 公开演示站，仓库没填 homepage 或站点打不开时为 null。 */
  demo_url: string | null;
  /** 演示站是否允许被我们 iframe。起草时按响应头实测，不是猜的。 */
  embeddable: boolean;
  provenance?: { license?: string; stars?: number; pushed_at?: string };
}

/** 许可证一行。拉不到就说拉不到，不写「未知」当成一种许可证。 */
export function aidLicenseNote(aid: ExternalAid): string {
  const license = aid.provenance?.license?.trim();
  if (!license || license === '无许可证信息') return '仓库未标注开源许可证';
  if (license === 'NOASSERTION') return '许可证未被 GitHub 识别';
  return `许可证 ${license}`;
}

/** 演示站域名，用于第三方提示语点名是谁家的站点。 */
export function demoHost(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 某个概念下的教具。概念对不上就返回空数组——**不退回「随便给几个」**：
 * 讲注意力的那一屏底下挂个 RAG 演示，比什么都不挂更让人困惑。
 */
export function aidsForConcept(aids: ExternalAid[], concept: string | null): ExternalAid[] {
  if (!concept) return [];
  return aids.filter((aid) => aid.concept === concept);
}

type AidLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; aids: ExternalAid[] }
  | { kind: 'missing'; reason: string }
  | { kind: 'unavailable'; reason: string };

/** 当前领域已发布的外部教具。结果与 corpus 绑定，切域当帧即失效旧数组。 */
export function usePublishedAids(corpus: string | null): AidLoadState {
  const [loaded, setLoaded] = useState<{ corpus: string; state: AidLoadState } | null>(null);

  useEffect(() => {
    if (!corpus) return;
    let alive = true;
    (async () => {
      try {
        const response = await fetch(`/api/teaching-aids/${encodeURIComponent(corpus)}`, {
          cache: 'no-store',
        });
        const body = (await response.json().catch(() => null)) as {
          status?: string;
          aids?: ExternalAid[];
          reason?: string;
        } | null;
        if (!alive) return;
        if (!response.ok || body?.status === 'unavailable') {
          setLoaded({
            corpus,
            state: {
              kind: 'unavailable',
              reason: body?.reason ?? '教具服务暂时不可用，当前无法确认发布状态。',
            },
          });
          return;
        }
        const aids = body?.aids ?? [];
        setLoaded({
          corpus,
          state: aids.length
            ? { kind: 'ready', aids }
            : {
                kind: 'missing',
                reason: body?.reason ?? '所属机构尚未发布该领域的外部教具。',
              },
        });
      } catch {
        if (alive) {
          setLoaded({
            corpus,
            state: {
              kind: 'unavailable',
              reason: '教具服务暂时不可用，当前无法确认发布状态。',
            },
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [corpus]);

  if (!corpus) return { kind: 'missing', reason: '当前学习领域尚未确认，暂时没有可读取的教具。' };
  return loaded?.corpus === corpus ? loaded.state : { kind: 'loading' };
}

const LEVEL_LABEL: Record<ExternalAid['level'], string> = {
  starter: '零基础可跟',
  advanced: '需要基础',
};

export function ExternalAidCard({ aid }: { aid: ExternalAid }) {
  const [embedded, setEmbedded] = useState(false);
  const host = demoHost(aid.demo_url);

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="text-base font-medium">{aid.name}</h4>
        <span className="text-xs text-muted-foreground">
          {LEVEL_LABEL[aid.level]} · 约 {aid.duration_minutes} 分钟
        </span>
      </div>

      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{aid.what_it_shows}</p>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
        {aid.use_in_class.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{aidLicenseNote(aid)}</span>
        {typeof aid.provenance?.stars === 'number' && <span>GitHub {aid.provenance.stars} 星</span>}
        <a className="underline hover:text-foreground" href={aid.url} target="_blank" rel="noreferrer">
          源码仓库
        </a>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {aid.demo_url && (
          <a
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
            href={aid.demo_url}
            target="_blank"
            rel="noreferrer"
          >
            打开演示
          </a>
        )}
        {aid.demo_url && aid.embeddable && (
          <button
            type="button"
            className="rounded border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onClick={() => setEmbedded((open) => !open)}
          >
            {embedded ? '收起' : '在这里打开'}
          </button>
        )}
      </div>

      {embedded && aid.demo_url && (
        <div className="mt-3">
          <p className="mb-1 text-xs text-muted-foreground">
            这是第三方站点 {host}，内容不由本站生成
          </p>
          {/* 跨源内容：allow-same-origin 只是让对方页面保住它自己的源，拿不到本站的。 */}
          <iframe
            src={aid.demo_url}
            title={aid.name}
            height={480}
            className="w-full rounded border border-border"
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
          />
        </div>
      )}
    </article>
  );
}

/**
 * 一屏底下的教具区块。概念对不上、还没发布、服务不可达都渲染 null——
 * 正文旁边多一句「暂无」对学习者没有价值，这里不是管理端。
 */
export function ExternalAidsForConcept({
  corpus,
  concept,
}: {
  corpus: string | null;
  concept: string | null;
}) {
  const state = usePublishedAids(corpus);
  if (state.kind !== 'ready') return null;
  const matched = aidsForConcept(state.aids, concept);
  if (!matched.length) return null;

  return (
    <section className="mt-6">
      <h3 className="text-sm font-medium">动手看：外部可视化教具</h3>
      <div className="mt-3 space-y-3">
        {matched.map((aid) => (
          <ExternalAidCard key={aid.id} aid={aid} />
        ))}
      </div>
    </section>
  );
}

/**
 * 挂在一屏底下的教具区块，自己解析这一屏讲的是哪个概念。
 *
 * 概念判据与 /api/course-path 那条完全一致：场景自带的概念票优先，没有就查
 * 反推表，再用 `pickPrimaryConcept` 取主概念。**不退回场景标题**——标题不是概念 ID，
 * 拿它去匹配教具只会一个都匹配不上，或者更糟，匹配错。
 */
export function ExternalAidsForScene({ sceneId }: { sceneId: string }) {
  const scene = useStageStore((s) => s.scenes.find((item) => item.id === sceneId));
  const courseDomains = useCourseDomains();
  const domain = scene ? courseDomains[scene.stageId] : undefined;
  const votes =
    (scene as { concepts?: { votes?: Record<string, number> } } | undefined)?.concepts?.votes ??
    conceptVotesForScene(sceneId);
  return (
    <ExternalAidsForConcept
      corpus={domain?.corpus ?? domain?.domain ?? null}
      concept={pickPrimaryConcept(votes)}
    />
  );
}
