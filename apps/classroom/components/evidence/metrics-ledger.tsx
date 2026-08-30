'use client';

/**
 * 区 E「我们测出来的数」折叠台账（公共页规格区 E）。
 *
 * 每行三列：值 / 口径原文 / 复算命令。数字只用 apps/agent-engine/data/metrics.json
 * 里真有的条目，口径跟着数字走——脱离口径的数字禁止上页。
 * 改这里的任何数字必须先改 metrics.json 真源，再跑
 * python apps/agent-engine/scripts/check_metrics.py（本文件已登记进 citations）。
 *
 * 刻意不上页的两个数：det_concept_coverage 1.0（分母是自家概念清单，循环论证）、
 * 「交付端<5%」（放行条件写死幻觉率阈值，是同义反复不是质量证据）。
 * 折叠用原生 <details>，不引依赖。
 */

const LEDGER = [
  {
    label: '生成端幻觉率（断言级）',
    value: '2.08%（95%CI 1.20%–3.61%）',
    caliber:
      '统计范围：576 条可核断言 / 57 个真实生成 run，12 条判无据。' +
      '两条覆盖限制：① 被审正文占比 51.5%；② 另有 38% 抽出句被审核智能体判为非事实断言' +
      '（教学类比 / 指令 / 题目解析 / 代码）。所以这是「讲义中可核事实断言」的幻觉率，' +
      '不是全篇幻觉率。',
    source:
      'cd apps/agent-engine && python scripts/run_real_llm_eval.py --gold v2 --concurrency 8 --output-dir data/eval/real_llm_v2',
  },
  {
    label: 'RAGTruth 检测层 F1',
    value: '0.336',
    caliber: 'RAGTruth QA 测试集 900 条，确定性检测层。外部公开数据集，非自证。',
    source: 'cd apps/agent-engine && python scripts/bench_ragtruth.py',
  },
  {
    label: '主语料新增知识域（具身智能）· 幻觉率',
    value: '1.55%（3/193）',
    caliber:
      '具身智能语料（752 个证据块）并入主索引 knowledge_index.jsonl 后，同一套多智能体管线' +
      '生成 2 门课（ROS2 入门 / VLA 入门）的生成端断言级幻觉率：三方审核 + 仲裁 + 修订后 ' +
      'incorrect 占比。这是 AI 大类内部的语料扩充，不是跨大类泛化域——跨大类泛化只有 IoTDB ' +
      '与 Odoo 两个，对照见 /admin/generalization。样本为课程审核链而非评测链，' +
      '与上面 2.08% 的口径不可直接对比；37 条 uncertain 按口径不进分子（超证据覆盖标注）。',
    source:
      'cd apps/agent-engine && python scripts/ingest_embodied.py && python scripts/build_knowledge_base.py && python scripts/build_embedding_index.py；造课走 /api/generate-classroom',
  },
  {
    label: '跨域画像适配准确率（两个泛化域）',
    value: '智能制造 77.8%｜IoTDB 94.4%（各 n=18）',
    caliber:
      '与主域 85.2% 同一把尺子（rubric v4：每例三判官独立盲评 2-of-3），但 n 差六倍——' +
      '主域 108 组、泛化域各 18 组（三档画像 × 6 主题），区间宽得多，只作等价检验不作优劣比较。' +
      '用例集与选题规则测前冻结并留哈希（见提交包证据目录）；画像三档定义与主域逐字相同，' +
      '只换 persona 行业背景与主题。分档 n=6，按档的数不可解读。' +
      '这一栏是难度分层缺陷修复后的一轮：修复前同一份用例集是智能制造 66.7%、IoTDB 88.9%，' +
      '两个域走向不一致，两比例检验判不出差异，两轮并列存档不择优。修复站得住的理由是机制证据——' +
      '同一查询在不同摘录难度上限下返回的证据块变了；修复前整库难度恒为 L1，上限卡在哪里都一样。',
    source:
      'cd apps/agent-engine && python scripts/judge_adaptation_probe.py --panel --resources data/eval/adaptation_probe/resources-<域>-tiered --out data/eval/adaptation_probe/runs/crossdomain-<域>-tiered-v4',
  },
  {
    label: '核心知识点覆盖率',
    value: '96.0%（48/50，6 门金标课汇总）',
    caliber:
      '金标全部 frozen-v1：教材目录独立构建、专家审查转正、生成前冻结。两级判定 = ' +
      '同义词机械匹配（讲解级：命中场景正文 ≥120 字）+ 审核智能体二级复核' +
      '（判词必须引课内原文且引文经机械核验，核不上不采信；borderline 双判一致制，不一致维持 miss）。' +
      '逐门全部 ≥90%，但单门分母只有 6-11 个知识点，小分母下逐门数字不承诺置信度，' +
      '只作重生成触发器；对外主数字用汇总口径（Σ命中/Σ总数，分母 50）。',
    source:
      'cd apps/agent-engine && python scripts/compute_kc_coverage.py --gold data/eval/kc_gold/<topic>.json --course ../classroom/data/classrooms/<id>.json --emit-misses <f> && python scripts/judge_kc_coverage.py --gold ... --course ... --misses <f>',
  },
  {
    label: '接地拼装管线 · 学习增益',
    value: '87%',
    caliber:
      '闭卷两阶段，17 题 ×2 轮，相对教材达成率；与教材同预算相比统计上分不开' +
      '（非劣效检验 δ=0.4 判不了），优势含选段与题库锚点对齐成分。',
    source: 'data/eval/learning_gain/report_e3_assembly.json',
  },
  {
    label: '仅提示词改造 · 学习增益（对照）',
    value: '66%',
    caliber: '同一批题、同一审核口径下的对照组；迁移层 31% 未过预注册的 40% 线。',
    source: 'data/eval/learning_gain/report_e1_prompts.json',
  },
  {
    label: '学习者画像-资源难度适配准确率（主口径）',
    // 区间写进「值」而不是只留在口径长段里：这个指标的目标线是 ≥85%，
    // 点估计只高出 0.2pp 而下界没过，单独摆 85.2% 会让人以为过线了。
    // 与上面幻觉率那一行同格式（值自带 95% CI）。
    value: '85.2%（95% CI 77.8–92.6%，n=108，下界未达 85%）',
    caliber:
      '离线口径 2A · rubric v4 预注册（run 20260813-001359）：108 组 = 3 档画像 × 12 主题 × 3 实例，' +
      '整批在同一代码快照下重新生成；三个审核智能体对每一例各独立盲评一次（都不见画像），' +
      '2-of-3 多数决，三方全不同记 0。' +
      '分档：beginner 86.1% / transition 88.9% / advanced 80.6%。' +
      '区间用聚类自助（按主题重抽）算 95% CI [77.8%, 92.6%]——同主题的 9 组共享素材，' +
      '按独立同分布算会把区间算窄。' +
      '距 ≥85% 目标线：点估计高出 0.2pp，区间下界未过。' +
      '精确二项检验 P(X≥92 | n=108, p=0.85) = 0.545——真实率恰为 85% 时看到 92 命中' +
      '本就是过半会发生的事，这个样本对「真值高于 85%」的证据量是零。' +
      '换估计量救不了：九种方法下界全在 77.1%–79.6%（最松的 Wald 单侧 79.56%），' +
      '同 n 下要过线需命中 ≥97；扩样本也救不了：聚类自助的精度由簇数（12 个主题）决定，' +
      '把 n 按比例复制到 1080 区间一字不变。逐条复算见 ' +
      'docs/05-evidence/adaptation-ci-honest-reporting-20260813.md。' +
      '主题由 6 扩到 12 是为了收窄区间，实测抽样半宽 10.2 → 7.4 个百分点；' +
      '新增的 6 个主题是生成侧从未针对性调过的，点估计因此比 6 主题那批低——' +
      '这是扩样本该暴露的东西。两批测试集不同，数字不可直比，下一行是旧那批。',
    source:
      'cd 挑战杯 && node scripts/run-adaptation-probe.mjs && cd apps/agent-engine && python scripts/judge_adaptation_probe.py --panel',
  },
  {
    label: '同一口径 · 6 主题旧测试集（保留并列）',
    value: '88.9%（95% CI 74.1–98.1%，n=54）',
    caliber:
      '同为 rubric v4（run 20260812-193908），差别只在测试集：6 主题 × 9 画像 = 54 组，' +
      '且那批资源生成于更早的代码快照。' +
      '分档：beginner 94.4% / transition 88.9% / advanced 83.3%；三方全不同 0 例，' +
      'Fleiss kappa 0.758。聚类 95% CI [74.1%, 98.1%]，比 12 主题那批宽 9.3 个百分点。',
    source: 'cd apps/agent-engine && python scripts/judge_adaptation_probe.py --panel',
  },
  {
    label: '同一指标 · 严格口径（08-12 前的主数字，保留并列）',
    value: '81.5%（44/54，run 20260811-010557）',
    caliber:
      'rubric v2：同一批资源、同一份难度判据，差别只在分歧处置——两个审核智能体判定' +
      '不一致时一律记 0。已知它会低估：13 例失分里 7 例的目标档被至少一位智能体判中了。' +
      '它被取代的原因不是数字难看，是估计量有结构缺陷：复核由第一个智能体的自报置信度触发，' +
      '而那个自报置信度实测与真实可靠性不挂钩。分档：beginner 83.3% / transition 83.3% / advanced 77.8%。',
    source: 'cd apps/agent-engine && python scripts/judge_adaptation_probe.py',
  },
  {
    label: '同一指标 · 仲裁口径（并列，第三个数）',
    value: '88.9%（48/54，run 20260811-012228）',
    caliber:
      'rubric v3：只在 borderline 且两个智能体分歧时请第三个仲裁，2-of-3 多数决。' +
      '分档：beginner 88.9% / transition 83.3% / advanced 94.4%。' +
      '⚠ 它与主口径**数值相同、路径不同**（一个是全量三评、一个是分歧才仲裁），' +
      '所以三行都印了 run id——只写 88.9% 分不开是哪一个。',
    source: 'cd apps/agent-engine && python scripts/judge_adaptation_probe.py --arbiter',
  },
  {
    label: '岗位技能证据覆盖率',
    value: '51.3%',
    caliber:
      '分母 = 14 岗位 150 条技能（不去重）；分子 = hybrid 检索有命中且无证据不足告警' +
      '（77 条）。测的是知识库的证据供给能力，不是课程已讲授。',
    source: 'cd apps/agent-engine && python scripts/compute_job_coverage.py',
  },
] as const;

