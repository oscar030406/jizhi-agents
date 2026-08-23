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

const KEY = 'mistakeBank';
/** 封顶条数。超出丢最旧的——错题本是近期回放，不是终身档案。 */
const CAP = 200;

export function readMistakes(): MistakeEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
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
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // 配额满等情况：宁可丢错题记录也不打断交卷流程。
  }
}
