/**
 * 旧课裸写教具重生成（缺陷台账 #旧教具 4 件处置，用户已批）。
 *
 * 对每个目标场景：走模板池路径重生成（interactive-template-select）→ 判官团
 * 重审核 → 替换课程 JSON 里的 content+audit（原件备份）。选不出贴题模板时
 * 生成链自动降级为同主题讲义（降级也比烂教具好——设计内行为）。
 *
 * ⚠ 跑前确认 dev :3000 空闲、引擎 :8001 带 AI_SERVICE_TOKEN 在跑。
 * 用法：node scripts/regenerate-widget-scene.mjs [--only OrIuCbq0Lw:5,...] [--dry]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const COURSES = path.join(ROOT, 'apps/classroom/data/classrooms');
const BACKUP = path.join(ROOT, 'tmp/widget-regen-backup-20260810');
const BASE = 'http://localhost:3000';

// 审核三判官单请求可超 5 分钟——Node 全局 fetch 的 undici 默认 headersTimeout
// 5min 必炸（memory: undici 非流式 5min 老坑）。借 classroom 的 undici 用带
// 长超时 dispatcher 的 fetch。
const undici = await import(
  pathToFileURL(path.join(ROOT, 'apps/classroom/node_modules/undici/index.js')).href
);
const dispatcher = new undici.Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });
const ufetch = undici.fetch;

/** 目标清单（scene 序号 1 起）。outline 描述手写贴题——原大纲未随课持久化。 */
const TARGETS = [
  {
    course: 'OrIuCbq0Lw', scene: 5,
    outline: {
      id: 'regen-oriu-s5', title: '温度参数模拟器', type: 'interactive',
      interactiveConfig: { conceptName: '温度参数', conceptOverview: '温度参数缩放 logits 改变 softmax 分布的确定性与随机性', designIdea: '温度滑块实验：拖动温度观察概率分布与采样行为变化' },
      description: '拖动温度滑块，观察 softmax 概率分布随温度变化：低温分布尖锐输出确定，高温分布平滑输出随机。让学习者亲手感受温度参数对采样的影响。',
      keyPoints: ['温度缩放 logits 改变 softmax 分布形状', '低温更确定、高温更随机', '采样按分布抽取下一 token'],
    },
  },
  {
    course: 'OrIuCbq0Lw', scene: 3,
    outline: {
      id: 'regen-oriu-s3', title: 'Softmax 可视化探索', type: 'interactive',
      interactiveConfig: { conceptName: 'Softmax 归一化', conceptOverview: 'softmax 把任意分数映射为和为 1 的概率分布，指数放大分差', designIdea: '分数滑块实验：调 logit 看概率柱实时变化' },
      description: '调整各分数（logit）滑块，实时观察 softmax 归一化后的概率分布柱状图，理解指数放大与归一化的效果。',
      keyPoints: ['softmax 把任意分数变成和为 1 的概率分布', '分数差距被指数放大', '温度参数缩放分数'],
    },
  },
  {
    course: 'h9BW5iQ-9D', scene: 4,
    outline: {
      id: 'regen-h9-s4', title: '注意力权重可视化', type: 'interactive',
      interactiveConfig: { conceptName: '注意力权重', conceptOverview: 'Q·K 相关性经 softmax 归一化决定注意力在各 token 的分配', designIdea: '注意力热区：点选 query 看权重分布' },
      description: '点选 query 词，观察注意力权重在各 token 上的分布热区；调整温度观察分布变化。理解 Q·K 相关性如何决定注意力分配。',
      keyPoints: ['注意力权重来自 Q 与 K 的相关性', 'softmax 归一化为概率分布', '权重决定 Value 的加权求和'],
    },
  },
  {
    course: '-Bc-f90i3V', scene: 3,
    outline: {
      id: 'regen-bc-s3', title: '梯度下降可视化探索', type: 'interactive',
      interactiveConfig: { conceptName: '梯度下降', conceptOverview: '沿梯度反方向按学习率步长迭代逼近损失最小值', designIdea: '损失曲线上拖起点调学习率看迭代轨迹' },
      description: '在损失曲线上拖动起点、调整学习率，观察梯度下降的迭代轨迹：学习率过大震荡、过小缓慢。',
      keyPoints: ['沿梯度反方向更新参数', '学习率决定步长', '过大震荡过小缓慢'],
    },
  },
];

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(',')) : null;

fs.mkdirSync(BACKUP, { recursive: true });

async function post(url, body) {
  const res = await ufetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-locale': 'zh-CN' },
    body: JSON.stringify(body),
    dispatcher,
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${JSON.stringify(payload).slice(0, 200)}`);
  return payload;
}

for (const t of TARGETS) {
  const key = `${t.course}:${t.scene}`;
  if (only && !only.has(key)) continue;
  const file = path.join(COURSES, `${t.course}.json`);
  const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const sc = d.scenes[t.scene - 1];
  console.log(`\n=== ${key} 「${sc.title}」（现 type=${sc.type}）`);
  if (dry) continue;

  const stageInfo = { name: d.stage?.name ?? t.course };
  const gen = await post('/api/generate/scene-content', {
    outline: t.outline,
    allOutlines: [t.outline],
    stageId: `widget-regen-${t.course}`,
    stageInfo,
  });
  const content = gen?.content ?? gen?.data?.content ?? gen?.data;
  const wc = content?.widgetConfig;
  const degraded = !wc || wc.type !== 'template';
  console.log(degraded
    ? `  模板未命中 → 降级产物（type=${content?.type ?? '?'}）`
    : `  模板命中：${wc.templateId}`);
  if (!content) {
    console.log('  ✗ 无产物，跳过（原场景保留）');
    continue;
  }

  const auditRes = await post('/api/generate/scene-audit', {
    outline: t.outline,
    content,
    courseTitle: stageInfo.name,
  });
  const audit = auditRes?.audit ?? auditRes?.data?.audit;
  const auditedContent = auditRes?.content ?? auditRes?.data?.content ?? content;
  console.log(`  审核：${audit?.verdict ?? '?'}（claims ${audit?.totalClaims ?? '?'}，decision ${audit?.decision ?? '?'}）`);

  fs.writeFileSync(path.join(BACKUP, `${t.course}-s${t.scene}.json`), JSON.stringify(sc, null, 2), 'utf-8');
  // 类型壳（08-04 教训重演被抓）：生成层产物无 type 壳，裸塞 content 会被
  // 渲染器判 Invalid——按场景类型补壳再落
  sc.content =
    auditedContent && typeof auditedContent === 'object' && !auditedContent.type
      ? { type: 'interactive', ...auditedContent }
      : auditedContent;
  if (audit) sc.audit = audit;
  if (degraded && content?.type !== 'interactive') sc.type = 'slide';
  fs.writeFileSync(file, JSON.stringify(d), 'utf-8');
  console.log(`  ✓ 已替换并落盘（原件备份 ${BACKUP}）`);
}
console.log('\n完成');
