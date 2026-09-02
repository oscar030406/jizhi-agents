import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { expect, test, type Browser, type Page } from '@playwright/test';

const BASE = process.env.JIZHI_PRODUCTION_BASE ?? 'https://jizhi.chenmingkun.cn';
const PASSWORD = process.env.JIZHI_DEMO_PASSWORD ?? '';
const SCREENSHOTS = path.resolve(
  __dirname,
  '../../../../docs/06-defense/screenshots/production-e2e',
);
const HONEST_JOB_EMPTY = '本机构管理者在接入该领域时未提供岗位/技能清单';
const NODE_REPORT_PATH = process.env.JIZHI_PRODUCTION_NODE_REPORT ?? '';

const ACTORS = {
  A: { username: 'orgdemo_mgr_vf1', role: 'manager' },
  B: { username: 'orgdemo_stu1_vf1', role: 'learner' },
  C: { username: 'orgdemo_mgr2_vf1', role: 'manager' },
  D: { username: 'orgdemo_stud_vf1', role: 'learner' },
} as const;

const SCENARIOS = [
  {
    key: 'ai',
    reportKey: 'ai',
    manager: 'A',
    learner: 'B',
    otherLearner: 'D',
    domain: 'ai',
    label: '人工智能应用开发',
    pathMustContain: /深度学习|deep_learning/iu,
    courseMustContain: /智能体|神经网络|深度学习|RAG/iu,
  },
  {
    key: 'smart-manufacturing',
    reportKey: 'smartManufacturing',
    manager: 'C',
    learner: 'D',
    otherLearner: 'B',
    domain: 'smart-manufacturing',
    label: '智能制造',
    pathMustContain: /ROS ?2|PLC|视觉|工位|设备|工业/iu,
    courseMustContain: /ROS ?2/iu,
  },
] as const;

type Scenario = (typeof SCENARIOS)[number];
type Assignment = { courseId: string; title: string; domain: string; createdAt?: string };
type DomainEntry = { domain?: string; corpus?: string };
type QuestionOption = { value: string };
type QuizQuestion = {
  question: string;
  type: string;
  answer: string | string[];
  options?: QuestionOption[];
};
type Scene = {
  id?: string;
  outlineId?: string;
  type: string;
  title: string;
  content?: { questions?: QuizQuestion[] };
  audit?: {
    verdict?: string;
    decision?: string;
    grounded?: boolean;
    corpus?: string;
    evidenceCount?: number;
  };
};
type Classroom = {
  stage: {
    name: string;
    origin?: { corpus?: string; domain?: string };
    learningContract?: { version?: number };
    courseAudit?: unknown;
  };
  scenes: Scene[];
};
type ProfileFields = Record<string, unknown> & {
  domain?: string;
  corpus?: string;
  conceptMasteryByDomain?: Record<string, Record<string, number>>;
  conceptConfidenceByDomain?: Record<string, Record<string, number>>;
  conceptRecallByDomain?: Record<string, Record<string, number>>;
};
type PathStage = { concepts?: Array<{ name: string }> };
type PathResponse = { path?: { source?: string; stages?: PathStage[] } };
type PracticeResponse = {
  status?: string;
  projects?: Array<{ name: string; courseIds?: string[] }>;
};

type NodeGenerateReport = {
  mode?: string;
  runId?: string;
  generatedCourses?: Record<
    string,
    { runId?: string; courseId?: string; domain?: string; manager?: string; learner?: string }
  >;
  checks?: Array<{ id?: string; ok?: boolean; actual?: { courseId?: string } }>;
};

function effectiveDomain(entry: DomainEntry | undefined) {
  return entry?.domain ?? entry?.corpus ?? null;
}

