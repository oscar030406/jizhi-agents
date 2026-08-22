const state = {
  profiles: [],
  run: null,
  chatStarted: false,
  draftProfile: {},
  feedbackHistory: [],
};

const $ = (id) => document.getElementById(id);
const isStaticDemo = () => Boolean(window.STATIC_DEMO_DATA);

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function parseBody(options = {}) {
  if (!options.body) return {};
  try {
    return JSON.parse(options.body);
  } catch {
    return {};
  }
}

function mockConversationTurn(request) {
  const text = (request.message || "").toLowerCase();
  if (/(评测|评价|eval|指标|测试报告)/.test(text)) {
    return {
      assistant_message: "我会打开评测摘要。评委关心的是概念覆盖、引用覆盖、难度适配和流程成功率。",
      suggested_action: "show_evaluation",
      artifact_targets: ["evaluation_metrics", "eval_results_v2.csv"],
      missing_fields: [],
      quick_replies: ["运行完整闭环", "查看 Agent trace", "提交反馈"],
    };
  }
  if (/(反馈|分数|不会|卡住|太难|信心)/.test(text)) {
    return {
      assistant_message: "这是反馈迭代场景。请给出测验得分、信心等级和卡点，我会调用反馈决策 Agent。",
      suggested_action: "collect_feedback",
      artifact_targets: ["feedback_decision", "updated_difficulty", "next_action"],
      missing_fields: ["quiz_score", "confidence"],
      quick_replies: ["得分偏低，需要降维解释", "得分中等，需要继续练习", "得分较高，给我进阶挑战"],
    };
  }
  if (/(开始|运行|诊断|生成|闭环|学习路径)/.test(text)) {
    const missing = request.learner_profile_id ? [] : ["learner_profile_id"];
    return {
      assistant_message: "我会按画像运行完整多 Agent 闭环，并返回诊断、证据、资源、审核和路径。",
      suggested_action: missing.length ? "collect_profile" : "run_workflow",
      artifact_targets: ["diagnosis", "retrieval", "resources", "audit", "learning_path", "trace"],
      missing_fields: missing,
      quick_replies: ["使用当前画像运行", "先换一个画像", "运行后显示审核指标"],
    };
  }
  if (request.has_workflow_run) {
    return {
      assistant_message: "当前已有一次结构化运行结果。你可以继续查看证据、审核、路径，或提交反馈进入下一轮。",
      suggested_action: "summarize_current_run",
      artifact_targets: ["workflow_run"],
      missing_fields: [],
      quick_replies: ["查看证据来源", "查看审核结果", "提交反馈"],
    };
  }
  return {
    assistant_message: "先确定学习目标、基础、时间预算和偏好。选择一个预设画像后，我可以运行完整闭环。",
    suggested_action: "collect_profile",
    artifact_targets: ["learner_profile"],
    missing_fields: ["learner_profile_id", "learning_goal"],
    quick_replies: ["我是零基础", "我会 Python 但不了解 Agent", "我要竞赛冲刺"],
  };
}

function mockFeedbackDecision(request, currentDifficulty = "L2") {
  if (request.quiz_score < 0.45 || request.confidence <= 2) {
    return {
      feedback_type: "remediation",
      decision: "downgrade_explanation",
      updated_difficulty: "L1",
      next_action: "生成更简单的解释，并为最薄弱概念补两道定向练习。",
      explanation: "低分或低信心说明学习者需要先降维理解，再推进到复杂任务。",
    };
  }
  if (request.quiz_score < 0.75) {
    return {
      feedback_type: "practice",
      decision: "add_practice",
      updated_difficulty: currentDifficulty,
      next_action: "保持当前路线，增加一个带明确提示的实操练习。",
      explanation: "学习者已经接近掌握，但还需要一轮练习闭环。",
    };
  }
  return {
    feedback_type: "advancement",
    decision: "advance_challenge",
    updated_difficulty: currentDifficulty === "L3" ? "L4" : "L3",
    next_action: "加入进阶挑战：组合 RAG、一次工具调用和审核 trace 可视化。",
    explanation: "高分且信心较高，可以进入更开放的任务。",
  };
}

