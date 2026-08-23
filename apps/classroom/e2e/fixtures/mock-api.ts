import type { Page } from '@playwright/test';
import { mockOutlines } from './test-data/scene-outlines';
import { mockSceneContentResponse } from './test-data/scene-content';
import { createMockSceneActionsResponse } from './test-data/scene-actions';
import {
  E2E_RUN_ID,
  mockDomainRegistryResponse,
  mockLearnerBlueprint as learnerBlueprintData,
  mockSceneAudit as sceneAuditData,
  mockSkillsResponse,
} from './test-data/knowledge-pipeline';

/**
 * 桩收到的东西。测试拿它做「页面到底发了什么」的反查——
 * 只断响应体等于自己跟自己对暗号，请求里带没带对库名才是接线有没有断的证据。
 */
export interface PipelineProbe {
  /** 接入表单实际提交的库名（从 multipart 请求体里抠出来的）。 */
  intakeCorpus?: string;
  /** 生成链发给判官的语料库名。undefined = 这一路没带画像。 */
  auditCorpus?: string;
}

/** 从 multipart/form-data 的原始文本里取一个字段的值。文件字段不走这里。 */
function multipartField(body: string, name: string): string | undefined {
  const re = new RegExp(`name="${name}"\\r?\\n\\r?\\n([^\\r\\n]*)`);
  return re.exec(body)?.[1];
}

/**
 * Wraps Playwright's page.route() to mock OpenMAIC API endpoints.
 * Supports both JSON and SSE (text/event-stream) responses.
 */
export class MockApi {
  constructor(private page: Page) {}

