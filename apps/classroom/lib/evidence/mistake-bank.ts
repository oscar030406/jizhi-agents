/**
 * 错题本——DeepTutor Question Bank 的提炼（判决见
 * docs/04-research/deeptutor-transplant-decision-20260821.md）。
 *
 * DeepTutor 的设计点：题目的 explanation 不出现在作答卡片上（防泄答案），但随
 * 作答记录进题库，是学习者日后复习错题时唯一能看到的解析。我们同构：quiz 的
 * `analysis` 字段在作答界面本来就不展示，交卷后把**答错的题**连同解析、学习者
 * 答案、正确答案存进这里，学情报告的错题本块回放。
 *
 * 为什么不塞进证据账本：账本是画像的原料，schema 冻结、只存 40 字符题干摘要
 * （防撑爆）；错题本是给人看的完整回放，两者目的不同，各存各的。
 * 存 localStorage（与画像同层，本机优先），条数封顶防膨胀。
 */

import { useAccountStore } from '@/lib/store/account';

export interface MistakeEntry {
  at: string;
  sceneId: string;
  sceneTitle: string;
  questionId: string;
  prompt: string;
  /** 题目解析（quiz 的 analysis 字段）。没有就空。 */
  analysis: string;
  userAnswer: string;
  correctAnswer: string;
  /** false = 空答（元认知型：不会）；true = 答了但错（应用型：会用错）。 */
  answered: boolean;
  /**
   * 交卷时画像所选的域（与证据的 Measured.domain 同源）。出货端联动清单 C2：
   * 不带域的错题本在换库后必然把两个知识库的错题混排——用户明令不许混。
   * 可选：老记录没有此字段，读取端把 undefined 当「不过滤时可见、按域过滤时归旧域桶」。
   */
  domain?: string;
  /**
   * 交卷时这一屏测验的难度档（`SceneOutline.quizConfig.difficulty`，easy/medium/hard）。
   *
   * 错题重练按 Fisher 信息量排序（`lib/quiz/item-selection.ts` 的 `rankRepractice`），
   * 而信息量要的是**逐题难度**。这个字段是错题本里唯一能提供 b 的东西——
   * 不存它，全池同 b，排序就退化成只按题型分，几乎没有区分度。
   *
   * 口径要说清：它是**屏级**的，同一场测验的错题共用一个值，所以它区分不了
   * 同屏内的难易。真正的逐题难度要出题时写进 `QuizQuestion`，那是另一张单。
   *
   * 可选：老记录没有此字段，读取端按 `DEFAULT_TIER` 处理。
   */
  tier?: string;
  /**
   * 题型与选项数。信息量里的猜对率 c 由它们决定（短答 c=0 最高、四选一 0.25 最低）。
   *
   * 与 `tier` 一起存是有必要的：`tier` 是屏级的、同屏内恒等，
   * **同屏错题之间的排序全靠这两格**。不存的话读取端连题型都不知道，
   * `rankRepractice` 在同一屏的错题上会退化成按 id 排序。
   */
  questionType?: string;
  optionCount?: number;
}

const KEY_BASE = 'mistakeBank';

/**
 * 错题本按账号分桶。
 *
 * ## 为什么必须分
 *
 * 原来是全局单键 `mistakeBank`，同一台浏览器换个账号照样读得出上一个人的错题，
 * 而学情报告拿它算掌握度——**别人的作答算进你的学情**。
 * 2026-08-24 走读实锤：错题本里混进了同浏览器旧账号的 3 条题。
 *
 * 这个文件为「域」那根轴修过一次（见上面 `domain` 字段的注释：不带域的错题本
 * 换库后必然把两个库的错题混排）。**账号那根轴当时没人想起来**——
 * 同一个文件、同一种病，隔了几周才由走读发现。
 *
 * 键名沿用仓库已有的约定 `<base>@<accountId>`（`maic.learnerMerged@<id>` 同款），
 * 不另起一套。
 *
 * ## 没登录的时候
 *
 * 用基础键（`mistakeBank`），也就是匿名桶。账户系统没启用的部署一切照旧。
 */
function bankKey(): string {
  try {
    const id = useAccountStore.getState().account?.id;
    return id ? `${KEY_BASE}@${id}` : KEY_BASE;
  } catch {
    return KEY_BASE; // store 还没挂载（SSR / 早期调用）：退回匿名桶
  }
}

/**
 * 把匿名桶里的老数据认领进当前账号，认领完删掉老键。**每个账号只做一次**。
 *
 * 不做迁移的话，加前缀那一刻现存用户的错题本会凭空消失——新键是空的。
 * 「认领」按先到先得：老数据没有主人标签，谁先登录归谁。
 * 那也比现在强——现在是**所有账号都看得见**，认领之后只有一个人看得见。
 */
function claimLegacyOnce(key: string): void {
  if (key === KEY_BASE) return; // 匿名桶自己就是老键，没什么可认领
  try {
    if (localStorage.getItem(key) !== null) return; // 这个账号已经有自己的桶
    const legacy = localStorage.getItem(KEY_BASE);
    if (legacy === null) return;
    localStorage.setItem(key, legacy);
    localStorage.removeItem(KEY_BASE);
  } catch {
    /* 存储不可用：认领失败不拦读写，最坏是这个账号从空错题本开始 */
  }
}
/** 封顶条数。超出丢最旧的——错题本是近期回放，不是终身档案。 */
const CAP = 200;

export function readMistakes(): MistakeEntry[] {
  if (typeof localStorage === 'undefined') return [];
  const key = bankKey();
  claimLegacyOnce(key);
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? (raw as MistakeEntry[]) : [];
  } catch {
    return [];
  }
}

/** 新错题排最前（错题本按最近优先读）。存失败静默——错题本丢一条不拦交卷。 */
export function appendMistakes(entries: ReadonlyArray<MistakeEntry>): void {
  if (typeof localStorage === 'undefined' || entries.length === 0) return;
  try {
    const merged = [...entries, ...readMistakes()].slice(0, CAP);
    localStorage.setItem(bankKey(), JSON.stringify(merged));
  } catch {
    // 配额满等情况：宁可丢错题记录也不打断交卷流程。
  }
}