async function mockApi(path, options = {}) {
  const demo = window.STATIC_DEMO_DATA;
  const url = new URL(path, window.location.href);
  const pathname = url.pathname;
  const body = parseBody(options);
  await new Promise((resolve) => setTimeout(resolve, 120));

  if (pathname.endsWith("/api/profiles")) return clone(demo.profiles);
  if (pathname.endsWith("/api/models/routes")) return clone(demo.model_routes || []);
  if (pathname.endsWith("/api/evaluation/summary")) return clone(demo.evaluation_summary);

  if (pathname.endsWith("/api/workflow/run")) {
    const run = clone(demo.runs[body.learner_profile_id] || demo.runs[demo.default_profile_id]);
    run.run_id = `static-${Date.now()}`;
    if (body.learning_goal) run.learning_goal = body.learning_goal;
    return run;
  }

  if (pathname.endsWith("/api/workflow/run-custom")) {
    const run = clone(demo.runs[demo.default_profile_id]);
    run.run_id = `static-custom-${Date.now()}`;
    run.learner_profile_id = body.profile?.id || "chat_draft";
    run.learning_goal = body.profile?.learning_goal || run.learning_goal;
    return run;
  }

  if (pathname.endsWith("/api/feedback")) {
    return mockFeedbackDecision(body, url.searchParams.get("current_difficulty") || "L2");
  }

  if (pathname.endsWith("/api/conversation/turn")) {
    return mockConversationTurn(body);
  }

  if (pathname.endsWith("/api/history/runs")) {
    return clone(demo.history || []);
  }

  const historyMatch = pathname.match(/\/api\/history\/runs\/([^/]+)$/);
  if (historyMatch) {
    const runId = decodeURIComponent(historyMatch[1]);
    const run = Object.values(demo.runs).find((item) => item.run_id === runId) || demo.runs[demo.default_profile_id];
    return clone(run);
  }

  throw new Error(`Static demo route not found: ${pathname}`);
}