function loadGeneratedCourseIds() {
  if (!NODE_REPORT_PATH) {
    throw new Error('必须显式设置 JIZHI_PRODUCTION_NODE_REPORT 指向本轮 Node --generate JSON 报告');
  }
  const report = JSON.parse(
    readFileSync(path.resolve(NODE_REPORT_PATH), 'utf8'),
  ) as NodeGenerateReport;
  if (report.mode !== 'generate' || !report.runId) {
    throw new Error('JIZHI_PRODUCTION_NODE_REPORT 不是带 runId 的 generate 报告');
  }
  return Object.fromEntries(
    SCENARIOS.map((scenario) => {
      const generated = report.generatedCourses?.[scenario.reportKey];
      const completed = report.checks?.find(
        (check) => check.id === `generate.${scenario.reportKey}.completed`,
      );
      const assigned = report.checks?.find(
        (check) => check.id === `assign.${scenario.reportKey}.created`,
      );
      if (
        !generated?.courseId ||
        generated.runId !== report.runId ||
        generated.domain !== scenario.domain ||
        generated.manager !== scenario.manager ||
        generated.learner !== scenario.learner ||
        completed?.ok !== true ||
        completed.actual?.courseId !== generated.courseId ||
        assigned?.ok !== true ||
        assigned.actual?.courseId !== generated.courseId
      ) {
        throw new Error(`Node generate 报告中的 ${scenario.domain} 本轮课程契约不完整`);
      }
      return [scenario.key, generated.courseId];
    }),
  ) as Record<Scenario['key'], string>;
}

const GENERATED_COURSE_IDS = loadGeneratedCourseIds();

test.beforeAll(async () => {
  expect(PASSWORD, '必须通过 JIZHI_DEMO_PASSWORD 提供演示账号密码').not.toBe('');
  await fs.mkdir(SCREENSHOTS, { recursive: true });
});

async function newActorPage(browser: Browser, actorKey: keyof typeof ACTORS): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  const actor = ACTORS[actorKey];
  const response = await page.request.post('/api/auth', {
    data: { action: 'login', username: actor.username, password: PASSWORD, role: actor.role },
  });
  expect(response.status(), `${actorKey} 登录`).toBe(200);
  const body = (await response.json()) as {
    account?: { username?: string; role?: string };
  };
  expect(body.account).toMatchObject({ username: actor.username, role: actor.role });
  return page;
}

async function json<T extends object>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return (await response.json()) as T;
}

async function assignmentFor(page: Page, scenario: Scenario) {
  const [assignmentBody, domainBody] = await Promise.all([
    json<{ assignments?: Assignment[] }>(page, '/api/org/assignments'),
    json<Record<string, DomainEntry>>(page, '/api/course-domains'),
  ]);
  const assignments = assignmentBody.assignments ?? [];
  const courseId = GENERATED_COURSE_IDS[scenario.key];
  const target = assignments.find((item) => item.courseId === courseId);
  expect(target, `${scenario.learner} 应收到本轮 ${scenario.domain} 课程 ${courseId}`).toBeTruthy();
  if (!target) throw new Error(`缺少本轮课程指派：${courseId}`);
  expect(target?.domain).toBe(scenario.domain);
  expect(effectiveDomain(domainBody[courseId])).toBe(scenario.domain);
  expect(
    assignments.every(
      (item) =>
        item.domain === scenario.domain &&
        effectiveDomain(domainBody[item.courseId]) === scenario.domain,
    ),
    `${scenario.learner} 的每条指派都必须显式且严格属于 ${scenario.domain}`,
  ).toBe(true);
  return { assignment: target, domains: domainBody };
}

