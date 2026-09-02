'use client';

import { examplePromptsFor } from '@/lib/knowledge/example-prompts';
import { useDomainRegistryVersion } from '@/lib/knowledge/use-domain-registry';
import { belongsToDomain } from '@/lib/knowledge/use-course-domains';
import { useEffectiveDomainContext } from '@/lib/knowledge/use-domain-context';
import { applyEffectiveDomain } from '@/lib/knowledge/domain-context';
import { useState, useEffect, useMemo, useRef, useDeferredValue, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence, MotionConfig } from 'motion/react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  Clock,
  ImagePlus,
  Pencil,
  Search,
  Sun,
  Moon,
  Monitor,
  ChevronUp,
  X,
  BarChart3,
  Briefcase,
  ShieldCheck,
  Bot,
} from 'lucide-react';
import Link from 'next/link';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { InputGroup, InputGroupInput, InputGroupButton } from '@/components/ui/input-group';
import { Textarea as UITextarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { EngineBridgeBanner } from '@/components/generation/engine-bridge-banner';
import { useTheme } from '@/lib/hooks/use-theme';
import { nanoid } from 'nanoid';
import type { UserRequirements } from '@/lib/types/generation';
import { useSettingsStore } from '@/lib/store/settings';
import { hasUsableLLMProvider } from '@/lib/store/settings-validation';
import { useUserProfileStore, AVATAR_OPTIONS } from '@/lib/store/user-profile';
import {
  StageListItem,
  listStages,
  deleteStageData,
  renameStage,
  getFirstSlideByStages,
  getResumeProgressByStages,
  revokeThumbnailSlideMediaUrls,
} from '@/lib/utils/stage-storage';
import type { Slide } from '@openmaic/dsl';
import { ContinueHeroCard, HERO_CTA_RECIPE } from '@/components/home/hero-card';
import { CourseCard, CARD_RECIPE, CARD_RECIPE_STATIC } from '@/components/home/course-card';
import { MasterySummaryCard, PathOrDomainCard } from '@/components/home/learning-overview';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import {
  describeChanges,
  fetchProfileSeed,
  mergeSeedIntoProfile,
} from '@/lib/generation/profile-from-requirement';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDraftCache } from '@/lib/hooks/use-draft-cache';
import { SpeechButton } from '@/components/audio/speech-button';
import { LearnerAccountSwitcher } from '@/components/learner-account-switcher';
import { OrgBadge } from '@/components/home/org-badge';
import { AccountMenu } from '@/components/account/account-menu';
import { PublicLanding } from '@/components/home/public-landing';
import { EmptyState } from '@/components/ui/empty-state';
import { useAccountStore } from '@/lib/store/account';
import {
  LearnerProfilePopover,
  loadLearnerProfile,
  DEFAULT_LEARNER_PROFILE,
  DOMAINS,
} from '@/components/generation/learner-profile-popover';

const log = createLogger('Home');

const RECENT_OPEN_STORAGE_KEY = 'recentClassroomsOpen';

/**
 * 造课卡示例提示：一键填入需求框，展示画像适配差异。
 * 按画像选定的知识库切换（域工作区）：示例必须是当前库里真讲得动的主题，
 * 否则点了示例生成出来就是「资料不足」——示例本身要诚实。
 */
// 示例提示词现在读**⑧站产出的域注册清单**（`examplePromptsFor`）：
// 每个走接入链建成的库都有三条真调 LLM 生成、锚在自己语料章节上的示例。
// 原先这里硬编码四个库各三条，新库投进来永远拿不到自己的示例——
// 那正是「个性化注册」那一段要解决的事，硬编码等于把它架空。
//
// 老的四组没删，搬进 `lib/knowledge/example-prompts.ts` 当 `LEGACY_EXAMPLES` 兜底：
// 清单不存在（本地刚 clone、引擎没跑过⑧站）或某个库没生成出示例时回退到它，
// 首页不会因此空掉。

/**
 * 功能入口卡（粉彩语义色与各功能页保持一致）。
 * 学情报告不在这里了——首屏的「我的学情」卡本身就带一行进 /report，
 * 同一个去处不摆两张卡。
 */
const FEATURE_LINKS = [
  {
    href: '/agents',
    label: '协同控制台',
    desc: '多智能体分工与协同过程的实时视图',
    icon: Bot,
    strip: 'bg-purple-deep/50',
    chip: 'bg-purple-soft text-purple-deep',
    // 用任意属性写渐变：bg-gradient-to-b 会被 tailwind-merge 判定与 CARD_RECIPE 的 bg-card 冲突而互吞
    tint: '[background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--purple-soft)_45%,transparent),transparent)]',
  },
] as const;

interface FormState {
  requirement: string;
}

const initialFormState: FormState = {
  requirement: '',
};

