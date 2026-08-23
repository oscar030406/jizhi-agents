/**
 * 测评环节的选题：最大 Fisher 信息量（MFI）。纯函数，零外部依赖。
 *
 * `lib/generation/selection.ts` 的 `rankNext` 管的是**学习环节**——把学习者放在
 * 0.75–0.85 的目标成功率带里，别推进挫败区。那份模块的 `rankNext` 文档末尾自己写了
 * 一句「测评环节（冷启动初评、置信度不够时的复核）该按 CAT 的最大信息选题，不走这条键」，
 * 一直是句空头支票。这个文件把它兑现，**不动 `rankNext`**：
 *
 * | | 目标 | 最优点 |
 * |---|---|---|
 * | `rankNext`（学） | 别让他失败 | P(答对) ∈ [0.75, 0.85] |
 * | 本模块（测） | 把 θ 量准 | P(答对) = (1+√(1+8c))/4，四选一下 0.683 |
 *
 * 两个目标**相邻但不相等**：四选一时测评的最优点 0.683 落在学习带下沿 0.75 **之下**，
 * 也就是「要问准一个人，得问得比教他时略难一点」。所以 MFI 是与 `rankNext`
 * **并列**的第三条排序键，按场合二选一，不是替换、也不塞进 `rankNext` 当 tie-break——
 * 塞进去等于让测评目标悄悄改掉学习路径的顺序。这条不变式在
 * `tests/quiz/item-selection.test.ts` 里钉成断言（`peakProb(0.25) < TARGET_SUCCESS_MIN`）。
 *
 * ## 公式出处
 *
 * 三参数 logistic（3PL，Birnbaum 1968，收在 Lord & Novick《Statistical Theories of
 * Mental Test Scores》ch. 17–20）：
 *
 *   P(θ) = c + (1−c) / (1 + exp(−a(θ−b)))
 *
 * 单题 Fisher 信息量（Lord 1980《Applications of Item Response Theory to Practical
 * Testing Problems》，由 I = (P′)²/(P(1−P)) 代入上式化简得）：
 *
 *   I(θ) = a² · (P−c)² · (1−P) / [ (1−c)² · P ]
 *
 * c=0 时退化成 2PL 的 `a²·P·(1−P)`——这正是 EduCAT（BIGDATA-USTC）MFI 策略里
 * IRT 模型那一支的信息量式子。**这里是照着公式重写的几十行，没有引它的包、没有抄它的源码。**
 *
 * 选题规则（Lord 1977，Applied Psychological Measurement 1(1)）：在候选池里取
 * `argmax I(θ̂)`。停止规则用 `SE(θ̂) = 1/√ΣI`（渐近标准误）。
 *
 * ## 我们的数据条件：只有粗档，没有逐题连续难度
 *
 * `QuizQuestion`（`@openmaic/dsl` 的 `src/stage.ts`）**没有难度字段**，`points` 是配分。
 * 逐 chunk 自动标难度那条路已经试过并被拒（`docs/05-evidence/admin-spec-audit-20260814.md`
 * H5：`chunk_difficulty_labels.json` 1702 条，重测同档率 57.5%、κ=0.292，不达标）。
 * 现存唯一有出处的难度刻度是 **L1–L4 四个粗档**，以及引擎侧
 * `apps/agent-engine/backend/services/difficulty_calibration.py` 里那张定标表。
 *
 * 所以本模块的 b 只有四个取值，θ 只有一条从掌握度线性映射来的刻度——常数全部照抄那份
 * 定标表，不另立一套（两处对不上时，难度定标报告与课堂选题会给出互相矛盾的结论）。
 * **能力的上限就在这里**：档内不可分辨，MFI 在同档同型的题之间给不出顺序。
 * 它真正起作用的地方是**跨档**（分阶测验选哪一档）和**跨题型**（猜对率不同，
 * 信息量差得很明显）。
 */

/** 难度档。与引擎侧 `difficulty_calibration.py` / `personalize_service` 的 L1–L4 同一套。 */
export type DifficultyTier = 'L1' | 'L2' | 'L3' | 'L4';

export const TIERS: readonly DifficultyTier[] = ['L1', 'L2', 'L3', 'L4'];

/**
 * 难度档 → Rasch 难度参数 b（logit 尺度）。逐字取自
 * `apps/agent-engine/backend/services/difficulty_calibration.py` 的 `DIFFICULTY_B`。
 * 等距铺开，不是拟合出来的——我们没有真实作答数据可拟合，这一点写在那份脚本的模块头里。
 */
export const TIER_DIFFICULTY: Readonly<Record<DifficultyTier, number>> = {
  L1: -1.5,
  L2: -0.5,
  L3: 0.5,
  L4: 1.5,
};