async function api(path, options = {}) {
  if (isStaticDemo()) return mockApi(path, options);
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadProfiles() {
  state.profiles = await api("/api/profiles");
  const select = $("profileSelect");
  select.innerHTML = state.profiles
    .map((profile) => `<option value="${profile.id}">${profile.name}</option>`)
    .join("");
  select.value = state.profiles[0]?.id || "";
  syncProfile();

  if (isStaticDemo() && !state.run) {
    state.run = clone(window.STATIC_DEMO_DATA.runs[window.STATIC_DEMO_DATA.default_profile_id]);
    renderRun(state.run);
    await showEvaluationSummary();
  }
}

function syncProfile() {
  const profile = state.profiles.find((item) => item.id === $("profileSelect").value);
  if (!profile) return;
  $("learningGoal").value = profile.learning_goal;
  $("profileDetail").innerHTML = `
    <h3>${escapeHtml(profile.name)}</h3>
    <p>${escapeHtml(profile.background)}</p>
    <div class="chip-list">
      <span class="chip">Python ${profile.python_level}/4</span>
      <span class="chip">Agent ${profile.agent_level}/4</span>
      <span class="chip">RAG ${profile.rag_level}/4</span>
      <span class="chip">工程 ${profile.engineering_level}/4</span>
      <span class="chip">${profile.time_budget_hours}h</span>
    </div>
  `;
}

async function runWorkflow() {
  $("runWorkflow").textContent = "运行中...";
  $("runWorkflow").disabled = true;
  try {
    state.run = await api("/api/workflow/run", {
      method: "POST",
      body: JSON.stringify({
        learner_profile_id: $("profileSelect").value,
        learning_goal: $("learningGoal").value,
      }),
    });
    renderRun(state.run);
    await loadHistory();
  } catch (error) {
    $("diagnosisSummary").innerHTML = `<span class="error">${escapeHtml(error.message)}</span>`;
  } finally {
    $("runWorkflow").textContent = "运行完整闭环";
    $("runWorkflow").disabled = false;
  }
}

function addChatMessage(role, message) {
  const log = $("chatLog");
  const item = document.createElement("div");
  item.className = `chat-msg ${role}`;
  item.innerHTML = escapeHtml(message);
  log.appendChild(item);
  log.scrollTop = log.scrollHeight;
}

function renderArtifactTargets(targets = []) {
  $("artifactTargets").innerHTML = targets.map((target) => `<span class="chip">${escapeHtml(target)}</span>`).join("");
}

function mergeMax(field, value) {
  state.draftProfile[field] = Math.max(Number(state.draftProfile[field] ?? 0), value);
}

function updateDraftProfile(message) {
  const text = message.toLowerCase();
  const draft = state.draftProfile;
  if (message.length > 6) draft.learning_goal = message.slice(0, 120);
  if (/(零基础|小白|不会编程|从零)/.test(message)) {
    draft.programming_level = 0;
    draft.python_level = 0;
    draft.agent_level = 0;
    draft.rag_level = 0;
    draft.engineering_level = 0;
    draft.learning_preference = "图解 + 分步实操";
  }
  if (/(python|会写代码|编程基础)/i.test(message)) {
    mergeMax("programming_level", 3);
    mergeMax("python_level", 3);
  }
  if (/(后端|api|fastapi|工程|部署)/i.test(message)) {
    mergeMax("engineering_level", 3);
    mergeMax("programming_level", 3);
  }
  if (/(agent|智能体|工具调用|function calling)/i.test(text)) mergeMax("agent_level", 2);
  if (/(rag|检索|知识库|引用|证据)/i.test(text)) mergeMax("rag_level", 2);
  if (/(竞赛|挑战杯|冲刺|答辩|路演)/.test(message)) {
    mergeMax("engineering_level", 3);
    draft.time_budget_hours = Math.max(Number(draft.time_budget_hours ?? 0), 24);
    draft.learning_preference = draft.learning_preference || "项目驱动 + 评测闭环";
  }
  const hourMatch = message.match(/(\d+)\s*(小时|h)/i);
  const dayMatch = message.match(/(\d+)\s*天/);
  if (hourMatch) draft.time_budget_hours = Number(hourMatch[1]);
  if (dayMatch) draft.time_budget_hours = Number(dayMatch[1]) * 4;
  renderProfileDraft();
}

function draftMissingFields() {
  const draft = state.draftProfile;
  const missing = [];
  if (!draft.learning_goal) missing.push("learning_goal");
  if (draft.python_level == null && draft.programming_level == null) missing.push("programming_level");
  if (draft.agent_level == null) missing.push("agent_level");
  if (draft.rag_level == null) missing.push("rag_level");
  if (!draft.time_budget_hours) missing.push("time_budget_hours");
  return missing;
}

function renderProfileDraft() {
  const draft = state.draftProfile;
  const chips = [];
  ["programming_level", "python_level", "agent_level", "rag_level", "engineering_level"].forEach((field) => {
    if (draft[field] != null) chips.push(`<span class="chip">${field.replace("_level", "")} ${draft[field]}/4</span>`);
  });
  if (draft.time_budget_hours) chips.push(`<span class="chip">${draft.time_budget_hours}h</span>`);
  const missing = draftMissingFields();
  $("profileDraft").innerHTML = `
    <h4>对话画像草稿</h4>
    <p>${escapeHtml(draft.learning_goal || "等待学习目标")}</p>
    <div class="chip-list">${chips.join("") || `<span class="chip muted-chip">未采集能力信息</span>`}</div>
    <p class="muted">缺失: ${missing.join(", ") || "无"}</p>
  `;
  $("runDraftProfile").disabled = missing.length > 2;
}

function buildDraftProfile() {
  const base = state.profiles.find((item) => item.id === $("profileSelect").value) || state.profiles[0];
  const draft = state.draftProfile;
  return {
    ...base,
    id: `chat_draft_${Date.now()}`,
    name: "对话画像草稿",
    background: draft.learning_goal || base.background,
    programming_level: Number(draft.programming_level ?? base.programming_level),
    python_level: Number(draft.python_level ?? base.python_level),
    agent_level: Number(draft.agent_level ?? base.agent_level),
    rag_level: Number(draft.rag_level ?? base.rag_level),
    engineering_level: Number(draft.engineering_level ?? base.engineering_level),
    learning_goal: draft.learning_goal || $("learningGoal").value || base.learning_goal,
    time_budget_hours: Number(draft.time_budget_hours ?? base.time_budget_hours),
    learning_preference: draft.learning_preference || base.learning_preference,
  };
}

async function runDraftWorkflow() {
  const profile = buildDraftProfile();
  $("runDraftProfile").textContent = "运行中...";
  $("runDraftProfile").disabled = true;
  try {
    state.run = await api("/api/workflow/run-custom", {
      method: "POST",
      body: JSON.stringify({ profile, answers: [] }),
    });
    renderRun(state.run);
    await loadHistory();
    addChatMessage("assistant", "已用对话画像运行闭环。画像、证据、资源、审核和路径已更新。");
    document.querySelector("#diagnosis").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    addChatMessage("assistant", `对话画像运行失败：${error.message}`);
  } finally {
    $("runDraftProfile").textContent = "用对话画像运行";
    $("runDraftProfile").disabled = draftMissingFields().length > 2;
  }
}

async function sendConversation(messageOverride) {
  const input = $("chatInput");
  const message = messageOverride || input.value.trim();
  if (!message) return;
  if (!messageOverride) input.value = "";
  addChatMessage("user", message);
  updateDraftProfile(message);
  try {
    const turn = await api("/api/conversation/turn", {
      method: "POST",
      body: JSON.stringify({
        message,
        learner_profile_id: $("profileSelect").value || null,
        has_workflow_run: Boolean(state.run),
      }),
    });
    addChatMessage("assistant", turn.assistant_message);
    renderArtifactTargets(turn.artifact_targets);
    if (turn.suggested_action === "run_workflow") {
      await runWorkflow();
      addChatMessage("assistant", "完整闭环已运行。诊断、证据、学习资源、审核和学习路径已更新到结构化面板。");
      document.querySelector("#trace").scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (turn.suggested_action === "show_evaluation") {
      await showEvaluationSummary();
    }
    if (turn.suggested_action === "collect_feedback") {
      document.querySelector("#feedback").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    addChatMessage("assistant", `动作失败：${error.message}`);
  }
}

async function showEvaluationSummary() {
  const summary = await api("/api/evaluation/summary");
  if (summary.status !== "ok") {
    $("evalSummary").innerHTML = `<p class="error">${escapeHtml(summary.message || "评测结果缺失")}</p>`;
    return;
  }
  $("evalSummary").innerHTML = Object.entries(summary.averages)
    .map(([key, value]) => `
      <div class="eval-pill">
        <span>${escapeHtml(key)}</span>
        <strong>${Math.round(Number(value) * 100)}%</strong>
      </div>
    `)
    .join("") + `
      <div class="eval-cases">
        ${summary.sample_cases.map((item) => `
          <div class="eval-case">
            <strong>${escapeHtml(item.case_id)}</strong>
            <span>${Math.round(Number(item.workflow_success) * 100)}%</span>
            <p class="muted">${escapeHtml(item.details)}</p>
          </div>
        `).join("")}
      </div>
    `;
  addChatMessage("assistant", `已读取 ${summary.case_count} 条评测样例的指标摘要。`);
}

async function loadModelRoutes() {
  try {
    const routes = await api("/api/models/routes");
    $("modelRoutes").innerHTML = routes
      .map((route) => `
        <div class="source-item">
          <b>${escapeHtml(route.agent)}</b>
          <p>${escapeHtml(route.provider)} / ${escapeHtml(route.model)}</p>
          <p class="muted">${escapeHtml(route.purpose)}</p>
          <div class="chip-list">
            <span class="chip">${escapeHtml(route.tier)}</span>
            <span class="chip ${route.enabled ? "source-chip" : "muted-chip"}">${route.enabled ? "API 可用" : "确定性降级"}</span>
          </div>
        </div>
      `)
      .join("");
  } catch (error) {
    $("modelRoutes").innerHTML = `<p class="error">模型路由加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderRun(run) {
  $("difficulty").textContent = run.diagnosis.recommended_difficulty;
  $("weakCount").textContent = run.diagnosis.weak_concepts.length;
  $("sourceCount").textContent = run.retrieval.source_ids.length;
  $("auditStatus").innerHTML = run.audit.revision_required ? `<span class="error">需修订</span>` : `<span class="ok">通过</span>`;
  $("diagnosisSummary").textContent = run.diagnosis.diagnosis_summary;
  $("weakConcepts").innerHTML = run.diagnosis.weak_concepts.map((concept) => `<span class="chip">${concept}</span>`).join("");
  renderMastery(run.diagnosis.mastery_vector);
  renderTrace(run.trace);
  renderResources(run);
  renderDebate(run);
  renderPath(run);
}

function renderDebate(run) {
  const panel = $("debatePanel");
  if (!panel) return;
  const debate = run.debate || [];
  const audit = run.audit || {};
  const arbitration = run.arbitration;

  const claimLine = audit.claims_total
    ? `<div class="debate-claimbar">
        <span>事实声明核验</span>
        <strong>${audit.claims_supported}/${audit.claims_total} 有据</strong>
        <span class="debate-halluc ${audit.hallucination_rate > 0.05 ? "warn" : "ok"}">幻觉率 ${(Number(audit.hallucination_rate) * 100).toFixed(1)}%</span>
      </div>`
    : "";

  const claimDetail = claimScoreBars(audit.claim_verdicts || []);

  if (!debate.length) {
    panel.innerHTML = `
      <div class="debate-head"><h3>审核辩论</h3><span class="debate-badge ok">一次通过</span></div>
      ${claimLine}
      <p class="muted">审核 Agent 首轮即判定内容有据、难度匹配，无需修订。证据链见上方引用。</p>
      ${claimDetail}
    `;
    return;
  }

  const rounds = debate
    .map(
      (round) => `
      <div class="debate-round">
        <div class="debate-role auditor">
          <span class="debate-tag">审核 Agent · 第 ${round.round_index} 轮质疑</span>
          <div class="chip-list">${(round.auditor_flags || []).map((f) => `<span class="chip warn">${escapeHtml(f)}</span>`).join("") || '<span class="chip">已放行</span>'}</div>
          ${(round.auditor_challenges || []).length ? `<ul class="debate-challenges">${round.auditor_challenges.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
          <p class="muted">事实性 ${Math.round(Number(round.auditor_factuality) * 100)}%</p>
        </div>
        <div class="debate-arrow">↓ 修订答复</div>
        <div class="debate-role generator">
          <span class="debate-tag">生成 Agent · 答复</span>
          <p><b>${escapeHtml(round.generator_action)}</b></p>
          <p class="muted">${escapeHtml(round.generator_note)}</p>
          <span class="debate-badge ${round.resolved ? "ok" : "warn"}">${round.resolved ? "分歧已解决" : "仍有分歧"}</span>
        </div>
      </div>`
    )
    .join("");

  const arbBlock = arbitration
    ? `<div class="debate-arbitration ${arbitration.action === "publish_with_warnings" ? "ok" : "block"}">
        <span class="debate-tag">仲裁 Agent · 终裁</span>
        <p><b>${arbitration.action === "publish_with_warnings" ? "放行（带警告）" : "拦截，转人工审核"}</b></p>
        <p class="muted">${escapeHtml(arbitration.rationale)}</p>
      </div>`
    : "";

  panel.innerHTML = `
    <div class="debate-head">
      <h3>审核辩论</h3>
      <span class="debate-badge ${audit.revision_required ? "warn" : "ok"}">${debate.length} 轮修订 · ${audit.revision_required ? "交仲裁" : "已达标"}</span>
    </div>
    ${claimLine}
    <div class="debate-flow">${rounds}${arbBlock}</div>
    ${claimDetail}
  `;
}

function claimScoreBars(verdicts) {
  if (!verdicts.length) return "";
  const order = { unsupported: 0, weak: 1, supported: 2 };
  const label = { supported: "有据", weak: "弱据", unsupported: "无据" };
  const rows = [...verdicts]
    .sort((a, b) => (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3))
    .slice(0, 12)
    .map((v) => {
      const pct = Math.round(Number(v.support_score) * 100);
      return `<div class="claim-row">
        <span class="claim-verdict ${v.verdict}">${label[v.verdict] || v.verdict}</span>
        <div class="claim-track"><div class="claim-fill ${v.verdict}" style="width:${Math.max(4, pct)}%"></div></div>
        <span class="claim-pct">${pct}%</span>
        <span class="claim-text">${escapeHtml((v.claim || "").slice(0, 46))}</span>
      </div>`;
    })
    .join("");
  return `<details class="claim-detail"><summary>声明核验明细（证据打分，共 ${verdicts.length} 条）</summary>${rows}</details>`;
}

function renderMastery(mastery) {
  $("masteryBars").innerHTML = Object.entries(mastery)
    .map(([concept, value]) => `
      <div class="bar-row">
        <span>${concept}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(value * 100)}%"></div></div>
        <span>${Math.round(value * 100)}%</span>
      </div>
    `)
    .join("");
}

function agentHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return hash;
}

function engineBadge(engine) {
  if (!engine) return "";
  const isLlm = engine.includes("llm");
  const label = isLlm ? (engine === "llm" ? "LLM" : "LLM+确定性") : "确定性兜底";
  return `<span class="engine-badge ${isLlm ? "llm" : "det"}">${label}</span>`;
}

function renderTrace(trace) {
  $("traceTimeline").innerHTML = trace
    .map((step) => {
      const artifactKeys = Object.keys(step.artifacts || {});
      const retrieval = step.artifacts?.retrieval;
      const audit = step.artifacts?.audit;
      const route = step.artifacts?.model_route;
      const engine = step.artifacts?.engine;
      const hue = agentHue(step.agent);
      const evidenceIds = retrieval?.source_ids || retrieval?.retrieved_chunks?.slice(0, 4).map((chunk) => chunk.source_id) || [];
      return `
      <div class="trace-step" style="border-left:4px solid hsl(${hue} 55% 55%)">
        <div>
          <strong style="color:hsl(${hue} 60% 38%)">${step.agent}</strong> ${engineBadge(engine)}
          <p class="muted">${step.status}</p>
          <div class="chip-list">${artifactKeys.filter((k) => k !== "engine" && k !== "model_route").map((key) => `<span class="chip">${escapeHtml(key)}</span>`).join("")}</div>
        </div>
        <div>
          <p><b>输入:</b> ${escapeHtml(step.input_summary)}</p>
          <p><b>输出:</b> ${escapeHtml(step.output_summary)}</p>
          ${route ? `<p><b>模型:</b> ${escapeHtml(route.provider)} / ${escapeHtml(route.model)} (${route.enabled ? "API" : "fallback"})</p>` : ""}
          ${evidenceIds.length ? `<div class="chip-list">${evidenceIds.map((id) => `<span class="chip source-chip">${escapeHtml(id)}</span>`).join("")}</div>` : ""}
          ${audit ? `<div class="mini-metrics">
            <span>事实 ${Math.round(Number(audit.factuality_score) * 100)}%</span>
            <span>引用 ${Math.round(Number(audit.citation_coverage) * 100)}%</span>
            <span>概念 ${Math.round(Number(audit.concept_coverage) * 100)}%</span>
          </div>` : ""}
          <details>
            <summary>JSON</summary>
            <pre>${escapeHtml(JSON.stringify(step.artifacts, null, 2))}</pre>
          </details>
        </div>
      </div>
    `;
    })
    .join("");
}

function sourceChips(sourceIds = []) {
  return `<div class="chip-list citations">${sourceIds.map((id) => `<span class="chip source-chip">${escapeHtml(id)}</span>`).join("")}</div>`;
}

function renderResources(run) {
  $("lecture").innerHTML = run.resources.lecture.sections
    .map((section) => `<h4>${escapeHtml(section.heading)}</h4><p>${escapeHtml(section.body)}</p>${sourceChips(section.source_ids)}`)
    .join("");
  const task = run.resources.practice_task;
  $("practiceTask").innerHTML = `
    <h4>${escapeHtml(task.title)}</h4>
    <p>${escapeHtml(task.scenario)}</p>
    <ol>${task.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
    <p><b>交付物</b> ${escapeHtml(task.deliverable)}</p>
    ${sourceChips(task.source_ids)}
  `;
  $("gradedQuiz").innerHTML = run.resources.graded_quiz
    .map((item) => `
      <div class="quiz-item">
        <b>${escapeHtml(item.question)}</b>
        <p>答案: ${escapeHtml(item.answer)}</p>
        <p class="muted">${escapeHtml(item.explanation)}</p>
        ${sourceChips(item.source_ids)}
      </div>
    `)
    .join("");
  $("sources").innerHTML = run.retrieval.retrieved_chunks
    .map((chunk) => `
      <div class="source-item">
        <b>${escapeHtml(chunk.source_id)}</b>
        <p>${escapeHtml(chunk.title)}</p>
        <p class="muted">${escapeHtml(chunk.content.slice(0, 180))}...</p>
      </div>
    `)
    .join("");
}

function renderPath(run) {
  $("auditPanel").innerHTML = `
    <div class="metrics-row">
      <div class="metric-card"><span>事实性</span><strong>${Math.round(run.audit.factuality_score * 100)}%</strong></div>
      <div class="metric-card"><span>引用覆盖</span><strong>${Math.round(run.audit.citation_coverage * 100)}%</strong></div>
      <div class="metric-card"><span>难度匹配</span><strong>${Math.round(run.audit.difficulty_match * 100)}%</strong></div>
      <div class="metric-card"><span>概念覆盖</span><strong>${Math.round(run.audit.concept_coverage * 100)}%</strong></div>
    </div>
    <p class="muted">风险标记: ${run.audit.hallucination_risk_flags.join(", ") || "无"}</p>
  `;
  $("learningPath").innerHTML = run.learning_path.learning_path
    .map((stage) => `
      <div class="path-item">
        <h4>${escapeHtml(stage.title)}</h4>
        <p><b>${stage.difficulty}</b> - ${stage.estimated_hours} 小时</p>
        <p>${escapeHtml(stage.practice_task)}</p>
        <div class="chip-list">${stage.concepts.map((concept) => `<span class="chip">${concept}</span>`).join("")}</div>
      </div>
    `)
    .join("");
  renderFeedbackHistory();
}

function renderFeedbackHistory() {
  if (!state.feedbackHistory.length || !state.run) return;
  const latest = state.feedbackHistory[state.feedbackHistory.length - 1];
  $("learningPath").insertAdjacentHTML("afterbegin", `
    <div class="path-item adaptive-decision">
      <h4>反馈后的路径调整</h4>
      <p><b>${escapeHtml(latest.updated_difficulty)}</b> - ${escapeHtml(latest.decision)}</p>
      <p>${escapeHtml(latest.next_action)}</p>
      <div class="mini-metrics">
        <span>审核 ${Math.round(Number(latest.audit_score) * 100)}%</span>
        <span>证据 ${latest.source_count}</span>
        <span>得分 ${latest.quiz_score}%</span>
      </div>
    </div>
  `);
}

async function loadHistory() {
  try {
    const items = await api("/api/history/runs?limit=8");
    renderHistory(items);
  } catch (error) {
    $("runHistory").innerHTML = `<p class="error">历史加载失败：${escapeHtml(error.message)}</p>`;
  }
}

function renderHistory(items = []) {
  if (!items.length) {
    $("runHistory").innerHTML = `<p class="muted">暂无运行历史。先运行一次完整闭环。</p>`;
    $("historyDetail").innerHTML = "";
    return;
  }
  $("runHistory").innerHTML = items
    .map((item) => `
      <button class="history-item" type="button" data-run-id="${escapeHtml(item.run_id)}">
        <b>${escapeHtml(item.recommended_difficulty)}</b>
        <span>${escapeHtml(item.learner_profile_id)}</span>
        <small>${escapeHtml(item.learning_goal.slice(0, 42))}</small>
        <div class="mini-metrics">
          <span>事实 ${Math.round(Number(item.factuality_score) * 100)}%</span>
          <span>引用 ${Math.round(Number(item.citation_coverage) * 100)}%</span>
          <span>证据 ${item.source_count}</span>
        </div>
      </button>
    `)
    .join("");
  document.querySelectorAll(".history-item").forEach((button) => {
    button.addEventListener("click", () => loadHistoryDetail(button.dataset.runId));
  });
}

async function loadHistoryDetail(runId) {
  const run = await api(`/api/history/runs/${runId}`);
  state.run = run;
  renderRun(run);
  $("historyDetail").innerHTML = `
    <h3>已回放运行 ${escapeHtml(run.run_id.slice(0, 8))}</h3>
    <p class="muted">${escapeHtml(run.learning_goal)}</p>
    <div class="chip-list">
      <span class="chip">${escapeHtml(run.diagnosis.recommended_difficulty)}</span>
      <span class="chip source-chip">${run.retrieval.source_ids.length} sources</span>
      <span class="chip">trace ${run.trace.length}</span>
    </div>
  `;
  document.querySelector("#diagnosis").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitFeedback() {
  const profileId = $("profileSelect").value;
  const difficulty = state.run?.diagnosis?.recommended_difficulty || "L2";
  const result = await api(`/api/feedback?current_difficulty=${difficulty}`, {
    method: "POST",
    body: JSON.stringify({
      learner_profile_id: profileId,
      quiz_score: Number($("feedbackScore").value) / 100,
      confidence: Number($("feedbackConfidence").value),
      free_text: $("feedbackText").value,
    }),
  });
  $("feedbackResult").innerHTML = `
    <h3>${escapeHtml(result.decision)}</h3>
    <p><b>下一步</b> ${escapeHtml(result.next_action)}</p>
    <p class="muted">${escapeHtml(result.explanation)}</p>
    <span class="chip">updated ${escapeHtml(result.updated_difficulty)}</span>
  `;
  state.feedbackHistory.push({
    decision: result.decision,
    updated_difficulty: result.updated_difficulty,
    next_action: result.next_action,
    audit_score: state.run?.audit?.factuality_score || 0,
    source_count: state.run?.retrieval?.source_ids?.length || 0,
    quiz_score: Number($("feedbackScore").value),
  });
  if (state.run) renderPath(state.run);
  addChatMessage("assistant", `反馈已更新路径：${result.next_action}`);
}

document.addEventListener("DOMContentLoaded", () => {
  if (isStaticDemo()) $("exportEval").href = "data/eval_results.csv";
  $("loadProfiles").addEventListener("click", loadProfiles);
  $("profileSelect").addEventListener("change", syncProfile);
  $("runWorkflow").addEventListener("click", runWorkflow);
  $("submitFeedback").addEventListener("click", submitFeedback);
  $("runDraftProfile").addEventListener("click", runDraftWorkflow);
  $("refreshHistory").addEventListener("click", loadHistory);
  $("sendChat").addEventListener("click", () => sendConversation());
  $("chatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendConversation();
  });
  document.querySelectorAll(".quick").forEach((button) => {
    button.addEventListener("click", () => sendConversation(button.dataset.message));
  });
  loadProfiles();
  loadHistory();
  loadModelRoutes();
  renderProfileDraft();
  addChatMessage("assistant", "先选择画像或直接告诉我目标。我会把对话转换成诊断、证据、资源、审核、路径或反馈决策。");
});
