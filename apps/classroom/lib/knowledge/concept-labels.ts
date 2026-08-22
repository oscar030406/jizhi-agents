/**
 * 概念 id → 中文名的**单一真源**。与 `domain-labels.ts` 同级同风格：一张表，
 * 查不到原样返回，不兜底成别的名字。
 *
 * 这张表原来抄在两个页面里（`app/report/page.tsx` 的 CONCEPT_META、
 * `app/demo/report/page.tsx` 的 CONCEPT_LABEL，后者是只留 label 的裁剪版），
 * 两份都是模块私有。于是首页学情卡、/console 的掌握度列表这些够不着它的地方
 * 就把 `llm_basics` 这类内部代号直接上屏了。合并到这里，读点一律 import。
 *
 * label + keywords 是引擎 `backend/services/goal_concepts.py` 里 KEYWORD_CONCEPTS
 * 的逆映射——「该概念在本课程里出现过吗」用的就是引擎当初挑概念用的那套词。
 */

export const CONCEPT_META: Record<string, { label: string; keywords?: string[] }> = {
  llm_basics: {
    label: '大模型基础',
    keywords: [
      '大模型',
      '大语言模型',
      'llm',
      'gpt',
      'transformer',
      '注意力',
      'attention',
      '分词',
      'tokenizer',
      '预训练',
      '微调',
      'rlhf',
    ],
  },
  deep_learning: {
    label: '深度学习',
    keywords: ['深度学习', '神经网络', '卷积', 'cnn', '池化', 'lenet'],
  },
  rag: {
    label: '检索增强 RAG',
    keywords: ['rag', '检索', '文档问答', '问答', '重排', '排序', 'retrieval'],
  },
  tool_calling: { label: '工具调用', keywords: ['工具', 'tool', 'function', '函数调用'] },
  langgraph: { label: '工作流编排', keywords: ['langgraph', '工作流', '编排', '状态图'] },
  evaluation: {
    label: '评测与指标',
    keywords: ['评测', '评估', '指标', '看板', 'eval', 'evaluate'],
  },
  guardrails: {
    label: '审核与护栏',
    keywords: ['审核', '复核', '裁决', '校验', '拒答', '拦截', '权限', '安全', 'guardrail'],
  },
  deployment: {
    label: '部署与接口',
    keywords: ['部署', '上线', '接口', 'api', 'http', 'docker', 'deploy'],
  },
  agent_basics: { label: '智能体基础', keywords: ['agent', '智能体', '助手'] },
  // 这两个只在前置图里出现（它们是别人的前置），引擎的 KEYWORD_CONCEPTS 里没有。
  // 给中文名是为了列「必经但清单没列的前置」时不露裸 id；
  // **不给 keywords**——上面那批是引擎词表的逆映射，这里编一套关键词进去，
  // 「本课程覆盖了该概念吗」就会用一套引擎从没用过的词判定。
  prompt_engineering: { label: '提示工程' },
  context_engineering: { label: '上下文工程' },
  // embodied 域的七个概念，同样**不给 keywords**，理由同上。名字取自
  // `data/knowledge_base/embodied_docs/` 里挂这个标签的章节标题，不是现编的：
  // 它们出现在 `lib/generation/data/prereq-graph.json` 的 embodied 段和
  // `lib/evidence/data/scene-concepts.json`（160 个场景里占 26 个），
  // 表里没有就意味着学情图和前置清单上直接印 `embodied_vlm`。
  embodied_ros2: { label: 'ROS 2 机器人系统' },
  embodied_sim: { label: '机器人仿真环境' },
  embodied_control: { label: '控制器与运动控制' },
  embodied_rl: { label: '强化学习' },
  embodied_vlm: { label: '视觉语言模型 VLM' },
  embodied_vla: { label: '视觉-语言-动作模型 VLA' },
  embodied_practice: { label: '四足机器人实操' },
};

/**
 * 概念的显示名。**认不出就原样返回**，不编中文名。
 *
 * 掌握度表的键是混合来源：导学写的是引擎概念 id（`llm_basics`），测验写的是
 * 场景标题（「知识巩固测试」）。后者本来就是中文，走这个函数原样出去。
 */
export function conceptLabel(key: string): string {
  return CONCEPT_META[key]?.label ?? key;
}

/** 判「本课程覆盖了该概念吗」用的词。表里没有就拿 id 本身当词。 */
export function conceptKeywords(key: string): string[] {
  return CONCEPT_META[key]?.keywords ?? [key.toLowerCase(), key.replace(/_/g, ' ').toLowerCase()];
}