/**
 * 固定区分度 a。同上，取自定标脚本的 `DISCRIMINATION_A = 1.7`
 * （1.7 是 logistic 逼近正态 ogive 的惯例常数）。
 *
 * 全池共用一个 a 的后果要记住：`I(θ)` 里的 `a²` 变成公因子，**跨档比较时它约不掉但
 * 不改变排序**——排序完全由 `|θ−b|` 与 `c` 决定。要让 a 真正参与排序，得有逐题区分度，
 * 那需要真实作答数据。
 */
export const DISCRIMINATION = 1.7;

/** 缺省档。与引擎 `decide_feedback(..., current_difficulty="L2")` 的默认值一致。 */
export const DEFAULT_TIER: DifficultyTier = 'L2';

/**
 * 掌握度 m∈[0,1] → 能力 θ∈[−2,2]。取自定标脚本的 `_ability`：`4m − 2`。
 *
 * 非有限值（NaN / Infinity）一律当 0 掌握度，与 `selection.ts` 的 `estimateOf` 同一条
 * 约定：脏数据宁可当他不会，与「跳过要高置信」同向。
 *
 * ponytail: 线性映射且两端截断——m=1 只给到 θ=2，比 L4 的 b=1.5 只高 0.5，
 * 顶端学习者之间分不开。真要分得开得换 logit 映射，但那要求 m 本身是校准过的概率，
 * 我们的 m 来自 fold 的估计值，没到那个精度。
 */
export function abilityFromMastery(mastery: number): number {
  const m = Number.isFinite(mastery) ? Math.min(1, Math.max(0, mastery)) : 0;
  return 4 * m - 2;
}

/**
 * 题型 + 选项数 → 猜对率 c。
 *
 * 单选取 1/选项数，与 `lib/generation/selection.ts` 的 `guessByOptions` 同一个约定
 * （小样本下 3PL 的 c 不可识别，只能钉死）。多选按「可区分的作答组合数」算：
 * n 个选项有 2ⁿ−1 种非空选法，蒙中一种的概率 1/(2ⁿ−1)——比单选低一个量级，
 * 所以同档的多选题携带的信息量比单选高。短答无选项可蒙，c=0。
 *
 * 选项数缺失/非法时按短答处理（c=0）而不是编一个默认值：c 高估会低估信息量，
 * 反过来会高估，宁可高估信息量也不要因为一个编出来的 c 把题排到后面去。
 */
export function guessRate(type: string | undefined, options: number | undefined): number {
  const n = Number.isFinite(options) ? Math.floor(options as number) : 0;
  if (type === 'short_answer' || n < 2) return 0;
  if (type === 'multiple') return 1 / (Math.pow(2, n) - 1);
  return 1 / n;
}

/** 3PL 的答对概率。`a` 缺省用 {@link DISCRIMINATION}。 */
export function probCorrect(ability: number, b: number, guess = 0, a = DISCRIMINATION): number {
  const c = Math.min(0.95, Math.max(0, guess));
  return c + (1 - c) / (1 + Math.exp(-a * (ability - b)));
}

/**
 * 单题 Fisher 信息量。`I(θ) = a²(P−c)²(1−P) / [(1−c)²P]`（见模块头出处）。
 *
 * 分母的 P 在 θ→−∞ 时趋于 c>0 而不是 0，所以不会真的除零；c=0 时 P→0 但分子的
 * (P−c)²=P² 掉得更快，极限是 0。浮点下仍可能出 0/0，兜底返回 0——
 * 「离题太远的题不带信息」，这与极限一致，不是掩盖。
 */
export function itemInformation(
  ability: number,
  b: number,
  guess = 0,
  a = DISCRIMINATION,
): number {
  const c = Math.min(0.95, Math.max(0, guess));
  const p = probCorrect(ability, b, c, a);
  if (p <= 0 || p >= 1) return 0;
  const info = (a * a * (p - c) * (p - c) * (1 - p)) / ((1 - c) * (1 - c) * p);
  return Number.isFinite(info) && info > 0 ? info : 0;
}

/**
 * 信息量峰值处的答对概率：`P* = (1 + √(1+8c)) / 4`（Birnbaum 1968）。
 *
 * 这个值**与 a、b 无关**，只由猜对率决定：c=0 时 0.5（经典结论——2PL 的最优题正好是
 * 五五开），c=0.25 时 0.683。它是本模块与学习环节判据的接缝：0.683 < 0.75，
 * 「测得准」要求的题比「学得下去」要求的题略难。
 */
