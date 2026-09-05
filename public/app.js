const $=(id)=>document.getElementById(id);
const money=(paise)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((Number(paise)||0)/100);
const fmtDate=(v)=>v?new Date(v).toLocaleString('en-IN'):'—';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actionLabel=(v)=>({retry_now:'issue recovery payment link',retry_with_backoff:'issue recovery payment link after backoff',issue_recovery_payment_link:'issue recovery payment link',issue_recovery_payment_link_after_backoff:'issue recovery payment link after backoff'}[v]||String(v??'—').split('_').join(' '));
let summary=null,cases=[],liveStatus=null;

async function api(url,options){const r=await fetch(url,options);const body=await r.json().catch(()=>({}));if(!r.ok)throw new Error(body.error||`Request failed (${r.status})`);return body}
function trusted(c){return c.financialStatus==='RECOVERED'&&c.status==='RECOVERED'&&Number(c.recoveredAmount)>0&&c.recoveredAt&&c.razorpayPaymentLinkId&&c.terminalReason==='trusted_payment_link_paid'}
function status(s){return `<span class="status ${esc(s)}">${esc(String(s??'—').split('_').join(' '))}</span>`}
function toast(msg){$('toast').textContent=msg;$('toast').classList.add('show');setTimeout(()=>$('toast').classList.remove('show'),2200)}
function showView(name){document.querySelectorAll('.app-view').forEach(v=>v.classList.toggle('active',v.id===name));document.querySelectorAll('.side-link').forEach(v=>v.classList.toggle('active',v.dataset.view===name));const titles={overview:'Recovery Overview',recoveries:'Recovery Proof',cases:'Recovery Cases',activity:'Live Pipeline',channels:'Recovery Channels',escalations:'Human Review Queue'};$('view-title').textContent=titles[name]||'Recovery Console'}

