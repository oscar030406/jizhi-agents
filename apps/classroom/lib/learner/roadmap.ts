/**
 * 线性路线图的数据整理（纯函数，不碰 React）。
 *
 * 评审意见是「学习路径以文本呈现，不直观」。/path 上已经有两张图（3D 知识宇宙、
 * 2D 前置图），它们讲的是**结构**；这里补的是学习者自己的那条**顺序**：
 * 从当前位置往前后看，一站一站排开。
 *
 * ## 顺序从哪来
 *
 * 只来自引擎已经排好的阶次：`/api/domain-path/{corpus}` 的 `stages[].index` 与
 * 阶内概念的书写顺序。画像与答题只移动游标（`cursor`），一个站都不重排——
 * 这是产品口径，和 domain-learning-path.tsx 里那句「引擎只用账户级画像与测验掌握度
 * 移动游标，不改知识库已有概念和顺序」是同一条。
 *
 * 输入直接复用 domain-learning-path.tsx 已经合好的 `graphNodes`（概念中文名、挂的课、
 * 掌握度状态都在里面），不新开取数口；课程是 /api/course-path 与 /api/course-domains
 * 在那里合进去的。
 *
 * ## 状态语义
 *
 * 与知识宇宙的图例逐条对应（components/path/knowledge-universe.tsx 的 COLOR 与图例）：
 * 已掌握 / 当前推荐 / 未测的概念 / 先学 / 学完可去。引擎给的 `future` 在这里按前置
 * 拆成两种——前置还没掌握的是「先学」（被前置卡住），前置都掌握了的是「学完可去」。
 * 拆开的理由：一条线上「后续」这一档占了大半，全同色等于没画。
 */

/** 站点状态。前三种与最后一种是宇宙图例原样，`ready` 对应图例里的「学完可去」。 */
export type RoadmapStatus = 'mastered' | 'current' | 'blocked' | 'ready' | 'unmeasured';

/** 引擎给的原始状态（domain-learning-path.tsx 的 `PathStatus`）。 */
export type EngineStatus = 'mastered' | 'current' | 'future' | 'unmeasured';

/** 与 concept-graph.tsx 的 `MASTERY_THRESHOLD` 同一档，两处别各写一个数。 */
export const MASTERY_THRESHOLD = 0.7;

export interface RoadmapInputNode {
  id: string;
  /** 中文名；概念表里查不到时是引擎给的 name 或 id 原样 */
  label: string;
  /** 引擎给的阶次，1 起 */
  stage: number;
  prereq: ReadonlyArray<string>;
  status?: EngineStatus;
  mastery?: number | null;
  courses: ReadonlyArray<{ id: string; title: string }>;
}

export interface RoadmapInputStage {
  index: number;
  title: string;
}

export interface RoadmapStation {
  id: string;
  label: string;
  stage: number;
  stageTitle: string;
  /** 是不是本阶的第一站：画阶次分隔用 */
  stageHead: boolean;
  status: RoadmapStatus;
  mastery: number | null;
  /** 还没掌握的前置的中文名。只有 `blocked` 用它说明卡在哪，其余站可能非空但不展示 */
  blockedBy: string[];
  courses: ReadonlyArray<{ id: string; title: string }>;
}

export interface Roadmap {
  stations: RoadmapStation[];
  /** 当前位置的下标。-1 = 没有可推进的站（路径为空，或本域概念全部达标） */
  cursor: number;
  counts: Record<RoadmapStatus, number>;
  /** 这个账户在本域有没有同源测评。false 时整条线只有「未测」，游标停在第一站 */
  measured: boolean;
}

const EMPTY_COUNTS: Record<RoadmapStatus, number> = {
  mastered: 0,
  current: 0,
  blocked: 0,
  ready: 0,
  unmeasured: 0,
};

function isMastered(node: RoadmapInputNode): boolean {
  return node.status === 'mastered' || (node.mastery ?? -1) >= MASTERY_THRESHOLD;
}

/**
 * 把概念节点摊成一条线。
 *
 * 排序只用 `stage`：同阶保持输入顺序（输入本身就是按引擎 `stages[]` 摊平的），
 * 所以同一份数据每次画出来一样，截图对得上。
 *
 * 同一个概念在两阶都出现时只留第一次——键要唯一，且更早的那一阶才是它该被学的位置。
 */
export function buildRoadmap(
  nodes: ReadonlyArray<RoadmapInputNode>,
  stages: ReadonlyArray<RoadmapInputStage> = [],
): Roadmap {
  const titleOfStage = new Map(stages.map((stage) => [stage.index, stage.title]));

  const seen = new Set<string>();
  const unique: RoadmapInputNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    unique.push(node);
  }

  // 稳定排序：V8 的 sort 已经是稳定的，但把下标写进比较里，口径就不依赖运行时实现。
  const ordered = unique
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.stage - b.node.stage || a.index - b.index)
    .map((entry) => entry.node);

  const masteredIds = new Set(ordered.filter(isMastered).map((node) => node.id));
  const labelOf = new Map(ordered.map((node) => [node.id, node.label]));

  const counts: Record<RoadmapStatus, number> = { ...EMPTY_COUNTS };
  let lastStage: number | null = null;

  const stations: RoadmapStation[] = ordered.map((node) => {
    // 只算路线上真有的前置：引擎的 prereq_ids 里会有本域路径之外的 id，
    // 拿它去说「你被 X 卡住」而 X 一站都不在线上，是解释不通的。
    const blockedBy = node.prereq
      .filter((id) => labelOf.has(id) && !masteredIds.has(id))
      .map((id) => labelOf.get(id)!);

    let status: RoadmapStatus;
    if (isMastered(node)) status = 'mastered';
    else if (node.status === 'current') status = 'current';
    else if (node.status === 'future') status = blockedBy.length ? 'blocked' : 'ready';
    else status = 'unmeasured';

    counts[status] += 1;
    const stageHead = node.stage !== lastStage;
    lastStage = node.stage;

    return {
      id: node.id,
      label: node.label,
      stage: node.stage,
      stageTitle: titleOfStage.get(node.stage) ?? `第 ${node.stage} 阶`,
      stageHead,
      status,
      mastery: typeof node.mastery === 'number' ? node.mastery : null,
      blockedBy,
      courses: node.courses,
    };
  });

  // 游标：引擎点名的「当前推荐」优先；它没点名就落在第一个还没掌握的站上。
  // 全掌握（以及一站都没有）时 findIndex 返回 -1，不硬塞一个位置。
  const currentIndex = stations.findIndex((station) => station.status === 'current');
  const firstUnfinished = stations.findIndex((station) => station.status !== 'mastered');
  const cursor = currentIndex >= 0 ? currentIndex : firstUnfinished;

  const measured = ordered.some(
    (node) =>
      typeof node.mastery === 'number' || node.status === 'mastered' || node.status === 'current',
  );

  return { stations, cursor, counts, measured };
}
