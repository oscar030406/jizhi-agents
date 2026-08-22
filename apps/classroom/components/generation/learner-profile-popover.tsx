'use client';

/**
 * Learner profile intake — the entry point for skill-training adaptation.
 *
 * Five prior-knowledge dimensions plus domain / education / role. Each dimension
 * is asked as a single behavioral-fact question (what have you actually done),
 * not a 0–4 self-rating: self-assessed knowledge correlates only r≈.34 with
 * measured learning, while "have you done X" items carry nearly the same
 * information as fine-grained scales. Mapping rule: the selected option's index
 * IS the 0–4 level stored in LearnerProfileFields — field names and numeric
 * shape are unchanged, so the engine's diagnosis agent
 * (lib/generation/learner-profile.ts) needs no changes. Persisted locally so a
 * demo doesn't have to re-enter it; nothing leaves the machine except the
 * profile fields themselves — no identity, no free-text notes.
 */

import { useEffect, useRef, useState } from 'react';
import { UserCog } from 'lucide-react';
import { useAccountStore } from '@/lib/store/account';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { LearnerProfileFields } from '@/lib/types/generation';
import { domainLabel, TRAINING_DOMAINS } from '@/lib/knowledge/domain-labels';
import { isScratchCorpus, truncateLabel } from '@/lib/knowledge/domain-registry';
import { ProfileImpactPreview } from '@/components/generation/profile-impact-preview';
import type { PretestDimResult, PretestQuestion } from '@/app/api/pretest/route';

const STORAGE_KEY = 'learnerProfile';

/** 前测校准维度（弱侧三维） → 画像字段。自评当先验，前测校正档位（r≈.29，Park 2019）。 */
const PRETEST_DIMS: Array<{ dim: string; field: keyof LearnerProfileFields }> = [
  { dim: 'agent', field: 'agent_level' },
  { dim: 'rag', field: 'rag_level' },
  { dim: 'engineering', field: 'engineering_level' },
];

export const DEFAULT_LEARNER_PROFILE: LearnerProfileFields = {
  domain: 'ai',
  education: 'bachelor',
  role: '在校学生',
  programming_level: 1,
  python_level: 1,
  agent_level: 0,
  rag_level: 0,
  engineering_level: 1,
  expected_performance: 2,
  learning_preference: '可运行示例与分步练习',
  time_budget_hours: 24,
};

/** Presets that make the adaptation visible in one click during a demo. */
const PRESETS: Array<{ id: string; label: string; hint: string; fact: string; patch: LearnerProfileFields }> = [
  {
    id: 'zero',
    label: '零基础转行',
    hint: '非计算机专业，全维近零',
    fact: '没写过程序，只用过 ChatGPT 类产品，没部署过任何东西',
    patch: {
      role: '非计算机专业转行',
      education: 'college',
      programming_level: 0,
      python_level: 0,
      agent_level: 0,
      rag_level: 0,
      engineering_level: 0,
      learning_preference: '生活类比和分步练习',
    },
  },
  {
    id: 'backend',
    label: '后端转型',
    hint: '工程强、AI 栈新',
    fact: '工作里日常写代码、部署过生产服务，但只用过 ChatGPT 类产品',
    patch: {
      role: '后端开发转 Agent 应用',
      education: 'bachelor',
      programming_level: 3,
      python_level: 3,
      agent_level: 1,
      rag_level: 1,
      engineering_level: 3,
      learning_preference: '系统设计、接口契约和扩展 TODO',
    },
  },
  {
    id: 'researcher',
    label: '科研/竞赛',
    hint: '理论强、工程弱',
    fact: '独立写过小工具、用别人的库搭过 RAG demo，但没部署过任何东西',
    patch: {
      role: '懂算法原理、工程落地弱',
      education: 'master',
      programming_level: 2,
      python_level: 2,
      agent_level: 1,
      rag_level: 2,
      engineering_level: 0,
      learning_preference: '架构图、接口说明和测试驱动',
    },
  },
];

/**
 * Behavioral-fact questions. Mapping rule: option index === stored 0–4 level.
 * Do not reorder options — the index is the value the engine consumes.
 */