document.querySelectorAll('.side-link').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
document.querySelectorAll('[data-jump]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.jump)));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeDrawer()));
$('refresh').addEventListener('click',()=>refreshAll(true));
$('case-search').addEventListener('input',renderCases);
$('case-status').addEventListener('change',renderCases);

function cards(items){return items.map(([l,v,c])=>`<div class="metric-card ${c||''}"><span>${l}</span><strong>${v}</strong></div>`).join('')}
function renderMetrics(){
  $('recovery-metrics').innerHTML=cards([
    ['Trusted recovered',money(summary.confirmedRecovered),'good'],
    ['Recovered cases',summary.recoveredCases,'good'],
    ['Financially open',summary.openCases,''],
    ['Financially stopped',summary.stoppedCases,'']
  ]);
  $('execution-metrics').innerHTML=cards([
    ['Successful actions',summary.successfulActions,''],
    ['Customers contacted',summary.contactsSent,''],
    ['Payment Links created',summary.paymentLinksCreated,''],
    ['Currently active links',summary.activePaymentLinks,'']
  ]);
  $('recovered-total').textContent=money(summary.confirmedRecovered);
  $('proof-total').textContent=money(summary.confirmedRecovered);
}
function renderStrategies(){const rows=summary.strategies||[];$('strategy-table').innerHTML=rows.length?`<table class="data-table"><thead><tr><th>Strategy</th><th>Cases attempted</th><th>Recovered</th><th>Recovery rate</th><th>Revenue recovered</th><th>Avg attempts</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(actionLabel(x.strategy))}</td><td>${x.cases}</td><td>${x.recoveredCases}</td><td>${Number(x.recoveryRate||0).toFixed(1)}%</td><td>${money(x.recoveredAmount)}</td><td>${Number(x.averageAttempts||0).toFixed(1)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No strategy evidence yet.</div>'}
function renderCauseBars(){const max=Math.max(1,...summary.rootCauses.map(x=>x.count));$('cause-bars').innerHTML=summary.rootCauses.length?summary.rootCauses.map(x=>`<div class="bar-row"><span>${esc(x.rootCause.split('_').join(' '))}</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(8,(x.count/max)*100)}%"></div></div><b>${x.count}</b></div>`).join(''):'<div class="empty">No diagnosis data yet.</div>'}
function proofRows(list,limit=3){const rows=list.slice(0,limit);return rows.length?rows.map(c=>`<div class="mini-proof"><span>Case #${c.id} · ${esc(actionLabel(c.strategy||'recovery'))}</span><strong>${money(c.recoveredAmount)}</strong></div>`).join(''):'<div class="empty">No trusted recoveries yet.</div>'}
function caseTable(list,limit){const rows=limit?list.slice(0,limit):list;if(!rows.length)return '<div class="empty">No cases match this view.</div>';return `<table class="data-table"><thead><tr><th>Case</th><th>Customer</th><th>Cause</th><th>Strategy</th><th>Amount</th><th>Financial</th><th>Automation</th></tr></thead><tbody>${rows.map(c=>`<tr class="clickable" data-case="${c.id}"><td>#${c.id}</td><td>${esc(c.customerEmail||'—')}</td><td>${esc((c.rootCause||'pending').split('_').join(' '))}</td><td>${esc(actionLabel(c.strategy||c.finalAction))}</td><td>${money(c.amountAtRisk)}</td><td>${status(c.financialStatus||c.status)}</td><td>${status(c.automationStatus||c.status)}</td></tr>`).join('')}</tbody></table>`}
function recoveryTable(list){if(!list.length)return '<div class="empty">No trusted recoveries yet.</div>';return `<table class="data-table"><thead><tr><th>Case</th><th>Customer</th><th>Recovered</th><th>Strategy</th><th>Recovered at</th><th>Payment Link</th></tr></thead><tbody>${list.map(c=>`<tr class="clickable" data-case="${c.id}"><td>#${c.id}</td><td>${esc(c.customerEmail||'—')}</td><td><b>${money(c.recoveredAmount)}</b></td><td>${esc(actionLabel(c.strategy))}</td><td>${fmtDate(c.recoveredAt)}</td><td><code>${esc(c.razorpayPaymentLinkId)}</code></td></tr>`).join('')}</tbody></table>`}
function bindCaseClicks(root=document){root.querySelectorAll('[data-case]').forEach(r=>r.addEventListener('click',()=>openCase(Number(r.dataset.case))))}
function renderCases(){const q=$('case-search').value.trim().toLowerCase();const s=$('case-status').value;const filtered=cases.filter(c=>(!s||c.status===s||c.financialStatus===s||c.automationStatus===s)&&(!q||[c.customerEmail,c.originalEventId,c.originalPaymentId].some(v=>String(v||'').toLowerCase().includes(q))));$('cases-table').innerHTML=caseTable(filtered);bindCaseClicks($('cases-table'))}
function renderCore(){const recovered=cases.filter(trusted).sort((a,b)=>new Date(b.recoveredAt)-new Date(a.recoveredAt));renderMetrics();renderStrategies();renderCauseBars();$('recovery-preview').innerHTML=proofRows(recovered);$('recovery-table').innerHTML=recoveryTable(recovered);$('case-preview').innerHTML=caseTable(cases,6);renderCases();bindCaseClicks($('case-preview'));bindCaseClicks($('recovery-table'))}

async function loadActivity(){const data=await api('/api/dashboard/activity?limit=35');$('activity-stream').innerHTML=data.items.length?data.items.map(x=>`<div class="timeline-item"><i class="timeline-dot"></i><b>${esc(x.stage.split('_').join(' '))}</b><span>${x.caseId?`Case #${x.caseId}`:esc(x.eventId)}</span><time>${fmtDate(x.createdAt)}</time></div>`).join(''):'<div class="empty">No audit activity yet.</div>'}
async function loadChannels(){const [s,d]=await Promise.all([api('/api/channels/status'),api('/api/channels/deliveries?limit=30')]);$('channel-status').innerHTML=s.providers.map(p=>`<div><span class="kicker">${esc(p.channel)}</span><h3 class="${p.live?'provider-live':'provider-sim'}">${p.live?'Live · '+esc(p.provider):'Simulation ready'}</h3><p>${esc(p.live?p.reason:'Provider credentials optional; workflow stays testable in explicit simulation mode.')}</p></div>`).join('');$('channel-table').innerHTML=d.items.length?`<table class="data-table"><thead><tr><th>Channel</th><th>Recipient</th><th>Provider</th><th>Provider message ID</th><th>Status</th><th>Sent</th></tr></thead><tbody>${d.items.map(x=>`<tr><td>${esc(x.channel)}</td><td>${esc(x.recipient)}</td><td>${esc(x.provider)}</td><td><code>${esc(x.providerMessageId||'—')}</code></td><td>${status(x.status)}</td><td>${fmtDate(x.createdAt)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No channel deliveries yet.</div>'}
async function loadEscalations(){const d=await api('/api/dashboard/escalations?limit=30');$('escalation-list').innerHTML=d.items.length?d.items.map(x=>`<div class="queue-card"><span class="kicker">Case #${x.caseId}</span><h3>${esc(x.customerEmail||'Customer')}</h3><p><b>Why automation stopped:</b> ${esc(x.reason)}</p><div class="proof-row"><span>Financial state</span><strong>${esc(x.financialStatus||'—')}</strong></div><div class="proof-row"><span>Automation state</span><strong>${esc(x.automationStatus||x.status)}</strong></div><div class="proof-row"><span>Amount at risk</span><strong>${money(x.amountAtRisk)}</strong></div></div>`).join(''):'<div class="empty">No human-review work items.</div>'}

function linkHistoryTable(links){if(!links.length)return '<div class="empty">No recovery Payment Links for this case.</div>';return `<table class="data-table"><thead><tr><th>Attempt</th><th>Link</th><th>Lifecycle</th><th>Provider</th><th>Amount</th><th>Paid</th><th>Created</th></tr></thead><tbody>${links.map((x,i)=>`<tr><td>#${links.length-i}</td><td><code>${esc(x.paymentLinkId)}</code>${x.current?' · current':''}</td><td>${status(x.status)}</td><td>${esc(x.providerStatus||'—')}</td><td>${x.amount==null?'—':money(x.amount)}</td><td>${money(x.amountPaid)}</td><td>${fmtDate(x.createdAt)}</td></tr>`).join('')}</tbody></table>`}

async function openCase(id){
  try{
    const [c,runtime,conversation,promises,timeline,links]=await Promise.all([
      api(`/api/dashboard/cases/${id}`),api(`/api/dashboard/cases/${id}/runtime`),api(`/api/dashboard/cases/${id}/conversation`),api(`/api/dashboard/cases/${id}/promises`),api(`/api/dashboard/cases/${id}/timeline`),api(`/api/dashboard/cases/${id}/payment-links`)
    ]);
    $('drawer-title').textContent=`Case #${id}`;
    const plan=runtime.plans[0];
    const stopReason=c.terminalReason||c.escalationReason||'Automation is still active or waiting for an outcome.';
    $('drawer-body').innerHTML=`
      <div class="detail-grid">
        <div class="detail-card"><span>Financial state</span><strong>${esc(c.financialStatus||c.status)}</strong></div>
        <div class="detail-card"><span>Automation state</span><strong>${esc(c.automationStatus||c.status)}</strong></div>
        <div class="detail-card"><span>Amount at risk</span><strong>${money(c.amountAtRisk)}</strong></div>
        <div class="detail-card"><span>Recovered</span><strong>${trusted(c)?money(c.recoveredAmount):'Not yet confirmed'}</strong></div>
        <div class="detail-card"><span>Diagnosis</span><strong>${esc((c.rootCause||'pending').split('_').join(' '))} ${c.confidence!=null?`· ${(c.confidence*100).toFixed(0)}%`:''}</strong></div>
        <div class="detail-card"><span>Verifier</span><strong>${esc(c.verifierResult||'pending')}</strong></div>
      </div>
      <div class="detail-card"><span>Why automation stopped / current reason</span><strong>${esc(stopReason.split('_').join(' '))}</strong></div>
      ${trusted(c)?`<div class="detail-card"><span>Trusted outcome</span><strong>${money(c.recoveredAmount)} recovered · ${fmtDate(c.recoveredAt)}</strong><small><code>${esc(c.razorpayPaymentLinkId)}</code></small></div>`:''}
      <section class="drawer-section"><h3>Payment Link lifecycle</h3>${linkHistoryTable(links.items)}</section>
      <section class="drawer-section"><h3>Latest AI recovery plan</h3>${plan?`<div class="detail-card"><span>Plan v${plan.version} · ${esc(plan.trigger)}</span><strong>${esc(actionLabel(plan.primaryAction))} → fallback ${esc(actionLabel(plan.fallbackAction))}</strong><p>${esc(plan.reasoning)}</p></div>`:'<div class="empty">No recovery plan yet.</div>'}</section>
      <section class="drawer-section"><h3>Scheduled work & contacts</h3><div class="detail-grid"><div class="detail-card"><span>Scheduled actions</span><strong>${runtime.scheduledActions.length}</strong></div><div class="detail-card"><span>Customer contacts</span><strong>${runtime.contacts.length}</strong></div><div class="detail-card"><span>Payment promises</span><strong>${promises.items.length}</strong></div><div class="detail-card"><span>Action attempts</span><strong>${runtime.actions.length}</strong></div></div></section>
      <section class="drawer-section"><h3>Customer conversation</h3>${conversation.messages.length?conversation.messages.filter(m=>m.content).map(m=>`<div class="message ${esc(m.role)}"><b>${esc(m.role)}</b><div>${esc(m.content)}</div></div>`).join(''):'<div class="empty">Conversation not started.</div>'}</section>
      <section class="drawer-section"><h3>Audit trail</h3><div class="timeline">${timeline.events.slice(-12).map(x=>`<div class="timeline-item"><i class="timeline-dot"></i><b>${esc(x.stage.split('_').join(' '))}</b><span></span><time>${fmtDate(x.createdAt)}</time></div>`).join('')}</div></section>
      ${liveStatus?.testConsoleEnabled&&c.financialStatus==='OPEN'&&!['ESCALATED','STOPPED'].includes(c.automationStatus)?`<section class="drawer-section"><h3>Local demo controls</h3><p>Visible only on localhost when <code>RECOVERY_ENABLE_TEST_CONSOLE=true</code>.</p><div class="hero-actions"><button class="button ghost demo-action" data-action="refresh_priority">Refresh priority</button><button class="button ghost demo-action" data-action="issue_recovery_payment_link_after_backoff">Issue link after backoff</button><button class="button ghost demo-action" data-action="whatsapp_nudge">Start outreach</button></div></section>`:''}`;
    $('drawer').classList.add('open');$('drawer').setAttribute('aria-hidden','false');
    document.querySelectorAll('.demo-action').forEach(b=>b.addEventListener('click',async()=>{try{await api(`/api/dashboard/cases/${id}/test-action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.dataset.action})});toast('Demo action accepted');await refreshAll();await openCase(id)}catch(e){toast(e.message)}}));
  }catch(e){toast(e.message)}
}
function closeDrawer(){$('drawer').classList.remove('open');$('drawer').setAttribute('aria-hidden','true')}

async function refreshAll(showToast=false){
  try{
    const [s,c,l]=await Promise.all([api('/api/dashboard/summary'),api('/api/dashboard/cases?limit=100'),api('/api/dashboard/live/status')]);summary=s;cases=c.cases;liveStatus=l;renderCore();await Promise.all([loadActivity(),loadChannels(),loadEscalations()]);$('backend-status').textContent=l.database==='connected'?'● Backend live':'Backend unavailable';$('last-sync').textContent=`Synced ${new Date(s.generatedAt).toLocaleTimeString('en-IN')}`;if(showToast)toast('Dashboard synced');
  }catch(e){$('backend-status').textContent='Backend unavailable';toast(e.message)}
}
refreshAll();setInterval(()=>refreshAll(),5000);