async function screenshot(page: Page, name: string, fullPage = true) {
  await page.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`), fullPage });
}

const PROFILE_BUCKET_FIELDS = [
  'conceptMasteryByDomain',
  'conceptConfidenceByDomain',
  'conceptRecallByDomain',
] as const;

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function targetBucketsChangedOnly(
  before: ProfileFields,
  after: ProfileFields,
  targetDomain: string,
) {
  return PROFILE_BUCKET_FIELDS.every((field) => {
    const beforeTable = before[field] ?? {};
    const afterTable = after[field] ?? {};
    if (jsonEqual(beforeTable[targetDomain], afterTable[targetDomain])) return false;
    const otherDomains = new Set([...Object.keys(beforeTable), ...Object.keys(afterTable)]);
    otherDomains.delete(targetDomain);
    return [...otherDomains].every((domain) => jsonEqual(beforeTable[domain], afterTable[domain]));
  });
}

test('生产浏览器门禁合同自检', () => {
  expect(GENERATED_COURSE_IDS.ai).not.toBe(GENERATED_COURSE_IDS['smart-manufacturing']);
  const before: ProfileFields = {
    conceptMasteryByDomain: { ai: { target: 0.2 }, other: { stable: 0.7 } },
    conceptConfidenceByDomain: { ai: { target: 0.3 }, other: { stable: 0.8 } },
    conceptRecallByDomain: { ai: { target: 0.4 }, other: { stable: 0.9 } },
  };
  const after: ProfileFields = {
    conceptMasteryByDomain: { ai: { target: 0.1 }, other: { stable: 0.7 } },
    conceptConfidenceByDomain: { ai: { target: 0.2 }, other: { stable: 0.8 } },
    conceptRecallByDomain: { ai: { target: 0.3 }, other: { stable: 0.9 } },
  };
  expect(targetBucketsChangedOnly(before, after, 'ai')).toBe(true);
  expect(
    targetBucketsChangedOnly(
      before,
      {
        ...after,
        conceptRecallByDomain: { ai: { target: 0.3 }, other: { stable: 0.1 } },
      },
      'ai',
    ),
  ).toBe(false);
});

for (const scenario of SCENARIOS) {
  test(`${scenario.manager} 管理者只管理自己的学员与领域课程`, async ({ browser }) => {
    const page = await newActorPage(browser, scenario.manager);
    const [orgBody, memberBody, assignmentBody, domainBody] = await Promise.all([
      json<{ org?: { name: string; role: string } }>(page, '/api/org'),
      json<{ members?: Array<{ username: string }> }>(page, '/api/org/members'),
      json<{ assignments?: Assignment[] }>(page, '/api/org/assignments'),
      json<Record<string, DomainEntry>>(page, '/api/course-domains'),
    ]);
    const targetAccount = ACTORS[scenario.learner];
    const otherAccount = ACTORS[scenario.otherLearner];
    const members = memberBody.members ?? [];
    expect(orgBody.org?.role).toBe('owner');
    expect(members.some((member) => member.username === targetAccount.username)).toBe(true);
    expect(members.some((member) => member.username === otherAccount.username)).toBe(false);
    const generatedCourseId = GENERATED_COURSE_IDS[scenario.key];
    expect(
      (assignmentBody.assignments ?? []).some(
        (item) =>
          item.courseId === generatedCourseId &&
          item.domain === scenario.domain &&
          effectiveDomain(domainBody[item.courseId]) === scenario.domain,
      ),
    ).toBe(true);
    expect(
      (assignmentBody.assignments ?? []).every(
        (item) =>
          item.domain === scenario.domain &&
          effectiveDomain(domainBody[item.courseId]) === scenario.domain,
      ),
      `${scenario.manager} 的每条指派都必须显式且严格属于 ${scenario.domain}`,
    ).toBe(true);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: '管理端' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '接入新的知识库' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '管理工作台' })).toBeVisible();
    await expect(page.getByRole('link', { name: /机构管理/ })).toBeVisible();
    await screenshot(page, `${scenario.manager}-管理工作台`, false);

    await page.goto('/admin/org');
    await expect(page.getByRole('heading', { name: '机构管理' })).toBeVisible();
    await expect(page.getByText(targetAccount.username, { exact: true })).toBeVisible();
    await expect(page.getByText(otherAccount.username, { exact: true })).toHaveCount(0);
    const section = page
      .getByRole('heading', { name: '课程指派' })
      .locator('xpath=ancestor::section');
    await expect(section).toBeVisible();
    await section.screenshot({ path: path.join(SCREENSHOTS, `${scenario.manager}-课程指派.png`) });
    await page.context().close();
  });

  test(`${scenario.learner} 学习端课程、路径、实操、岗位与报告全链同域`, async ({ browser }) => {
    const page = await newActorPage(browser, scenario.learner);
    const { assignment } = await assignmentFor(page, scenario);
    const [orgBody, courseBody, pathBody, practiceBody, skillBody, profileBody] = await Promise.all(
      [
        json<{ org: { name: string } }>(page, '/api/org'),
        json<{ classroom?: Classroom } & Partial<Classroom>>(
          page,
          `/api/classroom?id=${encodeURIComponent(assignment.courseId)}`,
        ),
        json<PathResponse>(page, `/api/domain-path/${encodeURIComponent(scenario.domain)}`),
        json<PracticeResponse>(page, `/api/practice-scout/${encodeURIComponent(scenario.domain)}`),
        json<{ jobs?: unknown[]; reason?: string }>(
          page,
          `/api/skills?domain=${encodeURIComponent(scenario.domain)}`,
        ),
        json<{ fields?: ProfileFields }>(page, '/api/profile'),
      ],
    );
    const classroom = courseBody.classroom ?? (courseBody as Classroom);
    const courseText = JSON.stringify(classroom);
    const pathText = JSON.stringify(pathBody.path ?? {});
    expect(profileBody.fields).toMatchObject({ domain: scenario.domain, corpus: scenario.domain });
    expect(classroom.stage?.origin?.corpus ?? classroom.stage?.origin?.domain).toBe(
      scenario.domain,
    );
    expect(classroom.stage?.learningContract?.version).toBe(2);
    expect(classroom.stage?.courseAudit).toBeTruthy();
    expect(classroom.scenes.some((scene) => scene.type === 'quiz')).toBe(true);
    expect(courseText).toMatch(scenario.courseMustContain);
    if (scenario.domain === 'smart-manufacturing') {
      expect(courseText).toMatch(/S7[- ]?1200|PLC/iu);
      expect(courseText).toMatch(/视觉检测/iu);
    }
    expect(pathBody.path?.source).not.toBe('none');
    const pathStages = pathBody.path?.stages ?? [];
    expect(pathStages.length).toBeGreaterThan(0);
    expect(pathText).toMatch(scenario.pathMustContain);
    if (scenario.domain === 'smart-manufacturing') {
      expect(pathText).not.toMatch(/agent_basics|llm_basics|LangGraph|\bRAG\b/iu);
      expect(skillBody.jobs ?? []).toHaveLength(0);
      expect(skillBody.reason).toBe(HONEST_JOB_EMPTY);
    } else {
      expect((skillBody.jobs ?? []).length).toBeGreaterThan(0);
    }
    expect(practiceBody.status).toBe('ready');
    const projects = practiceBody.projects ?? [];
    expect(projects.length).toBeGreaterThan(0);
    expect(
      projects.some((project) => (project.courseIds ?? []).includes(assignment.courseId)),
    ).toBe(true);

    await page.goto('/');
    await expect(page.getByText(`机构：${orgBody.org.name}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: assignment.title, exact: true })).toBeVisible();
    await expect(page.getByText(`${scenario.label} · 我的学习路径`, { exact: true })).toBeVisible();
    await screenshot(page, `${scenario.learner}-学习端首页`);

    await page.goto('/path');
    await expect(
      page.getByRole('heading', { name: new RegExp(`${scenario.label}.*学习路径`) }),
    ).toBeVisible();
    const firstConcept = pathStages[0]?.concepts?.[0]?.name;
    expect(firstConcept).toBeTruthy();
    await expect(page.getByText(firstConcept, { exact: false }).first()).toBeVisible();
    await screenshot(page, `${scenario.learner}-全景学习路径`);

    await page.goto('/skills');
    await expect(
      page.getByRole('heading', { name: '岗位技能地图 · 企业内训与转岗培训' }),
    ).toBeVisible();
    await expect(page.getByText(projects[0].name, { exact: true }).first()).toBeVisible();
    if (scenario.domain === 'smart-manufacturing') {
      await expect(page.getByText(/尚未提供.*岗位画像/)).toBeVisible();
    }
    await screenshot(page, `${scenario.learner}-岗位与实操`);

    await page.goto(`/classroom/${encodeURIComponent(assignment.courseId)}`);
    await expect(page.locator('body')).toContainText(classroom.stage.name);
    await screenshot(page, `${scenario.learner}-指派课堂`, false);

    await page.goto(`/report?stageId=${encodeURIComponent(assignment.courseId)}`);
    await expect(page.getByRole('heading', { name: '个人学情与资源匹配度报告' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前领域全景学习路径' })).toBeVisible();
    await expect(page.getByText(firstConcept, { exact: false }).first()).toBeVisible();
    await screenshot(page, `${scenario.learner}-学情报告`);
    await page.context().close();
  });
}

