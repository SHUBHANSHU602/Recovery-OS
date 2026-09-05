const state = {
  summary: null,
  cases: [],
  escalations: [],
  policy: null,
  activity: [],
  live: null,
  selectedCaseId: null,
  refreshing: false,
};

const money = (paise) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(paise || 0) / 100);
const pct = (value) => value == null ? "—" : `${Number(value).toFixed(1)}%`;
const fmtDate = (value) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "—";
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const isTerminal = (status) => ["RECOVERED", "STOPPED", "ESCALATED"].includes(status);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2800);
}

function statusBadge(status) {
  return `<span class="status ${esc(status)}">${esc(status)}</span>`;
}

function renderMetricGrid(summary) {
  const cards = [
    ["Revenue at risk", money(summary.revenueAtRisk), `${summary.totalCases} durable cases`],
    ["Expected recoverable", money(summary.expectedRecoveryValue), "Open-case priority model"],
    ["Confirmed recovered", money(summary.confirmedRecovered), `${summary.recoveredCases} provider-confirmed`],
    ["Value recovery", pct(summary.valueRecoveryRate), "Trusted paid outcomes only"],
    ["Diagnosis accuracy", pct(summary.diagnosisAccuracy), `${summary.diagnosisCorrect}/${summary.diagnosisTotal || 0} labeled`],
    ["Promise to pay", summary.activePromises, "Active commitments"],
    ["Open cases", summary.openCases, `${summary.waitingCases} waiting · ${summary.scheduledCases} scheduled`],
    ["Human escalations", summary.escalatedCases, "Policy / ambiguity handoff"],
  ];
  document.getElementById("metric-grid").innerHTML = cards.map(([label, value, foot]) => `<article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-foot">${foot}</div></article>`).join("");
}

function renderBars(targetId, items, labelKey, valueKey) {
  const target = document.getElementById(targetId);
  if (!items?.length) { target.innerHTML = `<div class="empty">No data yet.</div>`; return; }
  const max = Math.max(...items.map((item) => Number(item[valueKey] || 0)), 1);
  target.innerHTML = items.map((item) => {
    const value = Number(item[valueKey] || 0);
    return `<div class="bar-row"><div class="bar-meta"><span>${esc(item[labelKey])}</span><span>${value}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (value / max) * 100)}%"></div></div></div>`;
  }).join("");
}

function caseRows(cases) {
  return cases.map((item) => `<tr class="clickable" data-case-id="${item.id}">
    <td>#${item.id}</td>
    <td><strong>${esc(item.customerEmail || "Unknown")}</strong><br><span class="muted mono">${esc(item.originalEventId)}</span></td>
    <td>${money(item.amountAtRisk)}</td>
    <td>${esc(item.rootCause || "Awaiting diagnosis")}<br><span class="muted">${item.confidence == null ? "" : `${(item.confidence * 100).toFixed(0)}% confidence`}</span></td>
    <td>${item.recoveryPlan ? `<strong>v${item.recoveryPlan.version}</strong> · ${esc(item.recoveryPlan.primaryAction)}` : esc(item.strategy || item.finalAction || "—")}</td>
    <td>${statusBadge(item.status)}</td>
    <td>${fmtDate(item.updatedAt)}</td>
  </tr>`).join("");
}

function bindCaseRows(container) {
  container.querySelectorAll("[data-case-id]").forEach((row) => row.addEventListener("click", () => openCase(Number(row.dataset.caseId))));
}

function renderCaseTable(targetId, cases) {
  const target = document.getElementById(targetId);
  if (!cases?.length) { target.innerHTML = `<div class="empty">No recovery cases match this view.</div>`; return; }
  target.innerHTML = `<table><thead><tr><th>Case</th><th>Customer / event</th><th>At risk</th><th>Diagnosis</th><th>Current plan</th><th>Status</th><th>Updated</th></tr></thead><tbody>${caseRows(cases)}</tbody></table>`;
  bindCaseRows(target);
}