function HomePage() {
  const { t } = useI18n();
  const { theme, setTheme } = useTheme();
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialFormState);
  /**
   * 学习者画像。**登录时以服务端当前档案为准，未登录才退回 localStorage。**
   *
   * 原来只读 localStorage。账户体系上线后这条就错了：档案存在账户上、可以有多份、
   * 可以在别处（切换器、另一台设备）改，本地那份只是缓存。以缓存为准的后果是
   * 用户换了知识库、切了档案，回到首页又被本地旧值顶回去——正是 2026-08-18
   * 抓到的「画像里更换知识库无效果」。
   *
   * 顺序：先给默认值（首帧不闪空）→ 本地缓存（离线/未登录可用）→ 服务端档案覆盖（真源）。
   * 401 就停在本地那一步，匿名用户照常用。
   */
  const [learnerProfile, setLearnerProfile] = useState(DEFAULT_LEARNER_PROFILE);
  const [profileReady, setProfileReady] = useState(false);
  // 清单灌注落地时自增——示例词/中文名等读清单的渲染要吃到真值而不是首帧兜底
  const registryVersion = useDomainRegistryVersion();
  useEffect(() => {
    let cancelled = false;
    const localProfile = loadLearnerProfile();
    const frame = window.requestAnimationFrame(() => {
      if (cancelled) return;
      setLearnerProfile(localProfile);
      setProfileReady(true);
    });
    void fetch('/api/profile')
      .then(async (response) => {
        if (!response.ok) return null; // 401 = 未登录，本地那份就是全部
        return (await response.json()) as { fields: Record<string, unknown> | null };
      })
      .then((payload) => {
        if (cancelled || !payload?.fields) return;
        setLearnerProfile({ ...localProfile, ...(payload.fields as typeof localProfile) });
      })
      .catch(() => {
        /* 接口不可达：本地缓存已经生效，不影响使用 */
      });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, []);
  const domainContextState = useEffectiveDomainContext(learnerProfile, profileReady);
  const effectiveDomain =
    domainContextState.kind === 'ready' ? domainContextState.context.domain : null;

  // Draft cache for requirement text
  const { cachedValue: cachedRequirement, updateCache: updateRequirementCache } =
    useDraftCache<string>({ key: 'requirementDraft' });

  // A usable LLM provider exists ⇒ a concrete model is always selected (#580
  // invariant). Gate generation on this single condition (state A vs B)
  // instead of inspecting modelId directly.
  const providersConfig = useSettingsStore((s) => s.providersConfig);
  const hasUsableProvider = hasUsableLLMProvider(providersConfig);
  // 未登录公共页：账户系统开着且没登录 ⇒ 首页换成公共落地页（规格
  // docs/03-design/public-landing-spec.md）。账户系统未启用的部署（本地开发、
  // 无库环境）维持原工作台，行为零变化。
  // ?public=1 强制预览公共页——登录态下也能看评委看到的那一屏。
  const {
    enabled: accountEnabled,
    account,
    loading: accountLoading,
    refresh: refreshAccount,
  } = useAccountStore();
  const [forcePublic, setForcePublic] = useState(false);
  useEffect(() => {
    void refreshAccount();
    const sync = () =>
      setForcePublic(new URLSearchParams(window.location.search).get('public') === '1');
    const frame = window.requestAnimationFrame(sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('popstate', sync);
    };
  }, [refreshAccount]);

  // 最近学习降为次级：默认收起，首屏留给「继续学习 / 我的路径 / 我的学情」三件。
  // 手动展开过的仍按本机偏好恢复（下面的 hydrate effect 读 localStorage）。
  const [recentOpen, setRecentOpen] = useState(false);
  const persistRecentOpen = (next: boolean) => {
    setRecentOpen(next);
    try {
      localStorage.setItem(RECENT_OPEN_STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };

  // Hydrate client-only state after mount (avoids SSR mismatch)
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const saved = localStorage.getItem(RECENT_OPEN_STORAGE_KEY);
        if (saved !== null) setRecentOpen(saved !== 'false');
      } catch {
        /* localStorage unavailable */
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Restore requirement draft from localStorage on mount. The previous derived-state
  // pattern initialised `prev` from the cached value itself, so on the first client
  // render the comparison was always equal and the restore never fired. Use an effect
  // so the cache is hydrated into the form once we know the live requirement is empty.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (!cachedRequirement) return;
    draftRestoredRef.current = true;
    const frame = window.requestAnimationFrame(() =>
      setForm((prev) => (prev.requirement ? prev : { ...prev, requirement: cachedRequirement })),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [cachedRequirement]);

  const [themeOpen, setThemeOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [classrooms, setClassrooms] = useState<StageListItem[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, Slide>>({});
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const thumbnailsRef = useRef<Record<string, Slide>>({});

  const replaceThumbnails = useCallback((slides: Record<string, Slide>) => {
    const previous = thumbnailsRef.current;
    thumbnailsRef.current = slides;
    setThumbnails(slides);
    window.setTimeout(() => revokeThumbnailSlideMediaUrls(previous), 0);
  }, []);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!themeOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        setThemeOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [themeOpen]);

  const loadClassrooms = useCallback(async () => {
    try {
      const list = await listStages();
      setClassrooms(list);
      // Load first slide thumbnails
      if (list.length > 0) {
        const ids = list.map((c) => c.id);
        // 进度条是装饰信息：异步补上，不阻塞列表首屏
        getResumeProgressByStages(ids).then(setProgressMap);
        const slides = await getFirstSlideByStages(ids);
        replaceThumbnails(slides);
      } else {
        setProgressMap({});
        replaceThumbnails({});
      }
    } catch (err) {
      log.error('Failed to load classrooms:', err);
      toast.error('Persistence is unavailable. Saved classrooms could not be loaded.');
    }
  }, [replaceThumbnails]);

  useEffect(() => {
    // Clear stale media store to prevent cross-course thumbnail contamination.
    // The store may hold tasks from a previously visited classroom whose elementIds
    // (gen_img_1, etc.) collide with other courses' placeholders.
    useMediaGenerationStore.getState().revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    const frame = window.requestAnimationFrame(() => void loadClassrooms());

    return () => {
      window.cancelAnimationFrame(frame);
      revokeThumbnailSlideMediaUrls(thumbnailsRef.current);
      thumbnailsRef.current = {};
    };
  }, [loadClassrooms]);

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPendingDeleteId(id);
  };

  const confirmDelete = async (id: string) => {
    setPendingDeleteId(null);
    try {
      await deleteStageData(id);
      await loadClassrooms();
    } catch (err) {
      log.error('Failed to delete classroom:', err);
      toast.error('Failed to delete classroom');
    }
  };

  const handleRename = async (id: string, newName: string) => {
    try {
      await renameStage(id, newName);
      setClassrooms((prev) => prev.map((c) => (c.id === id ? { ...c, name: newName } : c)));
    } catch (err) {
      log.error('Failed to rename classroom:', err);
      toast.error(t('classroom.renameFailed'));
    }
  };

  const deferredSearchQuery = useDeferredValue(searchQuery);
  /**
   * 继续学习与最近课程共用指派优先的有效领域。存在指派时展示该领域全部可用课程；
   * 指派域缺失或解析失败时返回空列表，绝不回落旧画像。
   *
   * 不筛的现象：新账号切到智能制造域，最近学习里躺着 15 门 AI 课——
   * 用户口径是「两个库的课程与个性化不许混」。归属表里没有的课不进入
   * 学习者视图；生成链必须先写入课程 origin，再允许展示。
   */
  const domainScoped = useMemo(() => {
    if (domainContextState.kind !== 'ready' || !domainContextState.context.domain) return [];
    if (domainContextState.context.assignment) {
      const assignedCourseIds = domainContextState.context.courseIds ?? [
        domainContextState.context.assignment.courseId,
      ];
      return classrooms.filter((course) => assignedCourseIds.includes(course.id));
    }
    return classrooms.filter((course) =>
      belongsToDomain(
        course.id,
        domainContextState.context.domain ?? undefined,
        domainContextState.courseDomains ?? {},
      ),
    );
  }, [classrooms, domainContextState]);
  const continueClassroom = domainScoped[0];
  const filteredClassrooms = useMemo(() => {
    const q = deferredSearchQuery.trim().toLowerCase();
    if (!q) return domainScoped;
    return domainScoped.filter((c) => {
      const name = c.name?.toLowerCase() ?? '';
      const desc = c.description?.toLowerCase() ?? '';
      return name.includes(q) || desc.includes(q);
    });
  }, [domainScoped, deferredSearchQuery]);

  const examplePrompts = useMemo(
    () => (effectiveDomain ? examplePromptsFor(effectiveDomain, registryVersion) : []),
    [effectiveDomain, registryVersion],
  );

  const updateForm = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    try {
      if (field === 'requirement') updateRequirementCache(value as string);
    } catch {
      /* ignore */
    }
  };

  const handleGenerate = async () => {
    // No model/provider guard here: generation is gated by `canGenerate`
    // (requires a usable provider), and under the #580 invariant a usable
    // provider always has a concrete model. State A (no usable provider)
    // surfaces through the toolbar's single Configure-Provider affordance.
    if (!form.requirement.trim()) {
      setError(t('upload.requirementRequired'));
      return;
    }
    if (domainContextState.kind !== 'ready' || !domainContextState.context.domain) {
      setError('当前学习领域尚未确认，不能生成可能混入其它领域内容的课程。');
      return;
    }

    setError(null);

    try {
      const userProfile = useUserProfileStore.getState();
      // 需求框里的自述并进画像。2026-08-13 实测的洞：写「我完全不懂技术，也没写过代码」
      // 画像纹丝不动，课照旧给代码——抽取器认得这句话，只是从没人拿需求文本去问它。
      // 只影响本次生成，不写回 localStorage：自述是这一次的上下文，不是长期画像的修改。
      const seed = await fetchProfileSeed(form.requirement);
      const merged = mergeSeedIntoProfile(learnerProfile, seed);
      const effectiveProfile = applyEffectiveDomain(merged.profile, domainContextState.context);
      const { changes } = merged;
      if (changes.length > 0) {
        // 生成后会立刻跳到课堂，页面上留不住话——用 toast，停久一点让人读完
        toast.info(describeChanges(changes), { duration: 8000 });
      }

      const requirements: UserRequirements = {
        requirement: form.requirement,
        userNickname: userProfile.nickname || undefined,
        userBio: userProfile.bio || undefined,
        learnerProfile: effectiveProfile,
      };

      const sessionState = {
        sessionId: nanoid(),
        requirements,
        pdfText: '',
        pdfImages: [],
        imageStorageIds: [],
        sceneOutlines: null,
        currentStep: 'generating' as const,
      };
      sessionStorage.setItem('generationSession', JSON.stringify(sessionState));

      router.push('/generation-preview');
    } catch (err) {
      log.error('Error preparing generation:', err);
      setError(err instanceof Error ? err.message : t('upload.generateFailed'));
    }
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return t('classroom.today');
    if (diffDays === 1) return t('classroom.yesterday');
    if (diffDays < 7) return `${diffDays} ${t('classroom.daysAgo')}`;
    return date.toLocaleDateString();
  };

  const canGenerate = !!form.requirement.trim() && hasUsableProvider && Boolean(effectiveDomain);
  /** 有最近课时时英雄位是「继续学习」，造课按钮降级 ghost；否则造课卡当英雄位，
   *  其按钮就是全页唯一的实心紫拟物按压 CTA（规格 3.1 第 1/2 条，配方①③④） */
  const heroIsCourse = Boolean(continueClassroom);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (canGenerate) handleGenerate();
    }
  };

  // 身份未定前不抢渲染工作台：会话是服务端 cookie 说了算，抢渲染会闪一下
  // 登录态首页再换成公共页。
  if (accountLoading && !forcePublic) {
    return <div className="min-h-[100dvh] w-full bg-background" />;
  }
  if (forcePublic || (accountEnabled && !account)) {
    return (
      <div className="min-h-[100dvh] w-full bg-background">
        <PublicLanding />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col overflow-x-hidden">
      {/* ═══ 顶部导航条：左字标，右原有图标组（原样迁移） ═══ */}
      {/* 顶栏底极浅暖 tint：yellow-soft 渐变叠在半透明底上（色调回暖微调） */}
      <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/85 bg-gradient-to-b from-yellow-soft/35 to-yellow-soft/15 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 md:px-6">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="font-serif text-xl font-semibold tracking-[0.12em] text-foreground">
              集智
            </span>
            <span className="hidden truncate text-sm tracking-[0.14em] text-muted-foreground md:inline">
              多智能体生成带出处的课
            </span>
          </div>
          <div ref={toolbarRef} className="flex shrink-0 items-center gap-1">
            {/* Theme Selector */}
            <div className="relative">
              <button
                onClick={() => {
                  setThemeOpen(!themeOpen);
                }}
                aria-label="切换主题"
                aria-haspopup="menu"
                aria-expanded={themeOpen}
                title="切换主题"
                className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {theme === 'light' && <Sun className="w-4 h-4" />}
                {theme === 'dark' && <Moon className="w-4 h-4" />}
                {theme === 'system' && <Monitor className="w-4 h-4" />}
              </button>
              {themeOpen && (
                <div className="absolute top-full mt-2 right-0 bg-popover dark:bg-surface-2 border border-border rounded-lg shadow-dropdown dark:shadow-none overflow-hidden z-50 min-w-[140px]">
                  <button
                    onClick={() => {
                      setTheme('light');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'w-full px-4 py-2 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2',
                      theme === 'light' && 'bg-secondary text-primary',
                    )}
                  >
                    <Sun className="w-4 h-4" />
                    {t('settings.themeOptions.light')}
                  </button>
                  <button
                    onClick={() => {
                      setTheme('dark');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'w-full px-4 py-2 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2',
                      theme === 'dark' && 'bg-secondary text-primary',
                    )}
                  >
                    <Moon className="w-4 h-4" />
                    {t('settings.themeOptions.dark')}
                  </button>
                  <button
                    onClick={() => {
                      setTheme('system');
                      setThemeOpen(false);
                    }}
                    className={cn(
                      'w-full px-4 py-2 text-left text-sm hover:bg-accent transition-colors flex items-center gap-2',
                      theme === 'system' && 'bg-secondary text-primary',
                    )}
                  >
                    <Monitor className="w-4 h-4" />
                    {t('settings.themeOptions.system')}
                  </button>
                </div>
              )}
            </div>

            <div className="w-[1px] h-4 bg-border" />

            {/* 账户入口：未启用账户系统时自渲染 null */}
            <AccountMenu />

            {/* 岗位技能地图（企业内训 / 转岗培训入口） */}
            <Link
              href="/skills"
              title="岗位技能地图 · 企业内训与转岗培训"
              className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <Briefcase className="w-4 h-4" />
            </Link>

            {/* 个人学情与资源匹配度报告 */}
            <Link
              href="/report"
              title="个人学情与资源匹配度报告"
              className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <BarChart3 className="w-4 h-4" />
            </Link>

            {/* 数据与隐私说明 */}
            <Link
              href="/privacy"
              title="数据与隐私"
              className="p-2 rounded-full text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              <ShieldCheck className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* ═══ 工作台主体：卡片网格 ═══ */}
      <motion.main
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-6 md:py-8"
      >
        {/* 窄屏必须显式写 grid-cols-1：不写时隐式列是 auto，轨道被最宽子项的
            min-content 撑到 355px（实测 375 视口下容器只有 328px），卡片右边被
            根节点的 overflow-x-hidden 静默切掉。grid-cols-1 = minmax(0,1fr) 封住上界。 */}
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
          {/* ══ 首屏三件：继续学习 / 我的路径 / 我的学情 ══
               登录后第一眼要能回答「我学到哪、接下来学什么、我哪儿弱」，
               造课入口与最近课程排在其后。 */}

          {/* ── ⓪ 「继续上次」英雄卡：打开即知道下一步；无最近课时由造课卡当英雄位（规格 3.1 第 1 条） ── */}
          {domainContextState.kind === 'loading' && (
            <section className="lg:col-span-3 rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
              正在确认当前账户的课程指派与学习领域…
            </section>
          )}
          {domainContextState.kind === 'error' && (
            <div className="lg:col-span-3">
              <EmptyState title="当前学习领域暂时无法确认" hint={domainContextState.reason} />
            </div>
          )}
          {domainContextState.kind === 'ready' && !domainContextState.context.domain && (
            <div className="lg:col-span-3">
              <EmptyState
                title={
                  domainContextState.context.assignment
                    ? '机构指派课程的领域尚未确认'
                    : '当前学习领域尚未确认'
                }
                hint={`${domainContextState.context.reason ?? '当前没有可用的领域信息。'} 首页不会改用旧画像或其它领域内容。`}
              />
            </div>
          )}
          {effectiveDomain && continueClassroom && (
            <ContinueHeroCard
              classroom={continueClassroom}
              slide={thumbnails[continueClassroom.id]}
              progress={progressMap[continueClassroom.id]}
              formatDate={formatDate}
            />
          )}

          {/* ── ⓪b 我的学习路径（AI 域）或当前领域课程卡（非 AI 库，域工作区最小实现） ── */}
          {effectiveDomain && (
            <PathOrDomainCard corpus={effectiveDomain} className="lg:col-span-2" />
          )}

          {/* ── ⓪c 我的学情（只读有效领域对应的分域掌握度） ── */}
          {effectiveDomain && (
            <MasterySummaryCard profile={learnerProfile} effectiveDomain={effectiveDomain} />
          )}

          {/* ── ① 造课卡 ── */}
          <section className={cn('overflow-hidden lg:col-span-2', CARD_RECIPE_STATIC)}>
            <div className="h-1 w-full bg-primary/60" />
            <EngineBridgeBanner />
            {/* ── Greeting + Profile ── */}
            <div className="relative z-20">
              <GreetingBar />
            </div>

            {/* Textarea */}
            {/* 焦点环：原来写的是 focus:outline-none，键盘 Tab 进来这个页面上最重要的
                输入框没有任何可见反馈（实测四组合下它是全页唯一无焦点指示的控件）。
                环走站内既有配方（components/ui/button.tsx 的 ring-ring + ring-[3px]），
                内偏移 -3px 是因为卡片 overflow-hidden 会把外扩的环切掉。 */}
            <textarea
              ref={textareaRef}
              placeholder={t('upload.requirementPlaceholder')}
              className="w-full resize-none rounded-lg border-0 bg-transparent px-4 pt-1 pb-2 text-base leading-relaxed placeholder:text-muted-foreground/70 outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-inset min-h-[140px] max-h-[300px]"
              value={form.requirement}
              onChange={(e) => updateForm('requirement', e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
            />

            {/* 示例提示：一键填入 */}
            {!form.requirement.trim() && (
              <div className="flex flex-wrap gap-1.5 px-4 pb-2">
                {examplePrompts.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => updateForm('requirement', p)}
                    className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {/* 语音输入 + 发送。flex-wrap 留着：窄屏下发送按钮的文字会把一行顶宽。 */}
            <div className="px-3 pb-3 flex flex-wrap items-end justify-end gap-2">
              {/* Voice input */}
              <SpeechButton
                size="md"
                onTranscription={(text) => {
                  setForm((prev) => {
                    const next = prev.requirement + (prev.requirement ? ' ' : '') + text;
                    updateRequirementCache(next);
                    return { ...prev, requirement: next };
                  });
                }}
              />

              {/* Send button */}
              <button
                onClick={handleGenerate}
                disabled={!canGenerate}
                className={cn(
                  'shrink-0 h-8 flex items-center justify-center gap-1.5 px-3',
                  // 停用态原来是 muted-foreground/40，实测在 bg-muted 上只有 1.77:1
                  // （暗色 2.09:1），字面上看不见。停用文字不受 1.4.3 约束，但也不该
                  // 消失——/70 实测到 3.4:1 左右，既读得出又仍然明显是停用。
                  !canGenerate
                    ? 'rounded-lg bg-muted text-muted-foreground/70 cursor-not-allowed transition-colors'
                    : heroIsCourse
                      ? 'rounded-lg border border-border bg-transparent text-foreground hover:bg-accent cursor-pointer transition-colors'
                      : cn('cursor-pointer', HERO_CTA_RECIPE),
                )}
              >
                <span className="text-sm font-medium">{t('toolbar.enterClassroom')}</span>
                <ArrowUp className="size-3.5" />
              </button>
            </div>

            {/* ── Error ── */}
            <AnimatePresence>
              {error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mx-4 mb-3 p-3 bg-destructive/10 border border-destructive/20 rounded-lg"
                >
                  <p className="text-sm text-destructive">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </section>

          {/* ── ② 画像卡 + ④ 功能入口卡 ── */}
          <div className="flex flex-col gap-5">
            <section
              className={cn(
                // 卡头 soft tint 带（任意属性写法，避开 tailwind-merge 的 bg-* 冲突判定）
                'overflow-hidden [background-image:linear-gradient(to_bottom,color-mix(in_oklab,var(--green-soft)_45%,transparent),transparent_40%)]',
                CARD_RECIPE_STATIC,
              )}
            >
              <div className="h-1 w-full bg-green-deep/50" />
              <div className="space-y-3 p-5">
                <div className="flex items-center justify-between">
                  <p className="text-lg font-medium">学习者画像</p>
                  {Object.keys(learnerProfile.pretestCalibrated ?? {}).length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-soft px-2 py-0.5 text-xs font-medium text-green-deep">
                      <Check className="size-3" />
                      前测已校准
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded-full bg-green-soft px-2 py-0.5 text-xs text-green-deep">
                    {learnerProfile.role || '学习者'}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {DOMAINS.find((d) => d.id === learnerProfile.domain)?.label ?? 'AI'}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Agent Lv{learnerProfile.agent_level}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    RAG Lv{learnerProfile.rag_level}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    工程 Lv{learnerProfile.engineering_level}
                  </span>
                </div>
                {/* 复用现有画像弹窗：触发按钮即「完善画像/做校准」 */}
                <LearnerProfilePopover profile={learnerProfile} onChange={setLearnerProfile} />
                {/* 学习者档案切换（账户 A 档）：learner-key 分区 + 画像快照隔离 */}
                <LearnerAccountSwitcher />
                <p className="text-sm leading-relaxed text-muted-foreground">
                  学情诊断 Agent 据此计算难度档、讲解深度、类比领域与测验难度带
                </p>
                {/* 机构归属：入组后可见本机构专属知识库（域清单按机构过滤） */}
                <OrgBadge />
              </div>
            </section>

            {FEATURE_LINKS.map((f) => (
              <Link
                key={f.href}
                href={f.href}
                className={cn('group overflow-hidden', CARD_RECIPE, f.tint)}
              >
                <div className={cn('h-1 w-full', f.strip)} />
                <div className="flex items-center gap-3 p-5">
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-xl',
                      f.chip,
                    )}
                  >
                    <f.icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-base font-medium text-foreground">{f.label}</p>
                    <p className="truncate text-sm text-muted-foreground">{f.desc}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* ── ③ 最近学习卡（原折叠列表原样迁入） ── */}
          {domainScoped.length > 0 && (
            <section className={cn('overflow-hidden lg:col-span-3', CARD_RECIPE_STATIC)}>
              <div className="h-1 w-full bg-blue-deep/40" />
              <div className="flex w-full flex-col px-5 pb-4 pt-1">
                {/* Trigger — divider-line with centered text */}
                <div className="group w-full flex items-center gap-4 py-2">
                  <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
                  {/* 这一行原来整体压着 muted-foreground/60（实测 2.57:1），里面的搜索图标
                /50、导入按钮 /35（1.67:1）更淡。它们全是可点的控件，不是装饰，
                按 1.4.3/1.4.11 应当读得清——去掉 alpha 折扣，层次改由字号承担。 */}
                  <div className="shrink-0 flex items-center gap-3 text-sm text-muted-foreground select-none">
                    <button
                      onClick={() => persistRecentOpen(!recentOpen)}
                      className="flex items-center gap-2 rounded-md py-1 transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none cursor-pointer"
                    >
                      <Clock className="size-3.5" />
                      {t('classroom.recentClassrooms')}
                      <span className="text-xs tabular-nums opacity-60">{domainScoped.length}</span>
                      <motion.div
                        animate={{ rotate: recentOpen ? 180 : 0 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                      >
                        <ChevronDown className="size-3.5" />
                      </motion.div>
                    </button>

                    {/* Search toggle — icon that expands into an input in place */}
                    <AnimatePresence initial={false}>
                      {!searchOpen ? (
                        <motion.button
                          key="search-icon"
                          ref={searchButtonRef}
                          type="button"
                          aria-label={t('classroom.searchAriaLabel')}
                          onClick={() => {
                            setSearchOpen(true);
                            if (!recentOpen) persistRecentOpen(true);
                            requestAnimationFrame(() => searchInputRef.current?.focus());
                          }}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.12, ease: 'easeOut' }}
                          className="flex items-center justify-center size-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
                        >
                          <Search className="size-3.5" />
                        </motion.button>
                      ) : (
                        <motion.div
                          key="search-input"
                          initial={{ opacity: 0, width: 0 }}
                          animate={{ opacity: 1, width: 200 }}
                          exit={{ opacity: 0, width: 0 }}
                          transition={{ duration: 0.18, ease: [0.25, 0.1, 0.25, 1] }}
                          className="overflow-hidden"
                        >
                          <InputGroup
                            className={cn(
                              'h-7 text-sm rounded-full bg-muted/40 border-transparent shadow-none',
                              'transition-colors',
                              'hover:bg-muted/60',
                              'has-[[data-slot=input-group-control]:focus-visible]:bg-muted/60',
                              'has-[[data-slot=input-group-control]:focus-visible]:border-transparent',
                              'has-[[data-slot=input-group-control]:focus-visible]:ring-0',
                            )}
                          >
                            <InputGroupInput
                              ref={searchInputRef}
                              value={searchQuery}
                              onChange={(e) => setSearchQuery(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  e.preventDefault();
                                  if (searchQuery) {
                                    setSearchQuery('');
                                  } else {
                                    setSearchOpen(false);
                                    requestAnimationFrame(() => searchButtonRef.current?.focus());
                                  }
                                }
                              }}
                              onBlur={() => {
                                if (!searchQuery) {
                                  setSearchOpen(false);
                                }
                              }}
                              placeholder={t('classroom.searchPlaceholder')}
                              aria-label={t('classroom.searchAriaLabel')}
                              className="h-7 pl-3 placeholder:text-muted-foreground/50"
                            />
                            {searchQuery && (
                              <InputGroupButton
                                size="icon-xs"
                                aria-label={t('classroom.clearSearch')}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  setSearchQuery('');
                                  searchInputRef.current?.focus();
                                }}
                              >
                                <X />
                              </InputGroupButton>
                            )}
                          </InputGroup>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                  <div className="flex-1 h-px bg-border/40 group-hover:bg-border/70 transition-colors" />
                </div>

                {/* Expandable content */}
                <AnimatePresence>
                  {recentOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
                      className="w-full overflow-hidden"
                    >
                      {searchQuery.trim() && filteredClassrooms.length === 0 ? (
                        <div className="pt-8 pb-2 text-center text-sm text-muted-foreground">
                          {t('classroom.searchEmpty')}
                        </div>
                      ) : (
                        /* 等高栅格（规格 3.1 第 2 条，配方⑱值照抄）。
                     min(300px,100%)：窄屏可用宽只有 288px 时，写死的 300px 下限会让
                     卡片横向溢出卡片容器被切边，取 100% 让它退到容器宽。 */
                        <div className="pt-8 grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-5">
                          {filteredClassrooms.map((classroom, i) => (
                            <motion.div
                              key={classroom.id}
                              initial={{ opacity: 0, y: 16 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{
                                delay: i * 0.04,
                                duration: 0.35,
                                ease: 'easeOut',
                              }}
                            >
                              <CourseCard
                                classroom={classroom}
                                slide={thumbnails[classroom.id]}
                                progress={progressMap[classroom.id]}
                                formatDate={formatDate}
                                onDelete={handleDelete}
                                onRename={handleRename}
                                confirmingDelete={pendingDeleteId === classroom.id}
                                onConfirmDelete={() => confirmDelete(classroom.id)}
                                onCancelDelete={() => setPendingDeleteId(null)}
                                onClick={() => router.push(`/classroom/${classroom.id}`)}
                              />
                            </motion.div>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </section>
          )}
        </div>
      </motion.main>
    </div>
  );
}

// ─── Greeting Bar — avatar + "Hi, Name", click to edit in-place ────
const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

function isCustomAvatar(src: string) {
  return src.startsWith('data:');
}

function GreetingBar() {
  const { t } = useI18n();
  const avatar = useUserProfileStore((s) => s.avatar);
  const nickname = useUserProfileStore((s) => s.nickname);
  const bio = useUserProfileStore((s) => s.bio);
  const setAvatar = useUserProfileStore((s) => s.setAvatar);
  const setNickname = useUserProfileStore((s) => s.setNickname);
  const setBio = useUserProfileStore((s) => s.setBio);

  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const displayName = nickname || t('profile.defaultNickname');

  // Click-outside to collapse
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingName(false);
        setAvatarPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const startEditName = () => {
    setNameDraft(nickname);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const commitName = () => {
    setNickname(nameDraft.trim());
    setEditingName(false);
  };

  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_AVATAR_SIZE) {
      toast.error(t('profile.fileTooLarge'));
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast.error(t('profile.invalidFileType'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const ctx = canvas.getContext('2d')!;
        const scale = Math.max(128 / img.width, 128 / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        setAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <div ref={containerRef} className="relative pl-4 pr-2 pt-3.5 pb-1 w-auto">
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleAvatarUpload}
      />

      {/* ── Collapsed pill (always in flow) ──
           用 <button> 而不是带 onClick 的 div：这是打开个人资料面板的唯一入口，
           div 上 Tab 停不住、回车也按不动。 */}
      {!open && (
        <button
          type="button"
          aria-expanded={false}
          className="flex items-center gap-2.5 cursor-pointer transition-all duration-200 group rounded-full px-2.5 py-1.5 border border-border/50 text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 active:scale-[0.97]"
          onClick={() => setOpen(true)}
        >
          <div className="shrink-0 relative">
            <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-border/30 group-hover:ring-purple-deep/50 transition-all duration-300">
              <img src={avatar} alt="" className="size-full object-cover" />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-popover border border-border/40 flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
              <Pencil className="size-[7px] text-muted-foreground/70" />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="leading-none select-none flex items-center gap-1">
                  <span className="text-sm font-medium text-foreground/85 group-hover:text-foreground transition-colors">
                    {t('home.greetingWithName', { name: displayName })}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground/30 group-hover:text-muted-foreground/60 transition-colors shrink-0" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {t('profile.editTooltip')}
              </TooltipContent>
            </Tooltip>
          </div>
        </button>
      )}

      {/* ── Expanded panel (absolute, floating) ── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute left-4 top-3.5 z-50 w-64"
          >
            <div className="rounded-2xl border border-border bg-popover/95 dark:bg-surface-2/95 backdrop-blur-sm shadow-dropdown dark:shadow-none px-2.5 py-2">
              {/* ── Row: avatar + name ── */}
              <div
                className="flex items-center gap-2.5 cursor-pointer transition-all duration-200"
                onClick={() => {
                  setOpen(false);
                  setEditingName(false);
                  setAvatarPickerOpen(false);
                }}
              >
                {/* Avatar */}
                <div
                  className="shrink-0 relative cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAvatarPickerOpen(!avatarPickerOpen);
                  }}
                >
                  <div className="size-8 rounded-full overflow-hidden ring-[1.5px] ring-purple-deep/40 transition-all duration-300">
                    <img src={avatar} alt="" className="size-full object-cover" />
                  </div>
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className="absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full bg-popover border border-border/60 flex items-center justify-center"
                  >
                    <ChevronDown
                      className={cn(
                        'size-2 text-muted-foreground/70 transition-transform duration-200',
                        avatarPickerOpen && 'rotate-180',
                      )}
                    />
                  </motion.div>
                </div>

                {/* Text */}
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={nameInputRef}
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitName();
                          if (e.key === 'Escape') {
                            setEditingName(false);
                          }
                        }}
                        onBlur={commitName}
                        maxLength={20}
                        placeholder={t('profile.defaultNickname')}
                        className="flex-1 min-w-0 h-6 bg-transparent border-b border-border/80 text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/40"
                      />
                      <button
                        onClick={commitName}
                        className="shrink-0 size-5 rounded flex items-center justify-center text-primary hover:bg-purple-soft"
                      >
                        <Check className="size-3" />
                      </button>
                    </div>
                  ) : (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        startEditName();
                      }}
                      className="group/name inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span className="text-sm font-medium text-foreground/85 group-hover/name:text-foreground transition-colors">
                        {displayName}
                      </span>
                      <Pencil className="size-2.5 text-muted-foreground/30 opacity-0 group-hover/name:opacity-100 transition-opacity" />
                    </span>
                  )}
                </div>

                {/* Collapse arrow */}
                <motion.div
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="shrink-0 size-6 rounded-full flex items-center justify-center hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <ChevronUp className="size-3.5 text-muted-foreground/50" />
                </motion.div>
              </div>

              {/* ── Expandable content ── */}
              <div className="pt-2" onClick={(e) => e.stopPropagation()}>
                {/* Avatar picker */}
                <AnimatePresence>
                  {avatarPickerOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15, ease: 'easeInOut' }}
                      className="overflow-hidden"
                    >
                      <div className="p-1 pb-2.5 flex items-center gap-1.5 flex-wrap">
                        {AVATAR_OPTIONS.map((url) => (
                          <button
                            key={url}
                            onClick={() => setAvatar(url)}
                            className={cn(
                              'size-7 rounded-full overflow-hidden bg-muted cursor-pointer transition-all duration-150',
                              avatar === url
                                ? 'ring-2 ring-primary ring-offset-0'
                                : 'hover:ring-1 hover:ring-muted-foreground/30',
                            )}
                          >
                            <img src={url} alt="" className="size-full" />
                          </button>
                        ))}
                        <label
                          className={cn(
                            'size-7 rounded-full flex items-center justify-center cursor-pointer transition-all duration-150 border border-dashed',
                            isCustomAvatar(avatar)
                              ? 'ring-2 ring-primary ring-offset-0 border-purple-deep/30 bg-purple-soft'
                              : 'border-muted-foreground/30 text-muted-foreground/50 hover:border-muted-foreground/50',
                          )}
                          onClick={() => avatarInputRef.current?.click()}
                          title={t('profile.uploadAvatar')}
                        >
                          <ImagePlus className="size-3" />
                        </label>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Bio */}
                <UITextarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder={t('profile.bioPlaceholder')}
                  maxLength={200}
                  rows={2}
                  className="resize-none border-border/40 bg-transparent min-h-[72px] !text-sm !leading-relaxed placeholder:!leading-relaxed focus-visible:ring-1 focus-visible:ring-border/60"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Page() {
  // globals.css 里的 prefers-reduced-motion 分支只降 CSS 动画和过渡（那段注释自己也
  // 写了「framer-motion 走 JS 驱动不受此影响」），所以首页这些入场位移、卡片错峰、
  // 折叠展开在系统开了「减少动态效果」时照跑。MotionConfig 把这条补上，
  // 写法照抄 components/scene-renderers/classroom-complete.tsx 已有的用法。
  return (
    <MotionConfig reducedMotion="user">
      <HomePage />
    </MotionConfig>
  );
}
