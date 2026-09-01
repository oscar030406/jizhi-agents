'use client';

/**
 * 从页面发起一次领域接入 run。
 *
 * 两个开关（试跑体检 / 向量索引）都会真的调接口并计费，所以点「发起」不直接发车，
 * 先弹一层把这次要跑什么、跑多久、大概花多少摆出来，确认了才提交。
 * 时间比 token 数更有用——十二分钟里大半在审核，看的人要知道不是卡死了。
 *
 * 表单大部分字段原样交给桥接路由（`app/api/knowledge/intake-runs/route.ts`），
 * 字段名与引擎的 `Form(...)` 声明一一对应；只有难度那一格例外，见下。
 *
 * ## 投料形态三选一
 *
 * 一次只渲染选中那一路的输入框，没选的那两路连 input 都不在 DOM 里——FormData 里
 * 因此只会出现一个投料字段，桥那边不用猜哪个才算数。字段名：`files` / `zip` / `git_url`。
 *
 * ## 难度那一格为什么要翻译一层
 *
 * 引擎收的是 `tier_range`（`L1-L3` 这样的档位码，`backend/rag/emit.py` 的
 * `tier_bounds()` 只认里面的数字，切出几层就把素材按相对难度分成几层）。这个串对
 * 接入语料的人没有意义——08-16 用户评审的原话是「难度选择 1-3 是什么意思？」。
 * 所以表单问的是人话：**这批语料的学习者分几档、每档面向谁**；提交时
 * `tierRangeFor()` 把档数折成档位码，用户写的原文另走 `tier_definitions` 存进
 * run 记录（引擎跑链不读它，只在 run 页面回看时显示）。
 *
 * 档位码不出现在页面上，也不出现在任何 input 的 value 里——`tier_range` 是提交前
 * 现算进 FormData 的，不是藏一个 hidden input。
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * 试跑体检的实测口径。区间取自磁盘上跑完 ⑥⑦ 的两次 run（都是 4 屏，
 * token 数按 `apps/classroom/data/usage/<月>.jsonl` 的同窗记录求和，
 * 金额按 `backend/services/cost_meter.py` 的 PRICE_TABLE 逐模型折算）：
 *
 * - `20260815T195938-0f2a74`（12 块的库）：706,957 ms，41 次调用，
 *   input 129,971 + output 178,814 = 308,785 token，¥0.68
 * - `20260816T033452-2c7cae`（4 块的库）：999,423 ms，33 次调用，
 *   input 73,773 + output 134,835 = 208,608 token，¥0.49
 *
 * 50 万是引擎的 `TRIAL_TOKEN_BUDGET` 停机线，不是实测值。
 * 换库、换模型、改屏数都会变，改这里之前先跑一次拿新数。
 */
const TRIAL_COST = {
  minutes: '12–17',
  calls: '33–41',
  tokens: '21–31 万',
  budget: '50 万',
  yuan: '0.5–0.7',
};

/**
 * 试跑体检跑几档、几屏，是引擎侧写死的：`domain_intake.TRIAL_TIERS` 两档画像
 * （入门档 / 进阶档）× `TRIAL_SCENES_PER_COURSE = 2` 屏 = 4 次生成。
 * **它不跟着这里的档数走**——所以档数填 3 时要照实说第三档不会单独出试跑屏，
 * 不能顺着「你定义几档就跑几档」把话说圆。
 */
const TRIAL_TIERS = 2;
const TRIAL_SCENES = 2;

/** 档位模板：默认两档，第三档要点「加一档」才出现。文案是预填值，可改可删。 */
const TIER_TEMPLATE: ReadonlyArray<{ label: string; audience: string }> = [
  { label: '入门', audience: '没接触过这套系统的新人：从概念和一个能跑起来的最小例子讲起' },
  { label: '进阶', audience: '已经会用、要独立处理现场问题的人：讲取舍、边界条件和常见坑' },
  { label: '精通', audience: '要为团队定规范的人：讲架构权衡、故障复盘和跨系统的影响面' },
];
const MAX_TIERS = TIER_TEMPLATE.length;