  /** Mock the SSE outline streaming endpoint */
  async mockSceneOutlinesStream(outlines = mockOutlines) {
    await this.page.route('**/api/generate/scene-outlines-stream', (route) => {
      const events = outlines
        .map(
          (outline, i) =>
            `data: ${JSON.stringify({ type: 'outline', data: outline, index: i })}\n\n`,
        )
        .join('');
      const done = `data: ${JSON.stringify({ type: 'done', outlines, courseTitle: 'Mock Course' })}\n\n`;

      route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: events + done,
      });
    });
  }

  /** Mock the scene content generation endpoint */
  async mockSceneContent(response = mockSceneContentResponse) {
    await this.page.route('**/api/generate/scene-content', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(response),
      });
    });
  }

  /** Mock the scene actions generation endpoint.
   *  When no stageId is provided, it is extracted from the request body
   *  so the mock response matches the dynamically-generated stage id. */
  async mockSceneActions(stageId?: string) {
    await this.page.route('**/api/generate/scene-actions', async (route) => {
      let id = stageId ?? 'test-stage';
      if (!stageId) {
        try {
          const body = route.request().postDataJSON();
          if (body?.stageId) id = body.stageId;
        } catch {
          // fallback to default
        }
      }
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createMockSceneActionsResponse(id)),
      });
    });
  }

  /** Mock the server providers endpoint (returns empty — client-side config only) */
  async mockServerProviders() {
    await this.page.route('**/api/server-providers', (route) => {
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: {} }),
      });
    });
  }

  /**
   * 把访客变成登录用户。
   *
   * 账户系统恒开（`lib/accounts/store.ts` 的 `accountsEnabled()` 直接 return true），
   * 所以匿名访客在首页拿到的是 `PublicLanding`——上面没有需求输入框，也没有造课按钮。
   * 走首页造课的用例必须先有会话，否则连第一步都点不着。
   *
   * 这里截的是 `GET /api/auth`：客户端 `useAccountStore.refresh()` 只认这一跳的回体，
   * 拿到 `account` 非空就渲染工作台。回体形状照 `app/api/auth/route.ts` 的 GET 分支。
   *
   * 只对**客户端渲染**的页面有效。`/admin/**` 那几页是服务端组件、直接读 cookie 查账户库，
   * 桩伸不进去——那种用例得走真的注册/登录（见 knowledge-to-report.spec.ts）。
   */
  async mockSignedIn(account: Partial<{ id: string; username: string; role: string }> = {}) {
    const info = {
      id: account.id ?? 'e2e-learner',
      username: account.username ?? 'e2e_learner',
      displayName: account.username ?? 'e2e_learner',
      role: account.role ?? 'learner',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    await this.page.route('**/api/auth', (route) => {
      // 只接管会话查询；注册/登录/登出是 POST，留给真接口，别把它们也吞了。
      if (route.request().method() !== 'GET') return route.fallback();
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, account: info }),
      });
    });
  }

  /** Set up API mocks for the generation flow. Note: server-providers is already mocked by the base fixture. */
  async setupGenerationMocks(stageId?: string) {
    await this.mockSceneOutlinesStream();
    await this.mockSceneContent();
    await this.mockSceneActions(stageId);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 「接入 → 生成 → 审核门 → 报告」主线用到的桩。都走 page.route，与上面同一套机制。
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * ① 接入：发起 run 的桥接路由。
   *
   * 桩在桥这一层，不在引擎那一层——桥自己是「角色闸 + 原样转发」，把它截掉就等于
   * 引擎不在场。回体形状照 `apiSuccess`（扁平的 `success` + `run`），
   * 客户端读的就是 `body.success && body.run.run_id`。
   */
  async mockIntakeRunCreate(probe: PipelineProbe, runId = E2E_RUN_ID) {
    await this.page.route('**/api/knowledge/intake-runs', async (route) => {
      probe.intakeCorpus = multipartField(route.request().postData() ?? '', 'corpus');
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, run: { run_id: runId } }),
      });
    });
  }

  /** 域注册清单。浏览器侧的中文名/示例词全靠这一跳灌注，不灌就退回裸英文 id。 */
  async mockDomainRegistry() {
    await this.page.route('**/api/domains', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockDomainRegistryResponse()),
      }),
    );
  }

  /** 生成入口的知识库下拉只认这一路（`/api/skills`），拿不到才退部署期快照。 */
  async mockBuiltCorpora() {
    await this.page.route('**/api/skills', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mockSkillsResponse()),
      }),
    );
  }

  /**
   * ③ 审核门。判词里的 `corpus` **回显请求里带来的那个库名**，不是写死的常量：
   * 页面上印出的「取材《…》」因此是页面自己送出去的值绕一圈回来的，
   * 生成链哪天又忘了给判官带画像，这里收到 undefined，那行字就变回「受控知识库」。
   *
   * 讲稿审核走的是同一个端点（`auditSceneSpeech`），也命中这个桩；
   * 两份判词由 `mergeAudits` 合并，裁决取重——都是 publish，合并后仍是 publish。
   */
  async mockSceneAudit(probe: PipelineProbe) {
    await this.page.route('**/api/generate/scene-audit', async (route) => {
      let corpus: string | undefined;
      try {
        corpus = route.request().postDataJSON()?.learnerProfile?.corpus;
      } catch {
        corpus = undefined;
      }
      probe.auditCorpus ??= corpus;
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, audit: sceneAuditData(corpus) }),
      });
    });
  }

  /** ④ 报告：学情诊断。真路由要引擎在线，桩掉它报告页才有数可显。 */
  async mockLearnerBlueprint() {
    await this.page.route('**/api/adaptive/blueprint', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: learnerBlueprintData() }),
      }),
    );
  }

  /** 课程域归属表。报告页拿它过滤课程下拉；空表 = 不过滤，新课照常可见。 */
  async mockCourseDomains() {
    await this.page.route('**/api/course-domains', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
  }

  /**
   * 需求文本里的自述抽取。首页点「进入课堂」时同步调它，真路由会走模型——
   * 主线上不许有真调用，所以一律回「没抽到」（生成链把它当增强，空值不挡路）。
   */
  async mockProfileIntake() {
    await this.page.route('**/api/profile-intake', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, data: { seed: null } }),
      }),
    );
  }

  /** 主线四个环节的全部桩，一次装齐。返回值用来反查页面实际发出去的字段。 */
  async setupPipelineMocks(): Promise<PipelineProbe> {
    const probe: PipelineProbe = {};
    await this.mockDomainRegistry();
    await this.mockBuiltCorpora();
    await this.mockIntakeRunCreate(probe);
    await this.mockProfileIntake();
    await this.setupGenerationMocks();
    await this.mockSceneAudit(probe);
    await this.mockLearnerBlueprint();
    await this.mockCourseDomains();
    return probe;
  }
}