const DIMENSIONS: Array<{ key: keyof LearnerProfileFields; question: string; options: string[] }> = [
  {
    key: 'programming_level',
    question: '编程 · 你写程序的经历最接近哪种？',
    options: [
      '没写过程序',
      '上过课，写过作业',
      '独立写过小工具',
      '工作或项目里日常写',
      '多语言且做过架构设计',
    ],
  },
  {
    key: 'python_level',
    question: 'Python · 你用 Python 做过什么？',
    options: [
      '没用过',
      '写过脚本',
      '用过第三方库写过模块',
      '写过带测试的完整项目',
      '做过性能调优或发过包',
    ],
  },
  {
    key: 'agent_level',
    question: 'Agent · 你和大模型打过什么交道？',
    options: [
      '只听说过',
      '用过 ChatGPT 类产品',
      '调过 LLM API',
      '写过带工具调用的完整 Agent',
      '设计过多 Agent 系统',
    ],
  },
  {
    key: 'rag_level',
    question: 'RAG · 你接触检索增强生成到哪一步？',
    options: [
      '不知道是什么',
      '知道概念',
      '用别人的库搭过 demo',
      '自己搭过检索+生成链路',
      '调优过检索质量',
    ],
  },
  {
    key: 'engineering_level',
    question: '工程 · 你部署过什么？',
    options: [
      '没部署过任何东西',
      '本地跑通过 demo',
      '部署过单服务',
      '有生产环境经验',
      '有高并发或可观测性实践',
    ],
  },
  {
    key: 'expected_performance',
    question: '预期 · 你预期自己学这门课的表现如何？',
    options: ['可能很吃力', '有点吃力', '一般', '比较顺利', '很有把握'],
  },
];

// 名单真源在 `lib/knowledge/domain-labels.ts`；这里转出，老调用点的 import 路径不动。
export const DOMAINS = TRAINING_DOMAINS;

/**
 * 已建好索引的知识库。
 *
 * 先问运行时接口 `/api/skills`（引擎 `_corpus_status()` 的公开代理，与 /skills 页同一路），
 * 拿不到再退到部署时快照 `public/skill-map.json`。顺序不能反：新建好的库要在**不重新部署**
 * 的前提下出现在这个下拉里，快照做不到这件事（它是构建期产物）。
 * 管理端那条 `/api/knowledge/corpora` 也实时，但只对管理者开放（语料路径、许可状态是
 * 机构内部信息），生成入口是学习者在用，走不了。
 * 这里只取名字与块数，不取路径与许可。「能不能生成」仍由服务端实时读盘判，不信这份名单。
 */
interface BuiltCorpus {
  corpus: string;
  chunks: number;
}

/** 运行时优先、快照兜底。两路返回体同形（route.ts 的 apiSuccess 是扁平的）。 */
async function loadBuiltCorpora(): Promise<BuiltCorpus[]> {
  for (const url of ['/api/skills', '/skill-map.json']) {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      // 引擎离线时 /api/skills 是 204（ok 但没 body），直接退下一路。
      if (!resp.ok || resp.status === 204) continue;
      const payload = (await resp.json()) as {
        corpora?: Array<{
          corpus?: string;
          available?: boolean;
          eligible?: boolean;
          chunk_count?: number;
        }>;
      };
      const built = (payload.corpora ?? [])
        // `eligible` 是引擎那侧「够不够格对外露面」的完整判词（四条取与：可检索、
        // 块数够、词表闸、试跑不降级）。原先只看 `available`（索引加载得出来），
        // 当前数据下恰好等价，但一个正常命名、能检索、没过质量闸的库会漏进来——
        // 学习者选中它，生成的课要么资料不足要么质量没兜底。
        // 老接口没有这个字段时退回 `available`，不因为字段缺失把下拉清空。
        .filter((c) => (c.eligible ?? c.available) && typeof c.corpus === 'string')
        // 一次性验证库（*-probe/-test/-tmp/-scratch）不给学习者看——双保险：
        // 引擎侧 eligible 已判，这里按命名约定再拦一道。上次 fullpath-probe
        // 漏进这个下拉，就是因为唯一那道闸换了判据（跳过被当失败的镜像事故）。
        .filter((c) => !isScratchCorpus(c.corpus as string))
        .map((c) => ({ corpus: c.corpus as string, chunks: Number(c.chunk_count ?? 0) }));
      if (built.length) return built;
    } catch {
      /* 这一路取不到就试下一路 */
    }
  }
  return [];
}

