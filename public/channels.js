const providerGrid = document.getElementById('provider-grid');
const deliveriesBody = document.getElementById('deliveries');
const sendForm = document.getElementById('send-form');
const resultBox = document.getElementById('send-result');
const toast = document.getElementById('toast');
let refreshing = false;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function renderProviders(items) {
  providerGrid.innerHTML = items.map((item) => `
    <article class="provider">
      <h3>${escapeHtml(item.channel)}</h3>
      <span class="badge ${item.live ? 'live' : 'simulated'}">${item.live ? 'LIVE' : 'SIMULATED'}</span>
      <p><strong>${escapeHtml(item.provider)}</strong></p>
      <p>${escapeHtml(item.reason)}</p>
    </article>
  `).join('');
}

function renderDeliveries(items) {
  deliveriesBody.innerHTML = items.length ? items.map((item) => `
    <tr>
      <td>#${item.id}</td>
      <td>#${item.caseId}</td>
      <td>${escapeHtml(item.channel)}</td>
      <td>${escapeHtml(item.recipient)}</td>
      <td>${escapeHtml(item.provider)}</td>
      <td>${escapeHtml(item.status)}</td>
      <td>${new Date(item.createdAt).toLocaleString()}</td>
    </tr>
  `).join('') : '<tr><td colspan="7">No channel attempts yet.</td></tr>';
}

async function refresh({ quiet = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const [status, deliveries] = await Promise.all([
      fetchJson('/api/channels/status'),
      fetchJson('/api/channels/deliveries?limit=100'),
    ]);
    renderProviders(status.providers || []);
    renderDeliveries(deliveries.items || []);
  } catch (error) {
    if (!quiet) showToast(error.message);
  } finally {
    refreshing = false;
  }
}

sendForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const caseId = Number(document.getElementById('case-id').value);
  const channel = document.getElementById('channel').value;
  const message = document.getElementById('message').value.trim();
  resultBox.hidden = true;
  try {
    const result = await fetchJson(`/api/channels/cases/${caseId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, message: message || null }),
    });
    resultBox.hidden = false;
    resultBox.textContent = `${result.live ? 'LIVE' : 'SIMULATED'} ${result.channel.toUpperCase()} delivery\nStatus: ${result.status}\nProvider: ${result.provider}\nRecipient: ${result.recipient}`;
    showToast('Recovery contact recorded');
    await refresh();
  } catch (error) {
    resultBox.hidden = false;
    resultBox.textContent = `Blocked / failed: ${error.message}`;
    showToast(error.message);
  }
});

document.getElementById('refresh').addEventListener('click', () => refresh());
const linkedCase = new URLSearchParams(window.location.search).get('caseId');
if (linkedCase) document.getElementById('case-id').value = linkedCase;
refresh();
setInterval(() => { if (!document.hidden) refresh({ quiet: true }); }, 3000);
