/**
 * 学习端“当前到底属于哪个领域”的单一解析口径。
 *
 * 领域内容不在这里生成：课程归属来自运行时 course-domain 表，领域名称与可用性来自
 * 引擎 domain registry。这里仅做优先级裁决，避免 /path、/skills、/report 各自只读
 * localStorage，进而把机构已经指派的非 AI 课程又覆盖回旧画像里的 AI。
 */

export interface DomainContextProfile {
  domain?: string;
  corpus?: string;
}

export interface DomainContextAssignment {
  id: string;
  courseId: string;
  title?: string;
  createdAt?: string;
}

export interface DomainContextCourse {
  domain?: string;
  corpus?: string;
  title?: string;
}

export interface DomainContextRegistryEntry {
  corpus?: string;
  label?: string;
  eligible?: boolean;
}

export type EffectiveDomainSource =
  | 'course-assignment'
  | 'profile-corpus'
  | 'profile-domain'
  | 'none';

export type EffectiveDomainStatus = 'ready' | 'unregistered' | 'missing-course-domain' | 'none';

export interface EffectiveDomainContext {
  domain: string | null;
  label?: string;
  source: EffectiveDomainSource;
  status: EffectiveDomainStatus;
  isAi: boolean;
  registered: boolean;
  eligible?: boolean;
  assignment?: DomainContextAssignment;
  reason?: string;
}

export interface ResolveEffectiveDomainInput {
  assignments?: readonly DomainContextAssignment[];
  courseDomains?: Readonly<Record<string, DomainContextCourse>>;
  registry?: Readonly<Record<string, DomainContextRegistryEntry>>;
  profile?: DomainContextProfile | null;
}

const clean = (value?: string | null): string => value?.trim() ?? '';

/** `unknown` / `retired` 是 course-domain 的显式缺失态，不是可以拿去问引擎的域名。 */
function usableDomain(value?: string): string | null {
  const domain = clean(value);
  return domain && domain !== 'unknown' && domain !== 'retired' ? domain : null;
}

function fromDomain(
  domain: string,
  source: Exclude<EffectiveDomainSource, 'none'>,
  registry: Readonly<Record<string, DomainContextRegistryEntry>>,
  assignment?: DomainContextAssignment,
): EffectiveDomainContext {
  const entry = registry[domain];
  const rawLabel = clean(entry?.label);
  // 清单里的 label 与 corpus 同名是引擎的占位值，不当成人类可读名称盖掉 UI 兜底表。
  const label = rawLabel && rawLabel !== clean(entry?.corpus) ? rawLabel : undefined;
  const registered = Boolean(entry);
  const status: EffectiveDomainStatus = domain === 'ai' || registered ? 'ready' : 'unregistered';

  return {
    domain,
    ...(label ? { label } : {}),
    source,
    status,
    isAi: domain === 'ai',
    registered,
    ...(typeof entry?.eligible === 'boolean' ? { eligible: entry.eligible } : {}),
    ...(assignment ? { assignment } : {}),
    ...(status === 'unregistered'
      ? { reason: `引擎域注册清单尚未登记课程所属领域「${domain}」，系统不会改用 AI 内容代替。` }
      : {}),
  };
}

/**
 * 优先级：机构课程指派（经 course-domain + domain registry 解释）→ 画像显式 corpus
 * → 画像 domain。只要存在课程指派，归属表缺失就停在显式缺失态，绝不继续落到 AI 画像。
 */
export function resolveEffectiveDomainContext({
  assignments = [],
  courseDomains = {},
  registry = {},
  profile,
}: ResolveEffectiveDomainInput): EffectiveDomainContext {
  const orderedAssignments = assignments
    .map((assignment, index) => ({ assignment, index }))
    .sort((a, b) => {
      const byTime = clean(b.assignment.createdAt).localeCompare(clean(a.assignment.createdAt));
      return byTime || a.index - b.index;
    })
    .map(({ assignment }) => assignment);

  const assignment = orderedAssignments[0];
  if (assignment) {
    const course = courseDomains[assignment.courseId];
    const domain = usableDomain(course?.domain ?? course?.corpus);
    if (domain) return fromDomain(domain, 'course-assignment', registry, assignment);

    return {
      domain: null,
      source: 'course-assignment',
      status: 'missing-course-domain',
      isAi: false,
      registered: false,
      assignment,
      reason:
        '最新机构指派课程尚无引擎领域归属；系统不会改用旧课程或画像里的 AI 领域代替。',
    };
  }

  const profileCorpus = usableDomain(profile?.corpus);
  if (profileCorpus) return fromDomain(profileCorpus, 'profile-corpus', registry);

  const profileDomain = usableDomain(profile?.domain);
  if (profileDomain) return fromDomain(profileDomain, 'profile-domain', registry);

  return {
    domain: null,
    source: 'none',
    status: 'none',
    isAi: false,
    registered: false,
    reason: '尚未选择培训领域，也没有机构课程指派。',
  };
}

/** 把裁决后的领域写进送往引擎的画像副本；不改 localStorage 原画像。 */
export function applyEffectiveDomain<T extends DomainContextProfile>(
  profile: T,
  context: EffectiveDomainContext,
): T {
  if (!context.domain) return { ...profile };
  return { ...profile, domain: context.domain, corpus: context.domain };
}

export function isEffectiveDomainContext(value: unknown): value is EffectiveDomainContext {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<EffectiveDomainContext>;
  return (
    (typeof row.domain === 'string' || row.domain === null) &&
    typeof row.source === 'string' &&
    typeof row.status === 'string' &&
    typeof row.isAi === 'boolean'
  );
}