export function peakProb(guess: number): number {
  const c = Math.min(0.95, Math.max(0, guess));
  return (1 + Math.sqrt(1 + 8 * c)) / 4;
}

/**
 * 信息量峰值所在的 θ：`θ* = b + (1/a)·ln[(1+√(1+8c))/2]`。
 * c=0 时就是 b（最优题难度等于能力）；c>0 时峰值**右移**，即四选一的最优题比学习者
 * 的能力略难一点。这就是「不能直接照抄『选难度最接近的那档』」的地方。
 */
export function peakAbility(b: number, guess: number, a = DISCRIMINATION): number {
  const c = Math.min(0.95, Math.max(0, guess));
  return b + Math.log((1 + Math.sqrt(1 + 8 * c)) / 2) / a;
}

/**
 * 一批题的渐近标准误：`SE(θ̂) = 1/√ΣI`。池子空或总信息为 0 时返回 `Infinity`
 * ——「一道题都没答，对他的能力一无所知」。
 *
 * 这个函数存在的理由是**证伪自己**：`lib/generation/selection.ts` 的
 * `ESTIMATE_MASTERED` 注释里写着「把置信门槛照抄 CAT 的 SE ≤ 0.32 需要 29–65 道
 * 四选一题，我们一次也达不到」。有了它，这句话不用再靠引用，当场能算。
 */
