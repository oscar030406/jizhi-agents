/**
 * 离线补审：给「审核门关着生成」的课补一份事实性读数。
 *
 * ## 为什么要它
 *
 * 消融爬升的档 0（裸生成）与档 1（+模板池）都关了 `AUDIT_GATE`，落盘的课
 * 没有 `scene.audit`。于是爬升表最左边两档**没有事实性可比**——
 * 那张图画不出「从裸生成一路爬上来」，只剩右边两档孤零零两个点。
 *
 * 补的办法不是重新生成（那会把档间差混进生成随机性），而是**拿已经落盘的正文
 * 事后跑一遍判官**。生成条件不变，只补量具。
 *
 * ## 口径必须与产品一致，否则数字不可比
 *
 * 直接 import 产品的 `auditSceneContent`（`lib/generation/hallucination-audit.ts`），
 * 判官提示词、断言抽取、supported/uncertain/incorrect 的判法、
 * 甚至今天刚接上的数字旁路，全部跟着产品走——**这里一行判据都不自己写**。
 * 自己抄一份判官提示词是这类脚本最容易犯的错：抄的那一刻两条口径就开始分叉，
 * 而分叉之后算出来的「爬升」有一半是量具差异。
 *
 * 一处必须显式说明的差别：**这次补审没有证据**（不传 `evidence`）。
 * 产品线上审核带 RAG 证据、`EVIDENCE_ADDENDUM` 会把判官收紧
 * （supported 必须给得出 sourceId）。所以补审出来的是**无证据臂**的读数，
 * 与档 2/3 落盘时带证据的那份**不同口径**——报告里必须分开写，不许并列成一张表。
 *
 * 用法（cwd 必须是 apps/classroom，tsx 装在那边）：
 *   node --import tsx ../agent-engine/scripts/eval_sprint/offline_audit.mjs \
 *     --ids fHyaHoRE_S,oMqxcgn1f4 --budget 1
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CLASSROOM,
  EVIDENCE,
  Budget,
  arg,
  callModel,
  emit,
  flag,
  list,
  loadApiKey,
  stamp,
  stripProxyEnv,
} from './common.mjs';

const DRY = flag('dry-run');
const IDS = list('ids', []);
const JUDGE = arg('judge-model', 'MiniMaxAI/MiniMax-M2.5');

function loadCourse(id) {
  const p = path.join(CLASSROOM, 'data', 'classrooms', `${id}.json`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function main() {
  const stripped = stripProxyEnv();
  console.log('=== 离线补审（无证据臂）===');
  console.log(`判官：${JUDGE}`);
  console.log(`已剥代理变量：${stripped.join(', ') || '（无）'}`);
  if (!IDS.length) throw new Error('要补审哪几门课？用 --ids a,b');

  const apiKey = DRY ? null : loadApiKey();
  const budget = new Budget(Number(arg('budget', '1')));
  const ctx = { budget, apiKey };

  // 产品的审核链。**判据全部来自它，这里不自己写判官提示词。**
  const auditMod = pathToFileURL(
    path.join(CLASSROOM, 'lib', 'generation', 'hallucination-audit.ts'),
  ).href;
  const { auditSceneContent } = await import(auditMod);

  const rows = [];
  for (const id of IDS) {
    const course = loadCourse(id);
    const scenes = (course.scenes || []).filter(
      (s) => s?.content && (s.content.type === 'slide' || s.content.canvas),
    );
    console.log(`\n--- ${id}｜${course.stage?.name ?? ''}｜${scenes.length} 屏 ---`);

    let claims = 0;
    let incorrect = 0;
    let uncertain = 0;
    let audited = 0;
    for (const scene of scenes) {
      if (DRY) {
        audited += 1;
        continue;
      }
      const judgeCall = async (system, user) => {
        const res = await callModel(
          { model: JUDGE, system, user, tag: '离线补审', maxTokens: 2048 },
          ctx,
        );
        return res.text ?? '';
      };
      const { audit } = await auditSceneContent({
        sceneTitle: scene.title ?? '',
        content: scene.content,
        judgeCalls: [judgeCall],
        // 不传 reviseCall：补审只量，不改内容——改了就不是「这一档生成出来的东西」了。
        judgeModel: JUDGE,
        sceneType: scene.content?.type ?? 'slide',
      });
      audited += 1;
      claims += audit.totalClaims ?? 0;
      incorrect += audit.claims?.filter((c) => c.verdict === 'incorrect').length ?? 0;
      uncertain += audit.claims?.filter((c) => c.verdict === 'uncertain').length ?? 0;
      process.stdout.write('.');
    }
    const supported = claims - incorrect - uncertain;
    const rate = claims ? supported / claims : null;
    console.log(
      `\n  断言 ${claims}｜支持 ${supported}｜存疑 ${uncertain}｜判错 ${incorrect}` +
        `｜事实性 ${rate == null ? '—' : `${(rate * 100).toFixed(1)}%`}`,
    );
    rows.push({
      script: 'offline_audit',
      classroomId: id,
      title: course.stage?.name ?? '',
      scenesAudited: audited,
      totalClaims: claims,
      incorrectCount: incorrect,
      uncertainCount: uncertain,
      supportedRate: rate,
      arm: 'no-evidence',
    });
  }

  const md =
    `# 离线补审（无证据臂）${stamp()}\n\n` +
    '给审核门关着生成的课补事实性读数。**生成条件不变，只补量具。**\n\n' +
    '⚠️ **与落盘时带证据的读数不同口径**：这次补审不传 evidence，' +
    '产品线上审核带 RAG 证据且 `EVIDENCE_ADDENDUM` 会把判官收紧（supported 须给出 sourceId）。' +
    '两者不许并列成一张表。\n\n' +
    '| 课 | 屏 | 断言 | 支持 | 存疑 | 判错 | 事实性 |\n|---|---:|---:|---:|---:|---:|---:|\n' +
    rows
      .map(
        (r) =>
          `| ${r.classroomId} | ${r.scenesAudited} | ${r.totalClaims} | ` +
          `${r.totalClaims - r.incorrectCount - r.uncertainCount} | ${r.uncertainCount} | ` +
          `${r.incorrectCount} | ${r.supportedRate == null ? '—' : `${(r.supportedRate * 100).toFixed(1)}%`} |`,
      )
      .join('\n') +
    `\n\n样本量 ${rows.length} 门，每档 1 门——**档间差可能就是生成随机性**，不足以下结论。\n` +
    // 成本进报告，不只进控制台：报告是留档的那一份，控制台一关就没了。
    `\n\n## 成本\n\n${budget.markdown()}\n`;

  const out = emit(`offline_audit-${stamp()}${DRY ? '-dryrun' : ''}`, { rows, md });
  console.log(`\n明细 ${out.jsonl}\n报告 ${out.report}`);
  console.log(`\n${budget.markdown()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
