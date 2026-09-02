#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";

const DEFAULT_BASE = "https://jizhi.chenmingkun.cn";
const REQUEST_TIMEOUT_MS = 75_000;
const BLUEPRINT_TIMEOUT_MS = 45_000;
const GENERATION_TIMEOUT_MS = 55 * 60_000;
const PRACTICE_DRAFT_TIMEOUT_MS = 510_000;
const POLL_INTERVAL_MS = 5_000;
const HONEST_JOB_EMPTY = "本机构管理者在接入该领域时未提供岗位/技能清单";
const DOMAIN_BUCKET_CONCEPT = "跨域同名概念验收";
const DOMAIN_BUCKET_VALUES = Object.freeze({
  ai: 0.23,
  "smart-manufacturing": 0.81,
});
const DOCUMENT_REJECTION_STATUSES = new Set([401, 403, 404]);

const ACTORS = Object.freeze({
  A: { username: "orgdemo_mgr_vf1", role: "manager", orgRole: "owner" },
  B: { username: "orgdemo_stu1_vf1", role: "learner", orgRole: "member" },
  C: { username: "orgdemo_mgr2_vf1", role: "manager", orgRole: "owner" },
  D: { username: "orgdemo_stud_vf1", role: "learner", orgRole: "member" },
});

const SCENARIOS = Object.freeze([
  {
    key: "ai",
    domain: "ai",
    manager: "A",
    learner: "B",
    requirement:
      "为零基础企业新员工生成一门人工智能智能体入门课，包含讲解、分步实操、分层测验、反馈重试和迁移任务。",
    profile: {
      domain: "ai",
      corpus: "ai",
      education: "bachelor",
      role: "企业新员工",
      programming_level: 1,
      python_level: 1,
      agent_level: 0,
      rag_level: 0,
      engineering_level: 1,
      time_budget_hours: 20,
    },
  },
  {
    key: "smartManufacturing",
    domain: "smart-manufacturing",
    manager: "C",
    learner: "D",
    requirement:
      "为设备运维新员工生成一门装配工位视觉检测、ROS2 与 S7-1200 PLC 联调入门课，包含安全前置、分步操作、故障诊断、测验、反馈重试和迁移任务。",
    profile: {
      domain: "smart-manufacturing",
      corpus: "smart-manufacturing",
      education: "college",
      role: "设备运维新员工",
      programming_level: 1,
      python_level: 1,
      agent_level: 0,
      rag_level: 0,
      engineering_level: 1,
      time_budget_hours: 24,
    },
  },
]);

const AI_ONLY_CONCEPTS = new Set([
  "agent_basics",
  "rag",
  "tool_calling",
  "langgraph",
  "evaluation",
  "guardrails",
  "deployment",
  "prompt",
  "embedding",
  "transformer",
]);

const AI_JOB_TERMS =
  /(?:\bagents?\b|智能体|\brag\b|检索增强|向量检索|\bllm\b|大模型)/iu;
const SMART_ONLY_TERMS =
  /(?:智能制造|工业视觉|视觉检测|装配|工位|plc|s7[- ]?1200|ros ?2|设备运维|故障诊断|工业机器人)/iu;
const PATH_SOURCES = new Set(["index-graph", "intake", "index-tags"]);
const REPORT_PAGE_MARKERS = Object.freeze(["个人学情与资源匹配度报告"]);
const SCRATCH_DOMAIN =
  /(?:fullprobe|fullpath[-_]?probe|(?:^|[-_])probe(?:[-_]|$))/iu;
const PAGE_REJECTION =
  /(?:无权访问|没有访问权限|请先登录后|登录已失效|access denied)/iu;
const CONTRACT_PHASES = Object.freeze([
  "prerequisiteActivation",
  "demonstration",
  "learnerPractice",
  "feedbackRetry",
  "transferApplication",
  "assessment",
]);

function scenarioRequiredCheckIds(key) {
  return [
    `assignment.${key}.course-selected`,
    `assignment.${key}.target`,
    `assignment.${key}.learner-scope`,
    `assignment.${key}.effective-domain`,
    `course.${key}.acceptance`,
    `course.${key}.audit`,
    `course.${key}.learning-contract`,
    `course.${key}.coverage`,
    `path.${key}.acceptance`,
    `path.${key}.provenance`,
    `practice.${key}.acceptance`,
    `jobs.${key}.acceptance`,
    `report.${key}.profile`,
    `report.${key}.page`,
    `report.${key}.acceptance`,
    `report.${key}.domain-alignment`,
  ];
}

function remediationRequiredCheckIds(key) {
  return [
    `remediation.${key}.real-wrong.graded`,
    `remediation.${key}.real-wrong.evidence-changed`,
    `remediation.${key}.real-wrong.mastery-changed`,
    `remediation.${key}.real-wrong.next-resource-changed`,
  ];
}

function requiredCheckIds(mode) {
  const ids = [
    "cli.password",
    ...Object.keys(ACTORS).map((actor) => `auth.${actor}`),
    ...Object.keys(ACTORS).map((actor) => `org.${actor}.membership`),
    "org.dual-org-matrix",
    "hygiene.no-scratch-domains",
    ...Object.keys(ACTORS).flatMap((actor) =>
      ["assignments", "course-domains", "domains", "classrooms"].map(
        (source) => `source.${actor}.${source}`,
      ),
    ),
    ...SCENARIOS.flatMap((scenario) => scenarioRequiredCheckIds(scenario.key)),
    ...SCENARIOS.flatMap((scenario) => [
      ...Object.keys(ACTORS).map((actor) => `matrix.${scenario.key}.${actor}`),
      `matrix.${scenario.key}.acceptance`,
    ]),
  ];
  if (mode === "generate") {
    ids.push(
      "persistence.owned-document.nonowner-get-rejected",
      "persistence.owned-document.nonowner-put-rejected",
      "persistence.owned-document.nonowner-delete-rejected",
      "generate.safety-preflight",
      ...SCENARIOS.flatMap((scenario) => [
        `profile.${scenario.key}.saved`,
        `profile.${scenario.key}.reread`,
        `generate.${scenario.key}.accepted`,
        `generate.${scenario.key}.completed`,
        `assign.${scenario.key}.created`,
        `practice.${scenario.key}.drafted`,
        `practice.${scenario.key}.published`,
        `practice.${scenario.key}.restored`,
      ]),
      "negative-assignment.A-to-D.rejected",
      "negative-assignment.A-to-D.unchanged",
      "negative-assignment.C-to-B.rejected",
      "negative-assignment.C-to-B.unchanged",
      "report.same-concept.profile-buckets",
      "report.same-concept.evidence-buckets",
      ...SCENARIOS.flatMap((scenario) =>
        remediationRequiredCheckIds(scenario.key),
      ),
    );
  }
  return Object.freeze(ids);
}

function usage() {
  return `集智生产双机构双领域验收（Node 22，无第三方依赖）

用法：
  node scripts/production-dual-org-e2e.mjs [--base <url>]
  node scripts/production-dual-org-e2e.mjs --generate [--base <url>]
  node scripts/production-dual-org-e2e.mjs --self-test
  node scripts/production-dual-org-e2e.mjs --help

环境变量：
  JIZHI_DEMO_PASSWORD  四个既有 demo 账号的共同密码（必填）

安全边界：
  默认模式只创建登录会话并读取/计算验收数据，不改业务数据。
  只有 --generate 会通过 /api/profile 保存并复读 B/D 的目标领域画像，
  让 A/C 并发生成两门课，分别定向指派给 B/D，重建并审核各域实操项目，
  再验证跨机构指派、文档越权、同名概念分桶与答错补救；
  临时文档、证据 session 与同名概念字段均按精确 ID/键回收；
  不创建账号、不改密码/知识库归属，也不删除或撤回任何生产数据。

输出：stdout 仅输出最终 JSON 报告；生成进度写 stderr。任一检查失败时退出码非零。`;
}

function normalizeBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--base 不是合法 URL：${value}`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("--base 只允许 http/https");
  if (url.username || url.password)
    throw new Error("--base 不得携带用户名或密码");
  if (url.search || url.hash) throw new Error("--base 不得携带 query 或 hash");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (url.pathname !== "/") throw new Error("--base 只允许站点根地址");
  const production =
    url.protocol === "https:" &&
    url.hostname === "jizhi.chenmingkun.cn" &&
    (!url.port || url.port === "443");
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (!production && !local) {
    throw new Error(
      "--base 只允许生产站 https://jizhi.chenmingkun.cn 或本机 HTTP 地址",
    );
  }
  return url.toString().replace(/\/$/, "");
}

export function parseArgs(argv) {
  const options = {
    base: DEFAULT_BASE,
    generate: false,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--generate") options.generate = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--base") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--base 缺少 URL");
      options.base = value;
      index += 1;
    } else if (arg.startsWith("--base=")) {
      const value = arg.slice("--base=".length);
      if (!value) throw new Error("--base 缺少 URL");
      options.base = value;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.generate && options.selfTest)
    throw new Error("--generate 不能与 --self-test 同用");
  options.base = normalizeBase(options.base);
  return options;
}

function runSelfTest() {
  let assertions = 0;
  const test = (callback) => {
    callback();
    assertions += 1;
  };
  test(() =>
    assert.deepEqual(parseArgs([]), {
      base: DEFAULT_BASE,
      generate: false,
      selfTest: false,
      help: false,
    }),
  );
  test(() =>
    assert.deepEqual(
      parseArgs(["--generate", "--base", "http://localhost:3000/"]),
      {
        base: "http://localhost:3000",
        generate: true,
        selfTest: false,
        help: false,
      },
    ),
  );
  test(() =>
    assert.equal(
      parseArgs(["--base=https://jizhi.chenmingkun.cn/"]).base,
      DEFAULT_BASE,
    ),
  );
  test(() =>
    assert.throws(
      () => parseArgs(["--base=https://example.com/"]),
      /只允许生产站/,
    ),
  );
  test(() =>
    assert.throws(
      () => parseArgs(["--base=http://jizhi.chenmingkun.cn/"]),
      /只允许生产站/,
    ),
  );
  test(() =>
    assert.throws(
      () => parseArgs(["--base=http://localhost:3000/nested"]),
      /站点根地址/,
    ),
  );
  test(() => assert.throws(() => parseArgs(["--base"]), /缺少 URL/));
  test(() => assert.throws(() => parseArgs(["--unknown"]), /未知参数/));
  test(() =>
    assert.throws(
      () => parseArgs(["--base", "file:///tmp/demo"]),
      /http\/https/,
    ),
  );
  test(() =>
    assert.throws(() => parseArgs(["--generate", "--self-test"]), /不能与/),
  );
  test(() =>
    assert.equal(classifyJobState("ai", [{ title: "AI Agent" }], ""), "ready"),
  );
  test(() =>
    assert.equal(
      classifyJobState("smart-manufacturing", [], HONEST_JOB_EMPTY),
      "honest-empty",
    ),
  );
  test(() =>
    assert.equal(
      classifyJobState("smart-manufacturing", [], "暂时没有"),
      "invalid-empty",
    ),
  );
  test(() => assert.equal(SCRATCH_DOMAIN.test("fullprobe"), true));
  test(() => assert.equal(SCRATCH_DOMAIN.test("smart-manufacturing"), false));
  test(() =>
    assert.equal(
      documentRequestRejected({
        status: 404,
        body: { error: { code: "DOCUMENT_NOT_FOUND" } },
      }),
      true,
    ),
  );
  test(() => assert.equal(documentRequestRejected({ status: 204 }), false));
  test(() =>
    assert.equal(
      documentDeleteIsolated({ status: 204 }, { status: 200 }),
      true,
    ),
  );
  test(() =>
    assert.equal(
      documentDeleteIsolated({ status: 204 }, { status: 404 }),
      false,
    ),
  );
  test(() =>
    assert.equal(
      runtimeSessionMissing({
        status: 404,
        body: { error: { code: "SESSION_NOT_FOUND" } },
      }),
      true,
    ),
  );
  test(() => assert.equal(runtimeSessionMissing({ status: 204 }), false));
  test(() =>
    assert.equal(
      inspectDomainBuckets({
        conceptMasteryByDomain: {
          ai: { [DOMAIN_BUCKET_CONCEPT]: DOMAIN_BUCKET_VALUES.ai },
          "smart-manufacturing": {
            [DOMAIN_BUCKET_CONCEPT]:
              DOMAIN_BUCKET_VALUES["smart-manufacturing"],
          },
        },
      }).accepted,
      true,
    ),
  );
  test(() =>
    assert.equal(
      inspectDomainBuckets(
        {
          domain: "ai",
          corpus: "ai",
          conceptMasteryByDomain: {
            ai: { [DOMAIN_BUCKET_CONCEPT]: DOMAIN_BUCKET_VALUES.ai },
            "smart-manufacturing": {
              [DOMAIN_BUCKET_CONCEPT]:
                DOMAIN_BUCKET_VALUES["smart-manufacturing"],
            },
          },
        },
        "ai",
      ).accepted,
      true,
    ),
  );
  test(() =>
    assert.equal(
      inspectDomainBuckets(
        {
          domain: "smart-manufacturing",
          corpus: "smart-manufacturing",
          conceptMasteryByDomain: {
            ai: { [DOMAIN_BUCKET_CONCEPT]: DOMAIN_BUCKET_VALUES.ai },
            "smart-manufacturing": {
              [DOMAIN_BUCKET_CONCEPT]:
                DOMAIN_BUCKET_VALUES["smart-manufacturing"],
            },
          },
        },
        "ai",
      ).accepted,
      false,
    ),
  );
  test(() =>
    assert.equal(
      changedDimensions({ evidence: true, mastery: false, nextResource: true }),
      2,
    ),
  );
  test(() =>
    assert.equal(
      profileMasteryDigest({ conceptMastery: { beta: 0.2, alpha: 0.1 } }),
      profileMasteryDigest({ conceptMastery: { alpha: 0.1, beta: 0.2 } }),
    ),
  );

  const practiceFixture = {
    id: "project-runtime",
    approved: true,
    provenance: { source: "github-api" },
    links: [{ url: "https://github.com/example/project" }],
    steps: ["准备环境", "完成联调", "按标准验收"],
    acceptance: "三项检查全部通过",
    deliverable: "运行记录与说明文档",
    courseIds: ["course-runtime"],
    jobIds: ["job-runtime"],
  };
  const practiceBounds = {
    allowedCourseIds: new Set(["course-runtime"]),
    allowedJobIds: new Set(["job-runtime"]),
  };
  test(() =>
    assert.equal(
      inspectPracticeProject(practiceFixture, practiceBounds).accepted,
      true,
    ),
  );
  test(() =>
    assert.equal(
      inspectPracticeProject(
        { ...practiceFixture, steps: practiceFixture.steps.slice(0, 2) },
        practiceBounds,
      ).accepted,
      false,
    ),
  );
  test(() =>
    assert.equal(
      inspectPracticeProject(
        { ...practiceFixture, courseIds: ["course-other"] },
        practiceBounds,
      ).accepted,
      false,
    ),
  );
  test(() =>
    assert.equal(
      inspectPracticeProject(
        { ...practiceFixture, jobIds: [] },
        { ...practiceBounds, allowedJobIds: new Set() },
      ).accepted,
      true,
    ),
  );

  const reportPageFixture = {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<h1>个人学情与资源匹配度报告</h1>",
  };
  const reportContext = {
    courseId: "course-runtime",
    title: "运行时课程标题",
    domain: "ai",
    fields: { domain: "ai", corpus: "ai" },
    effectiveDomain: "ai",
    classroom: { id: "course-runtime" },
    assignment: {
      courseId: "course-runtime",
      learnerAccountId: "learner-runtime",
    },
    learnerAccountId: "learner-runtime",
  };
  test(() =>
    assert.equal(
      inspectReportPage(reportPageFixture, reportContext).accepted,
      true,
    ),
  );
  test(() =>
    assert.equal(
      inspectReportPage(reportPageFixture, {
        ...reportContext,
        effectiveDomain: "smart-manufacturing",
      }).accepted,
      false,
    ),
  );
  test(() =>
    assert.equal(
      inspectReportPage(
        { ...reportPageFixture, body: "<h1>无权访问</h1>" },
        reportContext,
      ).accepted,
      false,
    ),
  );

  const profile = { domain: "ai", corpus: "ai", role: "learner" };
  const payload = buildBlueprintPayload("AI 入门", profile);
  test(() => assert.deepEqual(payload.profile, profile));
  test(() => assert.notEqual(payload.profile, profile));
  const assignmentFixture = [{ courseId: "historical-ai", domain: "ai" }];
  const domainFixture = { "historical-ai": { domain: "ai" } };
  test(() =>
    assert.equal(
      selectScenarioCourseId(
        "generate",
        "current-ai",
        assignmentFixture,
        domainFixture,
        "ai",
      ),
      "current-ai",
    ),
  );
  test(() =>
    assert.equal(
      selectScenarioCourseId(
        "generate",
        null,
        assignmentFixture,
        domainFixture,
        "ai",
      ),
      null,
    ),
  );
  test(() =>
    assert.equal(
      selectScenarioCourseId(
        "read-only",
        null,
        assignmentFixture,
        domainFixture,
        "ai",
      ),
      "historical-ai",
    ),
  );
  test(() =>
    assert.equal(
      selectScenarioCourseId(
        "read-only",
        null,
        [{ courseId: "missing-domain" }],
        { "missing-domain": { domain: "ai" } },
        "ai",
      ),
      null,
    ),
  );
  test(() =>
    assert.equal(
      requiredCheckIds("read-only").includes(
        "persistence.owned-document.nonowner-delete-rejected",
      ),
      false,
    ),
  );
  test(() =>
    assert.equal(
      requiredCheckIds("generate").includes(
        "persistence.owned-document.nonowner-delete-rejected",
      ),
      true,
    ),
  );
  test(() =>
    assert.deepEqual(
      requiredCheckIds("generate").filter((id) =>
        id.startsWith("remediation."),
      ),
      SCENARIOS.flatMap((scenario) =>
        remediationRequiredCheckIds(scenario.key),
      ),
    ),
  );
  test(() => assert.equal(buildBoundaryContract([]).ok, true));
  test(() =>
    assert.deepEqual(
      buildBoundaryContract([
        { id: "informational", required: false },
        { id: "browser-required", required: true },
      ]),
      { required: ["browser-required"], ok: false },
    ),
  );
  test(() =>
    assert.equal(
      finalize({
        startedAt: new Date().toISOString(),
        mode: "read-only",
        checks: requiredCheckIds("read-only").map((id) => ({ id, ok: true })),
        boundaries: [{ id: "browser-required", required: true }],
      }).ok,
      false,
    ),
  );

  for (const mode of ["read-only", "generate"]) {
    const required = requiredCheckIds(mode);
    test(() => assert.equal(new Set(required).size, required.length));
    const complete = required.map((id) => ({ id, ok: true }));
    test(() => assert.equal(buildCheckContract(complete, mode).ok, true));
    test(() =>
      assert.deepEqual(buildCheckContract(complete.slice(1), mode).missing, [
        required[0],
      ]),
    );
    test(() =>
      assert.deepEqual(
        buildCheckContract([...complete, complete[0]], mode).duplicates,
        [required[0]],
      ),
    );
    test(() =>
      assert.deepEqual(
        buildCheckContract(
          [{ ...complete[0], skipped: true }, ...complete.slice(1)],
          mode,
        ).skipped,
        [required[0]],
      ),
    );
    test(() =>
      assert.deepEqual(
        buildCheckContract(
          [...complete, { id: "unexpected.check", ok: true }],
          mode,
        ).unexpected,
        ["unexpected.check"],
      ),
    );
  }

  const contract = {
    version: 2,
    teachingStrategy: "standard",
    plannedScenes: [
      { sceneId: "explain", type: "slide" },
      {
        sceneId: "practice",
        type: "interactive",
        widgetType: "procedural-skill",
      },
      { sceneId: "transfer", type: "pbl" },
      { sceneId: "quiz", type: "quiz" },
    ],
    required: {
      prerequisiteActivation: ["explain"],
      demonstration: ["explain"],
      learnerPractice: ["practice"],
      feedbackRetry: ["quiz"],
      transferApplication: ["transfer"],
      assessment: ["quiz"],
    },
  };
  const scenes = [
    {
      id: "scene-explain",
      outlineId: "explain",
      title: "原理讲解",
      type: "slide",
      content: { type: "slide", elements: [{ text: "完整讲解" }] },
      actions: [{ type: "speech", text: "讲解旁白" }],
    },
    {
      id: "scene-practice",
      outlineId: "practice",
      title: "分步练习",
      type: "interactive",
      content: {
        type: "interactive",
        widgetType: "procedural-skill",
        widgetConfig: {
          type: "procedural-skill",
          steps: [{ id: "step-1", title: "执行" }],
        },
      },
      actions: [{ type: "speech", text: "请按步骤执行" }],
    },
    {
      id: "scene-transfer",
      outlineId: "transfer",
      title: "迁移任务",
      type: "pbl",
      content: {
        type: "pbl",
        projectConfig: {
          projectInfo: { title: "新情境任务", description: "迁移所学方法" },
        },
      },
      actions: [],
    },
    {
      id: "scene-quiz",
      outlineId: "quiz",
      title: "达标测验",
      type: "quiz",
      content: {
        type: "quiz",
        questions: [{ id: "q1", question: "迁移题" }],
      },
      actions: [],
    },
  ];
  test(() =>
    assert.equal(
      validateLearningContractFulfillment(contract, scenes).fulfilled,
      true,
    ),
  );
  test(() =>
    assert.equal(
      validateLearningContractFulfillment({ ...contract, version: 1 }, scenes)
        .fulfilled,
      false,
    ),
  );
  test(() => {
    const { teachingStrategy: _missing, ...withoutStrategy } = contract;
    assert.equal(
      validateLearningContractFulfillment(withoutStrategy, scenes).fulfilled,
      false,
    );
  });
  test(() => {
    for (const outlineId of ["practice", "transfer", "quiz"]) {
      const emptied = scenes.map((scene) =>
        scene.outlineId === outlineId ? { ...scene, content: {} } : scene,
      );
      assert.equal(
        validateLearningContractFulfillment(contract, emptied).fulfilled,
        false,
      );
    }
  });
  test(() => {
    const ubd = {
      ...contract,
      teachingStrategy: "ubd",
      strategyEvidence: {
        essentialQuestion: "怎样把方法迁移到新情境？",
        enduringUnderstanding: "可迁移能力来自证据、练习与反思。",
        performanceEvidence: "quiz",
        reflectionRevision: "practice",
        transfer: "transfer",
      },
    };
    const feynman = {
      ...contract,
      teachingStrategy: "feynman",
      strategyEvidence: {
        learnerExplanation: "practice",
        gapDiagnosis: "quiz",
        diagnosedGapCount: 1,
        plainLanguage: "practice",
        analogyBoundary: "quiz",
        transfer: "transfer",
      },
    };
    assert.equal(
      validateLearningContractFulfillment(ubd, scenes).fulfilled,
      true,
    );
    assert.equal(
      validateLearningContractFulfillment(feynman, scenes).fulfilled,
      true,
    );
    assert.equal(
      validateLearningContractFulfillment(
        { ...ubd, strategyEvidence: undefined },
        scenes,
      ).fulfilled,
      false,
    );
  });

  const courseAudit = {
    verdict: "pass",
    decision: "publish",
    claims: [],
    totalClaims: 0,
    incorrectCount: 0,
    uncertainCount: 0,
    grounded: false,
    evidenceCount: 0,
    panelComplete: true,
    courseContentHash: hashCourseScenes(scenes),
  };
  test(() => assert.equal(validateCourseAudit(courseAudit, scenes).ok, true));
  test(() => {
    const reordered = scenes.map((scene, index) =>
      index === 0
        ? {
            ...scene,
            content: {
              elements: scene.content.elements,
              type: scene.content.type,
            },
          }
        : scene,
    );
    assert.equal(hashCourseScenes(reordered), courseAudit.courseContentHash);
  });
  test(() => {
    const tampered = scenes.map((scene, index) =>
      index === 0 ? { ...scene, title: "篡改标题" } : scene,
    );
    assert.equal(validateCourseAudit(courseAudit, tampered).ok, false);
  });
  test(() => {
    const tampered = scenes.map((scene, index) =>
      index === 0
        ? { ...scene, content: { ...scene.content, tampered: true } }
        : scene,
    );
    assert.equal(validateCourseAudit(courseAudit, tampered).ok, false);
  });
  test(() => {
    const tampered = scenes.map((scene, index) =>
      index === 0
        ? { ...scene, actions: [{ type: "speech", text: "篡改旁白" }] }
        : scene,
    );
    assert.equal(validateCourseAudit(courseAudit, tampered).ok, false);
  });
  test(() =>
    assert.equal(
      validateCourseAudit({ ...courseAudit, panelComplete: false }, scenes).ok,
      false,
    ),
  );
  test(() => {
    const json = reportJson(
      {
        error: "secret",
        cookie: "jizhi_session=cookie-value; Path=/",
        nested: { inviteCode: "JZ-ABC12345", apiKey: "provider-key" },
        token: "access-token",
      },
      ["secret"],
    );
    assert.equal(json.includes("secret"), false);
    assert.equal(json.includes("cookie-value"), false);
    assert.equal(json.includes("JZ-ABC12345"), false);
    assert.equal(json.includes("provider-key"), false);
    assert.equal(json.includes("access-token"), false);
    assert.doesNotThrow(() => JSON.parse(json));
  });
  return {
    schemaVersion: 2,
    command: "production-dual-org-e2e",
    mode: "parser-self-test",
    ok: true,
    assertions,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildBlueprintPayload(learningGoal, fields) {
  return { learningGoal, profile: { ...fields } };
}

function buildCheckContract(checks, mode) {
  const required = [...requiredCheckIds(mode)];
  const requiredSet = new Set(required);
  const counts = new Map();
  for (const check of checks) {
    counts.set(check.id, (counts.get(check.id) ?? 0) + 1);
  }
  const missing = required.filter((id) => !counts.has(id));
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const skipped = checks
    .filter((check) => check.skipped)
    .map((check) => check.id)
    .sort();
  const unexpected = [...counts.keys()]
    .filter((id) => !requiredSet.has(id))
    .sort();
  return {
    required,
    missing,
    duplicates,
    skipped,
    unexpected,
    ok:
      missing.length === 0 &&
      duplicates.length === 0 &&
      skipped.length === 0 &&
      unexpected.length === 0,
  };
}

function buildBoundaryContract(boundaries) {
  const required = boundaries
    .filter((boundary) => boundary?.required === true)
    .map((boundary) => boundary.id)
    .filter(Boolean);
  return { required, ok: required.length === 0 };
}

function reportJson(value, secrets = []) {
  let json = JSON.stringify(
    value,
    (key, child) =>
      /(?:authorization|cookie|invite.?code|api.?key|password|secret|token)/iu.test(
        key,
      )
        ? "[REDACTED]"
        : child,
    2,
  );
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) {
      json = json.replaceAll(secret, "[REDACTED]");
    }
  }
  return json.replace(
    /jizhi_session=[^;"\\\s]+/giu,
    "jizhi_session=[REDACTED]",
  );
}

function addCheck(report, id, ok, meta = {}) {
  report.checks.push({ id, ok: Boolean(ok), ...meta });
  return Boolean(ok);
}

function addSkipped(report, id, reason, meta = {}) {
  addCheck(report, id, false, { ...meta, skipped: true, detail: reason });
}

function summarizeHttp(result) {
  if (!result) return { status: 0, error: "未发起请求" };
  const body = isObject(result.body) ? result.body : null;
  const nestedError = isObject(body?.error) ? body.error : null;
  return {
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
    ...(typeof body?.error === "string" ? { apiError: body.error } : {}),
    ...(typeof nestedError?.code === "string"
      ? { errorCode: nestedError.code }
      : {}),
    ...(typeof body?.errorCode === "string"
      ? { errorCode: body.errorCode }
      : {}),
  };
}

function documentRequestRejected(result) {
  if (!DOCUMENT_REJECTION_STATUSES.has(result?.status)) return false;
  const error = isObject(result?.body?.error) ? result.body.error : null;
  const code = normalizedString(error?.code ?? result?.body?.errorCode);
  return [
    "DOCUMENT_NOT_FOUND",
    "FORBIDDEN_DOCUMENTS",
    "UNAUTHENTICATED",
  ].includes(code);
}

function documentDeleteIsolated(result, ownerReread) {
  return (
    documentRequestRejected(result) ||
    (result?.status === 204 && ownerReread?.status === 200)
  );
}

function runtimeSessionMissing(result) {
  const error = isObject(result?.body?.error) ? result.body.error : null;
  return Boolean(
    result?.status === 404 &&
    normalizedString(error?.code ?? result?.body?.errorCode) ===
      "SESSION_NOT_FOUND",
  );
}

function markFatal(report, message) {
  report.fatalError = [report.fatalError, message].filter(Boolean).join("；");
}

function inspectDomainBuckets(fields, effectiveDomain = null) {
  const byDomain = isObject(fields?.conceptMasteryByDomain)
    ? fields.conceptMasteryByDomain
    : {};
  const ai = isObject(byDomain.ai)
    ? byDomain.ai[DOMAIN_BUCKET_CONCEPT]
    : undefined;
  const manufacturing = isObject(byDomain["smart-manufacturing"])
    ? byDomain["smart-manufacturing"][DOMAIN_BUCKET_CONCEPT]
    : undefined;
  const effectiveValue = effectiveDomain
    ? byDomain[effectiveDomain]?.[DOMAIN_BUCKET_CONCEPT]
    : undefined;
  const effectiveDomainMatches = effectiveDomain
    ? profileMatchesDomain(fields, effectiveDomain)
    : true;
  return {
    accepted:
      ai === DOMAIN_BUCKET_VALUES.ai &&
      manufacturing === DOMAIN_BUCKET_VALUES["smart-manufacturing"] &&
      ai !== manufacturing &&
      effectiveDomainMatches &&
      (!effectiveDomain ||
        effectiveValue === DOMAIN_BUCKET_VALUES[effectiveDomain]),
    ai: typeof ai === "number" ? ai : null,
    smartManufacturing:
      typeof manufacturing === "number" ? manufacturing : null,
    effectiveDomain,
    effectiveDomainMatches,
    effectiveValue: typeof effectiveValue === "number" ? effectiveValue : null,
  };
}

function changedDimensions(values) {
  return Object.values(values).filter(Boolean).length;
}

function documentProbeFixture(stageId) {
  const now = Date.now();
  return {
    stage: {
      id: stageId,
      name: "生产隔离验收临时文档",
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: `${stageId}-scene`,
        stageId,
        title: "隔离验收",
        order: 0,
        type: "slide",
        content: {
          type: "slide",
          canvas: { id: `${stageId}-canvas`, elements: [] },
        },
      },
    ],
  };
}

function cookieFrom(headers) {
  const values =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/(?:^|,\s*)(jizhi_session=[^;]+)/);
    if (match) return match[1];
  }
  return null;
}

async function request(
  base,
  session,
  path,
  { method = "GET", json, timeoutMs } = {},
) {
  const headers = new Headers({ Accept: "application/json" });
  if (session?.cookie) headers.set("Cookie", session.cookie);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(new URL(path, `${base}/`), {
      method,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      headers: response.headers,
      contentType: response.headers.get("content-type") ?? "",
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    };
  }
}

async function login(base, spec, password) {
  const response = await request(base, null, "/api/auth", {
    method: "POST",
    json: {
      action: "login",
      username: spec.username,
      password,
      role: spec.role,
    },
  });
  return {
    response,
    cookie: response.headers ? cookieFrom(response.headers) : null,
    account: isObject(response.body?.account) ? response.body.account : null,
    profile: response.body?.profile ?? null,
  };
}

function responseArray(result, key) {
  return result?.status === 200 && Array.isArray(result.body?.[key])
    ? result.body[key]
    : [];
}

function responseObject(result, key) {
  const value = result?.body?.[key];
  return result?.status === 200 && isObject(value) ? value : null;
}

async function validateOwnedDocumentIsolation(report, options, sessions) {
  const checkIds = {
    GET: "persistence.owned-document.nonowner-get-rejected",
    PUT: "persistence.owned-document.nonowner-put-rejected",
    DELETE: "persistence.owned-document.nonowner-delete-rejected",
  };
  if (!options.generate) return;

  {
    const stageId = `e2e-owned-control-${randomUUID()}`;
    const path = `/api/persistence/documents/${encodeURIComponent(stageId)}`;
    const create = await request(options.base, sessions.A, path, {
      method: "PUT",
      json: documentProbeFixture(stageId),
    });
    let control = null;
    try {
      if (create.status === 204) {
        const get = await request(options.base, sessions.B, path);
        const put = await request(options.base, sessions.B, path, {
          method: "PUT",
          json: documentProbeFixture(stageId),
        });
        const remove = await request(options.base, sessions.B, path, {
          method: "DELETE",
        });
        const ownerAfterNonOwnerDelete = await request(
          options.base,
          sessions.A,
          path,
        );
        control = {
          stageId,
          created: summarizeHttp(create),
          GET: summarizeHttp(get),
          PUT: summarizeHttp(put),
          DELETE: summarizeHttp(remove),
          ownerAfterNonOwnerDelete: summarizeHttp(ownerAfterNonOwnerDelete),
          rejected: {
            GET: documentRequestRejected(get),
            PUT: documentRequestRejected(put),
            DELETE: documentDeleteIsolated(remove, ownerAfterNonOwnerDelete),
          },
        };
      } else {
        control = { stageId, created: summarizeHttp(create) };
      }
    } finally {
      const cleanup = await request(options.base, sessions.A, path, {
        method: "DELETE",
      });
      const [ownerReread, nonOwnerReread] = await Promise.all([
        request(options.base, sessions.A, path),
        request(options.base, sessions.B, path),
      ]);
      const cleanupVerified =
        create.status === 204
          ? documentRequestRejected(ownerReread) &&
            documentRequestRejected(nonOwnerReread)
          : null;
      report.operations.push({
        type: "cleanup-document-probe",
        actor: "A",
        stageId,
        status: cleanup.status,
        rereadStatuses: {
          owner: ownerReread.status,
          nonOwner: nonOwnerReread.status,
        },
        verified: cleanupVerified,
      });
      if (control) {
        control.cleanup = {
          delete: summarizeHttp(cleanup),
          ownerReread: summarizeHttp(ownerReread),
          nonOwnerReread: summarizeHttp(nonOwnerReread),
          verified: cleanupVerified,
        };
      }
      if (cleanupVerified === false) {
        markFatal(
          report,
          `临时文档 ${stageId} 删除后仍可读取；脚本只记录该精确 ID，不扩大清理范围`,
        );
      }
    }
    report.probes.ownedDocumentIsolation = control;
    for (const method of Object.keys(checkIds)) {
      addCheck(report, checkIds[method], control?.rejected?.[method] === true, {
        actor: "B",
        owner: "A",
        sampleKind: "temporary-owned-document",
        stageId,
        expected:
          method === "DELETE"
            ? "B 对 A 文档的 DELETE 被拒绝，或幂等返回 204 且 A 仍能读取原文档"
            : `B 对 A 文档的 ${method} 返回 401/403/404`,
        actual: control?.[method] ?? control?.created ?? null,
      });
    }
    return;
  }
}

function profileWithDomainBucketProbe(fields, activeDomain) {
  const next = structuredClone(fields);
  for (const key of [
    "conceptMasteryByDomain",
    "conceptConfidenceByDomain",
    "conceptRecallByDomain",
  ]) {
    const table = isObject(next[key]) ? structuredClone(next[key]) : {};
    for (const domain of Object.keys(DOMAIN_BUCKET_VALUES)) {
      const bucket = isObject(table[domain]) ? { ...table[domain] } : {};
      bucket[DOMAIN_BUCKET_CONCEPT] = DOMAIN_BUCKET_VALUES[domain];
      table[domain] = bucket;
    }
    next[key] = table;
  }
  const opposite = activeDomain === "ai" ? "smart-manufacturing" : "ai";
  for (const key of ["conceptMastery", "conceptConfidence", "conceptRecall"]) {
    next[key] = {
      ...(isObject(next[key]) ? next[key] : {}),
      [DOMAIN_BUCKET_CONCEPT]: DOMAIN_BUCKET_VALUES[opposite],
    };
  }
  return next;
}

function evidenceProbeEntry({
  accountId,
  domain,
  concept,
  resourceId,
  at,
  probeId,
}) {
  const score = DOMAIN_BUCKET_VALUES[domain] ?? 0;
  return {
    id: `evidence-record-${probeId}-${domain}`,
    sessionId: `evidence-probe-${probeId}`,
    sceneId: resourceId,
    createdAt: at,
    payload: {
      payloadVersion: 1,
      type: "evidence",
      evidence: {
        id: `evidence:${probeId}:${domain}`,
        learnerKey: accountId,
        source: {
          interactionId: `interaction-${probeId}`,
          resourceId,
          at,
        },
        measured: { kind: "concept", domain, concept },
        verdict: {
          outcome: score >= 0.5 ? "correct" : "incorrect",
          score,
          because: {
            hit: score >= 0.5 ? ["命中验收测项"] : [],
            missed: score < 0.5 ? ["未命中验收测项"] : [],
          },
        },
        verdictScope: "per-kc",
        context: {
          encounter: 1,
          modality: "quiz",
          elapsedMs: 1000,
          difficulty: 0.5,
        },
      },
    },
  };
}

async function createEvidenceProbe(base, session, accountId, resourceId) {
  const probeId = randomUUID();
  const sessionId = `evidence-probe-${probeId}`;
  const now = new Date().toISOString();
  const created = await request(
    base,
    session,
    "/api/persistence/runtime/sessions",
    {
      method: "POST",
      json: {
        id: sessionId,
        kind: "evidence",
        stageId: "evidence-ledger",
        learnerKey: accountId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  );
  const appends = [];
  if (created.status === 201) {
    for (const domain of Object.keys(DOMAIN_BUCKET_VALUES)) {
      appends.push(
        await request(
          base,
          session,
          `/api/persistence/runtime/sessions/${encodeURIComponent(sessionId)}/records`,
          {
            method: "POST",
            json: evidenceProbeEntry({
              accountId,
              domain,
              concept: DOMAIN_BUCKET_CONCEPT,
              resourceId,
              at: now,
              probeId,
            }),
          },
        ),
      );
    }
  }
  const listed = await request(
    base,
    session,
    `/api/persistence/runtime/sessions/${encodeURIComponent(sessionId)}/records`,
  );
  const records = Array.isArray(listed.body) ? listed.body : [];
  const domains = records
    .map((record) => record?.payload?.evidence?.measured)
    .filter(
      (measured) =>
        measured?.kind === "concept" &&
        measured?.concept === DOMAIN_BUCKET_CONCEPT,
    )
    .map((measured) => measured.domain)
    .sort();
  return {
    sessionId,
    accepted:
      created.status === 201 &&
      appends.length === 2 &&
      appends.every((item) => item.status === 201) &&
      listed.status === 200 &&
      JSON.stringify(domains) === JSON.stringify(["ai", "smart-manufacturing"]),
    statuses: {
      create: created.status,
      append: appends.map((item) => item.status),
      list: listed.status,
    },
    domains,
    recordCount: records.length,
  };
}

async function validateSameConceptDomainBuckets(
  report,
  base,
  sessions,
  accounts,
  scenarioResults,
) {
  const targets = [
    { actor: "B", domain: "ai", scenarioKey: "ai" },
    {
      actor: "D",
      domain: "smart-manufacturing",
      scenarioKey: "smartManufacturing",
    },
  ].map((target) => ({
    ...target,
    courseId:
      scenarioResults.find((item) => item?.scenario?.key === target.scenarioKey)
        ?.courseId ?? null,
  }));
  if (targets.some((target) => !target.courseId)) {
    for (const id of [
      "report.same-concept.profile-buckets",
      "report.same-concept.evidence-buckets",
    ]) {
      addSkipped(report, id, "两域课程不完整，未执行同名概念写入探针");
    }
    return;
  }

  const snapshots = await Promise.all(
    targets.map(async (target) => {
      const response = await request(
        base,
        sessions[target.actor],
        "/api/profile",
      );
      return {
        ...target,
        activeId: normalizedString(response.body?.activeId),
        fields: isObject(response.body?.fields)
          ? structuredClone(response.body.fields)
          : null,
        status: response.status,
      };
    }),
  );
  if (
    snapshots.some(
      (item) => item.status !== 200 || !item.activeId || !item.fields,
    )
  ) {
    for (const id of [
      "report.same-concept.profile-buckets",
      "report.same-concept.evidence-buckets",
    ]) {
      addSkipped(report, id, "B/D 当前画像无法完整快照，未执行可回滚写入探针");
    }
    return;
  }

  const evidenceProbes = [];
  try {
    const writes = await Promise.all(
      snapshots.map((item) =>
        request(base, sessions[item.actor], "/api/profile", {
          method: "POST",
          json: {
            action: "update",
            id: item.activeId,
            fields: profileWithDomainBucketProbe(item.fields, item.domain),
          },
        }),
      ),
    );
    const rereads = await Promise.all(
      snapshots.map((item) =>
        request(base, sessions[item.actor], "/api/profile"),
      ),
    );
    const profileInspections = rereads.map((response, index) =>
      inspectDomainBuckets(response.body?.fields, snapshots[index].domain),
    );
    addCheck(
      report,
      "report.same-concept.profile-buckets",
      writes.every((item) => item.status === 200) &&
        rereads.every((item) => item.status === 200) &&
        profileInspections.every((item) => item.accepted),
      {
        expected:
          "B/D 服务端画像均同时保存同名概念的 AI=0.23、智能制造=0.81 两个独立桶",
        actual: snapshots.map((item, index) => ({
          actor: item.actor,
          writeStatus: writes[index].status,
          readStatus: rereads[index].status,
          ...profileInspections[index],
        })),
      },
    );

    evidenceProbes.push(
      ...(await Promise.all(
        snapshots.map((item) =>
          createEvidenceProbe(
            base,
            sessions[item.actor],
            accounts[item.actor].id,
            item.courseId,
          ).then((probe) => ({ ...probe, actor: item.actor })),
        ),
      )),
    );
    addCheck(
      report,
      "report.same-concept.evidence-buckets",
      evidenceProbes.every((probe) => probe.accepted),
      {
        expected:
          "B/D 各自证据账本的隔离 session 均包含同名概念的 ai 与 smart-manufacturing 两条可复读记录",
        actual: evidenceProbes.map(
          ({ sessionId: _sessionId, ...probe }) => probe,
        ),
      },
    );

    const pages = await Promise.all(
      snapshots.map((item) =>
        request(
          base,
          sessions[item.actor],
          `/report?stageId=${encodeURIComponent(item.courseId)}`,
        ),
      ),
    );
    report.probes.sameConceptReportPages = snapshots.map((item, index) => ({
      actor: item.actor,
      domain: item.domain,
      status: pages[index].status,
      contentType: pages[index].contentType ?? "",
    }));
    report.boundaries.push({
      id: "same-concept-report-browser-render",
      required: true,
      reason:
        "报告页在浏览器挂载后读取领域画像和证据；本脚本只验服务端双桶写入与复读，真实渲染由 playwright.production.config.ts 的 B/D 学习端用例作为独立必跑门禁。",
    });
  } finally {
    const profileCleanup = await Promise.all(
      snapshots.map((item) =>
        request(base, sessions[item.actor], "/api/profile", {
          method: "POST",
          json: {
            action: "update",
            id: item.activeId,
            fields: item.fields,
          },
        }),
      ),
    );
    const evidenceCleanup = await Promise.all(
      evidenceProbes.map((probe) =>
        request(
          base,
          sessions[probe.actor],
          `/api/persistence/runtime/sessions/${encodeURIComponent(probe.sessionId)}`,
          { method: "DELETE" },
        ),
      ),
    );
    const [profileRereads, evidenceRereads] = await Promise.all([
      Promise.all(
        snapshots.map((item) =>
          request(base, sessions[item.actor], "/api/profile"),
        ),
      ),
      Promise.all(
        evidenceProbes.map((probe) =>
          request(
            base,
            sessions[probe.actor],
            `/api/persistence/runtime/sessions/${encodeURIComponent(probe.sessionId)}`,
          ),
        ),
      ),
    ]);
    const profilesRestored = snapshots.every((item, index) => {
      const reread = profileRereads[index];
      return Boolean(
        reread?.status === 200 &&
        reread.body?.activeId === item.activeId &&
        JSON.stringify(canonicalizeForHash(reread.body?.fields)) ===
          JSON.stringify(canonicalizeForHash(item.fields)),
      );
    });
    const evidenceRemoved = evidenceRereads.every(runtimeSessionMissing);
    report.operations.push({
      type: "cleanup-same-concept-probe",
      profileStatuses: profileCleanup.map((item) => item.status),
      evidenceSessionStatuses: evidenceCleanup.map((item) => item.status),
      profileRereadStatuses: profileRereads.map((item) => item.status),
      evidenceRereadStatuses: evidenceRereads.map((item) => item.status),
      profilesRestored,
      evidenceRemoved,
    });
    if (!profilesRestored || !evidenceRemoved) {
      markFatal(
        report,
        "同名概念探针未完整回滚：只记录本次画像 activeId 与临时 evidence session，不扩大清理范围",
      );
    }
  }
}

function firstQuizQuestion(classroom) {
  const scenes = Array.isArray(classroom?.scenes) ? classroom.scenes : [];
  for (const scene of scenes) {
    if (scene?.type !== "quiz") continue;
    const questions = Array.isArray(scene?.content?.questions)
      ? scene.content.questions
      : [];
    const question = questions.find((item) => normalizedString(item?.question));
    if (question) return { scene, question };
  }
  return null;
}

function profileMasteryDigest(fields) {
  const value = {
    conceptMastery: fields?.conceptMastery ?? null,
    conceptConfidence: fields?.conceptConfidence ?? null,
    conceptRecall: fields?.conceptRecall ?? null,
    conceptMasteryByDomain: fields?.conceptMasteryByDomain ?? null,
    conceptConfidenceByDomain: fields?.conceptConfidenceByDomain ?? null,
    conceptRecallByDomain: fields?.conceptRecallByDomain ?? null,
    derivedFrom: fields?.derivedFrom ?? null,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(value)), "utf8")
    .digest("hex");
}

async function validateWrongAnswerRemediation(
  report,
  base,
  sessions,
  accounts,
  scenarioResult,
) {
  const scenario = scenarioResult.scenario;
  const checkIds = remediationRequiredCheckIds(scenario.key);
  const dimensionCheckIds = checkIds.slice(1);
  const skipDimensions = (reason, meta = {}) => {
    for (const id of dimensionCheckIds) addSkipped(report, id, reason, meta);
  };
  if (!scenarioResult.courseId) {
    addSkipped(
      report,
      checkIds[0],
      `没有本轮生成且可访问的 ${scenario.domain} 指派课程，无法选择真实测验题`,
    );
    skipDimensions(`没有本轮生成且可访问的 ${scenario.domain} 课程`);
    return;
  }

  const actor = scenario.learner;
  const courseId = scenarioResult.courseId;
  const [courseResponse, profileBefore] = await Promise.all([
    request(
      base,
      sessions[actor],
      `/api/classroom?id=${encodeURIComponent(courseId)}`,
    ),
    request(base, sessions[actor], "/api/profile"),
  ]);
  const classroom = responseObject(courseResponse, "classroom");
  const picked = firstQuizQuestion(classroom);
  const sceneId = normalizedString(picked?.scene?.id);
  const beforeFields = isObject(profileBefore.body?.fields)
    ? structuredClone(profileBefore.body.fields)
    : null;
  const activeId = normalizedString(profileBefore.body?.activeId);
  if (!picked || !sceneId || !beforeFields || !activeId) {
    const reason = !picked
      ? "目标课程没有可作答的真实 quiz 题"
      : !sceneId
        ? "真实 quiz 场景缺少可持久化 sceneId"
        : "学习者画像 activeId/fields 不可完整读取";
    addSkipped(report, checkIds[0], reason, {
      actor,
      courseId,
      domain: scenario.domain,
    });
    skipDimensions(reason, { actor, courseId });
    return;
  }

  const question = picked.question;
  const scene = picked.scene;
  const points = Math.max(
    1,
    Number.isFinite(question.points) && question.points > 0
      ? question.points
      : 1,
  );
  const grade = await request(base, sessions[actor], "/api/quiz-grade", {
    method: "POST",
    json: {
      question: question.question,
      userAnswer: "我不知道，无法作答。",
      points,
      commentPrompt: question.commentPrompt,
      language: "zh-CN",
    },
  });
  const score = Number(grade.body?.score);
  const knownFallbackScore = Math.round(points * 0.5);
  const wrong = Boolean(
    grade.status === 200 &&
    Number.isFinite(score) &&
    score === 0 &&
    score !== knownFallbackScore,
  );
  addCheck(report, checkIds[0], wrong, {
    actor,
    courseId,
    domain: scenario.domain,
    sceneId,
    questionId: question.id ?? null,
    expected: `真实课程题经 /api/quiz-grade 明确判 0 分，且排除该路由解析失败时的固定半分回退 ${knownFallbackScore}/${points}`,
    actual:
      grade.status === 200
        ? {
            status: grade.status,
            score: Number.isFinite(score) ? score : null,
            points,
            knownFallbackScore,
          }
        : summarizeHttp(grade),
  });
  if (!wrong) {
    skipDimensions("真实答错未被明确判错，不执行后续三维验收", {
      actor,
      courseId,
    });
    return;
  }

  const probeId = randomUUID();
  const sessionId = `evidence-remediation-${scenario.key}-${probeId}`;
  const now = new Date().toISOString();
  const sessionPath = `/api/persistence/runtime/sessions/${encodeURIComponent(sessionId)}`;
  const created = await request(
    base,
    sessions[actor],
    "/api/persistence/runtime/sessions",
    {
      method: "POST",
      json: {
        id: sessionId,
        kind: "evidence",
        stageId: "evidence-ledger",
        learnerKey: accounts[actor].id,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
    },
  );
  let probe = null;
  try {
    const beforeRecords = await request(
      base,
      sessions[actor],
      `${sessionPath}/records`,
    );
    let append = null;
    if (created.status === 201) {
      const recordId = `evidence-record-remediation-${probeId}`;
      append = await request(base, sessions[actor], `${sessionPath}/records`, {
        method: "POST",
        json: {
          id: recordId,
          sessionId,
          sceneId,
          createdAt: now,
          payload: {
            payloadVersion: 1,
            type: "evidence",
            evidence: {
              id: `evidence:remediation:${probeId}`,
              learnerKey: accounts[actor].id,
              source: {
                interactionId: `interaction-remediation-${probeId}`,
                resourceId: sceneId,
                at: now,
              },
              measured: {
                kind: "concept",
                domain: scenario.domain,
                concept:
                  normalizedString(scene.title) ||
                  normalizedString(question.question),
              },
              verdict: {
                outcome: score === 0 ? "incorrect" : "partial",
                score: score / points,
                because: {
                  hit: [],
                  missed: [normalizedString(question.question)],
                },
              },
              verdictScope: "item-level",
              context: {
                encounter: 1,
                modality: "quiz",
                elapsedMs: 1000,
                difficulty: 0.5,
              },
            },
          },
        },
      });
    }
    const afterRecords = await request(
      base,
      sessions[actor],
      `${sessionPath}/records`,
    );
    const beforeCount = Array.isArray(beforeRecords.body)
      ? beforeRecords.body.length
      : -1;
    const afterCount = Array.isArray(afterRecords.body)
      ? afterRecords.body.length
      : -1;
    const evidenceChanged = Boolean(
      created.status === 201 &&
      append?.status === 201 &&
      beforeCount === 0 &&
      afterCount === 1,
    );

    const decision = await request(
      base,
      sessions[actor],
      "/api/adaptive/quiz-decision",
      {
        method: "POST",
        json: {
          quizScore: score / points,
          currentDifficulty: beforeFields.currentDifficulty,
          conceptScores: {
            [normalizedString(scene.title) || "当前测验"]: score / points,
          },
        },
      },
    );
    const decisionKind = normalizedString(decision.body?.decision);
    let remediation = null;
    if (
      ["downgrade_explanation", "add_practice", "advance_challenge"].includes(
        decisionKind,
      )
    ) {
      remediation = await request(
        base,
        sessions[actor],
        "/api/adaptive/remediation",
        {
          method: "POST",
          json: {
            decision: decisionKind,
            sceneTitle: scene.title,
            courseTitle: classroom.stage?.name,
            missedPoints: [question.question],
            learnerProfile: beforeFields,
            order:
              Number.isFinite(scene.order) && scene.order >= 0
                ? scene.order + 1
                : 1,
          },
        },
      );
    }
    const outline = isObject(remediation?.body?.outline)
      ? remediation.body.outline
      : null;
    const nextResourcePlanned = Boolean(
      remediation?.status === 200 &&
      Number(remediation.body?.evidenceCount) > 0 &&
      normalizedString(outline?.id).startsWith("remediation_") &&
      normalizedString(outline?.title) &&
      normalizedString(outline?.description),
    );
    const courseAfter = await request(
      base,
      sessions[actor],
      `/api/classroom?id=${encodeURIComponent(courseId)}`,
    );
    const afterClassroom = responseObject(courseAfter, "classroom");
    const nextResourceChanged = Boolean(
      nextResourcePlanned &&
      Array.isArray(afterClassroom?.scenes) &&
      afterClassroom.scenes.some((item) => item?.id === outline.id),
    );

    const profileAfter = await request(base, sessions[actor], "/api/profile");
    const afterFields = isObject(profileAfter.body?.fields)
      ? profileAfter.body.fields
      : null;
    const masteryChanged = Boolean(
      afterFields &&
      profileMasteryDigest(afterFields) !== profileMasteryDigest(beforeFields),
    );
    const dimensions = {
      evidence: evidenceChanged,
      mastery: masteryChanged,
      nextResource: nextResourceChanged,
    };
    addCheck(report, dimensionCheckIds[0], evidenceChanged, {
      actor,
      courseId,
      domain: scenario.domain,
      expected: "真实答错新增一条可复读证据",
      actual: { beforeCount, afterCount, appendStatus: append?.status ?? null },
    });
    addCheck(report, dimensionCheckIds[1], masteryChanged, {
      actor,
      courseId,
      domain: scenario.domain,
      expected: "真实答错后目标领域掌握度由证据重算并发生变化",
      actual: { changed: masteryChanged },
    });
    addCheck(report, dimensionCheckIds[2], nextResourceChanged, {
      actor,
      courseId,
      domain: scenario.domain,
      expected: "补救资源经生成与审核后写入本轮课程",
      actual: {
        planned: nextResourcePlanned,
        persistedInCourse: nextResourceChanged,
        outlineId: outline?.id ?? null,
      },
    });
    const changed = changedDimensions(dimensions);
    report.probes.remediationApiDimensions ??= {};
    report.probes.remediationApiDimensions[scenario.key] = {
      actor,
      courseId,
      domain: scenario.domain,
      changed,
      dimensions,
      evidence: {
        createStatus: created.status,
        appendStatus: append?.status ?? null,
        beforeCount,
        afterCount,
      },
      profile: {
        beforeStatus: profileBefore.status,
        afterStatus: profileAfter.status,
        changed: masteryChanged,
      },
      nextResource: {
        decisionStatus: decision.status,
        decision: decisionKind || null,
        remediationStatus: remediation?.status ?? null,
        groundingEvidenceCount: Number.isFinite(
          Number(remediation?.body?.evidenceCount),
        )
          ? Number(remediation.body.evidenceCount)
          : null,
        outlineId: outline?.id ?? null,
        planned: nextResourcePlanned,
        persistedInCourse: nextResourceChanged,
        courseRereadStatus: courseAfter.status,
      },
    };
    if (!masteryChanged) {
      report.boundaries.push({
        id: `remediation-${scenario.key}-profile-refresh-browser-boundary`,
        required: false,
        reason:
          "画像重算由浏览器 refreshDerivedProfile() 在写入证据后触发；生产没有单独的服务端重算 API。本次 API 链因此只把证据持久化并取得补救资源计划，没有伪写掌握度。",
      });
    }
    if (
      remediation?.status === 200 &&
      !(Number(remediation.body?.evidenceCount) > 0)
    ) {
      report.boundaries.push({
        id: `remediation-${scenario.key}-ungrounded-fallback-rejected`,
        required: true,
        reason:
          "补救接口返回了零知识库证据的 outline；脚本把它视为未接地回退，不计入下一资源变化。",
      });
    }
    if (nextResourcePlanned && !nextResourceChanged) {
      report.boundaries.push({
        id: `remediation-${scenario.key}-resource-insertion-browser-boundary`,
        required: true,
        reason:
          "补救 API 只返回 outline；完整正文生成、双审核与插入课程由浏览器 generateRemediationScene() 驱动。复读 /api/classroom 未出现该 outline ID，因此不把“计划已返回”冒充“下一资源已变化”。",
      });
    }
    probe = {
      actor,
      courseId,
      domain: scenario.domain,
      sceneId,
      questionId: question.id ?? null,
      grade: { status: grade.status, score, points },
      dimensions,
      changed,
    };
  } finally {
    const [cleanup, profileRestore] = await Promise.all([
      request(base, sessions[actor], sessionPath, { method: "DELETE" }),
      request(base, sessions[actor], "/api/profile", {
        method: "POST",
        json: { action: "update", id: activeId, fields: beforeFields },
      }),
    ]);
    const [cleanupReread, profileReread] = await Promise.all([
      request(base, sessions[actor], sessionPath),
      request(base, sessions[actor], "/api/profile"),
    ]);
    const cleanupVerified = runtimeSessionMissing(cleanupReread);
    const profileRestored = Boolean(
      profileRestore.status === 200 &&
      profileReread.status === 200 &&
      profileReread.body?.activeId === activeId &&
      JSON.stringify(canonicalizeForHash(profileReread.body?.fields)) ===
        JSON.stringify(canonicalizeForHash(beforeFields)),
    );
    report.operations.push({
      type: "cleanup-remediation-evidence-probe",
      actor,
      domain: scenario.domain,
      sessionId,
      status: cleanup.status,
      rereadStatus: cleanupReread.status,
      verified: cleanupVerified,
      profileRestoreStatus: profileRestore.status,
      profileRereadStatus: profileReread.status,
      profileRestored,
    });
    if (probe) {
      probe.cleanupStatus = cleanup.status;
      probe.cleanupRereadStatus = cleanupReread.status;
      probe.cleanupVerified = cleanupVerified;
    }
    if (!cleanupVerified || !profileRestored) {
      markFatal(
        report,
        `答错补救回滚不完整：只处理临时 evidence session ${sessionId} 与画像 ${activeId}，未扩大清理范围`,
      );
    }
    report.probes.wrongAnswerRemediation ??= {};
    report.probes.wrongAnswerRemediation[scenario.key] = probe;
  }
}

function inspectHtmlPage(result, markers) {
  const html = typeof result?.body === "string" ? result.body : "";
  const missingMarkers = markers.filter((marker) => !html.includes(marker));
  const rejection = html.match(PAGE_REJECTION)?.[0] ?? null;
  const nonRejected = Boolean(
    result?.status === 200 &&
    result?.contentType?.includes("text/html") &&
    html &&
    !rejection,
  );
  return {
    accepted: nonRejected && missingMarkers.length === 0,
    nonRejected,
    status: result?.status ?? 0,
    contentType: result?.contentType ?? "",
    missingMarkers,
    rejection,
    html,
  };
}

function inspectReportPage(result, context) {
  const page = inspectHtmlPage(result, REPORT_PAGE_MARKERS);
  const courseId = normalizedString(context.courseId);
  const title = normalizedString(context.title);
  const returnedCourseId = normalizedString(
    context.classroom?.id ?? context.classroom?.stage?.id,
  );
  const targetMentioned = Boolean(
    (courseId && page.html.includes(courseId)) ||
    (title && page.html.includes(title)),
  );
  const courseMatches = Boolean(
    courseId && title && returnedCourseId === courseId,
  );
  const assignmentMatches = Boolean(
    context.assignment?.courseId === courseId &&
    context.assignment?.learnerAccountId === context.learnerAccountId,
  );
  const domainMatches = Boolean(
    profileMatchesDomain(context.fields, context.domain) &&
    context.effectiveDomain === context.domain,
  );
  return {
    accepted:
      page.accepted && courseMatches && assignmentMatches && domainMatches,
    page,
    targetMentioned,
    explicitNonRejection: page.nonRejected && !targetMentioned,
    courseMatches,
    assignmentMatches,
    domainMatches,
    returnedCourseId,
  };
}

function entryDomain(entry) {
  if (!isObject(entry)) return null;
  const value = entry.domain ?? entry.corpus;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assignmentDomain(assignment, courseDomains) {
  const stored = normalizedString(assignment?.domain);
  const mapped = entryDomain(courseDomains?.[assignment?.courseId]);
  return stored && mapped && stored === mapped ? stored : null;
}

function selectScenarioCourseId(
  mode,
  generatedId,
  learnerAssignments,
  courseDomains,
  domain,
) {
  if (mode === "generate") {
    return normalizedString(generatedId) || null;
  }
  return (
    learnerAssignments.find(
      (assignment) => assignmentDomain(assignment, courseDomains) === domain,
    )?.courseId ?? null
  );
}

function normalizeConcept(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-—–·：:（）()]/g, "");
}

function pathConcepts(path) {
  const concepts = [];
  for (const stage of Array.isArray(path?.stages) ? path.stages : []) {
    for (const concept of Array.isArray(stage?.concepts)
      ? stage.concepts
      : []) {
      const value =
        concept?.name ?? concept?.concept ?? concept?.title ?? concept;
      if (typeof value === "string" && value.trim())
        concepts.push(value.trim());
    }
  }
  return concepts;
}

function conceptsOverlap(left, right) {
  const normalizedRight = right.map(normalizeConcept).filter(Boolean);
  return left.filter((value) => {
    const normalized = normalizeConcept(value);
    return normalizedRight.some(
      (candidate) =>
        candidate === normalized ||
        (candidate.length >= 4 && normalized.includes(candidate)) ||
        (normalized.length >= 4 && candidate.includes(normalized)),
    );
  });
}

function normalizedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedStrings(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(normalizedString).filter(Boolean))]
    : [];
}

function isValidGeneratedAt(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function profileMatchesDomain(fields, domain) {
  return Boolean(
    isObject(fields) && fields.domain === domain && fields.corpus === domain,
  );
}

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeForHash(child)]),
  );
}

function hashCourseScenes(scenes) {
  const payload = (Array.isArray(scenes) ? scenes : []).map(
    ({ id, outlineId, title, type, content, actions }) => ({
      id,
      outlineId,
      title,
      type,
      content,
      actions,
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeForHash(payload)))
    .digest("hex");
}

function auditPassed(audit) {
  if (!isObject(audit)) return false;
  const claims = Array.isArray(audit.claims) ? audit.claims : [];
  const totalClaims = Number.isFinite(audit.totalClaims)
    ? audit.totalClaims
    : -1;
  const factualClaimsGrounded =
    totalClaims === 0 ||
    (audit.grounded === true &&
      Number.isFinite(audit.evidenceCount) &&
      audit.evidenceCount > 0);
  return Boolean(
    audit.verdict === "pass" &&
    audit.decision === "publish" &&
    totalClaims === claims.length &&
    audit.incorrectCount === 0 &&
    audit.uncertainCount === 0 &&
    claims.every((claim) => claim?.verdict === "supported") &&
    factualClaimsGrounded,
  );
}

function validateCourseAudit(audit, scenes) {
  const recomputedHash = hashCourseScenes(scenes);
  const storedHash = normalizedString(audit?.courseContentHash);
  const hashFormatValid = /^[0-9a-f]{64}$/u.test(storedHash);
  const hashMatches = hashFormatValid && storedHash === recomputedHash;
  const panelComplete = audit?.panelComplete === true;
  return {
    ok: auditPassed(audit) && panelComplete && hashMatches,
    panelComplete,
    storedHash: storedHash || null,
    recomputedHash,
    hashFormatValid,
    hashMatches,
  };
}

function actualWidgetType(scene) {
  return isObject(scene?.content)
    ? normalizedString(scene.content.widgetType)
    : "";
}

function actualActivityContentIsNonEmpty(scene) {
  if (!isObject(scene?.content)) return false;
  if (scene.type === "quiz") {
    return (
      Array.isArray(scene.content.questions) &&
      scene.content.questions.length > 0
    );
  }
  if (scene.type === "interactive") {
    return Boolean(
      normalizedString(scene.content.html) ||
      (isObject(scene.content.widgetConfig) &&
        Object.keys(scene.content.widgetConfig).length > 0),
    );
  }
  if (scene.type === "pbl") {
    const projectConfig = isObject(scene.content.projectConfig)
      ? scene.content.projectConfig
      : {};
    const projectInfo = isObject(projectConfig.projectInfo)
      ? projectConfig.projectInfo
      : {};
    const issueboard = isObject(projectConfig.issueboard)
      ? projectConfig.issueboard
      : {};
    const projectV2 = isObject(scene.content.projectV2)
      ? scene.content.projectV2
      : {};
    return Boolean(
      normalizedString(projectInfo.title) ||
      normalizedString(projectInfo.description) ||
      (Array.isArray(issueboard.issues) && issueboard.issues.length > 0) ||
      normalizedString(projectV2.title) ||
      normalizedString(projectV2.description) ||
      (Array.isArray(projectV2.milestones) && projectV2.milestones.length > 0),
    );
  }
  return true;
}

function validateStrategyEvidence(raw, strategy, sceneIds, violations) {
  if (strategy === "standard") return undefined;
  if (!isObject(raw)) {
    violations.push(`${strategy} strategyEvidence is missing`);
    return undefined;
  }
  if (strategy === "ubd") {
    const evidence = {
      essentialQuestion: normalizedString(raw.essentialQuestion),
      enduringUnderstanding: normalizedString(raw.enduringUnderstanding),
      performanceEvidence: normalizedString(raw.performanceEvidence),
      reflectionRevision: normalizedString(raw.reflectionRevision),
      transfer: normalizedString(raw.transfer),
    };
    if (!evidence.essentialQuestion)
      violations.push("ubd essentialQuestion is missing");
    if (!evidence.enduringUnderstanding)
      violations.push("ubd enduringUnderstanding is missing");
    for (const field of [
      "performanceEvidence",
      "reflectionRevision",
      "transfer",
    ]) {
      const sceneId = evidence[field];
      if (!sceneId) violations.push(`ubd ${field} sceneId is missing`);
      else if (!sceneIds.has(sceneId)) {
        violations.push(`ubd ${field} references an unknown scene: ${sceneId}`);
      }
    }
    return evidence;
  }

  const gapCount = raw.diagnosedGapCount;
  const evidence = {
    learnerExplanation: normalizedString(raw.learnerExplanation),
    gapDiagnosis: normalizedString(raw.gapDiagnosis),
    plainLanguage: normalizedString(raw.plainLanguage),
    analogyBoundary: normalizedString(raw.analogyBoundary),
    transfer: normalizedString(raw.transfer),
  };
  if (gapCount !== 1 && gapCount !== 2) {
    violations.push("feynman diagnosedGapCount must be 1 or 2");
  }
  for (const field of [
    "learnerExplanation",
    "gapDiagnosis",
    "plainLanguage",
    "analogyBoundary",
    "transfer",
  ]) {
    const sceneId = evidence[field];
    if (!sceneId) violations.push(`feynman ${field} sceneId is missing`);
    else if (!sceneIds.has(sceneId)) {
      violations.push(
        `feynman ${field} references an unknown scene: ${sceneId}`,
      );
    }
  }
  return gapCount === 1 || gapCount === 2
    ? { ...evidence, diagnosedGapCount: gapCount }
    : undefined;
}

function strategySceneRefs(evidence) {
  if (!evidence) return [];
  return "essentialQuestion" in evidence
    ? [
        evidence.performanceEvidence,
        evidence.reflectionRevision,
        evidence.transfer,
      ]
    : [
        evidence.learnerExplanation,
        evidence.gapDiagnosis,
        evidence.plainLanguage,
        evidence.analogyBoundary,
        evidence.transfer,
      ];
}

function actualSceneMatchesPhase(phase, scene) {
  if (phase === "prerequisiteActivation" || phase === "demonstration")
    return true;
  if (phase === "learnerPractice")
    return scene?.type === "interactive" || scene?.type === "pbl";
  if (phase === "feedbackRetry" || phase === "transferApplication") {
    return ["interactive", "pbl", "quiz"].includes(scene?.type);
  }
  return Boolean(
    scene?.type === "quiz" ||
    scene?.type === "pbl" ||
    (scene?.type === "interactive" &&
      ["game", "procedural-skill"].includes(actualWidgetType(scene))),
  );
}

function validateLearningContractFulfillment(input, scenes) {
  if (
    !isObject(input) ||
    input.version !== 2 ||
    !Array.isArray(input.plannedScenes)
  ) {
    return {
      fulfilled: false,
      violations: ["learning contract plan is missing or invalid"],
    };
  }
  if (!isObject(input.required)) {
    return {
      fulfilled: false,
      violations: ["learning contract required phases are missing"],
    };
  }

  const violations = [];
  const requestedTeachingStrategy = normalizedString(input.teachingStrategy);
  const teachingStrategy = ["standard", "ubd", "feynman"].includes(
    requestedTeachingStrategy,
  )
    ? requestedTeachingStrategy
    : "standard";
  if (!requestedTeachingStrategy) {
    violations.push("teachingStrategy is missing from learning contract v2");
  } else if (teachingStrategy !== requestedTeachingStrategy) {
    violations.push("teachingStrategy must be one of: standard, ubd, feynman");
  }
  const planned = new Map();
  for (const candidate of input.plannedScenes) {
    if (!isObject(candidate)) {
      violations.push("learning contract contains an invalid planned scene");
      continue;
    }
    const sceneId = normalizedString(candidate.sceneId);
    const type = normalizedString(candidate.type);
    if (!sceneId || !["slide", "quiz", "interactive", "pbl"].includes(type)) {
      violations.push("learning contract contains an invalid planned scene");
      continue;
    }
    if (planned.has(sceneId)) {
      violations.push(`planned scene is duplicated: ${sceneId}`);
      continue;
    }
    const widgetType = normalizedString(candidate.widgetType);
    planned.set(sceneId, {
      sceneId,
      type,
      ...(widgetType ? { widgetType } : {}),
    });
  }
  if (planned.size === 0)
    violations.push("learning contract has no planned scenes");

  const actual = new Map();
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const sceneId = normalizedString(scene?.outlineId);
    if (!sceneId) continue;
    if (actual.has(sceneId)) {
      violations.push(`generated scene is duplicated: ${sceneId}`);
      continue;
    }
    actual.set(sceneId, scene);
  }
  for (const [sceneId, expected] of planned) {
    const scene = actual.get(sceneId);
    if (!scene) {
      violations.push(`planned scene is missing: ${sceneId}`);
      continue;
    }
    if (scene.type !== expected.type) {
      violations.push(
        `planned scene type changed: ${sceneId} expected ${expected.type} got ${scene.type || "missing"}`,
      );
    }
    if (
      expected.widgetType &&
      actualWidgetType(scene) !== expected.widgetType
    ) {
      violations.push(
        `planned scene widget changed: ${sceneId} expected ${expected.widgetType} got ${actualWidgetType(scene) || "missing"}`,
      );
    }
    if (
      scene.type === expected.type &&
      ["quiz", "interactive", "pbl"].includes(expected.type) &&
      !actualActivityContentIsNonEmpty(scene)
    ) {
      const missing =
        expected.type === "quiz"
          ? "questions"
          : expected.type === "interactive"
            ? "html or widgetConfig"
            : "task content";
      violations.push(`${expected.type} scene has no ${missing}: ${sceneId}`);
    }
  }

  const strategyEvidence = validateStrategyEvidence(
    input.strategyEvidence,
    teachingStrategy,
    new Set(planned.keys()),
    violations,
  );
  for (const sceneId of strategySceneRefs(strategyEvidence).filter(Boolean)) {
    if (!actual.has(sceneId)) {
      violations.push(
        `${teachingStrategy} strategy scene is missing: ${sceneId}`,
      );
    }
  }
  for (const phase of CONTRACT_PHASES) {
    const rawRefs = input.required[phase];
    const refs = normalizedStrings(rawRefs);
    if (
      !Array.isArray(rawRefs) ||
      refs.length === 0 ||
      refs.length !== rawRefs.length
    ) {
      violations.push(
        `learning contract phase is missing or invalid: ${phase}`,
      );
      continue;
    }
    for (const sceneId of refs) {
      if (!planned.has(sceneId)) {
        violations.push(`${phase} references an unplanned scene: ${sceneId}`);
        continue;
      }
      const scene = actual.get(sceneId);
      if (!scene) violations.push(`${phase} scene is missing: ${sceneId}`);
      else if (!actualSceneMatchesPhase(phase, scene)) {
        violations.push(
          `${phase} scene has the wrong teaching category: ${sceneId}`,
        );
      }
    }
  }
  return { fulfilled: violations.length === 0, violations };
}

function collectText(value, output = []) {
  if (typeof value === "string") {
    if (value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output);
    return output;
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) collectText(item, output);
  }
  return output;
}

function executableStepCount(value) {
  let best = 0;
  const visit = (candidate, key = "") => {
    if (Array.isArray(candidate)) {
      if (
        /(?:steps?|procedure|instructions?|workflow|操作步骤|执行步骤)/iu.test(
          key,
        )
      ) {
        const meaningful = candidate.filter(
          (item) =>
            (typeof item === "string" && item.trim()) ||
            (isObject(item) && collectText(item).join("").trim()),
        ).length;
        best = Math.max(best, meaningful);
      }
      for (const item of candidate) visit(item, key);
      return;
    }
    if (isObject(candidate)) {
      for (const [childKey, item] of Object.entries(candidate))
        visit(item, childKey);
    }
  };
  visit(value);
  return best;
}

function scenesForPhase(contract, scenes, phase) {
  const refs = new Set(normalizedStrings(contract?.required?.[phase]));
  return (Array.isArray(scenes) ? scenes : []).filter((scene) =>
    refs.has(normalizedString(scene?.outlineId)),
  );
}

function courseCoverage(contract, scenes) {
  const demonstration = scenesForPhase(contract, scenes, "demonstration");
  const practice = scenesForPhase(contract, scenes, "learnerPractice");
  const assessment = scenesForPhase(contract, scenes, "assessment");
  const feedback = scenesForPhase(contract, scenes, "feedbackRetry");
  const transfer = scenesForPhase(contract, scenes, "transferApplication");
  const feedbackText = collectText(
    feedback.map((scene) => scene?.content),
  ).join(" ");
  const transferText = collectText(
    transfer.map((scene) => scene?.content),
  ).join(" ");
  const coverage = {
    explanation:
      demonstration.length > 0 &&
      collectText(demonstration.map((scene) => scene?.content)).join("")
        .length >= 40,
    stepwisePractice:
      practice.some((scene) => ["interactive", "pbl"].includes(scene?.type)) &&
      practice.some((scene) => executableStepCount(scene?.content) >= 2),
    quiz:
      assessment.some((scene) => scene?.type === "quiz") &&
      (Array.isArray(scenes) ? scenes : []).some(
        (scene) => scene?.type === "quiz",
      ),
    feedbackRetry:
      feedback.length > 0 &&
      /(?:反馈|重试|再试|纠错|提示|再练|retry|feedback|remediat)/iu.test(
        feedbackText,
      ),
    transfer:
      transfer.length > 0 &&
      /(?:迁移|新情境|变式|举一反三|真实任务|应用到|transfer|novel context)/iu.test(
        transferText,
      ),
  };
  return { ...coverage, complete: Object.values(coverage).every(Boolean) };
}

function projectHasSource(project) {
  const source = normalizedString(project?.provenance?.source);
  const hasUrl = (Array.isArray(project?.links) ? project.links : []).some(
    (link) => /^https:\/\//iu.test(normalizedString(link?.url)),
  );
  return Boolean(source && hasUrl);
}

function inspectPracticeProject(
  project,
  { allowedCourseIds, allowedJobIds, requireApproved = true },
) {
  const courseIds = normalizedStrings(project?.courseIds);
  const jobIds = normalizedStrings(project?.jobIds);
  const steps = normalizedStrings(project?.steps);
  const courseEdgesValid = Boolean(
    courseIds.length > 0 &&
    courseIds.every((courseId) => allowedCourseIds.has(courseId)),
  );
  const jobEdgesValid = allowedJobIds.size
    ? jobIds.length > 0 && jobIds.every((jobId) => allowedJobIds.has(jobId))
    : jobIds.length === 0;
  const result = {
    id: normalizedString(project?.id) || null,
    approved: project?.approved === true,
    source: projectHasSource(project),
    stepCount: steps.length,
    acceptance: Boolean(normalizedString(project?.acceptance)),
    deliverable: Boolean(normalizedString(project?.deliverable)),
    courseIds,
    jobIds,
    courseEdgesValid,
    jobEdgesValid,
  };
  return {
    ...result,
    accepted: Boolean(
      result.id &&
      (!requireApproved || result.approved) &&
      result.source &&
      result.stepCount >= 3 &&
      result.stepCount <= 6 &&
      result.acceptance &&
      result.deliverable &&
      result.courseEdgesValid &&
      result.jobEdgesValid,
    ),
  };
}

function matchingAiJobs(jobs) {
  return jobs.filter((job) => AI_JOB_TERMS.test(JSON.stringify(job)));
}

function assignmentSnapshot(rows) {
  return rows
    .map((row) => ({
      id: row?.id ?? null,
      courseId: row?.courseId ?? null,
      learnerAccountId: row?.learnerAccountId ?? null,
      assignedBy: row?.assignedBy ?? null,
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
}

function classifyJobState(domain, jobs, reason) {
  if (domain === "ai" && matchingAiJobs(jobs).length > 0) return "ready";
  if (domain !== "ai" && jobs.length > 0) return "ready";
  if (domain === "smart-manufacturing" && reason === HONEST_JOB_EMPTY)
    return "honest-empty";
  return "invalid-empty";
}

function progress(event) {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveAndReadProfile(report, base, sessions, scenario) {
  const actor = scenario.learner;
  const before = await request(base, sessions[actor], "/api/profile");
  const activeId = normalizedString(before.body?.activeId);
  const beforeFields = isObject(before.body?.fields)
    ? before.body.fields
    : null;
  let update = null;
  if (before.status === 200 && activeId) {
    update = await request(base, sessions[actor], "/api/profile", {
      method: "POST",
      json: {
        action: "update",
        id: activeId,
        fields: { ...(beforeFields ?? {}), ...scenario.profile },
      },
    });
  }
  const updatedFields = isObject(update?.body?.fields)
    ? update.body.fields
    : null;
  const saved = Boolean(
    update?.status === 200 &&
    profileMatchesDomain(updatedFields, scenario.domain) &&
    Object.entries(scenario.profile).every(
      ([key, value]) => updatedFields?.[key] === value,
    ),
  );
  addCheck(report, `profile.${scenario.key}.saved`, saved, {
    actor,
    domain: scenario.domain,
    expected: "现有 activeId 画像经 /api/profile update 保存目标领域完整字段",
    actual: saved
      ? {
          activeId,
          storedDomain: updatedFields.domain,
          storedCorpus: updatedFields.corpus,
        }
      : updatedFields
        ? {
            activeId: update?.body?.activeId ?? null,
            storedDomain: updatedFields.domain ?? null,
            storedCorpus: updatedFields.corpus ?? null,
          }
        : update
          ? summarizeHttp(update)
          : summarizeHttp(before),
  });
  if (saved) {
    report.operations.push({
      type: "update-profile",
      actor,
      activeId,
      domain: scenario.domain,
    });
  }

  const reread = await request(base, sessions[actor], "/api/profile");
  const rereadFields = isObject(reread.body?.fields)
    ? reread.body.fields
    : null;
  const rereadOk = Boolean(
    saved &&
    reread.status === 200 &&
    reread.body?.activeId === activeId &&
    profileMatchesDomain(rereadFields, scenario.domain) &&
    Object.entries(scenario.profile).every(
      ([key, value]) => rereadFields?.[key] === value,
    ),
  );
  addCheck(report, `profile.${scenario.key}.reread`, rereadOk, {
    actor,
    domain: scenario.domain,
    expected: "再次 GET /api/profile 复读到刚保存的同一画像",
    actual: rereadFields
      ? {
          activeId: reread.body?.activeId ?? null,
          storedDomain: rereadFields.domain ?? null,
          storedCorpus: rereadFields.corpus ?? null,
        }
      : summarizeHttp(reread),
  });
  return rereadOk ? { ...rereadFields } : null;
}

async function generateCourse(
  report,
  base,
  sessions,
  scenario,
  learnerProfile,
) {
  const actor = scenario.manager;
  if (!profileMatchesDomain(learnerProfile, scenario.domain)) {
    addCheck(report, `generate.${scenario.key}.accepted`, false, {
      actor,
      domain: scenario.domain,
      expected: "先复读到目标领域的服务端画像，再创建课程",
      actual: "profile-reread-failed",
    });
    addSkipped(
      report,
      `generate.${scenario.key}.completed`,
      "服务端画像未通过复读",
      { actor, domain: scenario.domain },
    );
    return null;
  }
  const create = await request(
    base,
    sessions[actor],
    "/api/generate-classroom",
    {
      method: "POST",
      json: {
        requirement: scenario.requirement,
        learnerProfile,
        enableWebSearch: false,
        enableImageGeneration: false,
        enableVideoGeneration: false,
        enableTTS: false,
        agentMode: "default",
      },
    },
  );
  const jobId =
    typeof create.body?.jobId === "string" ? create.body.jobId : null;
  if (
    !addCheck(
      report,
      `generate.${scenario.key}.accepted`,
      create.status === 202 && jobId,
      {
        actor,
        domain: scenario.domain,
        expected: "HTTP 202 + jobId",
        actual: jobId
          ? { status: create.status, jobId }
          : summarizeHttp(create),
      },
    )
  ) {
    addSkipped(report, `generate.${scenario.key}.completed`, "生成任务未创建", {
      actor,
      domain: scenario.domain,
    });
    return null;
  }

  report.operations.push({
    type: "generate-course",
    actor,
    domain: scenario.domain,
    jobId,
  });
  const started = Date.now();
  let lastProgress = "";
  while (Date.now() - started < GENERATION_TIMEOUT_MS) {
    const poll = await request(
      base,
      sessions[actor],
      `/api/generate-classroom/${encodeURIComponent(jobId)}`,
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (poll.status !== 200) {
      addCheck(report, `generate.${scenario.key}.completed`, false, {
        actor,
        domain: scenario.domain,
        expected: "任务轮询 HTTP 200 并成功完成",
        actual: summarizeHttp(poll),
      });
      return null;
    }
    const state = `${poll.body?.status ?? "unknown"}:${poll.body?.step ?? "unknown"}:${poll.body?.progress ?? ""}`;
    if (state !== lastProgress) {
      progress({
        event: "generation-progress",
        actor,
        domain: scenario.domain,
        jobId,
        status: poll.body?.status,
        step: poll.body?.step,
        progress: poll.body?.progress,
      });
      lastProgress = state;
    }
    if (poll.body?.status === "succeeded") {
      const courseId =
        poll.body?.classroomId ??
        poll.body?.result?.classroomId ??
        poll.body?.result?.id ??
        null;
      addCheck(
        report,
        `generate.${scenario.key}.completed`,
        typeof courseId === "string",
        {
          actor,
          domain: scenario.domain,
          expected: "succeeded + classroomId",
          actual: {
            status: poll.body?.status,
            courseId,
            durationMs: Date.now() - started,
          },
        },
      );
      return typeof courseId === "string" ? courseId : null;
    }
    if (poll.body?.status === "failed" || poll.body?.done === true) {
      addCheck(report, `generate.${scenario.key}.completed`, false, {
        actor,
        domain: scenario.domain,
        expected: "succeeded",
        actual: {
          status: poll.body?.status,
          error: poll.body?.error ?? poll.body?.message ?? "任务提前结束",
        },
      });
      return null;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  addCheck(report, `generate.${scenario.key}.completed`, false, {
    actor,
    domain: scenario.domain,
    expected: `在 ${GENERATION_TIMEOUT_MS}ms 内完成`,
    actual: "timeout",
  });
  return null;
}

async function assignCourse(
  report,
  base,
  sessions,
  accounts,
  scenario,
  courseId,
) {
  const learnerAccountId = accounts[scenario.learner]?.id;
  const response = await request(
    base,
    sessions[scenario.manager],
    "/api/org/assignments",
    {
      method: "POST",
      json: { learnerAccountId, courseId },
    },
  );
  const assignment = responseObject(response, "assignment");
  const ok =
    response.status === 200 &&
    assignment?.courseId === courseId &&
    assignment?.learnerAccountId === learnerAccountId &&
    assignment?.domain === scenario.domain;
  addCheck(report, `assign.${scenario.key}.created`, ok, {
    actor: scenario.manager,
    learner: scenario.learner,
    domain: scenario.domain,
    expected: { courseId, learnerAccountId, domain: scenario.domain },
    actual: ok
      ? {
          id: assignment.id,
          courseId,
          learnerAccountId,
          domain: assignment.domain,
        }
      : summarizeHttp(response),
  });
  if (ok) {
    report.operations.push({
      type: "assign-course",
      actor: scenario.manager,
      learner: scenario.learner,
      courseId,
      learnerAccountId,
    });
  }
  return ok;
}

async function generatePracticeProjects(
  report,
  base,
  sessions,
  scenario,
  courseId,
) {
  const actor = scenario.manager;
  const response = await request(
    base,
    sessions[actor],
    `/api/practice-scout/${encodeURIComponent(scenario.domain)}/draft`,
    {
      method: "POST",
      json: { count: 6 },
      timeoutMs: PRACTICE_DRAFT_TIMEOUT_MS,
    },
  );
  const draft = responseObject(response, "draft");
  const projects = Array.isArray(draft?.projects) ? draft.projects : [];
  const allowedCourseIds = new Set(
    Array.isArray(draft?.course_candidates)
      ? draft.course_candidates
          .map((item) => normalizedString(item?.id))
          .filter(Boolean)
      : [],
  );
  const allowedJobIds = new Set(
    Array.isArray(draft?.job_candidates)
      ? draft.job_candidates
          .map((item) => normalizedString(item?.id))
          .filter(Boolean)
      : [],
  );
  const projectChecks = projects.map((project) =>
    inspectPracticeProject(project, {
      allowedCourseIds,
      allowedJobIds,
      requireApproved: false,
    }),
  );
  const projectIds = projectChecks.map((project) => project.id).filter(Boolean);
  const drafted = Boolean(
    response.status === 200 &&
    draft?.version === 3 &&
    draft?.corpus === scenario.domain &&
    /^sha256:[0-9a-f]{64}$/.test(normalizedString(draft?.snapshot_id)) &&
    allowedCourseIds.has(courseId) &&
    projectIds.length > 0 &&
    new Set(projectIds).size === projectIds.length &&
    projectChecks.every((project) => project.accepted) &&
    projectChecks.some((project) => project.courseIds.includes(courseId)),
  );
  addCheck(report, `practice.${scenario.key}.drafted`, drafted, {
    actor,
    domain: scenario.domain,
    expected:
      "v3 不可变初稿逐项满足真实来源、3–6 步、验收/交付物及当前域课程/岗位候选边，并至少一项关联新课",
    actual: draft
      ? {
          version: draft.version ?? null,
          corpus: draft.corpus ?? null,
          projectCount: projects.length,
          currentCourseCandidate: allowedCourseIds.has(courseId),
          currentCourseLinked: projectChecks.some((project) =>
            project.courseIds.includes(courseId),
          ),
          projects: projectChecks,
        }
      : summarizeHttp(response),
  });
  if (!drafted) {
    addSkipped(
      report,
      `practice.${scenario.key}.published`,
      "实操初稿未通过与发布端相同的结构门禁",
      { actor, domain: scenario.domain },
    );
    addSkipped(
      report,
      `practice.${scenario.key}.restored`,
      "实操初稿未通过，未创建可恢复发布版本",
      { actor, domain: scenario.domain },
    );
    return false;
  }
  report.operations.push({
    type: "draft-practice-projects",
    actor,
    domain: scenario.domain,
    projectIds,
  });

  const approve = await request(
    base,
    sessions[actor],
    `/api/practice-scout/${encodeURIComponent(scenario.domain)}/approve`,
    {
      method: "POST",
      json: { projectIds, draftSnapshotId: draft.snapshot_id },
    },
  );
  const publication = responseObject(approve, "publication");
  const release = publication?.release;
  const publishedIds = Array.isArray(release?.projects)
    ? release.projects
        .filter((project) => project?.approved === true)
        .map((project) => normalizedString(project?.id))
        .filter(Boolean)
        .sort()
    : [];
  const expectedIds = [...projectIds].sort();
  const published = Boolean(
    approve.status === 200 &&
    Number.isInteger(publication?.current_version) &&
    publication.current_version > 0 &&
    release?.version === publication.current_version &&
    release?.status === "published" &&
    /^sha256:[0-9a-f]{64}$/.test(normalizedString(release?.snapshot_id)) &&
    JSON.stringify(publishedIds) === JSON.stringify(expectedIds),
  );
  addCheck(report, `practice.${scenario.key}.published`, published, {
    actor,
    domain: scenario.domain,
    expected: { status: "published", projectIds: expectedIds },
    actual: release
      ? {
          status: release.status ?? null,
          version: release.version ?? null,
          snapshotId: release.snapshot_id ?? null,
          projectIds: publishedIds,
        }
      : summarizeHttp(approve),
  });
  if (published) {
    report.operations.push({
      type: "publish-practice-projects",
      actor,
      domain: scenario.domain,
      projectIds: expectedIds,
    });
  } else {
    addSkipped(
      report,
      `practice.${scenario.key}.restored`,
      "实操发布未通过，无法验证版本恢复",
      { actor, domain: scenario.domain },
    );
    return false;
  }

  const sourceVersion = publication.current_version;
  const historyBefore = await request(
    base,
    sessions[actor],
    `/api/practice-scout/${encodeURIComponent(scenario.domain)}/releases`,
  );
  const beforePublication = responseObject(historyBefore, "publication");
  const restore = await request(
    base,
    sessions[actor],
    `/api/practice-scout/${encodeURIComponent(scenario.domain)}/restore`,
    { method: "POST", json: { version: sourceVersion } },
  );
  const restoredPublication = responseObject(restore, "publication");
  const restoredRelease = restoredPublication?.release;
  const restoredIds = Array.isArray(restoredRelease?.projects)
    ? restoredRelease.projects
        .filter((project) => project?.approved === true)
        .map((project) => normalizedString(project?.id))
        .filter(Boolean)
        .sort()
    : [];
  const restored = Boolean(
    historyBefore.status === 200 &&
    beforePublication?.current_version === sourceVersion &&
    Array.isArray(beforePublication?.versions) &&
    beforePublication.versions.some(
      (item) => item?.version === sourceVersion,
    ) &&
    restore.status === 200 &&
    restoredPublication?.current_version === sourceVersion + 1 &&
    restoredRelease?.version === sourceVersion + 1 &&
    restoredRelease?.restored_from_version === sourceVersion &&
    restoredRelease?.snapshot_id === release.snapshot_id &&
    JSON.stringify(restoredIds) === JSON.stringify(expectedIds),
  );
  addCheck(report, `practice.${scenario.key}.restored`, restored, {
    actor,
    domain: scenario.domain,
    expected: { restoredFromVersion: sourceVersion, projectIds: expectedIds },
    actual: restoredRelease
      ? {
          version: restoredRelease.version ?? null,
          restoredFromVersion: restoredRelease.restored_from_version ?? null,
          snapshotId: restoredRelease.snapshot_id ?? null,
          projectIds: restoredIds,
        }
      : summarizeHttp(restore),
  });
  if (restored) {
    report.operations.push({
      type: "restore-practice-release",
      actor,
      domain: scenario.domain,
      sourceVersion,
      newVersion: restoredRelease.version,
    });
  }
  return restored;
}

async function validateForbiddenAssignment(
  report,
  base,
  sessions,
  accounts,
  { label, manager, target, courseId },
) {
  const before = await request(base, sessions[manager], "/api/org/assignments");
  const beforeRows = responseArray(before, "assignments");
  const learnerAccountId = accounts[target]?.id;
  const attempt = await request(
    base,
    sessions[manager],
    "/api/org/assignments",
    {
      method: "POST",
      json: { learnerAccountId, courseId },
    },
  );
  report.operations.push({
    type: "probe-forbidden-assignment",
    actor: manager,
    learner: target,
    courseId,
    status: attempt.status,
  });
  const rejected = [400, 403].includes(attempt.status);
  addCheck(report, `negative-assignment.${label}.rejected`, rejected, {
    actor: manager,
    learner: target,
    expected: "跨机构 learnerAccountId 指派返回 HTTP 400/403",
    actual: summarizeHttp(attempt),
  });

  const after = await request(base, sessions[manager], "/api/org/assignments");
  const afterRows = responseArray(after, "assignments");
  const unchanged = Boolean(
    before.status === 200 &&
    after.status === 200 &&
    JSON.stringify(assignmentSnapshot(beforeRows)) ===
      JSON.stringify(assignmentSnapshot(afterRows)) &&
    !afterRows.some(
      (row) =>
        row?.courseId === courseId &&
        row?.learnerAccountId === learnerAccountId,
    ),
  );
  addCheck(report, `negative-assignment.${label}.unchanged`, unchanged, {
    actor: manager,
    learner: target,
    expected: "拒绝前后机构指派列表完全一致，且目标学员无新增记录",
    actual: {
      beforeStatus: before.status,
      afterStatus: after.status,
      beforeCount: beforeRows.length,
      afterCount: afterRows.length,
      targetedRowPresent: afterRows.some(
        (row) =>
          row?.courseId === courseId &&
          row?.learnerAccountId === learnerAccountId,
      ),
    },
  });
}

async function validateScenario(
  report,
  base,
  sessions,
  accounts,
  shared,
  scenario,
  generatedId,
) {
  const managerAssignments = responseArray(
    shared.assignments[scenario.manager],
    "assignments",
  );
  const learnerAssignments = responseArray(
    shared.assignments[scenario.learner],
    "assignments",
  );
  const domains = shared.courseDomains[scenario.learner]?.body;
  const courseDomains = isObject(domains) ? domains : {};
  const learnerAccountId = accounts[scenario.learner].id;

  const courseId = selectScenarioCourseId(
    report.mode,
    generatedId,
    learnerAssignments,
    courseDomains,
    scenario.domain,
  );

  addCheck(
    report,
    `assignment.${scenario.key}.course-selected`,
    typeof courseId === "string",
    {
      actor: scenario.learner,
      domain: scenario.domain,
      expected: "存在该领域的定向指派课程",
      actual: {
        assignedCourseIds: learnerAssignments
          .map((item) => item?.courseId)
          .filter(Boolean),
      },
    },
  );

  if (!courseId) {
    const existing = new Set(report.checks.map((check) => check.id));
    for (const id of scenarioRequiredCheckIds(scenario.key)) {
      if (
        id !== `report.${scenario.key}.domain-alignment` &&
        !existing.has(id)
      ) {
        addSkipped(report, id, "找不到该领域的定向指派课程", {
          actor: scenario.learner,
          domain: scenario.domain,
        });
      }
    }
    return {
      scenario,
      courseId: null,
      pathConcepts: [],
      diagnosisConcepts: [],
      structuralOk: false,
    };
  }

  const managerAssignment = managerAssignments.find(
    (item) =>
      item?.courseId === courseId &&
      item?.learnerAccountId === learnerAccountId,
  );
  const learnerAssignment = learnerAssignments.find(
    (item) => item?.courseId === courseId,
  );
  const effectiveDomain = entryDomain(courseDomains[courseId]);
  addCheck(
    report,
    `assignment.${scenario.key}.target`,
    Boolean(
      managerAssignment &&
      learnerAssignment?.learnerAccountId === learnerAccountId &&
      learnerAssignment?.learnerDisplayName,
    ),
    {
      actor: scenario.manager,
      learner: scenario.learner,
      domain: scenario.domain,
      expected: { courseId, learnerAccountId, learnerDisplayName: "非空" },
      actual: managerAssignment ?? learnerAssignment ?? null,
    },
  );
  addCheck(
    report,
    `assignment.${scenario.key}.learner-scope`,
    learnerAssignments.every(
      (item) =>
        item?.learnerAccountId === learnerAccountId &&
        assignmentDomain(item, courseDomains) === scenario.domain,
    ),
    {
      actor: scenario.learner,
      expected: `所有返回指派 learnerAccountId=${learnerAccountId}，且 assignment.domain 与课程域都明确等于 ${scenario.domain}`,
      actual: learnerAssignments.map((item) => ({
        learnerAccountId: item?.learnerAccountId ?? null,
        assignmentDomain: item?.domain ?? null,
        mappedDomain: entryDomain(courseDomains[item?.courseId]),
      })),
    },
  );
  addCheck(
    report,
    `assignment.${scenario.key}.effective-domain`,
    effectiveDomain === scenario.domain &&
      managerAssignment?.domain === scenario.domain &&
      learnerAssignment?.domain === scenario.domain,
    {
      actor: scenario.learner,
      expected: scenario.domain,
      actual: {
        courseDomain: effectiveDomain,
        managerAssignmentDomain: managerAssignment?.domain ?? null,
        learnerAssignmentDomain: learnerAssignment?.domain ?? null,
      },
      detail: "按这门具体指派课程核对学习端领域，不以公共域可见性代替",
    },
  );

  const [
    managerCourse,
    learnerCourse,
    path,
    practice,
    jobs,
    profile,
    reportPage,
  ] = await Promise.all([
    request(
      base,
      sessions[scenario.manager],
      `/api/classroom?id=${encodeURIComponent(courseId)}`,
    ),
    request(
      base,
      sessions[scenario.learner],
      `/api/classroom?id=${encodeURIComponent(courseId)}`,
    ),
    request(
      base,
      sessions[scenario.learner],
      `/api/domain-path/${encodeURIComponent(scenario.domain)}`,
    ),
    request(
      base,
      sessions[scenario.learner],
      `/api/practice-scout/${encodeURIComponent(scenario.domain)}`,
    ),
    request(
      base,
      sessions[scenario.learner],
      `/api/skills?domain=${encodeURIComponent(scenario.domain)}`,
    ),
    request(base, sessions[scenario.learner], "/api/profile"),
    request(
      base,
      sessions[scenario.learner],
      `/report?stageId=${encodeURIComponent(courseId)}`,
    ),
  ]);

  const classroom = responseObject(learnerCourse, "classroom");
  const managerClassroom = responseObject(managerCourse, "classroom");
  const title = classroom?.stage?.name;
  const scenes = Array.isArray(classroom?.scenes) ? classroom.scenes : [];
  const sceneTypes = scenes.map((scene) => scene?.type).filter(Boolean);
  const classroomList = responseArray(
    shared.classrooms[scenario.learner],
    "classrooms",
  );
  const courseOk = Boolean(
    managerCourse.status === 200 &&
    learnerCourse.status === 200 &&
    managerClassroom &&
    classroom &&
    !classroom.generating &&
    scenes.length > 0 &&
    classroomList.some((item) => item?.id === courseId) &&
    entryDomain(courseDomains[courseId]) === scenario.domain,
  );
  addCheck(report, `course.${scenario.key}.acceptance`, courseOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected: "管理者/学员可读、生成已结束、有场景、课程墙与具体课程域一致",
    actual: {
      managerStatus: managerCourse.status,
      learnerStatus: learnerCourse.status,
      listed: classroomList.some((item) => item?.id === courseId),
      courseDomain: entryDomain(courseDomains[courseId]),
      generating: Boolean(classroom?.generating),
      sceneCount: scenes.length,
      sceneTypes,
    },
  });

  const courseAudit = classroom?.stage?.courseAudit;
  const courseAuditValidation = validateCourseAudit(courseAudit, scenes);
  const failedSceneAudits = scenes.flatMap((scene, index) =>
    auditPassed(scene?.audit)
      ? []
      : [normalizedString(scene?.id) || `scene-${index + 1}`],
  );
  const courseAuditOk = Boolean(
    courseAuditValidation.ok && failedSceneAudits.length === 0,
  );
  addCheck(report, `course.${scenario.key}.audit`, courseAuditOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected:
      "courseAudit=pass/publish、panelComplete=true、courseContentHash 与最终场景规范化哈希一致，且每个场景审核均 pass/publish",
    actual: {
      courseVerdict: courseAudit?.verdict ?? null,
      courseDecision: courseAudit?.decision ?? null,
      panelComplete: courseAuditValidation.panelComplete,
      storedCourseContentHash: courseAuditValidation.storedHash,
      recomputedCourseContentHash: courseAuditValidation.recomputedHash,
      hashFormatValid: courseAuditValidation.hashFormatValid,
      hashMatches: courseAuditValidation.hashMatches,
      sceneAuditCount: scenes.length,
      failedSceneAudits,
    },
  });

  const learningContract = classroom?.stage?.learningContract;
  const fulfillment = validateLearningContractFulfillment(
    learningContract,
    scenes,
  );
  addCheck(
    report,
    `course.${scenario.key}.learning-contract`,
    fulfillment.fulfilled,
    {
      actor: scenario.learner,
      domain: scenario.domain,
      expected:
        "新生成课程必须使用 learningContract v2；teachingStrategy 与策略证据有效，计划场景、活动内容及六个必需阶段全部履约",
      actual: {
        version: learningContract?.version ?? null,
        plannedScenes: Array.isArray(learningContract?.plannedScenes)
          ? learningContract.plannedScenes.length
          : 0,
        violations: fulfillment.violations,
      },
    },
  );

  const coverage = courseCoverage(learningContract, scenes);
  addCheck(report, `course.${scenario.key}.coverage`, coverage.complete, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected: "成品实际覆盖讲解、分步实操、测验、反馈重试与迁移任务",
    actual: coverage,
  });

  const pathBody = responseObject(path, "path");
  const concepts = pathConcepts(pathBody);
  const pathStageCount = Array.isArray(pathBody?.stages)
    ? pathBody.stages.length
    : 0;
  const pathSource = pathBody?.source ?? null;
  const deepLearningCovered =
    scenario.domain !== "ai" ||
    concepts.some((concept) =>
      ["deeplearning", "深度学习"].includes(normalizeConcept(concept)),
    );
  const pathOk = Boolean(
    path.status === 200 &&
    pathBody &&
    pathBody.corpus === scenario.domain &&
    PATH_SOURCES.has(pathBody.source) &&
    pathStageCount > 0 &&
    concepts.length > 0 &&
    deepLearningCovered,
  );
  addCheck(report, `path.${scenario.key}.acceptance`, pathOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected:
      "本域路径仅来自引擎 index-graph/intake/index-tags 产物，有阶段、有概念且不回退手工或其它领域路径；AI 主域必须覆盖深度学习",
    actual: pathBody
      ? {
          status: path.status,
          corpus: pathBody.corpus,
          source: pathBody.source,
          stageCount: pathStageCount,
          conceptCount: concepts.length,
          deepLearningCovered,
          reason: pathBody.reason,
        }
      : summarizeHttp(path),
  });
  const pathProvenanceOk = Boolean(
    pathBody &&
    isValidGeneratedAt(pathBody.generated_at) &&
    (normalizedString(pathBody.run_id) ||
      /^sha256:[0-9a-f]{16}$/u.test(normalizedString(pathBody.artifact_id))),
  );
  addCheck(report, `path.${scenario.key}.provenance`, pathProvenanceOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected: "路径带可解析 generated_at，以及接入 run_id 或根引擎产物哈希",
    actual: pathBody
      ? {
          generatedAt: pathBody.generated_at ?? null,
          runId: pathBody.run_id ?? null,
          artifactId: pathBody.artifact_id ?? null,
          source: pathBody.source ?? null,
        }
      : summarizeHttp(path),
  });

  const jobRows = responseArray(jobs, "jobs");
  const jobReason =
    typeof jobs.body?.reason === "string" ? jobs.body.reason : "";
  const jobState =
    jobs.status === 200
      ? classifyJobState(scenario.domain, jobRows, jobReason)
      : "error";
  const allowedCourseIds = new Set(
    classroomList
      .map((item) => normalizedString(item?.id))
      .filter(
        (candidate) =>
          candidate &&
          entryDomain(courseDomains[candidate]) === scenario.domain,
      ),
  );
  const allowedJobIds = new Set(
    jobRows
      .map((job) => normalizedString(job?.job_id ?? job?.id))
      .filter(Boolean),
  );
  const projects = responseArray(practice, "projects");
  const projectChecks = projects.map((project) =>
    inspectPracticeProject(project, { allowedCourseIds, allowedJobIds }),
  );
  const practiceOk = Boolean(
    practice.status === 200 &&
    practice.body?.corpus === scenario.domain &&
    practice.body?.status === "ready" &&
    projects.length > 0 &&
    projectChecks.every((project) => project.accepted) &&
    projectChecks.some((project) => project.courseIds.includes(courseId)),
  );
  addCheck(report, `practice.${scenario.key}.acceptance`, practiceOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected:
      "目标 corpus 的已发布项目逐项含真实来源、3–6 步、验收/交付物与有效课程/岗位边，且至少一项关联当前指派课",
    actual:
      practice.status === 200
        ? {
            corpus: practice.body?.corpus ?? null,
            status: practice.body?.status,
            projectCount: projects.length,
            projects: projectChecks,
            reason: practice.body?.reason,
          }
        : summarizeHttp(practice),
  });
  const aiJobMatches = matchingAiJobs(jobRows);
  const jobsOk = Boolean(
    jobs.status === 200 &&
    (scenario.domain === "ai"
      ? jobState === "ready" && aiJobMatches.length > 0
      : ["ready", "honest-empty"].includes(jobState)),
  );
  addCheck(report, `jobs.${scenario.key}.acceptance`, jobsOk, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected:
      scenario.domain === "smart-manufacturing"
        ? `岗位有数据，或空数组并原样返回「${HONEST_JOB_EMPTY}」`
        : "AI 岗位至少一条命中 agent/RAG/智能体/检索增强等本域词",
    actual:
      jobs.status === 200
        ? {
            state: jobState,
            jobCount: jobRows.length,
            matchingAiJobs: aiJobMatches.map(
              (job) => job?.job_id ?? job?.title ?? null,
            ),
            reason: jobReason || null,
          }
        : summarizeHttp(jobs),
  });

  const fields = isObject(profile.body?.fields) ? profile.body.fields : null;
  addCheck(
    report,
    `report.${scenario.key}.profile`,
    profile.status === 200 && profileMatchesDomain(fields, scenario.domain),
    {
      actor: scenario.learner,
      domain: scenario.domain,
      expected: "服务端复读画像的 domain/corpus 均为该学习者目标领域",
      actual: fields
        ? {
            activeId: profile.body?.activeId ?? null,
            storedDomain: fields.domain ?? null,
            storedCorpus: fields.corpus ?? null,
          }
        : summarizeHttp(profile),
    },
  );
  const reportPageEvidence = inspectReportPage(reportPage, {
    courseId,
    title,
    domain: scenario.domain,
    fields,
    effectiveDomain,
    classroom,
    assignment: learnerAssignment,
    learnerAccountId,
  });
  addCheck(report, `report.${scenario.key}.page`, reportPageEvidence.accepted, {
    actor: scenario.learner,
    domain: scenario.domain,
    expected:
      "登录学员的报告页契约成立，画像/指派/课程 ID 与目标领域一致；页面明确非拒绝，若 SSR 携带课程标题或 ID 则同时核对",
    actual: {
      status: reportPageEvidence.page.status,
      contentType: reportPageEvidence.page.contentType,
      missingMarkers: reportPageEvidence.page.missingMarkers,
      rejection: reportPageEvidence.page.rejection,
      targetMentioned: reportPageEvidence.targetMentioned,
      explicitNonRejection: reportPageEvidence.explicitNonRejection,
      courseId,
      courseTitle: title ?? null,
      returnedCourseId: reportPageEvidence.returnedCourseId,
      effectiveDomain,
      storedDomain: fields?.domain ?? null,
      storedCorpus: fields?.corpus ?? null,
      assignmentMatches: reportPageEvidence.assignmentMatches,
    },
  });

  let blueprint = null;
  let diagnosisConcepts = [];
  let structuralOk = false;
  if (fields && typeof title === "string" && title.trim()) {
    const blueprintResponse = await request(
      base,
      sessions[scenario.learner],
      "/api/adaptive/blueprint",
      {
        method: "POST",
        json: buildBlueprintPayload(title, fields),
        timeoutMs: BLUEPRINT_TIMEOUT_MS,
      },
    );
    blueprint = responseObject(blueprintResponse, "blueprint");
    const gaps = Array.isArray(blueprint?.blueprint?.skill_gaps)
      ? blueprint.blueprint.skill_gaps
          .map((gap) => gap?.concept)
          .filter(Boolean)
      : [];
    const weak = Array.isArray(blueprint?.weak_concepts)
      ? blueprint.weak_concepts
      : [];
    diagnosisConcepts = [...new Set([...gaps, ...weak])];
    structuralOk = Boolean(
      blueprintResponse.status === 200 &&
      blueprint &&
      Object.keys(blueprint.mastery_vector ?? {}).length > 0 &&
      typeof blueprint.recommended_difficulty === "string" &&
      blueprint.recommended_difficulty &&
      typeof blueprint.diagnosis_summary === "string" &&
      blueprint.diagnosis_summary.trim() &&
      blueprint.blueprint &&
      Array.isArray(blueprint.blueprint.skill_gaps),
    );
    addCheck(report, `report.${scenario.key}.acceptance`, structuralOk, {
      actor: scenario.learner,
      domain: scenario.domain,
      expected: "掌握度、难度、诊断摘要与技能缺口均由学情引擎返回",
      actual: blueprint
        ? {
            engine: blueprint.engine ?? null,
            masteryCount: Object.keys(blueprint.mastery_vector ?? {}).length,
            weakConceptCount: weak.length,
            skillGapCount: gaps.length,
            recommendedDifficulty: blueprint.recommended_difficulty ?? null,
          }
        : summarizeHttp(blueprintResponse),
    });
  } else {
    addSkipped(
      report,
      `report.${scenario.key}.acceptance`,
      "缺少画像或课程标题，未调用学情引擎",
      {
        actor: scenario.learner,
        domain: scenario.domain,
      },
    );
  }

  report.courses[scenario.key] = {
    courseId,
    domain: scenario.domain,
    title: typeof title === "string" ? title : null,
    learner: scenario.learner,
    learnerAccountId,
    sceneCount: scenes.length,
    courseContentHash: courseAuditValidation.storedHash,
    courseContentHashMatches: courseAuditValidation.hashMatches,
    learningContractFulfilled: fulfillment.fulfilled,
    coverage,
    pathStages: pathStageCount,
    pathSource,
    pathConcepts: concepts.length,
    practiceProjects: projects.length,
    jobs: jobRows.length,
    jobState,
    blueprintEngine: blueprint?.engine ?? null,
  };
  return {
    scenario,
    courseId,
    pathConcepts: concepts,
    diagnosisConcepts,
    structuralOk,
  };
}

async function validateCourseMatrix(
  report,
  base,
  sessions,
  shared,
  scenario,
  courseId,
) {
  if (!courseId) {
    for (const actor of Object.keys(ACTORS)) {
      addSkipped(
        report,
        `matrix.${scenario.key}.${actor}`,
        "没有可验收的具体课程 ID",
        { actor, domain: scenario.domain },
      );
    }
    addSkipped(
      report,
      `matrix.${scenario.key}.acceptance`,
      "没有可验收的具体课程 ID",
      { domain: scenario.domain },
    );
    return;
  }

  const allowed = new Set([scenario.manager, scenario.learner]);
  const outcomes = await Promise.all(
    Object.keys(ACTORS).map(async (actor) => {
      const course = await request(
        base,
        sessions[actor],
        `/api/classroom?id=${encodeURIComponent(courseId)}`,
      );
      const classrooms = responseArray(shared.classrooms[actor], "classrooms");
      const assignments = responseArray(
        shared.assignments[actor],
        "assignments",
      );
      const domains = isObject(shared.courseDomains[actor]?.body)
        ? shared.courseDomains[actor].body
        : {};
      const shouldRead = allowed.has(actor);
      const ok = shouldRead
        ? course.status === 200 &&
          Boolean(responseObject(course, "classroom")) &&
          classrooms.some((item) => item?.id === courseId)
        : course.status === 404 &&
          !classrooms.some((item) => item?.id === courseId) &&
          !assignments.some((item) => item?.courseId === courseId) &&
          !(courseId in domains);
      addCheck(report, `matrix.${scenario.key}.${actor}`, ok, {
        actor,
        domain: scenario.domain,
        expected: shouldRead
          ? "这门具体课程 HTTP 200 且出现在课程墙"
          : "这门具体课程 HTTP 404，且不出现在课程墙/指派/课程域清单",
        actual: {
          courseStatus: course.status,
          inClassroomList: classrooms.some((item) => item?.id === courseId),
          inAssignments: assignments.some(
            (item) => item?.courseId === courseId,
          ),
          inCourseDomains: courseId in domains,
        },
      });
      return [actor, ok];
    }),
  );
  addCheck(
    report,
    `matrix.${scenario.key}.acceptance`,
    outcomes.every(([, ok]) => ok),
    {
      domain: scenario.domain,
      courseId,
      expected:
        scenario.key === "ai"
          ? "A/B 可读 AI 具体课程；C/D 即使可见公共 AI 域也必须 404"
          : "C/D 可读智能制造具体课程；A/B 必须 404",
      actual: Object.fromEntries(outcomes),
    },
  );
}

function validateReportDomainAlignment(report, scenarioResults) {
  for (const current of scenarioResults) {
    const key = current?.scenario?.key;
    if (!key) continue;
    const other = scenarioResults.find(
      (candidate) => candidate?.scenario?.key !== key,
    );
    if (
      !current.structuralOk ||
      current.pathConcepts.length === 0 ||
      current.diagnosisConcepts.length === 0 ||
      !other
    ) {
      addSkipped(
        report,
        `report.${key}.domain-alignment`,
        "学情或两域路径概念不完整，无法做跨域泄漏验收",
        { actor: current.scenario.learner, domain: current.scenario.domain },
      );
      continue;
    }
    const ownOverlap = conceptsOverlap(
      current.diagnosisConcepts,
      current.pathConcepts,
    );
    const otherOnlyConcepts = other.pathConcepts.filter(
      (concept) =>
        conceptsOverlap([concept], current.pathConcepts).length === 0,
    );
    const pathLeakage = conceptsOverlap(
      current.diagnosisConcepts,
      otherOnlyConcepts,
    );
    const explicitLeakage = current.diagnosisConcepts.filter((concept) => {
      if (key === "ai") return SMART_ONLY_TERMS.test(String(concept));
      const raw = String(concept);
      return (
        AI_ONLY_CONCEPTS.has(raw.toLowerCase()) ||
        AI_JOB_TERMS.test(raw) ||
        /(?:prompt|embedding|transformer|工具调用)/iu.test(raw)
      );
    });
    const leakage = [...new Set([...pathLeakage, ...explicitLeakage])];
    addCheck(
      report,
      `report.${key}.domain-alignment`,
      ownOverlap.length > 0 && leakage.length === 0,
      {
        actor: current.scenario.learner,
        domain: current.scenario.domain,
        expected: "学情概念命中本域全景路径，且不泄漏另一域专属概念",
        actual: {
          diagnosisConcepts: current.diagnosisConcepts,
          ownPathConceptCount: current.pathConcepts.length,
          ownOverlap,
          otherDomain: other.scenario.domain,
          leakage,
        },
      },
    );
  }
}

function finalize(report) {
  report.finishedAt = new Date().toISOString();
  report.durationMs =
    Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  report.checkContract = buildCheckContract(report.checks, report.mode);
  report.boundaryContract = buildBoundaryContract(report.boundaries);
  const failed = report.checks.filter((check) => !check.ok).length;
  report.summary = {
    total: report.checks.length,
    passed: report.checks.length - failed,
    failed,
    skipped: report.checks.filter((check) => check.skipped).length,
  };
  report.ok =
    failed === 0 &&
    report.checkContract.ok &&
    report.boundaryContract.ok &&
    !report.fatalError;
  return report;
}

async function run(options) {
  const report = {
    schemaVersion: 2,
    command: "production-dual-org-e2e",
    runId: randomUUID(),
    mode: options.generate ? "generate" : "read-only",
    base: options.base,
    startedAt: new Date().toISOString(),
    safety: {
      allowedAccounts: Object.values(ACTORS).map((actor) => actor.username),
      businessDataWrites: options.generate
        ? [
            "B/D 更新现有 activeId 画像并复读",
            "A/C 生成课程",
            "A→B 与 C→D 定向指派",
            "A→D 与 C→B 跨机构拒绝探针",
            "临时文档/证据 session 与同名概念字段验收后精确回收",
          ]
        : [],
      forbiddenWrites: [
        "创建账号",
        "修改 A/C 或非 activeId 画像",
        "修改密码",
        "修改知识库归属",
        "删除课程",
        "撤回指派",
      ],
    },
    actors: {},
    courses: {},
    generatedCourses: {},
    operations: [],
    probes: {},
    boundaries: [],
    checks: [],
  };

  const password = process.env.JIZHI_DEMO_PASSWORD;
  addCheck(report, "cli.password", Boolean(password), {
    expected: "环境变量 JIZHI_DEMO_PASSWORD 已设置",
    actual: password ? "set" : "missing",
  });
  if (!password) {
    return finalize(report);
  }

  const loginEntries = await Promise.all(
    Object.entries(ACTORS).map(async ([key, spec]) => [
      key,
      await login(options.base, spec, password),
    ]),
  );
  const sessions = {};
  const accounts = {};
  for (const [key, result] of loginEntries) {
    const spec = ACTORS[key];
    const ok =
      result.response.status === 200 &&
      result.cookie &&
      result.account?.username === spec.username &&
      result.account?.role === spec.role &&
      typeof result.account?.id === "string";
    addCheck(report, `auth.${key}`, ok, {
      actor: key,
      expected: {
        username: spec.username,
        role: spec.role,
        sessionCookie: true,
      },
      actual: ok
        ? {
            username: result.account.username,
            role: result.account.role,
            accountId: result.account.id,
          }
        : summarizeHttp(result.response),
    });
    if (ok) {
      sessions[key] = { cookie: result.cookie };
      accounts[key] = result.account;
      report.actors[key] = {
        username: result.account.username,
        role: result.account.role,
        accountId: result.account.id,
      };
    }
  }
  if (Object.keys(sessions).length !== 4) {
    report.fatalError =
      "四个既有 demo 账号未全部通过登录预检；未继续访问或生成。";
    return finalize(report);
  }

  const [orgEntries, memberEntries] = await Promise.all([
    Promise.all(
      Object.keys(ACTORS).map(async (key) => [
        key,
        await request(options.base, sessions[key], "/api/org"),
      ]),
    ),
    Promise.all(
      ["A", "C"].map(async (key) => [
        key,
        await request(options.base, sessions[key], "/api/org/members"),
      ]),
    ),
  ]);
  const orgs = Object.fromEntries(
    orgEntries.map(([key, result]) => [key, responseObject(result, "org")]),
  );
  const members = Object.fromEntries(
    memberEntries.map(([key, result]) => [
      key,
      responseArray(result, "members"),
    ]),
  );
  for (const key of Object.keys(ACTORS)) {
    addCheck(
      report,
      `org.${key}.membership`,
      Boolean(orgs[key]?.id && orgs[key]?.role === ACTORS[key].orgRole),
      {
        actor: key,
        expected: { role: ACTORS[key].orgRole, orgId: "非空" },
        actual: orgs[key] ?? null,
      },
    );
    if (report.actors[key]) {
      report.actors[key].orgId = orgs[key]?.id ?? null;
      report.actors[key].orgName = orgs[key]?.name ?? null;
      report.actors[key].orgRole = orgs[key]?.role ?? null;
    }
  }
  const orgMatrixOk = Boolean(
    orgs.A?.id &&
    orgs.A.id === orgs.B?.id &&
    orgs.C?.id &&
    orgs.C.id === orgs.D?.id &&
    orgs.A.id !== orgs.C.id &&
    members.A.some(
      (member) =>
        member?.accountId === accounts.B.id && member?.role === "member",
    ) &&
    members.C.some(
      (member) =>
        member?.accountId === accounts.D.id && member?.role === "member",
    ) &&
    !members.A.some((member) => member?.accountId === accounts.D.id) &&
    !members.C.some((member) => member?.accountId === accounts.B.id),
  );
  addCheck(report, "org.dual-org-matrix", orgMatrixOk, {
    expected: "A/B 同机构、C/D 同机构、两机构不同，且 B/D 只在各自名册",
    actual: {
      A: orgs.A?.id ?? null,
      B: orgs.B?.id ?? null,
      C: orgs.C?.id ?? null,
      D: orgs.D?.id ?? null,
      aHasB: members.A.some((member) => member?.accountId === accounts.B.id),
      aHasD: members.A.some((member) => member?.accountId === accounts.D.id),
      cHasB: members.C.some((member) => member?.accountId === accounts.B.id),
      cHasD: members.C.some((member) => member?.accountId === accounts.D.id),
    },
  });

  await validateOwnedDocumentIsolation(report, options, sessions);

  const generatedIds = {};
  if (options.generate) {
    addCheck(report, "generate.safety-preflight", orgMatrixOk, {
      expected: "四个固定账号与双机构名册完全匹配后才允许写入",
      actual: orgMatrixOk,
    });
    if (orgMatrixOk) {
      const profileResults = await Promise.all(
        SCENARIOS.map((scenario) =>
          saveAndReadProfile(report, options.base, sessions, scenario),
        ),
      );
      const results = await Promise.all(
        SCENARIOS.map((scenario, index) =>
          generateCourse(
            report,
            options.base,
            sessions,
            scenario,
            profileResults[index],
          ),
        ),
      );
      SCENARIOS.forEach((scenario, index) => {
        if (results[index]) generatedIds[scenario.key] = results[index];
      });
      if (results.every((courseId) => typeof courseId === "string")) {
        const assignmentResults = await Promise.all(
          SCENARIOS.map((scenario) =>
            assignCourse(
              report,
              options.base,
              sessions,
              accounts,
              scenario,
              generatedIds[scenario.key],
            ),
          ),
        );
        if (assignmentResults.every(Boolean)) {
          await Promise.all([
            ...SCENARIOS.map((scenario) =>
              generatePracticeProjects(
                report,
                options.base,
                sessions,
                scenario,
                generatedIds[scenario.key],
              ),
            ),
            validateForbiddenAssignment(
              report,
              options.base,
              sessions,
              accounts,
              {
                label: "A-to-D",
                manager: "A",
                target: "D",
                courseId: generatedIds.ai,
              },
            ),
            validateForbiddenAssignment(
              report,
              options.base,
              sessions,
              accounts,
              {
                label: "C-to-B",
                manager: "C",
                target: "B",
                courseId: generatedIds.smartManufacturing,
              },
            ),
          ]);
        } else {
          for (const scenario of SCENARIOS) {
            addSkipped(
              report,
              `practice.${scenario.key}.drafted`,
              "正常课程指派未全部成功，不生成实践项目",
              { actor: scenario.manager, domain: scenario.domain },
            );
            addSkipped(
              report,
              `practice.${scenario.key}.published`,
              "正常课程指派未全部成功，不发布实践项目",
              { actor: scenario.manager, domain: scenario.domain },
            );
            addSkipped(
              report,
              `practice.${scenario.key}.restored`,
              "正常课程指派未全部成功，不验证实践项目恢复",
              { actor: scenario.manager, domain: scenario.domain },
            );
          }
          for (const label of ["A-to-D", "C-to-B"]) {
            addSkipped(
              report,
              `negative-assignment.${label}.rejected`,
              "正常指派未全部成功，不执行跨机构写探针",
            );
            addSkipped(
              report,
              `negative-assignment.${label}.unchanged`,
              "正常指派未全部成功，不执行跨机构写探针",
            );
          }
        }
      } else {
        for (const scenario of SCENARIOS) {
          addSkipped(
            report,
            `assign.${scenario.key}.created`,
            "两门课程未全部生成成功，不做部分指派",
            {
              actor: scenario.manager,
              learner: scenario.learner,
              domain: scenario.domain,
            },
          );
          addSkipped(
            report,
            `practice.${scenario.key}.drafted`,
            "两门课程未全部生成成功",
            { actor: scenario.manager, domain: scenario.domain },
          );
          addSkipped(
            report,
            `practice.${scenario.key}.published`,
            "两门课程未全部生成成功",
            { actor: scenario.manager, domain: scenario.domain },
          );
          addSkipped(
            report,
            `practice.${scenario.key}.restored`,
            "两门课程未全部生成成功",
            { actor: scenario.manager, domain: scenario.domain },
          );
        }
        for (const label of ["A-to-D", "C-to-B"]) {
          addSkipped(
            report,
            `negative-assignment.${label}.rejected`,
            "两门课程未全部生成成功",
          );
          addSkipped(
            report,
            `negative-assignment.${label}.unchanged`,
            "两门课程未全部生成成功",
          );
        }
      }
    } else {
      for (const scenario of SCENARIOS) {
        addSkipped(
          report,
          `profile.${scenario.key}.saved`,
          "写入安全预检失败",
          { actor: scenario.learner, domain: scenario.domain },
        );
        addSkipped(
          report,
          `profile.${scenario.key}.reread`,
          "写入安全预检失败",
          { actor: scenario.learner, domain: scenario.domain },
        );
        addSkipped(
          report,
          `generate.${scenario.key}.accepted`,
          "写入安全预检失败",
          {
            actor: scenario.manager,
            domain: scenario.domain,
          },
        );
        addSkipped(
          report,
          `generate.${scenario.key}.completed`,
          "写入安全预检失败",
          {
            actor: scenario.manager,
            domain: scenario.domain,
          },
        );
        addSkipped(
          report,
          `assign.${scenario.key}.created`,
          "写入安全预检失败",
          {
            actor: scenario.manager,
            learner: scenario.learner,
            domain: scenario.domain,
          },
        );
        addSkipped(
          report,
          `practice.${scenario.key}.drafted`,
          "写入安全预检失败",
          { actor: scenario.manager, domain: scenario.domain },
        );
        addSkipped(
          report,
          `practice.${scenario.key}.published`,
          "写入安全预检失败",
          { actor: scenario.manager, domain: scenario.domain },
        );
        addSkipped(
          report,
          `practice.${scenario.key}.restored`,
          "写入安全预检失败",
          { actor: scenario.manager, domain: scenario.domain },
        );
      }
      for (const label of ["A-to-D", "C-to-B"]) {
        addSkipped(
          report,
          `negative-assignment.${label}.rejected`,
          "写入安全预检失败",
        );
        addSkipped(
          report,
          `negative-assignment.${label}.unchanged`,
          "写入安全预检失败",
        );
      }
    }
  }

  report.generatedCourses = Object.fromEntries(
    SCENARIOS.flatMap((scenario) => {
      const courseId = generatedIds[scenario.key];
      return courseId
        ? [
            [
              scenario.key,
              {
                runId: report.runId,
                courseId,
                domain: scenario.domain,
                manager: scenario.manager,
                learner: scenario.learner,
              },
            ],
          ]
        : [];
    }),
  );

  const shared = {
    assignments: {},
    courseDomains: {},
    domains: {},
    classrooms: {},
  };
  await Promise.all(
    Object.keys(ACTORS).flatMap((actor) => [
      request(options.base, sessions[actor], "/api/org/assignments").then(
        (result) => (shared.assignments[actor] = result),
      ),
      request(options.base, sessions[actor], "/api/course-domains").then(
        (result) => (shared.courseDomains[actor] = result),
      ),
      request(options.base, sessions[actor], "/api/domains").then(
        (result) => (shared.domains[actor] = result),
      ),
      request(options.base, sessions[actor], "/api/classroom").then(
        (result) => (shared.classrooms[actor] = result),
      ),
    ]),
  );
  for (const actor of Object.keys(ACTORS)) {
    for (const [source, result] of [
      ["assignments", shared.assignments[actor]],
      ["course-domains", shared.courseDomains[actor]],
      ["domains", shared.domains[actor]],
      ["classrooms", shared.classrooms[actor]],
    ]) {
      addCheck(report, `source.${actor}.${source}`, result.status === 200, {
        actor,
        expected: "HTTP 200",
        actual: result.status === 200 ? { status: 200 } : summarizeHttp(result),
      });
    }
  }
  const scratchByActor = Object.fromEntries(
    Object.keys(ACTORS).map((actor) => {
      const entries = isObject(shared.domains[actor]?.body?.entries)
        ? Object.keys(shared.domains[actor].body.entries)
        : [];
      return [actor, entries.filter((domain) => SCRATCH_DOMAIN.test(domain))];
    }),
  );
  addCheck(
    report,
    "hygiene.no-scratch-domains",
    Object.values(scratchByActor).every((domains) => domains.length === 0),
    {
      expected:
        "四个真实账号的领域清单均不出现 fullprobe/fullpath-probe/probe 临时库",
      actual: scratchByActor,
    },
  );

  const scenarioResults = await Promise.all(
    SCENARIOS.map((scenario) =>
      validateScenario(
        report,
        options.base,
        sessions,
        accounts,
        shared,
        scenario,
        generatedIds[scenario.key],
      ),
    ),
  );
  validateReportDomainAlignment(report, scenarioResults);
  await Promise.all(
    scenarioResults.map((result) =>
      validateCourseMatrix(
        report,
        options.base,
        sessions,
        shared,
        result.scenario,
        result.courseId,
      ),
    ),
  );
  if (options.generate) {
    await validateSameConceptDomainBuckets(
      report,
      options.base,
      sessions,
      accounts,
      scenarioResults,
    );
    await Promise.all(
      scenarioResults.map((scenarioResult) =>
        validateWrongAnswerRemediation(
          report,
          options.base,
          sessions,
          accounts,
          scenarioResult,
        ),
      ),
    );
  }

  return finalize(report);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (options.selfTest) {
    process.stdout.write(`${reportJson(runSelfTest())}\n`);
  } else {
    const report = await run(options);
    process.stdout.write(
      `${reportJson(report, [process.env.JIZHI_DEMO_PASSWORD])}\n`,
    );
    process.exitCode = report.ok ? 0 : 1;
  }
} catch (error) {
  const report = {
    schemaVersion: 2,
    command: "production-dual-org-e2e",
    mode: "cli-error",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stdout.write(
    `${reportJson(report, [process.env.JIZHI_DEMO_PASSWORD])}\n`,
  );
  process.exitCode = 2;
}