export function standardError(informations: readonly number[]): number {
  const total = informations.reduce((s, i) => s + (Number.isFinite(i) && i > 0 ? i : 0), 0);
  return total > 0 ? 1 / Math.sqrt(total) : Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// 候选池排序
// ---------------------------------------------------------------------------

/** 候选题。三个字段都可缺——缺什么就退化成什么，见各字段说明。 */
export interface CandidateItem {
  id: string;
  /** 难度档。缺省按 {@link DEFAULT_TIER}——档位缺失时全池同 b，排序只剩题型在起作用。 */
  tier?: DifficultyTier;
  /** 选项数。单选/多选用；短答不填。 */
  options?: number;
  /** `QuizQuestion.type`。缺省按单选处理（有选项数时）。 */
  type?: string;
}

export interface InformationPick {
  id: string;
  /** Fisher 信息量，首排序键，大的先。 */
  information: number;
  /** 现在考他的答对概率（3PL，与 `predictedCorrect` 的 DINA 通道不是同一个模型）。 */
  predicted: number;
  /** 这道题用的难度参数。 */
  b: number;
  /** 这道题用的猜对率。 */
  guess: number;
}

/** 名字排序，只为让结果稳定可测（与 `selection.ts` 的 `byName` 同一个理由）。 */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 候选池按 Fisher 信息量降序。信息量相等时按 id——**不引入随机数**，
 * 同一份卷子重跑要出同一个顺序（与 `item-gate.ts` 的轮转选项同一条纪律）。
 *
 * 空池返回空数组。全会（θ 顶到 2）/ 全不会（θ 到 −2）都只是让信息量普遍变小，
 * 不会崩、也不会返回空——极端处仍有一个「最不坏」的选择。
 */
export function rankByInformation(
  items: readonly CandidateItem[],
  ability: number,
  a = DISCRIMINATION,
): InformationPick[] {
  const theta = Number.isFinite(ability) ? ability : 0;
  return items
    .map((item) => {
      const b = TIER_DIFFICULTY[item.tier ?? DEFAULT_TIER];
      const guess = guessRate(item.type, item.options);
      return {
        id: item.id,
        information: itemInformation(theta, b, guess, a),
        predicted: probCorrect(theta, b, guess, a),
        b,
        guess,
      };
    })
    .sort((x, y) => y.information - x.information || byId(x.id, y.id));
}

// ---------------------------------------------------------------------------
// 接入点一：分阶测验——下一份卷子出哪一档
// ---------------------------------------------------------------------------

export interface TierPick {
  tier: DifficultyTier;
  information: number;
  predicted: number;
}

/**
 * 按 MFI 选下一份测验的难度档。
 *
 * 这是 MFI 在我们的数据条件下**最站得住的用法**：b 只有四个取值，但这四个值有出处
 * （定标脚本），而「选哪一档」恰好就是分阶测验唯一要决的事。
 *
 * 与「选难度最接近的那档」的差别在 c 上：`peakAbility` 说峰值比 b 高
 * `ln[(1+√(1+8c))/2]/a`，四选一 a=1.7 时是 +0.18 logit。也就是同样的能力，
 * 四选一该出得比短答**略难**——纯比距离的做法给不出这个修正。差值不大，
 * 但它是有推导的差，不是拍的。
 *
 * `allowed` 用来卡住画像给的难度带（`quiz_difficulty_band`）：带外的档不该被选中，
 * 哪怕它信息量更高。空数组视为不限。
 */
export function pickTier(
  mastery: number,
  opts: { allowed?: readonly DifficultyTier[]; options?: number; type?: string } = {},
): TierPick {
  const theta = abilityFromMastery(mastery);
  const guess = guessRate(opts.type, opts.options ?? 4);
  const pool = opts.allowed?.length ? TIERS.filter((t) => opts.allowed!.includes(t)) : TIERS;
  const tiers = pool.length ? pool : TIERS;

  let best: TierPick | null = null;
  for (const tier of tiers) {
    const b = TIER_DIFFICULTY[tier];
    const information = itemInformation(theta, b, guess);
    // 平手取更低的档：`tiers` 按 L1→L4 遍历，只在严格更大时替换。
    // 理由是不对称的代价——档选高了学习者直接卡住，选低了只是少测到一点信息。
    if (!best || information > best.information) {
      best = { tier, information, predicted: probCorrect(theta, b, guess) };
    }
  }
  // `tiers` 恒非空，这里必有值；写成兜底只为让类型收敛。
  return best ?? { tier: DEFAULT_TIER, information: 0, predicted: 0 };
}

/** L1–L4 → 出题接口用的三档（`SceneOutline.quizConfig.difficulty`）。L4 并入 hard。 */
export function quizDifficultyOf(tier: DifficultyTier): 'easy' | 'medium' | 'hard' {
  if (tier === 'L1') return 'easy';
  if (tier === 'L2') return 'medium';
  return 'hard';
}

/** 宽松解析：认 L1–L4，也认 easy/medium/hard（后者没有 L4 的名字）。认不出返回 null。 */
export function parseTier(raw: string | undefined): DifficultyTier | null {
  const s = (raw ?? '').trim().toUpperCase();
  if (s === 'L1' || s === 'L2' || s === 'L3' || s === 'L4') return s;
  if (s === 'EASY') return 'L1';
  if (s === 'MEDIUM') return 'L2';
  if (s === 'HARD') return 'L3';
  return null;
}

// ---------------------------------------------------------------------------
// 接入点二：错题重练——先重练哪一道
// ---------------------------------------------------------------------------

/** 一道待重练的错题。`tier` 缺失是常态，见 {@link rankRepractice} 的说明。 */
export interface RepracticeItem extends CandidateItem {
  /** 上次是否作答过。空答 = false。 */
  answered?: boolean;
}

/**
 * 错题重练队列排序：Fisher 信息量降序，**空答的题排到最后**。
 *
 * 两条键的分工：
 *
 * 1. **空答先剔出去**（`answered === false`）。`lib/quiz/grading.ts` 已经把这个区分
 *    写在 `QuestionResult.answered` 上：空答是「不知道」（元认知型），答了但错是
 *    「会用错」（应用型），补救方向不同——前者该降档重讲，后者才该加练订正。
 *    MFI 管不了这件事：信息量只看 θ 和题目参数，看不见「他连试都没试」。
 *    硬按信息量排会把该重讲的题排到重练队首。所以这条键在**信息量之前**，
 *    它是分流不是排序，属于既有判据，不是 MFI 带来的。
 * 2. 同类内按信息量降序（{@link rankByInformation}）。
 *
 * **诚实交代这里 MFI 剩多少**：错题本条目（`lib/evidence/mistake-bank.ts` 的
 * `MistakeEntry`）没有难度档字段，同一场测验的错题也共用一个 `quizConfig.difficulty`，
 * 所以 `tier` 在跨会话回放时基本恒为缺省值——b 全池相同，信息量的差异**只剩题型与
 * 选项数**（短答 c=0 信息最高，四选一次之，多选因为 c 极小反而接近短答）。
 * 这是个真实存在但很弱的排序。要让这一处真正吃到 MFI，缺的是**逐题难度档**：
 * 要么出题时把档写进 `QuizQuestion`，要么把场景的 `quizConfig.difficulty` 落进
 * `MistakeEntry`。两者都在本模块管不到的地方。
 */
export function rankRepractice(
  items: readonly RepracticeItem[],
  mastery: number,
): Array<InformationPick & { answered: boolean }> {
  const theta = abilityFromMastery(mastery);
  const answeredOf = new Map(items.map((i) => [i.id, i.answered !== false]));
  return rankByInformation(items, theta)
    .map((pick) => ({ ...pick, answered: answeredOf.get(pick.id) ?? true }))
    .sort(
      (x, y) =>
        Number(y.answered) - Number(x.answered) ||
        y.information - x.information ||
        byId(x.id, y.id),
    );
}
