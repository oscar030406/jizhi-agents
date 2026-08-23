import type { Page } from '@playwright/test';

import { test, expect } from '../fixtures/base';
import { KnowledgeIntakePage } from '../pages/knowledge-intake.page';
import { IntakeRunPage } from '../pages/intake-run.page';
import { WorkbenchHomePage } from '../pages/workbench-home.page';
import { GenerationPreviewPage } from '../pages/generation-preview.page';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage, USABLE_PROVIDERS_CONFIG } from '../fixtures/test-data/settings';
import { E2E_CORPUS, E2E_CORPUS_LABEL, E2E_RUN_ID } from '../fixtures/test-data/knowledge-pipeline';

/**
 * 主线 happy path：知识库接入 → 课程生成 → 审核门 → 报告。
 *
 * ## 这条用例要证明的一件事
 *
 * 不是「四个页面各自打得开」，而是**管理者接进来的那个库，一路走到了报告页**。
 * 所以四个环节共用一个库名（`E2E_CORPUS`），每一环都断在它身上：
 * 接入表单提交的是它、造课入口选的是它、判官收到的是它、课堂徽标印的是它的中文名。
 * 中间任何一跳把它丢了（历史上真断过：判官那一路从不带画像，换库生成的课
 * 由默认语料的判官来评），断言当场就炸，而不是四页全绿、库悄悄换了。
 *
 * ## 断言只断看得见的东西
 *
 * 全部断在页面渲染出来的文字上——徽标面板里的「门禁裁决：直接放行」、
 * 「取材《时序数据库运维》」、报告页的「已审核场景 1/1」。
 * 断 API 返回体没有意义：这个项目吃过「验 API 响应体当成上屏了」的亏，
 * 接口回得漂亮而页面上什么都没变的情况，一次都不许再放过。
 *
 * 桩里那份 `corpus` 是**回显请求里带来的值**（见 mock-api 的 mockSceneAudit），
 * 所以屏幕上那行「取材《…》」是页面自己送出去的库名绕一圈回来的，不是桩写死的。
 *
 * ## 全程不碰真模型、真引擎
 *
 * 生成三站、判官、学情诊断、域清单、库名单、需求自述抽取全部 page.route 截掉。
 * 唯一走真实服务端的是注册/登录（本机文件账户库，不联网、不过模型）——
 * 管理端和造课入口都要登录态，这道闸没有旁路。
 *
 * run 详情页是个例外：它是服务端组件、直接读引擎数据目录，`page.route` 够不着。
 * 它在这里有数，是因为 `playwright.config.ts` 把 `ENGINE_DATA_DIR` 指到了
 * `e2e/fixtures/engine-data/`。**那棵树里没有一个字节来自真引擎**，
 * 所以 ① 的那几条断的是「读盘 → 推状态 → 上屏」这条链走不走得通，
 * 不是「引擎真的跑完了八站」。别拿这一页的 e2e 截图当线上证据。
 *
 * ## 报错要指得出卡在第几环
 *
 * 每一环包在 `test.step('① …')` 里，且每条断言都带一句中文的第二参数。
 * 失败时报告里先看到卡在哪一步，再看到那一步为什么算失败。
 */

/** 造课按钮的启用判据是「有一个可用的模型服务商」——要 apiKey + 至少一个模型。 */
const SETTINGS_STORAGE = createSettingsStorage({
  sidebarCollapsed: false,
  providersConfig: USABLE_PROVIDERS_CONFIG,
});

/** 管理者账号。用户名要过 `[A-Za-z0-9_]{3,24}`，密码要过 `[A-Za-z0-9]{6,64}`。 */
const MANAGER = { username: 'e2e_manager', password: 'e2epass123', role: 'manager' as const };

/**
 * 拿一个管理者会话。
 *
 * 走真接口而不是塞 cookie：会话 token 存在服务端账户库里，伪造一个 cookie
 * 过不了 `accountForSession()`。注册与登录二选一，用固定用户名，
 * 反复跑不会在 `data/accounts/` 里堆一串账号。
 *
 * `page.request` 与浏览器共用同一个 cookie 罐，所以这里拿到的
 * Set-Cookie 后面页面导航时直接带着走。
 */
async function signInAsManager(page: Page) {
  const registered = await page.request.post('/api/auth', {
    data: { action: 'register', ...MANAGER },
  });
  if (registered.ok()) return;
  const loggedIn = await page.request.post('/api/auth', { data: { action: 'login', ...MANAGER } });
  expect(
    loggedIn.ok(),
    `① 接入：管理者账号既注册不上也登录不了（注册 HTTP ${registered.status()}，登录 HTTP ${loggedIn.status()}）`,
  ).toBeTruthy();
}