for (const scenario of SCENARIOS) {
  test(`${scenario.learner} 在本轮 ${scenario.label} 验收课程答错后生成并插入唯一有据审核补救资源`, async ({
    browser,
  }) => {
    test.setTimeout(15 * 60_000);
    const page = await newActorPage(browser, scenario.learner);
    const { assignment } = await assignmentFor(page, scenario);
    const courseBody = await json<{ classroom?: Classroom } & Partial<Classroom>>(
      page,
      `/api/classroom?id=${encodeURIComponent(assignment.courseId)}`,
    );
    const classroom = courseBody.classroom ?? (courseBody as Classroom);
    const profileBefore = await json<{ activeId?: string; fields?: ProfileFields }>(
      page,
      '/api/profile',
    );
    expect(profileBefore.activeId, '必须精确快照当前画像 activeId').toBeTruthy();
    expect(profileBefore.fields, '必须精确快照当前画像完整 fields').toBeTruthy();
    const activeId = profileBefore.activeId as string;
    const fieldsBefore = structuredClone(profileBefore.fields as ProfileFields);
    const sceneIdsBefore = new Set(classroom.scenes.map((scene) => scene.id).filter(Boolean));
    const quiz = classroom.scenes.find(
      (scene) => scene.type === 'quiz' && (scene.content?.questions?.length ?? 0) > 0,
    );
    expect(quiz, '课程必须有真实测验场景').toBeTruthy();
    test.info().annotations.push({
      type: 'data-policy',
      description: `课程 ${assignment.courseId} 是本轮 Node generate 生成的生产验收样例；仅保留一次目标补救 outline，不触碰任何旧课。`,
    });

    try {
      await page.goto(`/classroom/${encodeURIComponent(assignment.courseId)}`);
      await page.getByText(quiz.title, { exact: true }).first().click();
      await page.getByRole('button', { name: /开始测验/ }).click();
      for (const question of quiz?.content?.questions ?? []) {
        const card = page.locator('[data-testid="quiz-question"]').filter({
          hasText: question.question,
        });
        await expect(card).toBeVisible();
        if (question.type === 'short') {
          await card.locator('textarea').fill('我不知道，无法作答。');
          continue;
        }
        const options = question.options ?? [];
        const answers = Array.isArray(question.answer) ? question.answer : [question.answer];
        const wrongIndex = options.findIndex((option) => !answers.includes(option.value));
        expect(wrongIndex, `题目必须存在明确错误选项：${question.question}`).toBeGreaterThanOrEqual(
          0,
        );
        await card.locator('button').nth(wrongIndex).click();
      }
      await page.getByRole('button', { name: /提交答案/ }).click();
      const banner = page.getByTestId('adaptive-decision-banner');
      await expect(banner).toBeVisible({ timeout: 120_000 });
      const action = banner.getByRole('button', { name: /^执行：/ });
      await expect(action).toBeVisible();
      await action.click();
      await expect(banner.getByText(/已插入新场景（带审核徽标）/)).toBeVisible({
        timeout: 12 * 60_000,
      });

      await expect
        .poll(
          async () => {
            const profileAfter = await json<{ fields?: ProfileFields }>(page, '/api/profile');
            return Boolean(
              profileAfter.fields &&
              targetBucketsChangedOnly(fieldsBefore, profileAfter.fields, scenario.domain),
            );
          },
          { timeout: 60_000 },
        )
        .toBe(true);

      let insertedScene: Scene | undefined;
      await expect
        .poll(
          async () => {
            const afterBody = await json<{ classroom?: Classroom } & Partial<Classroom>>(
              page,
              `/api/classroom?id=${encodeURIComponent(assignment.courseId)}`,
            );
            const after = afterBody.classroom ?? (afterBody as Classroom);
            const inserted = after.scenes.filter(
              (scene) => scene.id && !sceneIdsBefore.has(scene.id),
            );
            insertedScene = inserted.length === 1 ? inserted[0] : undefined;
            return insertedScene?.outlineId ?? '';
          },
          { timeout: 60_000 },
        )
        .toMatch(/^remediation_/);
      expect(insertedScene?.outlineId).toMatch(/^remediation_/);
      expect(insertedScene?.audit).toMatchObject({
        grounded: true,
        corpus: scenario.domain,
      });
      expect(insertedScene?.audit?.evidenceCount).toBeGreaterThan(0);
      expect(insertedScene?.audit?.decision).not.toBe('block_pending_review');
      expect(insertedScene?.audit?.verdict).not.toBe('flagged');
      await banner.screenshot({
        path: path.join(SCREENSHOTS, `${scenario.learner}-${scenario.key}-答错后下一资源.png`),
      });
    } finally {
      try {
        const restore = await page.request.post('/api/profile', {
          data: { action: 'update', id: activeId, fields: fieldsBefore },
        });
        expect(restore.status(), '画像精确恢复写入').toBe(200);
        const restored = await json<{ activeId?: string; fields?: ProfileFields }>(
          page,
          '/api/profile',
        );
        expect(restored.activeId, '恢复后 activeId 不得漂移').toBe(activeId);
        expect(restored.fields, '恢复后完整 fields 必须逐字段一致').toEqual(fieldsBefore);
      } finally {
        await page.context().close();
      }
    }
  });
}
