const money=(paise)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format((Number(paise)||0)/100);
async function load(){
  try{
    const [summary,health]=await Promise.all([
      fetch('/api/dashboard/summary').then(r=>r.json()),
      fetch('/health').then(r=>r.json())
    ]);
    document.getElementById('landing-recovered').textContent=money(summary.confirmedRecovered);
    document.getElementById('landing-recovered-cases').textContent=summary.recoveredCases ?? '—';
    document.getElementById('landing-accuracy').textContent=summary.diagnosisAccuracy==null?'—':`${summary.diagnosisAccuracy.toFixed(1)}%`;
    document.getElementById('landing-health').textContent=health.status==='ok'?'Live':'Degraded';
  }catch{
    document.getElementById('landing-health').textContent='Unavailable';
  }
}
load();
