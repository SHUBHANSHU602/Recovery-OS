import "dotenv/config";
import assert from "node:assert/strict";
import { Pool } from "pg";

type LinkRow = {
  action_id: string;
  idempotency_key: string;
  payment_link_id: string;
  short_url: string | null;
  case_id: string | null;
  case_status: string | null;
  amount_at_risk: string | null;
  recovered_amount: string | null;
  razorpay_payment_link_id: string | null;
  terminal_reason: string | null;
};

type ProviderLink = { id: string; status: string; amount: number; amount_paid: number; short_url?: string | null };
function rupees(paise: number): string { return `₹${(paise / 100).toFixed(2)}`; }

async function loadProviderCreatedLinks(pool: Pool): Promise<LinkRow[]> {
  const result = await pool.query(`
    SELECT
      a.id AS action_id, a.idempotency_key, a.response->>'id' AS payment_link_id, a.response->>'short_url' AS short_url,
      COALESCE(rpl.case_id, rc_by_link.id, rc_by_intervention.id, rc_by_prefix.id) AS case_id,
      COALESCE(rc_history.status, rc_by_link.status, rc_by_intervention.status, rc_by_prefix.status) AS case_status,
      COALESCE(rc_history.amount_at_risk, rc_by_link.amount_at_risk, rc_by_intervention.amount_at_risk, rc_by_prefix.amount_at_risk) AS amount_at_risk,
      COALESCE(rc_history.recovered_amount, rc_by_link.recovered_amount, rc_by_intervention.recovered_amount, rc_by_prefix.recovered_amount) AS recovered_amount,
      COALESCE(rc_history.razorpay_payment_link_id, rc_by_link.razorpay_payment_link_id, rc_by_intervention.razorpay_payment_link_id, rc_by_prefix.razorpay_payment_link_id) AS razorpay_payment_link_id,
      COALESCE(rc_history.terminal_reason, rc_by_link.terminal_reason, rc_by_intervention.terminal_reason, rc_by_prefix.terminal_reason) AS terminal_reason
    FROM actions a
    LEFT JOIN recovery_payment_links rpl ON rpl.payment_link_id = a.response->>'id'
    LEFT JOIN recovery_cases rc_history ON rc_history.id = rpl.case_id
    LEFT JOIN interventions i ON i.id = a.intervention_id
    LEFT JOIN diagnoses d ON d.id = i.diagnosis_id
    LEFT JOIN recovery_cases rc_by_link ON rc_by_link.razorpay_payment_link_id = a.response->>'id'
    LEFT JOIN recovery_cases rc_by_intervention ON rc_by_intervention.original_event_id = d.event_id
    LEFT JOIN LATERAL (
      SELECT e.event_id FROM events e
      WHERE a.idempotency_key LIKE e.event_id || '%'
      ORDER BY length(e.event_id) DESC LIMIT 1
    ) matched ON true
    LEFT JOIN recovery_cases rc_by_prefix ON rc_by_prefix.original_event_id = matched.event_id
    WHERE a.razorpay_api_call = 'payment_links.create'
      AND a.status = 'success'
      AND a.response->>'id' IS NOT NULL
    ORDER BY a.id ASC
  `);
  return result.rows as LinkRow[];
}

