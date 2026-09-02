/**
 * 实操指南导出 — 把一门课里全部 procedural-skill 场景组装成一份 Markdown。
 *
 * 数据来源（只读，不编造）：
 * - scene.content.widgetConfig（ProceduralSkillConfig，生成 HTML 内嵌的结构化配置，最丰富）
 * - outline.widgetOutline（大纲侧字段，含 widgetConfig 没有的 errorConsequences）
 * - localStorage.learnerProfile 摘要（适用画像一行）
 * 缺哪个字段就跳过哪节。
 */
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline, LearnerProfileFields } from '@/lib/types/generation';
import type { ProceduralSkillConfig } from '@/lib/types/widgets';
import { projectProfileToDomain } from '@/lib/knowledge/domain-context';
import { redact } from '@/lib/privacy/redact';

export function isProceduralScene(scene: Scene): boolean {
  return scene.content?.type === 'interactive' && scene.content.widgetType === 'procedural-skill';
}

function findOutline(scene: Scene, outlines: SceneOutline[]): SceneOutline | undefined {
  if (scene.outlineId) {
    const byId = outlines.find((o) => o.id === scene.outlineId);
    if (byId) return byId;
  }
  return outlines.find((o) => o.order === scene.order);
}

const LEVEL_LABELS: Array<[keyof LearnerProfileFields, string]> = [
  ['programming_level', '编程'],
  ['python_level', 'Python'],
  ['agent_level', 'Agent'],
  ['rag_level', 'RAG'],
  ['engineering_level', '工程'],
];

/**
 * 画像摘要一行；无画像返回空串。
 *
 * role / domain 是学习者自己填的自由文本，是这份导出里唯一的用户输入，
 * 所以出文件前过一遍 {@link redact}。正文（任务、步骤、验收点）不脱敏：
 * 那是课件内容，实操课里的绝对路径、邮箱多半是教学素材，抹了指南就废了。
 */
export function summarizeLearnerProfile(profile: LearnerProfileFields | null): string {
  if (!profile) return '';
  const parts: string[] = [];
  if (profile.role) parts.push(profile.role);
  if (profile.domain) parts.push(`领域 ${profile.domain}`);
  for (const [key, label] of LEVEL_LABELS) {
    const v = profile[key];
    if (typeof v === 'number') parts.push(`${label} Lv${v}`);
  }
  if (profile.currentDifficulty) parts.push(`当前难度 ${profile.currentDifficulty}`);
  return redact(parts.join(' · '));
}

function bulletList(lines: string[], items: string[] | undefined, heading: string): void {
  if (!items || items.length === 0) return;
  lines.push(`### ${heading}`, '');
  for (const item of items) lines.push(`- ${item}`);
  lines.push('');
}

/**
 * 组装整份 Markdown。scenes 里非 procedural-skill 的场景被忽略；
 * 一个 procedural 场景都没有时返回 null（调用方隐藏入口，正常到不了这里）。
 */
export function buildPracticeGuideMarkdown(
  stageName: string,
  scenes: Scene[],
  outlines: SceneOutline[],
  profileSummary?: string,
): string | null {
  const proceduralScenes = scenes.filter(isProceduralScene);
  if (proceduralScenes.length === 0) return null;

  const lines: string[] = [`# 实操指南 — ${stageName}`, ''];
  if (profileSummary) lines.push(`> 适用画像：${profileSummary}`, '');

  proceduralScenes.forEach((scene, i) => {
    const content = scene.content as Extract<Scene['content'], { type: 'interactive' }>;
    const config =
      content.widgetConfig?.type === 'procedural-skill'
        ? (content.widgetConfig as ProceduralSkillConfig)
        : undefined;
    const widgetOutline = findOutline(scene, outlines)?.widgetOutline;

    const task = config?.task || widgetOutline?.task || scene.title;
    lines.push(`## 任务${i + 1}：${task}`, '');
    lines.push(`> 来源场景：第 ${scene.order + 1} 页「${scene.title}」`, '');
    if (config?.description) lines.push(config.description, '');

    bulletList(lines, config?.tools ?? widgetOutline?.tools, '工具与材料');

    // 操作步骤：优先 widgetConfig 的结构化步骤（带每步工具/验收点），退回大纲的字符串步骤。
    if (config?.steps && config.steps.length > 0) {
      lines.push('### 操作步骤', '');
      config.steps.forEach((step, n) => {
        lines.push(
          `${n + 1}. **${step.title}**${step.description ? ` — ${step.description}` : ''}`,
        );
        if (step.tools?.length) lines.push(`   - 所需工具：${step.tools.join('、')}`);
        for (const check of step.successCriteria ?? []) lines.push(`   - 验收点：${check}`);
      });
      lines.push('');
    } else if (widgetOutline?.steps?.length) {
      lines.push('### 操作步骤', '');
      widgetOutline.steps.forEach((step, n) => lines.push(`${n + 1}. ${step}`));
      lines.push('');
    }

    bulletList(lines, config?.successCriteria ?? widgetOutline?.successCriteria, '验收标准');
    bulletList(lines, widgetOutline?.errorConsequences, '常见错误与后果');
  });

  return lines.join('\n');
}

/** 读画像 + 组装 + 触发浏览器下载。仅浏览器端调用。 */
export function exportPracticeGuide(
  stageName: string,
  scenes: Scene[],
  outlines: SceneOutline[],
  domain?: string,
): boolean {
  let profile: LearnerProfileFields | null = null;
  try {
    const stored = JSON.parse(localStorage.getItem('learnerProfile') ?? 'null');
    profile = stored && domain ? projectProfileToDomain(stored, domain) : null;
  } catch {
    // 画像损坏就不带画像行
  }
  const markdown = buildPracticeGuideMarkdown(
    stageName,
    scenes,
    outlines,
    summarizeLearnerProfile(profile),
  );
  if (!markdown) return false;

  const safeName = stageName.replace(/[\\/:*?"<>|]/g, '_') || '未命名课程';
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `实操指南-${safeName}.md`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}