/**
 * 档数 → 引擎的档位码区间。
 *
 * 引擎按这个区间把素材切成同样多的难度层（`plan_sections` 里 `TIERS[lo-1:hi]`，
 * 层内按相对难度分位切）。所以「分几档」与「素材分几层」是同一个数，翻译是一一对应的，
 * 不是把用户的话硬塞进一个固定区间。
 */
export function tierRangeFor(count: number): string {
  const n = Math.min(Math.max(Math.round(count) || 1, 1), 4);
  return n === 1 ? 'L1' : `L1-L${n}`;
}

/** 投料形态。key 就是提交时用的字段名（`git` 那一路的字段是 `git_url`）。 */
const SOURCES = [
  { key: 'files', label: '上传文件' },
  { key: 'zip', label: '上传压缩包' },
  { key: 'git', label: '填仓库地址' },
] as const;
type SourceKind = (typeof SOURCES)[number]['key'];

/** 输入框的样式，不含宽度——宽度由各处自己给，混在一起 Tailwind 的 w-* 会互相盖。 */
const FIELD_BASE =
  'rounded-lg border border-border bg-background px-3 py-1.5 text-xs outline-none focus:border-purple-400/70';
const FIELD = `w-full ${FIELD_BASE}`;

/** 字节转人话。上传进度要频繁刷，别在渲染里做字符串拼接以外的事。 */
function mb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)}GB` : `${(bytes / 1e6).toFixed(1)}MB`;
}

/** 秒转「x 分 y 秒」。超过一小时就不细报了——那种情况人不会盯着看。 */
function eta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds > 3600) return '一小时以上';
  const m = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return m > 0 ? `${m} 分 ${sec} 秒` : `${sec} 秒`;
}

export function StartIntake() {
  const router = useRouter();
  const [tiers, setTiers] = useState(() => TIER_TEMPLATE.slice(0, 2).map((t) => ({ ...t })));
  const [source, setSource] = useState<SourceKind>('files');
  const [pending, setPending] = useState<FormData | null>(null);
  const [busy, setBusy] = useState(false);
  /** 选完文件立刻回显。原来只在确认弹层里印，表单上零反馈——验收时对方
   *  选完 392MB 的 zip 什么都没看到，只能靠开控制台查 DOM 才确认挂上了。 */
  const [picked, setPicked] = useState<string | null>(null);
  /** 上传进度。null = 没在传。大包要传好几分钟，不给数就跟死了没区别。 */
  const [sent, setSent] = useState<{ loaded: number; total: number; bytesPerSecond: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const files = pending ? pending.getAll('files').filter((f) => f instanceof File) : [];
  const zip = pending?.get('zip');
  const gitUrl = String(pending?.get('git_url') ?? '').trim();
  /** 确认弹层里那句「这次投的是什么」——三种形态各说各的，别都印成文件数。 */
  const sourceSummary =
    zip instanceof File ? `压缩包 ${zip.name}` : gitUrl ? `仓库 ${gitUrl}` : `${files.length} 个文件`;
  const trial = pending?.get('trial_run') === 'true';
  const vector = pending?.get('build_vector') === 'true';
  /** 追加模式。**必须在弹层里回显**：新建与追加的行为差别极大（跑几站、
   *  会不会碰既有库），只在表单勾一下、确认时只字不提，与当年「涉及实操
   *  不回显」同一族问题。 */
  const append = pending?.get('append') === 'true';
  /** 剔除声明的条数。与引擎 parse_exclusions 同口径（换行或逗号分条），
   *  只用于决定点回显——真正的解析仍归引擎一处。 */
  const excludeCount = String(pending?.get('exclude') ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean).length;
  /** 填没填岗位/技能清单。只判空——形状归引擎判，前端不开第二个真源。 */
  const hasJobs = String(pending?.get('job_requirements') ?? '').trim().length > 0;

  function edit(i: number, patch: Partial<{ label: string; audience: string }>) {
    setTiers((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  }

  /** 用 XHR 不用 fetch：**只有 XHR 有上传进度事件**。
   *
   *  实测（2026-08-22 验收）：投一个 392MB 的包，页面上八分钟只有「发起中」三个字，
   *  验收人不得不来问「是不是死了」——他还是知道内情的人。这不是体验瑕疵，是可信度
   *  问题：一个转了八分钟没有任何反馈的按钮，看的人只会认为它坏了。而且这一段恰好
   *  是全链唯一不可见的地方，跟我们自己主张的「过程要看得见」正好冲突。
   *
   *  `fetch` 至今没有上传进度（可读流只覆盖下载方向），所以这里退回 XHR。
   *  不引任何库——原生 `upload.onprogress` 就给字节数。 */
  async function send() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const body = await new Promise<{ success?: boolean; error?: string; run?: { run_id?: string } }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/knowledge/intake-runs');
          const startedAt = Date.now();
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const seconds = (Date.now() - startedAt) / 1000;
            setSent({
              loaded: e.loaded,
              total: e.total,
              // 均速而不是瞬时速率：瞬时值在弱网下会剧烈跳动，反而让人觉得卡了。
              bytesPerSecond: seconds > 0 ? e.loaded / seconds : 0,
            });
          };
          xhr.onload = () => {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new Error(`发起失败（HTTP ${xhr.status}）`));
            }
          };
          xhr.onerror = () => reject(new Error('网络中断，这次上传没有完成'));
          xhr.ontimeout = () => reject(new Error('上传超时'));
          xhr.send(pending);
        },
      );
      if (!body.success || !body.run?.run_id) {
        setError(body.error || '发起失败');
        return;
      }
      // 机构联动（2026-08-30）：发起人属于机构时，新库自动归属其机构——
      // 归属即学习端可见性（本机构学员可见，外机构不可见）。发起人无机构或
      // 认领失败都不拦发起：库落成后随时可在 /admin/org 手动归属。
      const corpusName = String(pending?.get('corpus') ?? '').trim();
      if (corpusName) {
        void fetch('/api/org/corpora', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ corpus: corpusName, action: 'claim' }),
        }).catch(() => undefined);
      }
      router.push(`/admin/knowledge/runs/${body.run.run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setSent(null);
    }
  }

  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          const data = new FormData(e.currentTarget);
          // 档位码在这里现算进 FormData：页面上没有它，DOM 里也没有它。
          data.set('tier_range', tierRangeFor(tiers.length));
          data.set('tier_definitions', JSON.stringify(tiers));
          setPending(data);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-[11px] text-muted-foreground">
            新库名（小写字母数字与 -_，只能建新库）
            {/* 连字符要转义：不转义时浏览器按 `v` 标志编译这条 pattern 会直接报
                Invalid character in character class，整条校验静默失效。 */}
            <input
              name="corpus"
              required
              pattern="[a-z0-9][a-z0-9_\-]*"
              placeholder="tsdb-ops"
              className={`${FIELD} mt-1 font-mono`}
            />
          </label>
          <label className="block text-[11px] text-muted-foreground">
            这个领域要培养什么人
            <input name="scope" placeholder="时序数据库运维" className={`${FIELD} mt-1`} />
          </label>
        </div>

        <div>
          <div className="text-[11px] text-muted-foreground">这批语料从哪里来</div>
          <div
            role="radiogroup"
            aria-label="这批语料从哪里来"
            className="mt-1 inline-flex gap-0.5 rounded-lg border border-border p-0.5"
          >
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                role="radio"
                aria-checked={source === s.key}
                onClick={() => setSource(s.key)}
                className={`rounded-md px-3 py-1 text-[11px] transition-colors ${
                  source === s.key
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          {/* 没选中的那两路整块不渲染：DOM 里不留空的 file input，提交上去的 FormData
              里也就只有一个投料字段。 */}
          {source === 'files' && (
            <label className="mt-2 block text-[11px] text-muted-foreground">
              挑文档传上来（md / markdown / txt / rst，可以多选）
              <input
                type="file"
                name="files"
                multiple
                required
                accept=".md,.markdown,.txt,.rst"
                onChange={(e) => {
                  const chosen = Array.from(e.currentTarget.files ?? []);
                  setPicked(
                    chosen.length === 0
                      ? null
                      : chosen.length === 1
                        ? `已挑：${chosen[0].name}（${mb(chosen[0].size)}）`
                        : `已挑 ${chosen.length} 个文件，共 ${mb(chosen.reduce((n, f) => n + f.size, 0))}`,
                  );
                }}
                className={`${FIELD} mt-1 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-[11px]`}
              />
            </label>
          )}

          {source === 'zip' && (
            <label className="mt-2 block text-[11px] text-muted-foreground">
              把整套文档打包成一个 zip 传上来，里面的文件夹层次会保留
              <input
                type="file"
                name="zip"
                required
                accept=".zip"
                onChange={(e) => {
                  const chosen = Array.from(e.currentTarget.files ?? []);
                  setPicked(
                    chosen.length === 0
                      ? null
                      : chosen.length === 1
                        ? `已挑：${chosen[0].name}（${mb(chosen[0].size)}）`
                        : `已挑 ${chosen.length} 个文件，共 ${mb(chosen.reduce((n, f) => n + f.size, 0))}`,
                  );
                }}
                className={`${FIELD} mt-1 file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-[11px]`}
              />
            </label>
          )}

          {source === 'git' && (
            <label className="mt-2 block text-[11px] text-muted-foreground">
              仓库地址（公开仓库，网站自己去把里面的文档取下来）
              <input
                name="git_url"
                type="url"
                required
                placeholder="https://github.com/apache/iotdb"
                className={`${FIELD} mt-1 font-mono`}
              />
              <span className="mt-1.5 block leading-relaxed">
                取仓库这一步走的是外网，几百个文件的仓库通常要等几分钟，网络绕远时更久；
                也可能取不下来——地址打错、仓库要登录、体积太大都会失败。真失败了不用改别的：
                把仓库下载成 zip，改用「上传压缩包」传同一份东西，后面的步骤完全一样。
              </span>
            </label>
          )}

          {/* 选完文件立刻回显。三路共用一个显示位——挂在各自的 label 里会漏，
              因为切换投料形态时那个 label 整块不渲染，回显跟着消失。 */}
          {picked && (
            <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">{picked}</p>
          )}
        </div>

        {/* 疆域的「范围」半边：这个域明确不教什么。字段直通引擎的 exclude Form 字段
            （桥不解析）。声明是库的属性——留空时引擎沿用这个库上一次声明过的那份；
            但**一旦填了就是全量替换**，上次声明过、这次没写的前缀会被丢掉（引擎会在
            ①站报警告点名）。所以这里明说「填就填全」。 */}
        <label className="block text-[11px] text-muted-foreground">
          这个域明确不教什么（选填）：一行一条路径前缀，命中的文件在收料时按声明剔除，
          且不算就绪度缺口。整个目录写目录名，单个文件写完整相对路径。
          留空则沿用这个库上一次接入时的声明；<strong className="font-medium">要改就写全</strong>
          ——填了任何一条，上次声明里没重复写的就不再生效。
          <textarea
            name="exclude"
            rows={4}
            placeholder={'SQL-Manual/Keywords.md\nAI-capability'}
            className={`${FIELD} mt-1 font-mono leading-relaxed`}
          />
        </label>

        {/* 岗位/技能清单：学习端「岗位技能地图」那一页的唯一数据源。字段直通引擎的
            job_requirements Form 字段，形状也全归引擎判——前端再写一份校验规则，
            两边迟早对不上，填错时还会蹦出两条打架的文案。
            收 JSON 而不是「一行一个岗位」：技能项本身就带顿号（「PLC 编程、触摸屏组态」
            是一项还是两项？），按分隔符猜只会猜错，而这份清单一般是从别处整理好的。 */}
        <label className="block text-[11px] text-muted-foreground">
          岗位/技能要求（选填）：这个域的学习者将来做什么岗、每个岗要会什么。
          填了，学习端的「岗位技能地图」就按这份清单列岗位，并拿这个库逐条判有没有对应的教材；
          <strong className="font-medium">不填也能建库</strong>
          ，只是那一页会如实显示「该领域未登记岗位要求」。
          格式是 JSON 数组，每项 <code>{'{title, skills, summary?}'}</code>
          ；写坏了发起时当场退回并指出是第几个岗位，不会悄悄少收一条。
          <span className="mt-1 block">
            只在新建库时生效：勾了「追加到已有库」这次不重算注册清单，填了会被退回。
          </span>
          <textarea
            name="job_requirements"
            rows={5}
            placeholder={
              '[{"title":"液压设备维护技师","summary":"负责产线液压回路的日常维护",' +
              '"skills":["液压系统日常点检","泵阀故障判读"]}]'
            }
            className={`${FIELD} mt-1 font-mono leading-relaxed`}
          />
        </label>

        <fieldset className="rounded-lg border border-border/70 bg-muted/30 px-3 py-3">
          <legend className="px-1 text-[11px] font-medium text-foreground">
            这批语料的学习者分几档？
          </legend>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            填几档，素材就按相对难度分成几层。每档写一行「面向谁、讲到哪为止」，
            会原样存进本次接入记录。
          </p>

          <ol className="mt-2.5 space-y-2">
            {tiers.map((t, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-1.5 w-9 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  第 {i + 1} 档
                </span>
                <input
                  aria-label={`第 ${i + 1} 档的名字`}
                  value={t.label}
                  onChange={(e) => edit(i, { label: e.target.value })}
                  placeholder="档位名"
                  className={`w-24 shrink-0 ${FIELD_BASE}`}
                />
                <input
                  aria-label={`第 ${i + 1} 档面向谁`}
                  value={t.audience}
                  onChange={(e) => edit(i, { audience: e.target.value })}
                  placeholder="面向谁、讲到哪为止"
                  className={`min-w-0 flex-1 ${FIELD_BASE}`}
                />
                {tiers.length > 1 && (
                  <button
                    type="button"
                    aria-label={`删掉第 ${i + 1} 档`}
                    onClick={() => setTiers((prev) => prev.filter((_, j) => j !== i))}
                    className="mt-1 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </li>
            ))}
          </ol>

          {tiers.length < MAX_TIERS && (
            <button
              type="button"
              onClick={() => setTiers((prev) => [...prev, { ...TIER_TEMPLATE[prev.length] }])}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-[11px] transition-colors hover:bg-accent"
            >
              <Plus className="size-3" />
              加一档
            </button>
          )}
        </fieldset>

        <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
          {/* 两个开关原来各挂 60–150 字的小字（试跑那条还带一句随档数变的说明），
              等于把确认弹层的内容提前印一遍。08-18 降噪：勾选项上只留「是什么、要不要钱」
              一句，跑多少屏、多少钱、你分的档与试跑档对不对得上，全部由确认弹层负责——
              那里才是真要掏钱的地方，一个字都没删，只是挪到了决定点上。 */}
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" name="trial_run" value="true" className="mt-0.5" />
            <span>
              <span className="font-medium text-foreground">试跑体检</span>
              ：在新库上真生成课程并复测幻觉、覆盖、个性化，按 token 计费。
            </span>
          </label>
          {/* C21：高危领域免责层。**由投料方声明，不从语料里猜。**
              试过关键词判据，主库与 ROS2 语料上命中的全是误报（「性价比接地气」
              「高温度 Temperature」「上下文腐蚀」），关键词认字面不认语境，
              而安全警示恰恰是语境问题。漏标是安全责任，误标是每门 AI 课
              都顶着「注意触电」——两个方向都不能接受，所以让知情的人来勾。 */}
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" name="hands_on_safety" value="true" className="mt-0.5" />
            <span>
              <span className="font-medium text-foreground">涉及实操</span>
              ：这个领域会教动手操作（带电作业、机械装配、化学品、高温高压等）。
              勾上之后，这个库生成的课程会带一层安全提示与「以现行国标和厂商手册为准」的说明。
              纯软件、纯理论的库不用勾。
            </span>
          </label>
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" name="build_vector" value="true" className="mt-0.5" />
            <span>
              <span className="font-medium text-foreground">向量索引</span>
              ：给新库建嵌入索引，按 token 计费；不开则用 TF-IDF 检索。
            </span>
          </label>
          {/* 引擎的 extract_concepts 一直有，表单里一直没有——SM 与 iotdb 重投
              都因此少了概念词表和前置图（就绪度两道闸直接 ✗）。与 exclude 同一族缺口。 */}
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" name="extract_concepts" value="true" className="mt-0.5" />
            <span>
              <span className="font-medium text-foreground">概念词表与前置图</span>
              ：从语料里抽概念词表、建章节前置关系图，就绪度的两道闸看它们——调 LLM，按 token
              计费。
            </span>
          </label>
          {/* E31 T0：追加。此前「补几篇文档进已有的库」的唯一出路是整库重建，
              而重建会让 source_id 重新编号——旧课正文里的出处集体指向别的段落，
              课看着没变，引文全错位。追加只接在后面，既有块一个字节不动。
              「改过或要删的」不在此列，那仍需重建，这句不能含糊。 */}
          <label className="flex items-start gap-2 text-[11px] leading-relaxed">
            <input type="checkbox" name="append" value="true" className="mt-0.5" />
            <span>
              <span className="font-medium text-foreground">追加到已有库</span>
              ：把这批文档补进上面填的那个<strong className="font-medium">已经存在</strong>的库。既有内容原样保留，
              已经出的课引用的出处不会断。只跑收料、切块、刷索引三站——
              概念词表、金标、注册清单沿用既有的。
              <span className="text-muted-foreground">
                {' '}
                改过的文档、要删的文档不走这条：那得整库重建。
              </span>
            </span>
          </label>
        </div>

        {error && (
          <p className="rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 text-[11px] leading-relaxed text-rose-800 dark:border-rose-800/60 dark:bg-rose-950/40 dark:text-rose-200">
            {error}
          </p>
        )}

        {/* 与 /admin 的入口按钮同一档字号：这是同一条动线的第二步，两步长得一样重。 */}
        <button
          type="submit"
          className="inline-flex items-center gap-2 rounded-full bg-foreground px-7 py-3 text-base font-medium text-background shadow-card transition-opacity hover:opacity-90"
        >
          发起接入
        </button>
      </form>

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-base">
              {append ? '确认追加到已有库' : '确认发起接入'}
            </DialogTitle>
            <DialogDescription className="text-xs">
              语料库 <code className="font-mono">{String(pending?.get('corpus') ?? '')}</code>，
              {sourceSummary}，学习者分 {tiers.length} 档。发起后系统按依赖关系逐站处理，
              过程可在接入记录页面查看。
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-2 text-[11px] leading-relaxed">
            {append && (
              <li className="rounded-lg border border-sky-300/70 bg-sky-50 px-3 py-2 text-sky-900 dark:border-sky-700/60 dark:bg-sky-950/40 dark:text-sky-200">
                <span className="font-medium">追加到已有库</span>
                ：这次不建新库，而是把文档补进{' '}
                <code className="font-mono">{String(pending?.get('corpus') ?? '')}</code>{' '}
                。既有内容原样保留，已经出的课引用的出处不会断；只跑收料、切块、
                刷索引三站，概念词表、金标、注册清单沿用既有的。
                <span className="mt-1 block">
                  库里已经有的文档会被跳过；改过的文档、要删的文档不走这条——那得整库重建。
                </span>
              </li>
            )}
            <li className="text-muted-foreground">
              档位定义会原样存进这次的接入记录：
              {tiers.map((t, i) => (
                <span key={i} className="mt-0.5 block">
                  第 {i + 1} 档「{t.label || '未命名'}」——{t.audience || '（没填）'}
                </span>
              ))}
            </li>
            {gitUrl && (
              <li className="text-muted-foreground">
                第一步是把仓库取下来，这一步可能要等几分钟，也可能失败；失败了改用上传压缩包。
              </li>
            )}
            {/* 剔除声明也要在决定点回显：填了就是全量替换上次的声明，这个差别
                与「追加/新建」同级，不能只在表单里小字带过。 */}
            <li className="text-muted-foreground">
              {excludeCount > 0
                ? `剔除声明 ${excludeCount} 条：命中的文件在收料时按声明剔除。这份声明会整体取代这个库上一次的声明。`
                : '没填剔除声明：沿用这个库上一次接入时声明过的那份（第一次接入则没有）。'}
            </li>
            {/* 岗位清单也在决定点回显。不在这里数有几个岗位：那要在前端再解析一遍
                JSON，形状判断就变成两处真源；填没填这一格已经足够决定要不要回去改。 */}
            <li className="text-muted-foreground">
              {hasJobs
                ? '岗位/技能要求：已填。建库后学习端的岗位技能地图按这份清单列岗位；格式不对会被引擎当场退回，那时这次接入不会发起。'
                : '没填岗位/技能要求：这个库的岗位技能地图会显示「该领域未登记岗位要求」，学员照常按课程学。'}
            </li>
            {trial ? (
              <li className="rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
                <span className="font-medium">试跑体检开</span>
                ：{TRIAL_COST.minutes} 分钟，大半时间花在逐条审核上。已经跑完的两次分别是{' '}
                {TRIAL_COST.calls} 次模型调用、{TRIAL_COST.tokens} token，按价目表折算 ¥
                {TRIAL_COST.yuan}（价目表自注以账单为准）；换库换模型会有出入，累计到{' '}
                {TRIAL_COST.budget} token 就停机不再发新的生成。
                {/* 联动但不圆场：试跑的档数是引擎写死的两档，与上面填几档无关。
                    这句从表单挪到这里——真要花钱的是这一步，说清楚的地方也该是这一步。 */}
                <span className="mt-1 block">
                  {tiers.length === TRIAL_TIERS
                    ? `试跑固定按入门、进阶两档各生成 ${TRIAL_SCENES} 屏（共 ${TRIAL_TIERS * TRIAL_SCENES} 次生成），正好对上你分的 ${tiers.length} 档。`
                    : `试跑固定按入门、进阶两档各生成 ${TRIAL_SCENES} 屏（共 ${TRIAL_TIERS * TRIAL_SCENES} 次生成）；你分了 ${tiers.length} 档，多出来的档不会单独出试跑屏——档位定义管的是素材怎么分层，不是试跑跑几遍。`}
                </span>
              </li>
            ) : (
              <li className="text-muted-foreground">
                试跑体检关：链跑到 ⑤ 金标冻结为止，⑥⑦ 两站记成跳过，不产生生成与审核的开销。
              </li>
            )}
            {vector && (
              <li className="text-muted-foreground">
                向量索引开：按块数调用一次嵌入接口。这一站是旁路，失败只记录告警，不判定整次接入失败。
              </li>
            )}
            {pending?.get('extract_concepts') === 'true' && (
              <li className="text-muted-foreground">
                概念词表与前置图开：④整理知识站会调 LLM 抽词表、建前置图，按 token 计费。
              </li>
            )}
          </ul>

          {/* 失败要留驻在弹层里。
              2026-08-22 验收实测：392MB 传了 7 分钟撞 408，弹层只是把「发起中」
              弹回「确认发起」，错误条挂在**表单**上、弹层一关就看不见——管理者视角
              就是白等七分钟然后表单装作无事发生。错误必须和发起动作在同一处，
              带 HTTP 码、一句人话、以及不用重新填表的重试入口。 */}
          {error && (
            <div className="rounded-lg border border-rose-300/70 bg-rose-50 px-3 py-2 dark:border-rose-800/60 dark:bg-rose-950/40">
              <p className="text-[11px] font-medium leading-relaxed text-rose-800 dark:text-rose-200">
                这次没发起成功：{error}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-rose-700/80 dark:text-rose-300/70">
                你填的东西还在，直接重试即可，不用重新选文件。
              </p>
            </div>
          )}

          <DialogFooter>
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-full border border-border px-4 py-1.5 text-xs transition-colors hover:bg-accent"
            >
              {error ? '关掉' : '取消'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send()}
              className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-4 py-1.5 text-xs text-background transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy && <Loader2 className="size-3 animate-spin" />}
              {busy
                ? sent
                  ? `上传中 ${Math.floor((sent.loaded / sent.total) * 100)}%`
                  : '发起中'
                : error
                  ? '重试'
                  : '确认发起'}
            </button>
            {sent && (
              <div className="mt-2 w-full">
                <div className="h-1 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full bg-foreground transition-all duration-300"
                    style={{ width: `${(sent.loaded / sent.total) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
                  {mb(sent.loaded)} / {mb(sent.total)}
                  {sent.bytesPerSecond > 0 && (
                    <>
                      {' · '}
                      {mb(sent.bytesPerSecond)}/s{' · '}
                      {/* 剩余时间按均速估，弱网下会飘——写「约」不写死。 */}
                      约还需 {eta((sent.total - sent.loaded) / sent.bytesPerSecond)}
                    </>
                  )}
                </p>
              </div>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