const EDUCATIONS = [
  { id: 'high_school', label: '高中/中专' },
  { id: 'college', label: '专科' },
  { id: 'bachelor', label: '本科' },
  { id: 'master', label: '硕士+' },
];

export function loadLearnerProfile(): LearnerProfileFields {
  if (typeof window === 'undefined') return DEFAULT_LEARNER_PROFILE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw
      ? { ...DEFAULT_LEARNER_PROFILE, ...(JSON.parse(raw) as LearnerProfileFields) }
      : DEFAULT_LEARNER_PROFILE;
  } catch {
    return DEFAULT_LEARNER_PROFILE;
  }
}

export function LearnerProfilePopover({
  profile,
  onChange,
}: {
  profile: LearnerProfileFields;
  onChange: (next: LearnerProfileFields) => void;
}) {
  const [open, setOpen] = useState(false);
  // 前测校准状态机：idle → loading → active（就地答题）→ submitting → idle；
  // 引擎不可达（204）→ unavailable（按钮禁用），不影响画像其余功能。
  const [calibState, setCalibState] = useState<'idle' | 'loading' | 'active' | 'submitting' | 'unavailable'>('idle');
  const [calibQuestions, setCalibQuestions] = useState<PretestQuestion[]>([]);
  const [calibAnswers, setCalibAnswers] = useState<Record<string, string>>({});
  // 可选的知识库名单。只列已建好索引的库——没建索引的选了也是无据可依，
  // 生成入口那道闸会直接拦下（lib/server/knowledge-center.ts corpusUnavailableReason）。
  const [corpora, setCorpora] = useState<BuiltCorpus[]>([]);
  useEffect(() => {
    if (!open || corpora.length > 0) return;
    void loadBuiltCorpora().then(setCorpora);
  }, [open, corpora.length]);

  // 本地先落盘（未登录也要能用），登录时再上行到账户——画像随账户走，
  // 换设备登录即恢复。防抖 800ms：滑块/下拉连改不该刷一串请求。
  //
  // **挂载那一次不上行**（2026-08-18 修）：这个 effect 依赖 `profile`，而 `profile` 初值
  // 来自 `loadLearnerProfile()`——localStorage 的旧快照。原来挂载即触发保存，等于
  // **每次打开页面都用本地旧画像把服务端覆盖一遍**。用户在别处（档案切换器、别的设备）
  // 改的知识库，回到首页一刷新就被打回去——这正是「画像里更换知识库无效果」的真实机制，
  // 表面看像是没保存，其实是保存了又被这一发覆盖。
  //
  // 本地缓存跟着 profile 走（未登录也要能用，且生成链就地读这个键）。
  // **上行不放在这个 effect 里**——理由见下面 `patch`。
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      /* storage unavailable — the profile still works for this session */
    }
  }, [profile]);

  /**
   * 用户改了画像才上行。**不要退回「effect 里监听 profile 变化就保存」那种写法。**
   *
   * 2026-08-18 实测的翻车过程：宿主 `app/page.tsx` 先用 `DEFAULT_LEARNER_PROFILE`
   * 渲染一次，再用 effect 把 localStorage 的值 `setLearnerProfile` 进来——于是
   * 弹层会收到**两次** profile 变化，两次都不是用户操作。挂载即保存的写法会把
   * 「本地旧快照（甚至是默认值）」当成用户意图 POST 上去，把服务端刚改的画像冲掉。
   * 表现就是用户抓到的「画像里更换知识库无效果」：其实存进去了，
   * 下一次页面加载又被本地那份覆盖回来。
   *
   * 先加了个「跳过第一次」的 ref，只挡住默认值那一发，localStorage 那一发照样冲——
   * 所以改成现在这样：**只有 `patch()` 被调用（下拉、滑块、预设、前测回写）才算用户改了。**
   */
  const saveProfileToAccount = useAccountStore((s) => s.saveProfile);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patch = (next: Partial<LearnerProfileFields>) => {
    const merged = { ...profile, ...next };
    onChange(merged);
    // 防抖 800ms：滑块/下拉连改不该刷一串请求。
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveProfileToAccount(merged);
    }, 800);
  };
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const startCalibration = async () => {
    setCalibState('loading');
    try {
      const resp = await fetch('/api/pretest?dims=agent,rag,engineering&per_dim=2');
      if (resp.status !== 200) {
        setCalibState('unavailable');
        return;
      }
      const payload = (await resp.json()) as { questions?: PretestQuestion[] };
      if (!payload.questions?.length) {
        setCalibState('unavailable');
        return;
      }
      setCalibQuestions(payload.questions);
      setCalibAnswers({});
      setCalibState('active');
    } catch {
      setCalibState('unavailable');
    }
  };

  const submitCalibration = async () => {
    setCalibState('submitting');
    try {
      const selfLevels = Object.fromEntries(
        PRETEST_DIMS.map(({ dim, field }) => [dim, (profile[field] as number | undefined) ?? 0]),
      );
      const resp = await fetch('/api/pretest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: calibAnswers, self_levels: selfLevels }),
      });
      if (resp.status !== 200) {
        setCalibState('unavailable');
        return;
      }
      const payload = (await resp.json()) as { results?: Record<string, PretestDimResult> };
      if (!payload.results) {
        setCalibState('unavailable');
        return;
      }
      const levelPatch: Partial<LearnerProfileFields> = {};
      const calibrated: Record<string, string> = { ...(profile.pretestCalibrated ?? {}) };
      for (const { dim, field } of PRETEST_DIMS) {
        const r = payload.results[dim];
        if (!r) continue;
        (levelPatch as Record<string, unknown>)[field] = r.corrected;
        calibrated[dim] = r.evidence;
      }
      patch({ ...levelPatch, pretestCalibrated: calibrated });
      setCalibState('idle');
      setCalibQuestions([]);
    } catch {
      setCalibState('unavailable');
    }
  };

  const summary =
    `${DOMAINS.find((d) => d.id === profile.domain)?.label ?? 'AI'} · ${profile.role || '学习者'}` +
    // 换了库就写在按钮上：不然生成完没人说得清这门课是照着哪本书讲的
    (profile.corpus ? ` · ${domainLabel(profile.corpus)}` : '');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full text-xs"
          title="学习者画像：驱动难度、讲解深度、类比领域与测验难度"
        >
          <UserCog className="size-3.5" />
          <span className="max-w-[9rem] truncate">{summary}</span>
        </Button>
      </PopoverTrigger>
      {/* 高度按 Radix 算出的「触发点到视口底的可用高度」封顶＋内部滚动：
          画像项多，低分辨率屏上弹层会伸出屏幕底，底部字段和保存按钮够不着
          （线上实拍）。用 available-height 而不是固定 vh——弹层起点随触发按钮
          位置浮动，固定值仍会溢出。collisionPadding 留出边距。 */}
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="w-[22rem] p-4 space-y-3 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
      >
        <div>
          <p className="text-sm font-semibold">学习者画像</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            学情诊断 Agent 据此计算难度档、讲解深度、类比领域与测验难度带
          </p>
        </div>

        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">快速套用</p>
          <div className="space-y-1">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                onClick={() => patch(p.patch)}
                className="block w-full rounded-md border px-2.5 py-1 text-left text-[11px] transition hover:bg-muted"
              >
                <span className="font-medium">{p.label}</span>
                <span className="ml-1.5 text-muted-foreground">{p.fact}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 预览放在套用按钮正下方、所有字段之上：套预设是演示时切画像的主要手势，
            切完不用滚动就能看见这份画像把课改成了什么样。 */}
        <ProfileImpactPreview profile={profile} />

        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] space-y-1">
            <span className="text-muted-foreground">培训领域</span>
            <select
              value={profile.domain}
              onChange={(e) => patch({ domain: e.target.value })}
              className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
            >
              {DOMAINS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {/* 知识库与培训领域分成两个字段：培训领域进蓝图提示词、证据账本分桶和类比取材，
              知识库只决定检索读哪份索引。合成一个字段就得跟学习者说「你的培训领域是 odoo」。 */}
          <label className="text-[11px] space-y-1">
            <span className="text-muted-foreground">知识库</span>
            <select
              value={profile.corpus ?? ''}
              onChange={(e) => patch({ corpus: e.target.value || undefined })}
              className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
            >
              <option value="">跟随培训领域</option>
              {/* 中文名走 domain-labels 这份真源；表里没登记的新库退回 id 本身，
                  不会因为查不到就把库名兜底成别的库（domainLabel 的约定）。 */}
              {corpora.map((c) => (
                <option key={c.corpus} value={c.corpus}>
                  {truncateLabel(domainLabel(c.corpus), 12)}（{c.chunks} 块）
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] space-y-1">
            <span className="text-muted-foreground">学历背景</span>
            <select
              value={profile.education}
              onChange={(e) => patch({ education: e.target.value })}
              className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
            >
              {EDUCATIONS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="block text-[11px] space-y-1">
          <span className="text-muted-foreground">身份 / 来路</span>
          <input
            value={profile.role ?? ''}
            onChange={(e) => patch({ role: e.target.value })}
            placeholder="如：后端开发转 Agent 应用"
            className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          />
        </label>

        <div className="space-y-2">
          <p className="text-[11px] font-medium text-muted-foreground">经历自陈（选最符合的一项）</p>
          {DIMENSIONS.map((d) => {
            const calibDim = PRETEST_DIMS.find((p) => p.field === d.key)?.dim;
            const evidence = calibDim ? profile.pretestCalibrated?.[calibDim] : undefined;
            return (
            <label key={d.key} className="block text-[11px] space-y-1">
              <span className="text-muted-foreground">
                {d.question}
                {evidence ? (
                  <span className="ml-1.5 rounded bg-green-soft px-1 py-0.5 text-[10px] text-green-deep">
                    已校准（{evidence}）
                  </span>
                ) : null}
              </span>
              <select
                value={(profile[d.key] as number | undefined) ?? 0}
                onChange={(e) => patch({ [d.key]: Number(e.target.value) } as Partial<LearnerProfileFields>)}
                className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
              >
                {d.options.map((opt, i) => (
                  <option key={i} value={i} className="bg-background text-foreground">
                    {opt}
                  </option>
                ))}
              </select>
            </label>
            );
          })}
        </div>

        <label className="block text-[11px] space-y-1">
          <span className="text-muted-foreground">学习偏好（只调呈现配比，不改内容深度）</span>
          <input
            value={profile.learning_preference ?? ''}
            onChange={(e) => patch({ learning_preference: e.target.value })}
            placeholder="如：图解优先 / 可运行代码优先"
            className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          />
        </label>

        {/* 前测校准（可选，永不强制）：自评当先验，6 题实测校正 agent/rag/engineering 档位 */}
        <div className="space-y-2 border-t pt-2">
          {calibState !== 'active' && calibState !== 'submitting' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full text-[11px]"
              disabled={calibState === 'loading' || calibState === 'unavailable'}
              onClick={startCalibration}
            >
              {calibState === 'unavailable'
                ? '校准服务未连接'
                : calibState === 'loading'
                  ? '加载题目…'
                  : '做 6 题校准（约 2 分钟）'}
            </Button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-muted-foreground">
                前测校准：自评只是先验，答完 6 题按实测校正档位
              </p>
              {calibQuestions.map((q, idx) => (
                <label key={q.id} className="block text-[11px] space-y-1">
                  <span className="text-muted-foreground">
                    {idx + 1}. [{q.dim}] {q.question}
                  </span>
                  <select
                    value={calibAnswers[q.id] ?? ''}
                    onChange={(e) => setCalibAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                    className="w-full rounded-md border bg-background text-foreground px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
                  >
                    <option value="" disabled className="bg-background text-muted-foreground">
                      请选择
                    </option>
                    {Object.entries(q.options).map(([key, text]) => (
                      <option key={key} value={key} className="bg-background text-foreground">
                        {key}. {text}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="flex-1 text-[11px]"
                  disabled={
                    calibState === 'submitting' ||
                    calibQuestions.some((q) => !calibAnswers[q.id])
                  }
                  onClick={submitCalibration}
                >
                  {calibState === 'submitting' ? '判分中…' : '提交并校正档位'}
                </Button>
                {/* 跳过永远可见：前测永远可选，不强制 */}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-[11px]"
                  onClick={() => {
                    setCalibState('idle');
                    setCalibQuestions([]);
                  }}
                >
                  跳过
                </Button>
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