async function fetchProviderLink(linkId: string, auth: string): Promise<ProviderLink> {
  const response = await fetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(linkId)}`, { headers: { Authorization: `Basic ${auth}` } });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(`Razorpay lookup failed for ${linkId}: ${body?.error?.description ?? body?.error?.reason ?? `HTTP ${response.status}`}`);
  return { id: String(body.id), status: String(body.status), amount: Number(body.amount ?? 0), amount_paid: Number(body.amount_paid ?? 0), short_url: body.short_url == null ? null : String(body.short_url) };
}

async function printPortfolioMetrics(pool: Pool, caseIds: number[]) {
  if (!caseIds.length) return;
  const portfolio = await pool.query(`
    SELECT
      COUNT(*) AS cases,
      COALESCE(SUM(amount_at_risk),0) AS revenue_at_risk,
      COUNT(*) FILTER (WHERE financial_status='RECOVERED' AND terminal_reason='trusted_payment_link_paid') AS recovered_cases,
      COALESCE(SUM(recovered_amount) FILTER (WHERE financial_status='RECOVERED' AND terminal_reason='trusted_payment_link_paid'),0) AS recovered_amount,
      COUNT(*) FILTER (WHERE financial_status='OPEN') AS unresolved_cases,
      COUNT(*) FILTER (WHERE financial_status='STOPPED') AS stopped_cases,
      COUNT(*) FILTER (WHERE automation_status='ESCALATED') AS escalated_cases
    FROM recovery_cases WHERE id = ANY($1::bigint[])`, [caseIds]);
  const p = portfolio.rows[0];
  const attempts = await pool.query(`
    SELECT COALESCE(AVG(link_count),0) AS average_attempts
    FROM (
      SELECT case_id, COUNT(*)::numeric AS link_count
      FROM recovery_payment_links WHERE case_id = ANY($1::bigint[]) GROUP BY case_id
    ) x`, [caseIds]);
  const duplicateActive = await pool.query(`
    SELECT COUNT(*) AS violations FROM (
      SELECT case_id FROM recovery_payment_links
      WHERE case_id = ANY($1::bigint[]) AND status='ACTIVE'
      GROUP BY case_id HAVING COUNT(*) > 1
    ) x`, [caseIds]);
  const strategies = await pool.query(`
    SELECT COALESCE(strategy,'unassigned') AS strategy,
           COUNT(*) AS cases,
           COUNT(*) FILTER (WHERE financial_status='RECOVERED' AND terminal_reason='trusted_payment_link_paid') AS recovered_cases,
           COALESCE(SUM(recovered_amount) FILTER (WHERE financial_status='RECOVERED' AND terminal_reason='trusted_payment_link_paid'),0) AS recovered_amount
    FROM recovery_cases WHERE id = ANY($1::bigint[])
    GROUP BY COALESCE(strategy,'unassigned') ORDER BY cases DESC, strategy`, [caseIds]);

  const total = Number(p.cases ?? 0); const recovered = Number(p.recovered_cases ?? 0);
  console.log("\nProvider-backed portfolio metrics");
  console.log(`Failed-payment cases represented: ${total}`);
  console.log(`Revenue at risk: ${rupees(Number(p.revenue_at_risk ?? 0))}`);
  console.log(`Cases recovered: ${recovered}`);
  console.log(`Cases unresolved (financial OPEN): ${Number(p.unresolved_cases ?? 0)}`);
  console.log(`Cases escalated (automation): ${Number(p.escalated_cases ?? 0)}`);
  console.log(`Cases stopped financially: ${Number(p.stopped_cases ?? 0)}`);
  console.log(`Observed controlled-dataset recovery percentage: ${total ? ((recovered / total) * 100).toFixed(1) : '0.0'}%`);
  console.log(`Average recovery Payment Links per represented case: ${Number(attempts.rows[0]?.average_attempts ?? 0).toFixed(2)}`);
  console.log(`Cases with >1 locally ACTIVE recovery link: ${Number(duplicateActive.rows[0]?.violations ?? 0)}`);
  console.log("Strategy | cases | recovered | rate | recovered revenue");
  for (const s of strategies.rows) {
    const cases = Number(s.cases); const rec = Number(s.recovered_cases);
    console.log(`${s.strategy} | ${cases} | ${rec} | ${cases ? ((rec/cases)*100).toFixed(1) : '0.0'}% | ${rupees(Number(s.recovered_amount ?? 0))}`);
  }
  console.log("NOTE: recovery percentage is descriptive for this controlled Test Mode dataset, not a production conversion-rate claim.");
}

async function main() {
  const keyId = process.env.RAZORPAY_KEY_ID; const keySecret = process.env.RAZORPAY_KEY_SECRET;
  assert.ok(keyId && keySecret, "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required for provider reconciliation");
  const pool = new Pool();
  try {
    const rows = await loadProviderCreatedLinks(pool);
    assert.ok(rows.length > 0, "No successful Razorpay Payment Link creations were found in the local ledger");
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    let providerPaid=0,providerUnpaid=0,paidCorrect=0,unpaidCorrect=0,providerBackedRecoveredPaise=0;
    const mismatches:string[]=[]; const caseIds=new Set<number>();
    const providerPaidByCase = new Map<number, string[]>();

    console.log("\nRecovery OS — Razorpay provider reconciliation\n");
    console.log("link_id | provider | amount_paid | case | case_status | recovered_amount | verdict");
    for (const row of rows) {
      const provider=await fetchProviderLink(row.payment_link_id,auth);
      const caseId=row.case_id==null?null:Number(row.case_id); if(caseId!=null)caseIds.add(caseId);
      const recoveredAmount=Number(row.recovered_amount??0); const currentCaseLink=row.razorpay_payment_link_id; let verdict="PASS";
      if(provider.status==="paid"&&provider.amount_paid>0){
        providerPaid+=1;
        if(caseId!=null){const links=providerPaidByCase.get(caseId)??[];links.push(provider.id);providerPaidByCase.set(caseId,links);}
        const expectedRecovered=Math.min(Number(row.amount_at_risk??provider.amount_paid),provider.amount_paid);
        const valid=caseId!=null&&row.case_status==="RECOVERED"&&recoveredAmount===expectedRecovered&&row.terminal_reason==="trusted_payment_link_paid"&&currentCaseLink===provider.id;
        if(valid){paidCorrect+=1;providerBackedRecoveredPaise+=recoveredAmount;}else{verdict="MISMATCH";mismatches.push(`${provider.id}: provider is paid (${provider.amount_paid}) but ledger case=${caseId??"none"}, status=${row.case_status??"none"}, recovered=${recoveredAmount}, terminal=${row.terminal_reason??"none"}, currentLink=${currentCaseLink??"none"}`);}
      }else{
        providerUnpaid+=1; const falselyAttributed=row.case_status==="RECOVERED"&&currentCaseLink===provider.id&&recoveredAmount>0;
        if(!falselyAttributed)unpaidCorrect+=1;else{verdict="MISMATCH";mismatches.push(`${provider.id}: provider status=${provider.status}, amount_paid=${provider.amount_paid}, but ledger attributes positive recovery to this link`);}
      }
      console.log(`${provider.id} | ${provider.status} | ${rupees(provider.amount_paid)} | ${caseId??"-"} | ${row.case_status??"-"} | ${rupees(recoveredAmount)} | ${verdict}`);
    }

    const duplicateProviderPaidCases = [...providerPaidByCase.entries()].filter(([,links])=>links.length>1);
    for(const [caseId,links] of duplicateProviderPaidCases){
      mismatches.push(`case ${caseId}: multiple provider-paid recovery links detected (${links.join(', ')}). This is a duplicate-payment integrity violation.`);
    }

    console.log("\nSummary");
    console.log(`Provider links checked: ${rows.length}`); console.log(`Provider-paid links: ${providerPaid}`); console.log(`Provider-unpaid links: ${providerUnpaid}`);
    console.log(`Paid links correctly reconciled: ${paidCorrect}/${providerPaid}`); console.log(`Unpaid links not falsely attributed to recovered revenue: ${unpaidCorrect}/${providerUnpaid}`);
    console.log(`Cases with multiple provider-paid recovery links: ${duplicateProviderPaidCases.length}`);
    console.log(`Provider-backed recovered amount: ${rupees(providerBackedRecoveredPaise)}`); console.log(`Mismatches: ${mismatches.length}`);
    await printPortfolioMetrics(pool,[...caseIds]);

    if(mismatches.length){console.error("\nReconciliation mismatches:");for(const mismatch of mismatches)console.error(`- ${mismatch}`);throw new Error("Provider reconciliation FAILED");}
    assert.equal(paidCorrect,providerPaid,"Every provider-paid link must reconcile to trusted recovered accounting");
    assert.equal(unpaidCorrect,providerUnpaid,"No provider-unpaid link may be falsely attributed to recovered revenue");
    assert.equal(duplicateProviderPaidCases.length,0,"No recovery case may have multiple provider-paid recovery links");
    console.log("\nPROVIDER RECONCILIATION RESULT: PASS");
  } finally { await pool.end(); }
}

main().catch((error)=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
