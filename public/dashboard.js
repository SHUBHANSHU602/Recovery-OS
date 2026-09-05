const state = {
  summary: null,
  cases: [],
  escalations: [],
  policy: null,
};

const money = (paise) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
}).format(Number(paise || 0) / 100);

const pct = (value) => value == null ? "—" : `${Number(value).toFixed(1)}%`;
const fmtDate = (value) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return response.json();
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2500);
}

function statusBadge(status) {
  return `<span class="status ${esc(status)}">${esc(status)}</span>`;
}

function renderMetricGrid(summary) {
  const cards = [
    ["Revenue at risk", money(summary.revenueAtRisk), `${summary.totalCases} durable recovery cases`],
    ["Expected recoverable value", money(summary.expectedRecoveryValue), "Priority model over open cases"],
    ["Confirmed recovered", money(summary.confirmedRecovered), `${summary.recoveredCases} provider-confirmed case(s)`],
    ["Value recovery", pct(summary.valueRecoveryRate), "Only trusted paid outcomes count"],
    ["Diagnosis accuracy", pct(summary.diagnosisAccuracy), `${summary.diagnosisCorrect}/${summary.diagnosisTotal || 0} labeled cases`],
    ["Promise to pay", summary.activePromises, "Active durable customer commitments"],
    ["Open cases", summary.openCases, `${summary.waitingCases} waiting · ${summary.scheduledCases} scheduled`],
    ["Human escalations", summary.escalatedCases, "Policy and ambiguity remain human-owned"],
  ];

  document.getElementById("metric-grid").innerHTML = cards.map(([label, value, foot]) => `
    <article class="metric-card">
      <div class="metric-label">${label}</div>
      <div class="metric-value">${value}</div>
      <div class="metric-foot">${foot}</div>
    </article>
  `).join("");
}