export function MetricsLedgerSection() {
  return (
    // id 供页脚「数字台账」锚点直达（public-site-redesign §1 页脚证据列）
    <section id="metrics-ledger" className="mt-16 scroll-mt-20">
      <details className="group rounded-xl border border-border bg-card shadow-card dark:shadow-none">
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <span className="text-xl font-semibold">实测指标台账</span>
          <span className="text-xs text-muted-foreground">
            <span className="group-open:hidden">展开台账 · 每个数带口径与复算命令</span>
            <span className="hidden group-open:inline">收起</span>
          </span>
        </summary>
        <div className="overflow-x-auto border-t border-border">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">值</th>
                <th className="px-5 py-2.5 font-medium">口径原文</th>
                <th className="px-5 py-2.5 font-medium">复算命令 / 数据源</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {LEDGER.map((row) => (
                <tr key={row.label} className="align-top">
                  <td className="px-5 py-3">
                    <p className="whitespace-nowrap font-semibold tabular-nums [font-feature-settings:'tnum']">
                      {row.value}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{row.label}</p>
                  </td>
                  <td className="px-5 py-3 text-xs leading-relaxed text-muted-foreground">
                    {row.caliber}
                  </td>
                  <td className="px-5 py-3">
                    <code className="block max-w-xs whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                      {row.source}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
          表中数字与仓库内的指标数据文件自动校验一致；口径不同的数字不作直接对比。
        </p>
      </details>
    </section>
  );
}