function renderEscalations(items) {
  const target = document.getElementById("escalation-list");
  if (!items?.length) { target.innerHTML = `<div class="empty">No human escalations.</div>`; return; }
  target.innerHTML = items.map((item) => `<article class="queue-card clickable" data-case-id="${item.caseId}"><div class="queue-top"><div><strong>Case #${item.caseId}</strong><span class="muted">${esc(item.customerEmail || "Unknown")}</span></div>${statusBadge(item.status)}</div><p>${esc(item.reason)}</p><div class="queue-meta"><span>${money(item.amountAtRisk)} at risk</span><span>${esc(item.rootCause || "No diagnosis")}</span><span>${fmtDate(item.updatedAt)}</span></div></article>`).join("");
  target.querySelectorAll("[data-case-id]").forEach((card) => card.addEventListener("click", () => openCase(Number(card.dataset.caseId))));
}

function renderPolicy(policy) {
  const quiet = policy.quietHours ? `${String(policy.quietHours.startHour).padStart(2, "0")}:00–${String(policy.quietHours.endHour).padStart(2, "0")}:00 (${policy.quietHours.timeZone})` : "Disabled";
  const entries = [
    ["Decision authority", policy.mode], ["Max automated retries", policy.maxAutomatedRetries], ["Max contacts / 24h", policy.maxContactsPerDay],
    ["Already recovered", policy.recoveredCaseBehavior], ["Customer opted out", policy.optedOutBehavior], ["Ambiguous execution", policy.ambiguousExecutionBehavior],
    ["Quiet hours", quiet], ["Prioritization", policy.prioritization], ["Promise-to-pay", policy.promiseToPay],
  ];
  document.getElementById("policy-cards").innerHTML = entries.map(([label, value]) => `<div class="policy-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
}

function activityItem(item) {
  const detail = item.detail && typeof item.detail === "object" ? JSON.stringify(item.detail) : String(item.detail ?? "");
  return `<article class="activity-item ${item.caseId ? "clickable" : ""}" ${item.caseId ? `data-case-id="${item.caseId}"` : ""}>
    <div class="activity-dot"></div>
    <div class="activity-main"><div class="activity-head"><strong>${esc(item.stage)}</strong><time>${fmtDate(item.createdAt)}</time></div><div class="activity-meta">${item.caseId ? `Case #${item.caseId}` : esc(item.eventId)}${item.customerEmail ? ` · ${esc(item.customerEmail)}` : ""}${item.caseStatus ? ` · ${esc(item.caseStatus)}` : ""}</div><div class="activity-detail">${esc(detail)}</div></div>
  </article>`;
}

function renderActivity(targetId, items, maxItems) {
  const target = document.getElementById(targetId);
  const visible = maxItems ? items.slice(0, maxItems) : items;
  target.innerHTML = visible.length ? visible.map(activityItem).join("") : `<div class="empty">No audit activity yet.</div>`;
  target.querySelectorAll("[data-case-id]").forEach((row) => row.addEventListener("click", () => openCase(Number(row.dataset.caseId))));
}

function detailCard(label, value) {
  return `<div class="detail-card"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

function renderPlan(plan) {
  return `<article class="plan-card"><div class="plan-top"><strong>Plan v${plan.version}</strong><span>${esc(plan.trigger)}</span></div><h4>${esc(plan.primaryAction)} → ${esc(plan.fallbackAction)}</h4><p>${esc(plan.reasoning)}</p><div class="plan-policy">${esc(plan.policyResult)} · final: ${esc(plan.policyFinalAction)}</div></article>`;
}

function renderRuntime(runtime) {
  const actions = runtime.actions.map((a) => `<tr><td>${esc(a.apiCall)}</td><td class="mono">${esc(a.idempotencyKey)}</td><td>${statusBadge(a.status)}</td><td>${fmtDate(a.createdAt)}</td></tr>`).join("") || `<tr><td colspan="4">No action attempts yet.</td></tr>`;
  const schedules = runtime.scheduledActions.map((s) => `<tr><td>${esc(s.desiredAction)}</td><td>${statusBadge(s.status)}</td><td>${s.attemptCount}</td><td>${fmtDate(s.runAt)}</td><td>${esc(s.lastError || "—")}</td></tr>`).join("") || `<tr><td colspan="5">No scheduled actions.</td></tr>`;
  return `<div class="runtime-grid">
    <section><div class="subhead">Versioned AI plans</div>${runtime.plans.length ? runtime.plans.map(renderPlan).join("") : `<div class="empty small">No AI plan persisted yet.</div>`}</section>
    <section><div class="subhead">Action execution / idempotency</div><div class="table-wrap"><table><thead><tr><th>Boundary</th><th>Idempotency key</th><th>Status</th><th>Created</th></tr></thead><tbody>${actions}</tbody></table></div></section>
    <section><div class="subhead">Durable scheduler</div><div class="table-wrap"><table><thead><tr><th>Action</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Error</th></tr></thead><tbody>${schedules}</tbody></table></div></section>
  </div>`;
}

function renderConversation(conversation, testEnabled, terminal) {
  const messages = conversation.messages.filter((m) => m.role !== "system").map((m) => `<div class="message ${esc(m.role)}"><span>${esc(m.role)}</span><p>${esc(m.content || (m.toolCalls?.length ? `Tool request: ${m.toolCalls.map((t) => t.name).join(", ")}` : "Tool result"))}</p></div>`).join("") || `<div class="empty small">Conversation not started yet.</div>`;
  return `<div class="conversation"><div class="conversation-log">${messages}</div>${testEnabled && !terminal ? `<form id="agent-form" class="agent-form"><input id="agent-message" class="input" placeholder="Customer reply, e.g. I will pay tomorrow at 8 PM" required /><button class="button" type="submit">Send customer reply</button></form>` : `<div class="notice">${terminal ? "Terminal case: conversation controls are read-only." : "Enable RECOVERY_ENABLE_TEST_CONSOLE=true for local interactive agent testing."}</div>`}</div>`;
}

function renderTestLab(item, testEnabled) {
  if (!testEnabled) return `<div class="notice">Local test controls are OFF. Add <code>RECOVERY_ENABLE_TEST_CONSOLE=true</code> to .env and restart the server. Read-only live monitoring still works.</div>`;
  if (isTerminal(item.status)) return `<div class="notice">This case is terminal (${esc(item.status)}). Recovery side effects are intentionally disabled.</div>`;
  const buttons = [
    ["refresh_priority", "Refresh priority"], ["retry_now", "Retry now / Payment Link"], ["retry_with_backoff", "Schedule 1s backoff"],
    ["offer_alternate_payment_method", "Alternate method contact"], ["whatsapp_nudge", "WhatsApp nudge"], ["escalate_to_human", "Escalate to human"],
  ];
  return `<div class="test-actions">${buttons.map(([action, label]) => `<button class="button secondary test-action" data-action="${action}">${label}</button>`).join("")}<a class="button secondary" href="/channels.html?caseId=${item.id}">Open omnichannel lab</a></div><p class="muted compact">Every button calls the real policy-gated backend path. Provider limits, quiet hours, retry caps and terminal states can still block execution.</p>`;
}

async function openCase(caseId, silent = false) {
  state.selectedCaseId = caseId;
  const drawer = document.getElementById("case-drawer");
  const content = document.getElementById("drawer-content");
  document.getElementById("drawer-title").textContent = `Case #${caseId}`;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  if (!silent) content.innerHTML = `<div class="empty">Loading live case state…</div>`;

  try {
    const [item, timeline, promises, runtime, conversation] = await Promise.all([
      api(`/api/dashboard/cases/${caseId}`), api(`/api/dashboard/cases/${caseId}/timeline`), api(`/api/dashboard/cases/${caseId}/promises`),
      api(`/api/dashboard/cases/${caseId}/runtime`), api(`/api/dashboard/cases/${caseId}/conversation`),
    ]);
    document.getElementById("drawer-sync").textContent = `Live sync ${new Date().toLocaleTimeString()} · event ${item.originalEventId}`;
    const activePromise = promises.items.find((p) => p.status === "PENDING");
    const terminal = isTerminal(item.status);
    content.innerHTML = `
      <div class="detail-grid">
        ${detailCard("Status", statusBadge(item.status))}${detailCard("Amount at risk", money(item.amountAtRisk))}${detailCard("Expected recovery", money(item.expectedRecoveryValue || 0))}
        ${detailCard("Recovered", money(item.recoveredAmount))}${detailCard("Root cause", esc(item.rootCause || "—"))}${detailCard("Verifier", esc(item.verifierResult || "—"))}
        ${detailCard("AI plan", item.recoveryPlan ? `v${item.recoveryPlan.version} · ${esc(item.recoveryPlan.primaryAction)}` : "—")}${detailCard("Policy final action", esc(item.recoveryPlan?.policyFinalAction || item.finalAction || "—"))}
        ${detailCard("Next scheduled action", fmtDate(item.nextRunAt))}${detailCard("Payment Link", esc(item.razorpayPaymentLinkId || "—"))}${detailCard("Terminal reason", esc(item.terminalReason || "—"))}${detailCard("Customer", esc(item.customerEmail || "—"))}
      </div>

      <section class="panel accent-panel"><p class="eyebrow">Local feature lab</p><h3>Exercise the real recovery boundaries</h3>${renderTestLab(item, Boolean(state.live?.testConsoleEnabled))}</section>

      <section class="panel"><div class="panel-header"><p class="eyebrow">Conversational AI</p><h3>Customer reply → tool calling → deterministic policy</h3></div>${renderConversation(conversation, Boolean(state.live?.testConsoleEnabled), terminal)}</section>

      <section class="panel"><div class="panel-header"><p class="eyebrow">Promise to Pay</p><h3>${activePromise ? "Active commitment" : "Create commitment"}</h3></div>
        ${activePromise ? `<div class="detail-grid">${detailCard("Promised", money(activePromise.promisedAmount))}${detailCard("Due", fmtDate(activePromise.dueAt))}${detailCard("Source", esc(activePromise.source))}${detailCard("Status", statusBadge(activePromise.status))}</div>` : terminal ? `<div class="notice">Terminal cases cannot accept a new Promise-to-Pay.</div>` : `<form id="promise-form" class="form-grid"><input id="promise-amount" class="input" type="number" min="0.01" step="0.01" value="${(item.amountAtRisk / 100).toFixed(2)}" required /><input id="promise-due" class="input" type="datetime-local" required /><input id="promise-note" class="input" placeholder="Customer explicitly promised to pay" /><button class="button" type="submit">Save PTP</button></form>`}
      </section>

      <section class="panel"><div class="panel-header"><p class="eyebrow">Runtime internals</p><h3>Plans, idempotent actions and scheduler</h3></div>${renderRuntime(runtime)}</section>

      <section class="panel"><div class="panel-header"><p class="eyebrow">Append-only audit</p><h3>Case timeline</h3></div><div class="timeline">${timeline.events.length ? timeline.events.slice().reverse().map((event) => `<div class="timeline-item"><strong>${esc(event.stage)}</strong><time>${fmtDate(event.createdAt)}</time><div class="timeline-json">${esc(JSON.stringify(event.detail, null, 2))}</div></div>`).join("") : `<div class="empty">No audit events.</div>`}</div></section>`;

    document.querySelectorAll(".test-action").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const result = await api(`/api/dashboard/cases/${caseId}/test-action`, { method: "POST", body: JSON.stringify({ action: button.dataset.action }) });
        toast(`${button.textContent}: ${result.status || result.result || "done"}`);
        await refreshAll({ quiet: true });
        await openCase(caseId, true);
      } catch (error) { toast(error.message); }
      finally { button.disabled = false; }
    }));

    document.getElementById("agent-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = document.getElementById("agent-message");
      const message = input.value.trim();
      if (!message) return;
      input.disabled = true;
      try {
        const result = await api(`/api/dashboard/cases/${caseId}/conversation`, { method: "POST", body: JSON.stringify({ message }) });
        toast(result.reply || "Agent turn completed");
        await refreshAll({ quiet: true });
        await openCase(caseId, true);
      } catch (error) { toast(error.message); input.disabled = false; }
    });

    document.getElementById("promise-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const amountRupees = Number(document.getElementById("promise-amount").value);
      const due = document.getElementById("promise-due").value;
      const note = document.getElementById("promise-note").value.trim();
      try {
        await api(`/api/dashboard/cases/${caseId}/promises`, { method: "POST", body: JSON.stringify({ promisedAmount: Math.round(amountRupees * 100), dueAt: new Date(due).toISOString(), note, source: "merchant_dashboard" }) });
        toast("Promise-to-Pay persisted");
        await refreshAll({ quiet: true });
        await openCase(caseId, true);
      } catch (error) { toast(error.message); }
    });
  } catch (error) {
    content.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function closeDrawer() {
  state.selectedCaseId = null;
  const drawer = document.getElementById("case-drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  const titles = { overview: "Revenue Recovery Command Center", cases: "Recovery Cases", activity: "Live Recovery Activity", escalations: "Human Review Queue", policy: "Policy Control Center" };
  document.getElementById("page-title").textContent = titles[viewName] || "Recovery OS";
}

async function loadSummary() { state.summary = await api("/api/dashboard/summary"); renderMetricGrid(state.summary); renderBars("status-chart", state.summary.statuses, "status", "count"); renderBars("cause-chart", state.summary.rootCauses, "rootCause", "count"); renderCaseTable("recent-cases", state.summary.recentCases); }
async function loadCases() { const search = document.getElementById("case-search").value.trim(); const status = document.getElementById("case-status").value; const params = new URLSearchParams({ limit: "100" }); if (search) params.set("search", search); if (status) params.set("status", status); const result = await api(`/api/dashboard/cases?${params}`); state.cases = result.cases; renderCaseTable("cases-table", result.cases); }
async function loadEscalations() { const result = await api("/api/dashboard/escalations"); state.escalations = result.items; renderEscalations(result.items); }
async function loadPolicy() { state.policy = await api("/api/dashboard/policy"); renderPolicy(state.policy); }
async function loadActivity() { const result = await api("/api/dashboard/activity?limit=60"); state.activity = result.items; renderActivity("activity-preview", state.activity, 8); renderActivity("activity-list", state.activity); }
async function loadLive() {
  state.live = await api("/api/dashboard/live/status");
  const indicator = document.getElementById("live-indicator");
  indicator.classList.toggle("offline", !state.live.live);
  indicator.querySelector("b").textContent = state.live.live ? "LIVE" : "OFFLINE";
  document.getElementById("console-mode").textContent = state.live.testConsoleEnabled ? "Local test console: ENABLED" : "Local test console: read-only";
}

async function refreshAll(options = {}) {
  if (state.refreshing) return;
  state.refreshing = true;
  const button = document.getElementById("refresh-button");
  if (!options.quiet) { button.disabled = true; button.textContent = "Syncing…"; }
  try {
    await Promise.all([loadLive(), loadSummary(), loadCases(), loadEscalations(), loadPolicy(), loadActivity()]);
    document.getElementById("last-sync").textContent = `Last live sync ${new Date().toLocaleTimeString()} · ${state.summary.totalCases} cases`;
  } catch (error) {
    document.getElementById("live-indicator").classList.add("offline");
    document.getElementById("live-indicator").querySelector("b").textContent = "DEGRADED";
    if (!options.quiet) toast(error.message || "Unable to sync dashboard");
  } finally {
    state.refreshing = false;
    button.disabled = false;
    button.textContent = "Refresh now";
  }
}

async function autoTick() {
  if (!document.getElementById("auto-refresh")?.checked || document.hidden) return;
  await refreshAll({ quiet: true });
  const active = document.activeElement;
  const editing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
  if (state.selectedCaseId && !editing) await openCase(state.selectedCaseId, true);
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item[data-view]").forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  document.querySelectorAll("[data-open-view]").forEach((item) => item.addEventListener("click", () => showView(item.dataset.openView)));
  document.querySelectorAll("[data-close-drawer]").forEach((item) => item.addEventListener("click", closeDrawer));
  document.getElementById("refresh-button").addEventListener("click", () => refreshAll());
  document.getElementById("apply-case-filter").addEventListener("click", loadCases);
  document.getElementById("case-search").addEventListener("keydown", (event) => { if (event.key === "Enter") loadCases(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
  refreshAll();
  setInterval(autoTick, 3000);
});