function renderBars(targetId, items, labelKey, valueKey) {
  const target = document.getElementById(targetId);
  if (!items.length) {
    target.innerHTML = `<div class="empty">No data yet.</div>`;
    return;
  }
  const max = Math.max(...items.map((item) => Number(item[valueKey] || 0)), 1);
  target.innerHTML = items.map((item) => {
    const value = Number(item[valueKey] || 0);
    return `
      <div class="bar-row">
        <div class="bar-meta"><span>${esc(item[labelKey])}</span><span>${value}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (value / max) * 100)}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderStrategyTable(strategies) {
  const target = document.getElementById("strategy-table");
  if (!strategies.length) {
    target.innerHTML = `<div class="empty">No strategy data yet.</div>`;
    return;
  }
  target.innerHTML = `
    <table>
      <thead><tr><th>Strategy</th><th>Cases</th><th>Recovered cases</th><th>Confirmed value</th></tr></thead>
      <tbody>
        ${strategies.map((item) => `<tr>
          <td>${esc(item.strategy)}</td>
          <td>${item.cases}</td>
          <td>${item.recoveredCases}</td>
          <td>${money(item.recoveredAmount)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  `;
}

function caseRows(cases) {
  return cases.map((item) => `
    <tr class="clickable" data-case-id="${item.id}">
      <td>#${item.id}</td>
      <td><strong>${esc(item.customerEmail || "Unknown")}</strong><br><span class="muted">${esc(item.bank || "—")}</span></td>
      <td>${money(item.amountAtRisk)}</td>
      <td>${money(item.expectedRecoveryValue || 0)}<br><span class="muted">${item.recoveryProbability == null ? "—" : pct(item.recoveryProbability * 100)}</span></td>
      <td>${esc(item.rootCause || "Awaiting diagnosis")}</td>
      <td>${esc(item.strategy || item.finalAction || "—")}</td>
      <td>${statusBadge(item.status)}</td>
      <td>${fmtDate(item.updatedAt)}</td>
    </tr>
  `).join("");
}

function bindCaseRows(container) {
  container.querySelectorAll("[data-case-id]").forEach((row) => {
    row.addEventListener("click", () => openCase(Number(row.dataset.caseId)));
  });
}

function renderCaseTable(targetId, cases) {
  const target = document.getElementById(targetId);
  if (!cases.length) {
    target.innerHTML = `<div class="empty">No recovery cases match this view.</div>`;
    return;
  }
  target.innerHTML = `
    <table>
      <thead><tr><th>Case</th><th>Customer</th><th>At risk</th><th>Expected value</th><th>Diagnosis</th><th>Strategy</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${caseRows(cases)}</tbody>
    </table>
  `;
  bindCaseRows(target);
}

function renderEscalations(items) {
  const target = document.getElementById("escalation-list");
  if (!items.length) {
    target.innerHTML = `<div class="empty">No human escalations.</div>`;
    return;
  }
  target.innerHTML = items.map((item) => `
    <article class="queue-card" data-case-id="${item.caseId}">
      <div class="queue-top">
        <div><strong>Case #${item.caseId}</strong><span class="muted">${esc(item.customerEmail || "Unknown customer")}</span></div>
        ${statusBadge(item.status)}
      </div>
      <p>${esc(item.reason)}</p>
      <div class="queue-meta">
        <span>${money(item.amountAtRisk)} at risk</span>
        <span>${money(item.expectedRecoveryValue || 0)} expected</span>
        <span>${esc(item.rootCause || "No diagnosis")}</span>
        <span>${fmtDate(item.updatedAt)}</span>
      </div>
    </article>
  `).join("");
  target.querySelectorAll("[data-case-id]").forEach((card) => card.addEventListener("click", () => openCase(Number(card.dataset.caseId))));
}

function renderPolicy(policy) {
  const quiet = policy.quietHours
    ? `${String(policy.quietHours.startHour).padStart(2, "0")}:00–${String(policy.quietHours.endHour).padStart(2, "0")}:00 (${policy.quietHours.timeZone})`
    : "Disabled";
  const entries = [
    ["Decision authority", policy.mode],
    ["Maximum automated retries", policy.maxAutomatedRetries],
    ["Maximum contacts / 24h", policy.maxContactsPerDay],
    ["Already recovered", policy.recoveredCaseBehavior],
    ["Customer opted out", policy.optedOutBehavior],
    ["Ambiguous execution", policy.ambiguousExecutionBehavior],
    ["Quiet hours", quiet],
    ["Prioritization", policy.prioritization],
    ["Promise-to-pay", policy.promiseToPay],
  ];
  document.getElementById("policy-cards").innerHTML = entries.map(([label, value]) => `
    <div class="policy-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>
  `).join("");
}

function detailCard(label, value) {
  return `<div class="detail-card"><span>${esc(label)}</span><strong>${value}</strong></div>`;
}

async function openCase(caseId) {
  const drawer = document.getElementById("case-drawer");
  const content = document.getElementById("drawer-content");
  document.getElementById("drawer-title").textContent = `Case #${caseId}`;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  content.innerHTML = `<div class="empty">Loading trusted case history…</div>`;

  try {
    const [item, timeline, promises] = await Promise.all([
      api(`/api/dashboard/cases/${caseId}`),
      api(`/api/dashboard/cases/${caseId}/timeline`),
      api(`/api/dashboard/cases/${caseId}/promises`),
    ]);

    const activePromise = promises.items.find((promise) => promise.status === "PENDING");
    content.innerHTML = `
      <div class="detail-grid">
        ${detailCard("Status", statusBadge(item.status))}
        ${detailCard("Amount at risk", money(item.amountAtRisk))}
        ${detailCard("Expected recovery value", money(item.expectedRecoveryValue || 0))}
        ${detailCard("Recovery probability", item.recoveryProbability == null ? "—" : pct(item.recoveryProbability * 100))}
        ${detailCard("Confirmed recovered", money(item.recoveredAmount))}
        ${detailCard("Customer", esc(item.customerEmail || "—"))}
        ${detailCard("Root cause", esc(item.rootCause || "—"))}
        ${detailCard("Verifier", esc(item.verifierResult || "—"))}
        ${detailCard("Diagnosis confidence", item.confidence == null ? "—" : `${(item.confidence * 100).toFixed(1)}%`)}
        ${detailCard("Strategy", esc(item.strategy || item.finalAction || "—"))}
        ${detailCard("Provider link", esc(item.razorpayPaymentLinkId || "—"))}
        ${detailCard("Terminal reason", esc(item.terminalReason || "—"))}
        ${detailCard("Next scheduled action", fmtDate(item.nextRunAt))}
        ${detailCard("Recovered at", fmtDate(item.recoveredAt))}
      </div>

      <section class="panel accent-panel">
        <p class="eyebrow">Outcome integrity</p>
        <h3>${item.status === "RECOVERED" ? "Provider-confirmed revenue recovery" : "Revenue is not yet counted as recovered"}</h3>
        <p class="muted">${item.status === "RECOVERED" ? "This case has the persisted outcome evidence required by Recovery OS." : "Execution success alone does not increase recovered revenue."}</p>
      </section>

      <section class="panel">
        <div class="panel-header"><p class="eyebrow">Promise to pay</p><h3>${activePromise ? "Active commitment" : "Create customer commitment"}</h3></div>
        ${activePromise ? `
          <div class="detail-grid">
            ${detailCard("Promised amount", money(activePromise.promisedAmount))}
            ${detailCard("Due", fmtDate(activePromise.dueAt))}
            ${detailCard("Source", esc(activePromise.source))}
            ${detailCard("Status", statusBadge(activePromise.status))}
          </div>
        ` : item.status === "RECOVERED" || item.status === "STOPPED" || item.status === "ESCALATED" ? `<div class="empty">Terminal cases cannot accept a new promise.</div>` : `
          <form id="promise-form" class="detail-grid">
            <label class="detail-card"><span>Promised amount (₹)</span><input id="promise-amount" type="number" min="0.01" step="0.01" value="${(item.amountAtRisk / 100).toFixed(2)}" required></label>
            <label class="detail-card"><span>Due at</span><input id="promise-due" type="datetime-local" required></label>
            <label class="detail-card"><span>Note</span><input id="promise-note" type="text" placeholder="Customer said they will pay later"></label>
            <button class="primary-button" type="submit">Save promise</button>
          </form>
        `}
      </section>

      <div class="panel-header"><p class="eyebrow">Audit trail</p><h3>Case timeline</h3></div>
      <div class="timeline">
        ${timeline.events.length ? timeline.events.map((event) => `
          <div class="timeline-item">
            <strong>${esc(event.stage)}</strong>
            <time>${fmtDate(event.createdAt)}</time>
            <div class="timeline-json">${esc(JSON.stringify(event.detail, null, 2))}</div>
          </div>
        `).join("") : `<div class="empty">No audit events recorded.</div>`}
      </div>
    `;

    const form = document.getElementById("promise-form");
    if (form) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          const amountRupees = Number(document.getElementById("promise-amount").value);
          const due = document.getElementById("promise-due").value;
          const note = document.getElementById("promise-note").value.trim();
          await api(`/api/dashboard/cases/${caseId}/promises`, {
            method: "POST",
            body: JSON.stringify({
              promisedAmount: Math.round(amountRupees * 100),
              dueAt: new Date(due).toISOString(),
              note,
              source: "merchant_dashboard",
            }),
          });
          toast("Promise-to-pay scheduled");
          await openCase(caseId);
          await refreshAll();
        } catch (error) {
          toast(error.message || "Unable to save promise");
        }
      });
    }
  } catch (error) {
    content.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function closeDrawer() {
  const drawer = document.getElementById("case-drawer");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${viewName}-view`));
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === viewName));
  const titles = {
    overview: "Revenue Recovery Command Center",
    cases: "Recovery Cases",
    escalations: "Human Review Queue",
    policy: "Policy Control Center",
  };
  document.getElementById("page-title").textContent = titles[viewName] || "Recovery OS";
}

async function loadSummary() {
  state.summary = await api("/api/dashboard/summary");
  renderMetricGrid(state.summary);
  renderBars("status-chart", state.summary.statuses, "status", "count");
  renderBars("cause-chart", state.summary.rootCauses, "rootCause", "count");
  renderStrategyTable(state.summary.strategies);
  renderCaseTable("recent-cases", state.summary.recentCases);
}

async function loadCases() {
  const search = document.getElementById("case-search").value.trim();
  const status = document.getElementById("case-status").value;
  const params = new URLSearchParams({ limit: "100" });
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  const result = await api(`/api/dashboard/cases?${params}`);
  state.cases = result.cases;
  renderCaseTable("cases-table", result.cases);
}

async function loadEscalations() {
  const result = await api("/api/dashboard/escalations");
  state.escalations = result.items;
  renderEscalations(result.items);
}

async function loadPolicy() {
  state.policy = await api("/api/dashboard/policy");
  renderPolicy(state.policy);
}

async function refreshAll() {
  const button = document.getElementById("refresh-button");
  button.disabled = true;
  button.textContent = "Refreshing…";
  try {
    await Promise.all([loadSummary(), loadCases(), loadEscalations(), loadPolicy()]);
    toast("Dashboard synced with Recovery OS");
  } catch (error) {
    console.error(error);
    toast(error.message || "Unable to refresh dashboard");
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  document.querySelectorAll("[data-open-view]").forEach((item) => item.addEventListener("click", () => showView(item.dataset.openView)));
  document.querySelectorAll("[data-close-drawer]").forEach((item) => item.addEventListener("click", closeDrawer));
  document.getElementById("refresh-button").addEventListener("click", refreshAll);
  document.getElementById("apply-case-filter").addEventListener("click", loadCases);
  document.getElementById("case-search").addEventListener("keydown", (event) => { if (event.key === "Enter") loadCases(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDrawer(); });
  refreshAll();
});
