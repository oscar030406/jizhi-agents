/**
 * 把需求框里的自述并进学习者画像。
 *
 * ## 合并口径（这是本文件唯一有争议的地方，写清楚）
 *
 * 抽取器只在**自述里明确提到**的维度上给档位，没提到的维度不出现。所以合并规则是：
 * **自述提到的维度以自述为准（可升可降），没提到的维度原样保留。**
 *
 * 为什么允许下调——引擎抽取器的文档写着「只上调不虚构」，那句话管的是
 * 「别给没提到的维度编档位」，不是「用户说自己不会也不许信」。
 * 一个人刚打字说「我完全不懂技术、没写过代码」，系统还按存着的
 * `programming_level: 1` 给他 `argsort` 代码，那不叫保守，叫没听见。
 *
 * 但**下调必须留痕并可撤销**：返回 `changes` 让界面把「按你写的『没写过代码』，
 * 本次按零编程基础生成」摆在明面上。默默改画像和默默不改一样坏。
 *
 * 本次生成用合并后的画像；**不写回 localStorage**——自述是这一次的上下文，
 * 不是对长期画像的修改。要改长期画像走画像弹窗，那里有申诉机制。
 */

export interface ProfileSeed {
  levels: Record<string, number>;
  background_hint: string;
  evidence: Array<{ dimension: string; level: number; keyword: string; reason: string }>;
  unmatched: boolean;
}

/** 抽取器的维度名 → 画像字段名。两侧命名不同，映射写死在这里，别靠猜。 */
const FIELD_OF: Record<string, string> = {
  programming: 'programming_level',
  python: 'python_level',
  agent: 'agent_level',
  rag: 'rag_level',
  engineering: 'engineering_level',
};

export interface IntakeChange {
  field: string;
  from: number | undefined;
  to: number;
  keyword: string;
  reason: string;
}

export async function fetchProfileSeed(text: string): Promise<ProfileSeed | null> {
  try {
    const resp = await fetch('/api/profile-intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) return null;
    const payload = (await resp.json()) as { data?: { seed?: ProfileSeed } };
    return payload.data?.seed ?? null;
  } catch {
    return null; // 自述抽取是增强，桥断了不该挡住生成
  }
}

/**
 * 合并。返回新画像与逐条变更；`changes` 为空表示自述没带来任何改动。
 * 不修改入参（生成流程里画像会被多处读，就地改会串味）。
 */
export function mergeSeedIntoProfile<T extends object>(
  profile: T,
  seed: ProfileSeed | null,
): { profile: T; changes: IntakeChange[] } {
  if (!seed || seed.unmatched || Object.keys(seed.levels).length === 0) {
    return { profile, changes: [] };
  }
  const merged = { ...profile } as Record<string, unknown>;
  const changes: IntakeChange[] = [];
  for (const [dimension, level] of Object.entries(seed.levels)) {
    const field = FIELD_OF[dimension];
    if (!field) continue;
    const before = merged[field];
    const beforeNum = typeof before === 'number' ? before : undefined;
    if (beforeNum === level) continue;
    const hit = seed.evidence.find((e) => e.dimension === dimension);
    merged[field] = level;
    changes.push({
      field,
      from: beforeNum,
      to: level,
      keyword: hit?.keyword ?? '',
      reason: hit?.reason ?? '',
    });
  }
  return { profile: merged as T, changes };
}

/** 一句给用户看的话。界面不该只闷声改画像。 */
export function describeChanges(changes: IntakeChange[]): string {
  if (changes.length === 0) return '';
  const LABEL: Record<string, string> = {
    programming_level: '编程',
    python_level: 'Python',
    agent_level: '智能体',
    rag_level: '检索增强',
    engineering_level: '工程',
  };
  const parts = changes.map((c) => `${LABEL[c.field] ?? c.field} → ${c.to} 档`);
  const kw = changes.find((c) => c.keyword)?.keyword;
  const because = kw ? `根据你写的「${kw}」，` : '根据你的描述，';
  return `${because}本次按 ${parts.join('、')} 生成。想长期改档位请到学习者画像里调。`;
}