test.describe('主线 happy path', () => {
  test('知识库接入 → 课程生成 → 审核门 → 报告', async ({ page, mockApi }) => {
    test.setTimeout(120_000);

    // 界面已统一简体中文，断言也全是中文；base fixture 为了老用例种的是 en-US，
    // 这里覆盖掉——不然造课按钮上是 "Enter Classroom"，定位器和文案对不上。
    await page.addInitScript(() => localStorage.setItem('locale', 'zh-CN'));
    await page.addInitScript((settings) => {
      localStorage.setItem('settings-storage', settings);
    }, SETTINGS_STORAGE);

    // 桩必须先于任何导航装好：生成在 generation-preview 挂载时自动开跑。
    const probe = await mockApi.setupPipelineMocks();
    await signInAsManager(page);

    // ── ① 知识库接入 ────────────────────────────────────────────────────
    await test.step('① 知识库接入', async () => {
      const intake = new KnowledgeIntakePage(page);
      await intake.goto();

      await expect(
        intake.intakeHeading,
        '① 接入：管理端知识库页没出接入区（进不去多半是没拿到管理者会话，页面换成了「只对管理者账号开放」）',
      ).toBeVisible();

      await intake.fillNewCorpus();
      await intake.submit();

      // 确认弹层是真要花钱的那一步，库名、投料、档数必须在这里当面回显。
      await expect(intake.confirmDialog, '① 接入：点「发起接入」后没有弹确认层').toBeVisible();
      await expect(
        intake.confirmDialog,
        `① 接入：确认层里没印出这次要建的库名 ${E2E_CORPUS}`,
      ).toContainText(E2E_CORPUS);

      await intake.confirm();

      // 发起成功的用户可见结果就是跳到这次 run 的观看页。
      await page.waitForURL(new RegExp(`/admin/knowledge/runs/${E2E_RUN_ID}$`), {
        timeout: 15_000,
      });

      expect(probe.intakeCorpus, '① 接入：表单提交上去的库名不是页面上填的那个').toBe(E2E_CORPUS);

      // ── run 详情页：这一页是服务端组件、直接读引擎数据目录，page.route 的桩
      //    伸不进去。它有数是因为 playwright.config 把 ENGINE_DATA_DIR 指到了
      //    e2e/fixtures/engine-data/，下面每一个数字都出自那两个文件。
      //    **所以这几条断的是「读盘 → 推状态 → 上屏」这条链，不是引擎真跑了。**
      const run = new IntakeRunPage(page);

      await expect(run.identity, '① 接入：run 详情页没印出「库名 · run 号」那一行').toBeVisible();

      // 泳道的价值全在「并行画成并行」。③检索索引 与 ④知识整理 都只依赖 ②切块，
      // 编排器同时发车——页面必须把它们放进同一波并标出来。画成串行就是错的。
      await expect(
        page.getByText('第 3 波 · 2 站（并行）'),
        '① 接入：泳道没把同一波的两站标成并行（并行被画成串行，这一页就白做了）',
      ).toBeVisible();
      await expect(
        run.stageCard('检索索引'),
        '① 接入：检索索引这一站没标出与别的站同时在跑（事件里两站区间是重叠的）',
      ).toContainText('与另外 1 站同时在跑');

      // 每站实数：卡上的数字来自事件 detail，不是页面自己编的占位。
      await expect(
        run.stageCard('切块入库'),
        '① 接入：切块站没显示证据块数（每站产出卡没吃到事件里的 detail）',
      ).toContainText('证据块');
      await expect(run.stageCard('切块入库'), '① 接入：证据块数不是 128').toContainText('128');

      // 事件流：落盘 11 条，页面就该显示 11 条。
      await expect(run.eventCount(11, 11), '① 接入：事件流计数不是 11 / 11 条').toBeVisible();
      await expect(run.eventList.locator('li'), '① 接入：事件流列表不是 11 行').toHaveCount(11);

      // 回放：拖游标不是播一段动画，是拿前 n 条事件重新推一遍状态。
      // 所以退回第 5 条时，泳道里第 6、7 条才开跑的两站必须回到「等待上游」——
      // 这才证明回放与直播走的是同一条 deriveView，而不是另做的一份演出。
      await run.replayCursor.focus();
      await run.replayCursor.press('Home');
      await expect(run.eventCount(0, 11), '① 接入：游标推到起点后计数没归零').toBeVisible();
      await expect(
        run.eventList,
        '① 接入：游标在起点时事件流没出空态那一行',
      ).toContainText('（游标在起点，还没有事件）');

      for (let i = 0; i < 5; i++) await run.replayCursor.press('ArrowRight');
      await expect(run.eventCount(5, 11), '① 接入：游标走到第 5 条时计数没跟上').toBeVisible();
      await expect(run.eventList.locator('li'), '① 接入：游标在第 5 条时列出的不是 5 行').toHaveCount(
        5,
      );
      await expect(
        run.stageCard('知识整理'),
        '① 接入：回放退回第 5 条时，第 7 条才开跑的知识整理站没退回「等待上游」（回放没走 deriveView，只是播了段动画）',
      ).toContainText('等待上游');

      await run.replayCursor.press('End');
      await expect(run.eventCount(11, 11), '① 接入：游标推回末尾后没回到最终态').toBeVisible();
    });

    // ── ② 课程生成 ──────────────────────────────────────────────────────
    await test.step('② 课程生成', async () => {
      const home = new WorkbenchHomePage(page);
      await home.goto();

      await expect(
        home.requirement,
        '② 生成：登录后首页没出造课输入框（未登录时首页是公共落地页，上面没有这个框）',
      ).toBeVisible();

      // 换库：这一步是「接进来的库被拿去生成」的动作本身。
      await home.pickCorpus(E2E_CORPUS);
      await expect(
        home.profileTrigger,
        `② 生成：画像按钮上没显示已选的库《${E2E_CORPUS_LABEL}》（显示成裸英文 id 说明域注册清单没灌进浏览器侧）`,
      ).toContainText(E2E_CORPUS_LABEL);

      // 填完需求按钮才亮：判据是「需求非空 + 有一个可用的模型服务商」，
      // 所以断启用一定要在填完之后，否则断的是空框那一态。
      await home.fillRequirement('讲解时序数据库的写入链路与压缩策略');
      await expect(
        home.enterButton,
        '② 生成：填完需求后造课按钮仍未启用（多半是 settings 桩里的服务商不算「可用」：要 apiKey + baseUrl + 至少一个模型）',
      ).toBeEnabled();

      await home.submit();
      await page.waitForURL(/\/generation-preview/, { timeout: 15_000 });

      const preview = new GenerationPreviewPage(page);
      await expect(preview.stepTitle, '② 生成：生成进度页没出步骤标题').toBeVisible();

      // 大纲流 → 正文 → 动作三站跑完自动进课堂。
      await preview.waitForRedirectToClassroom();
      expect(page.url(), '② 生成：没跳进课堂').toMatch(/\/classroom\//);
    });

    // ── ③ 审核门 ────────────────────────────────────────────────────────
    await test.step('③ 审核门', async () => {
      const classroom = new ClassroomPage(page);
      await classroom.waitForLoaded();

      await expect(
        classroom.sidebarScenes.first(),
        '③ 审核门：课堂侧栏一个场景都没有，审核徽标无处可挂',
      ).toBeVisible({ timeout: 15_000 });

      // 审核是异步后置的（先上台、判词后到），徽标晚于场景出现，这里要等。
      const badge = page.getByTestId('scene-audit-badge').first();
      await expect(
        badge,
        '③ 审核门：场景上没挂审核徽标（判官那一路没跑，或判词没写回 scene.audit）',
      ).toBeVisible({ timeout: 30_000 });

      await badge.click();
      const panel = page.getByTestId('scene-audit-panel');
      await expect(panel, '③ 审核门：点开徽标没出判词面板').toBeVisible();

      // 门禁的价值在于「裁决改变了什么」，所以断裁决那一行，不是断徽标颜色。
      await expect(panel, '③ 审核门：判词面板里没有门禁裁决那一行').toContainText(
        '门禁裁决：直接放行',
      );

      // 这一页取材自哪本书要写出来——换了库，页面上得看得出换了。
      await expect(
        panel,
        `③ 审核门：判词面板没印出「取材《${E2E_CORPUS_LABEL}》」（生成链没把画像里的库名带给判官，判官就在评另一本书）`,
      ).toContainText(`取材《${E2E_CORPUS_LABEL}》`);

      expect(probe.auditCorpus, '③ 审核门：发给判官的请求里没带上画像选的语料库').toBe(E2E_CORPUS);
    });

    // ── ④ 报告 ──────────────────────────────────────────────────────────
    await test.step('④ 报告', async () => {
      // 整页导航，内存里的课程状态清空——报告页只能从落盘的那份读。
      // 这正是要验的：审核判词有没有真的跟着课程存下来。
      await page.goto('/report');

      await expect(
        page.getByRole('heading', { name: '个人学情与资源匹配度报告' }),
        '④ 报告：报告页没打开',
      ).toBeVisible();

      // 「内容可信度小结」那一区的两块数：审过几个场景、其中几个由知识库接地。
      // 这两块是审核门在报告页留下的唯一痕迹——它们出数，说明判词跟着课程落了盘。
      await expect(
        page.getByTestId('audit-summary-audited'),
        '④ 报告：可信度小结里「已审核场景」不是 1/1（课程落盘时把 scene.audit 丢了，或报告页读的不是这门课）',
      ).toContainText('1/1');
      await expect(
        page.getByTestId('audit-summary-grounded'),
        '④ 报告：证据接地率不是 100%（判词里的 grounded 没跟着落盘）',
      ).toContainText('100%');
      await expect(
        page.getByText('全部直接放行，可以交付'),
        '④ 报告：没给出可交付的结论句',
      ).toBeVisible();
    });
  });
});
