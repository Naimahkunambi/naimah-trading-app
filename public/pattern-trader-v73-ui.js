const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const fmt = (v, n = 1) => Number.isFinite(+v) ? Number(v).toFixed(n) : '—';
const money = v => `${Number(v || 0) >= 0 ? '+' : ''}$${Number(v || 0).toFixed(2)}`;

let mode = 'LIVE';
let replayOffset = 0;
let latest = { analysis: null, setups: [], ticks: [], engine: null };
let replayListener = null;

function installStyles() {
  if ($('v73Styles')) return;
  const style = document.createElement('style');
  style.id = 'v73Styles';
  style.textContent = `
    html{overflow-anchor:none}.v73ModeBar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0 14px}.v73Tabs{display:flex;gap:6px}.v73Tabs button.active{border-color:#f5f7fa;background:#f5f7fa;color:#0b0c0f}.v73ReplayTools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.v73ReplayTools span{font-size:11px;color:#9299a8}.v73Decision{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:12px 0}.v73Gate{border:1px solid #2b3039;border-radius:12px;background:#0f1115;padding:12px;min-height:86px}.v73Gate span,.v73Gate small{display:block;color:#9299a8;font-size:10px}.v73Gate strong{display:block;margin:7px 0;font-size:14px;overflow-wrap:anywhere}.v73Gate.pass{border-color:rgba(103,217,154,.45)}.v73Gate.block{border-color:rgba(255,116,116,.35)}.v73Why{border:1px solid #343a45;border-radius:12px;padding:12px 14px;background:#11141a;margin:8px 0 12px}.v73Why b{display:block;font-size:11px;margin-bottom:4px}.v73Why span{font-size:12px;color:#c6cbd4}.v73SetupCard{border:1px solid #2b3039;border-radius:14px;padding:14px;margin:12px 0;background:#0e1014}.v73SetupCard .head{display:flex;justify-content:space-between;align-items:center;gap:10px}.v73SetupCard .head strong{font-size:15px}.v73SetupGrid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin-top:12px}.v73SetupGrid div{background:#12151b;border-radius:9px;padding:9px}.v73SetupGrid span{display:block;color:#9299a8;font-size:9px}.v73SetupGrid b{display:block;margin-top:4px;font-size:12px}.v73RichMetrics{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;margin:10px 0 14px}.v73RichMetrics div{background:#101319;border:1px solid #252a33;border-radius:10px;padding:10px}.v73RichMetrics span{display:block;color:#9299a8;font-size:9px}.v73RichMetrics strong{display:block;margin-top:4px;font-size:13px}.v73State{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.auditHistory{height:430px;max-height:430px;overflow:auto;scrollbar-gutter:stable}.logs{height:240px!important;max-height:240px!important}.observatoryCanvasCard{min-height:520px}#masterCanvas{height:410px}.v73Legend{display:flex;gap:14px;flex-wrap:wrap;color:#9299a8;font-size:10px;margin-top:8px}.v73Legend b{color:#e5e8ee}.v73Legacy{opacity:.45}.v73ModeReplay .v73LiveOnly{opacity:.55}.v73ModeLive .v73ReplayOnly{display:none}
    @media(max-width:1100px){.v73Decision{grid-template-columns:repeat(3,1fr)}.v73RichMetrics{grid-template-columns:repeat(4,1fr)}.v73SetupGrid{grid-template-columns:repeat(3,1fr)}}
    @media(max-width:650px){.v73Decision{grid-template-columns:1fr 1fr}.v73RichMetrics{grid-template-columns:1fr 1fr}.v73SetupGrid{grid-template-columns:1fr 1fr}.v73ModeBar{align-items:flex-start;flex-direction:column}}
  `;
  document.head.appendChild(style);
}

function install() {
  installStyles();
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Pattern + Structure Sniper v7.3'));
  const intro = document.querySelector('.obsIntro');
  if (intro) {
    intro.querySelector('.eyebrow').textContent = '200 + 80 → HL/LH → PRIME BOS → PATTERN 5T → EV → TRADE';
    intro.querySelector('h2').textContent = 'One setup, one state machine, one auditable decision.';
    intro.querySelector('p').textContent = 'v7.3 moves regime, structure and Pattern qualification into a dedicated tick-driven worker. The page only renders state and executes approved Demo orders. Every setup lifecycle is persisted from ARMED through shadow/live resolution.';
    const badges = intro.querySelectorAll('.obsBadges span');
    ['Demo only','200+80 strict','PRIME BOS only','top-10 pattern vote','fixed 5T','worker engine'].forEach((t,i)=>{ if (badges[i]) badges[i].textContent=t; });
  }

  const patternLensTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Pattern lens'));
  if (patternLensTitle) {
    patternLensTitle.textContent = 'Pattern Observatory · research view';
    const note = patternLensTitle.closest('.card')?.querySelector('p.muted');
    if (note) note.textContent = 'This visible research lens is independent. v7.3 trading Pattern logic runs inside the worker with frozen 20-tick shape, 40+ relatives, 88%+ average similarity, 58%+ 5T edge, 7/10 top-match agreement and positive EV.';
  }

  const masterCard = $('masterCanvas')?.closest('.card');
  if (masterCard && !$('v73ModeBar')) {
    const bar = document.createElement('div');
    bar.id = 'v73ModeBar';
    bar.className = 'v73ModeBar';
    bar.innerHTML = `<div class="v73Tabs"><button id="v73LiveTab" class="active" type="button">LIVE</button><button id="v73ReplayTab" type="button">REPLAY</button></div><div class="v73ReplayTools replayOnly"><span id="v73ReplayLabel">LIVE · latest 220 ticks</span><button id="v73Older" type="button">← Older</button><button id="v73Newer" type="button">Newer →</button><button id="v73Now" type="button">Back to live</button></div>`;
    masterCard.insertBefore(bar, $('masterCanvas'));
    const legend = document.createElement('div');
    legend.className = 'v73Legend';
    legend.innerHTML = '<span><b>HL/LH</b> anchor</span><span><b>BOS</b> frozen break level</span><span><b>P</b> PRIME candidate</span><span><b>C</b> CHASE blocked</span><span><b>A</b> approved</span><span><b>E</b> Deriv entry</span><span><b>X</b> expiry</span><span><b>OLD</b> previous cohort</span>';
    masterCard.appendChild(legend);
  }

  const traderCard = [...document.querySelectorAll('.card')].find(card => card.querySelector('#ptPnl'));
  if (traderCard && !$('v73Dashboard')) {
    const dash = document.createElement('div');
    dash.id = 'v73Dashboard';
    dash.innerHTML = `
      <div class="v73Decision">
        <div id="v73GateContext" class="v73Gate"><span>1 · CONTEXT</span><strong id="v73Context">WAIT</strong><small>200 + 80 must agree</small></div>
        <div id="v73GateStructure" class="v73Gate"><span>2 · STRUCTURE</span><strong id="v73Structure">WAIT</strong><small>HL/LH → PRIME BOS</small></div>
        <div id="v73GatePattern" class="v73Gate"><span>3 · PATTERN</span><strong id="v73Pattern">WAIT</strong><small>40 / 88 / 58 / top10</small></div>
        <div id="v73GateEV" class="v73Gate"><span>4 · EV</span><strong id="v73EV">WAIT</strong><small>positive expectancy</small></div>
        <div id="v73GateAction" class="v73Gate"><span>5 · ACTION</span><strong id="v73Action">WAIT</strong><small>fixed 5T Demo only</small></div>
      </div>
      <div class="v73Why"><b>WHY NOT?</b><span id="v73WhyText">Waiting for worker analysis.</span></div>
      <div class="v73SetupCard">
        <div class="head"><strong>Active Setup Card</strong><span id="v73State" class="v73State">WARMING</span></div>
        <div class="v73SetupGrid">
          <div><span>Direction</span><b id="v73SetupDir">—</b></div><div><span>Anchor</span><b id="v73Anchor">—</b></div><div><span>BOS</span><b id="v73Bos">—</b></div><div><span>Timing</span><b id="v73Timing">—</b></div><div><span>Pattern</span><b id="v73PatternDetail">—</b></div><div><span>Window</span><b id="v73Window">T+1→T+6</b></div>
        </div>
      </div>
      <div class="v73RichMetrics">
        <div><span>Setups opened</span><strong id="v73SetupN">0</strong></div><div><span>PRIME BOS</span><strong id="v73PrimeN">0</strong></div><div><span>Pattern passed</span><strong id="v73PatternPass">0</strong></div><div><span>Top10 passed</span><strong id="v73Top10Pass">0</strong></div><div><span>Actual WR</span><strong id="v73ActualWR">—</strong></div><div><span>Shadow WR</span><strong id="v73ShadowWR">—</strong></div><div><span>Blocks saved/missed</span><strong id="v73SavedMissed">0 / 0</strong></div><div><span>Actual P/L</span><strong id="v73ActualPnl">+$0.00</strong></div>
      </div>`;
    const signal = $('ptSignal');
    traderCard.insertBefore(dash, signal);
  }

  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader'));
  if (title) title.textContent = 'Pattern + Structure Sniper v7.3 · Worker Engine';
  if ($('ptStart')) $('ptStart').textContent = 'Start v7.3 Sniper';
  const tx = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('transactions'));
  if (tx) tx.textContent = 'v7.3 actual PRIME agreement trades · fixed 5T';
  const ledgerTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Setup Ledger') || x.textContent.includes('Candidate Audit'));
  if (ledgerTitle) ledgerTitle.textContent = 'v7.3 Full Setup Lifecycle Audit';
  const ledgerTable = $('ptLedgerRows')?.closest('table');
  if (ledgerTable) {
    ledgerTable.querySelector('thead').innerHTML = '<tr><th>Time</th><th>State</th><th>Dir</th><th>Anchor</th><th>BOS</th><th>Timing</th><th>Pattern</th><th>Top10</th><th>EV</th><th>Actual</th><th>Shadow</th><th>Why</th></tr>';
    ledgerTable.closest('.tableWrap')?.classList.add('auditHistory');
  }

  $('v73LiveTab')?.addEventListener('click', () => setMode('LIVE'));
  $('v73ReplayTab')?.addEventListener('click', () => setMode('REPLAY'));
  $('v73Older')?.addEventListener('click', () => { replayOffset += 180; notifyReplay(); });
  $('v73Newer')?.addEventListener('click', () => { replayOffset = Math.max(0, replayOffset - 180); notifyReplay(); });
  $('v73Now')?.addEventListener('click', () => { replayOffset = 0; setMode('LIVE'); });
}

function setMode(next) {
  mode = next === 'REPLAY' ? 'REPLAY' : 'LIVE';
  if (mode === 'LIVE') replayOffset = 0;
  document.body.classList.toggle('v73ModeReplay', mode === 'REPLAY');
  document.body.classList.toggle('v73ModeLive', mode === 'LIVE');
  $('v73LiveTab')?.classList.toggle('active', mode === 'LIVE');
  $('v73ReplayTab')?.classList.toggle('active', mode === 'REPLAY');
  notifyReplay();
}
function notifyReplay() { replayListener?.({ mode, replayOffset }); renderChart(latest.ticks, latest.setups, latest.analysis, latest.engine); }
function onReplay(fn) { replayListener = fn; }

function why(analysis) {
  if (!analysis) return 'Waiting for worker analysis.';
  if (analysis.state === 'WARMING') return analysis.reason || 'Building 200-tick context.';
  if (analysis.regime200 === 'NEUTRAL') return '200t context is NEUTRAL.';
  if (analysis.authority80 === 'NEUTRAL') return '80t authority is NEUTRAL.';
  if (analysis.regime200 !== analysis.authority80) return `200t ${analysis.regime200} conflicts with 80t ${analysis.authority80}.`;
  if (analysis.chop?.blocked) return `CHOP veto ${(analysis.chop.score * 100).toFixed(0)}%.`;
  if (analysis.volatility && analysis.volatility !== 'HEALTHY') return `Volatility is ${analysis.volatility}.`;
  return analysis.reason || 'Waiting for a fresh PRIME setup.';
}
function passClass(el, pass, block = false) { if (!el) return; el.classList.toggle('pass', Boolean(pass)); el.classList.toggle('block', Boolean(block)); }

function renderDecision(analysis, setups) {
  const fresh = setups.filter(x => !x.legacy);
  const current = fresh.find(x => !['WON','LOST','FLAT'].includes(x.actual?.outcome) && !['WON','LOST','FLAT'].includes(x.shadow?.outcome)) || fresh[0];
  const aligned = analysis && analysis.regime200 !== 'NEUTRAL' && analysis.regime200 === analysis.authority80;
  $('v73Context').textContent = aligned ? `${analysis.direction} LOCKED` : 'WAIT';
  passClass($('v73GateContext'), aligned, Boolean(analysis && !aligned));
  const timing = current?.timingClass || (analysis?.activeSetup ? 'ARMED' : 'WAIT');
  const prime = timing === 'PRIME';
  $('v73Structure').textContent = current?.pivotType ? `${current.pivotType}→BOS · ${timing}` : analysis?.activeSetup ? `${analysis.activeSetup.pivotType} ARMED` : 'WAIT';
  passClass($('v73GateStructure'), prime, timing === 'CHASE');
  const pat = current?.pattern;
  $('v73Pattern').textContent = pat ? `${pat.status} · ${fmt(pat.expectedEdge)}%` : 'WAIT';
  passClass($('v73GatePattern'), Boolean(pat?.ok), Boolean(pat && !pat.ok));
  $('v73EV').textContent = pat && Number.isFinite(+pat.ev) ? `${pat.ev >= 0 ? '+' : ''}${(pat.ev * 100).toFixed(1)}%` : 'WAIT';
  passClass($('v73GateEV'), Boolean(pat?.gates?.ev), Boolean(pat && !pat?.gates?.ev));
  const approved = current?.decision?.approved || current?.state === 'APPROVED';
  $('v73Action').textContent = approved ? `${current.direction === 'BULL' ? 'CALL' : 'PUT'} · 5T` : 'WAIT';
  passClass($('v73GateAction'), approved, Boolean(current && current.state?.includes('BLOCK')));
  $('v73WhyText').textContent = current?.decision?.why || current?.lastReason || why(analysis);
  $('v73State').textContent = current?.state || analysis?.state || 'WARMING';
  const active = analysis?.activeSetup || current;
  $('v73SetupDir').textContent = active?.direction || '—';
  $('v73Anchor').textContent = active?.pivotType ? `${active.pivotType} ${fmt(active.pivotQuote,2)}` : '—';
  $('v73Bos').textContent = Number.isFinite(+active?.bosLevel) ? fmt(active.bosLevel,2) : '—';
  $('v73Timing').textContent = current?.timingClass || (analysis?.activeSetup ? 'ARMED' : '—');
  $('v73PatternDetail').textContent = pat ? `${fmt(pat.expectedEdge)}% · ${pat.top10Agree || 0}/${pat.top10Total || 10}` : '—';
  $('v73Window').textContent = `T+${pat?.executionOffset || 1}→T+${(pat?.executionOffset || 1) + 5}`;
  if ($('ptSignal')) $('ptSignal').innerHTML = approved
    ? `<b class="${current.direction === 'BULL' ? 'positive' : 'negative'}">FIRE · ${current.direction === 'BULL' ? 'CALL' : 'PUT'} 5T</b><span>200+80 aligned · ${esc(current.pivotType)}→BOS PRIME · Pattern ${fmt(pat?.expectedEdge)}% · top10 ${pat?.top10Agree || 0}/10 · EV ${(Number(pat?.ev || 0)*100).toFixed(1)}%</span>`
    : `<b>WAIT · ${esc(analysis?.state || current?.state || 'SEARCHING')}</b><span>${esc($('v73WhyText').textContent)}</span>`;
}

function metrics(setups) {
  setups = setups.filter(s => !s.legacy);
  const actual = setups.filter(s => ['WON','LOST'].includes(s.actual?.outcome));
  const shadow = setups.filter(s => ['WON','LOST'].includes(s.shadow?.outcome));
  const blocked = setups.filter(s => s.decision && !s.decision.approved && ['WON','LOST'].includes(s.shadow?.outcome));
  const aw = actual.filter(s => s.actual.outcome === 'WON').length;
  const sw = shadow.filter(s => s.shadow.outcome === 'WON').length;
  const saved = blocked.filter(s => s.shadow.outcome === 'LOST').length;
  const missed = blocked.filter(s => s.shadow.outcome === 'WON').length;
  const pnl = actual.reduce((sum,s)=>sum+Number(s.actual?.profit||0),0);
  return { actual, shadow, aw, sw, saved, missed, pnl };
}
function renderMetrics(setups) {
  const m = metrics(setups);
  const fresh = setups.filter(s => !s.legacy);
  $('v73SetupN').textContent = String(fresh.length);
  $('v73PrimeN').textContent = String(fresh.filter(s => s.timingClass === 'PRIME').length);
  $('v73PatternPass').textContent = String(fresh.filter(s => s.pattern?.ok).length);
  $('v73Top10Pass').textContent = String(fresh.filter(s => s.pattern?.gates?.top10).length);
  $('v73ActualWR').textContent = m.actual.length ? `${(m.aw/m.actual.length*100).toFixed(1)}% (${m.aw}/${m.actual.length})` : '—';
  $('v73ShadowWR').textContent = m.shadow.length ? `${(m.sw/m.shadow.length*100).toFixed(1)}% (${m.sw}/${m.shadow.length})` : '—';
  $('v73SavedMissed').textContent = `${m.saved} / ${m.missed}`;
  $('v73ActualPnl').textContent = money(m.pnl);
}

function renderLedger(setups) {
  setups = setups.filter(s => !s.legacy);
  const rows = setups.slice(0, 300);
  $('ptQualified').textContent = String(setups.length);
  $('ptSkipped').textContent = String(setups.filter(s => s.decision && !s.decision.approved).length);
  $('ptBought').textContent = String(setups.filter(s => s.actual?.contractId).length);
  const actual = setups.filter(s => ['WON','LOST'].includes(s.actual?.outcome));
  const wins = actual.filter(s => s.actual.outcome === 'WON').length;
  const losses = actual.filter(s => s.actual.outcome === 'LOST').length;
  const pnl = actual.reduce((a,s)=>a+Number(s.actual?.profit||0),0);
  $('ptCohortN').textContent = String(actual.length);
  $('ptCohortWL').textContent = `${wins} / ${losses}`;
  $('ptCohortPnl').textContent = money(pnl);
  $('ptLedgerRows').innerHTML = rows.length ? rows.map(s => {
    const tm = new Date(s.createdAt || s.openedAt || Date.now()).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const pat = s.pattern ? `${fmt(s.pattern.expectedEdge)}% ${s.pattern.expected || ''}` : '—';
    const top = s.pattern ? `${s.pattern.top10Agree || 0}/${s.pattern.top10Total || 10}` : '—';
    const ev = Number.isFinite(+s.pattern?.ev) ? `${(s.pattern.ev*100).toFixed(1)}%` : '—';
    return `<tr><td>${tm}</td><td>${esc(s.state || '—')}</td><td>${esc(s.direction || '—')}</td><td>${s.pivotType ? `${esc(s.pivotType)} ${fmt(s.pivotQuote,2)}` : '—'}</td><td>${fmt(s.bosLevel,2)}</td><td>${esc(s.timingClass || '—')}</td><td>${esc(pat)}</td><td>${top}</td><td>${ev}</td><td>${esc(s.actual?.outcome || '—')}</td><td>${esc(s.shadow?.outcome || '—')}</td><td>${esc(s.decision?.why || s.lastReason || '—')}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v7.3 setup lifecycles yet.</td></tr>';
}

function canvasScale(ctx, canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, rect.width || 1400), height = Math.max(260, rect.height || 410);
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) { canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr); }
  ctx.setTransform(dpr,0,0,dpr,0,0); return {width,height};
}
function renderChart(ticks, setups, analysis) {
  const canvas = $('masterCanvas'); if (!canvas) return;
  const all = Array.isArray(ticks) ? ticks : [];
  const maxOffset = Math.max(0, all.length - Math.min(220, all.length));
  replayOffset = Math.min(replayOffset, maxOffset);
  const end = Math.max(0, all.length - replayOffset), start = Math.max(0, end - 220), rows = all.slice(start,end);
  $('v73ReplayLabel').textContent = mode === 'LIVE' ? 'LIVE · latest 220 ticks' : `${replayOffset} ticks behind live`;
  const ctx = canvas.getContext('2d'), {width,height}=canvasScale(ctx,canvas); ctx.clearRect(0,0,width,height);
  ctx.strokeStyle='rgba(146,153,168,.10)';
  for(let x=0;x<=width;x+=width/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
  for(let y=0;y<=height;y+=height/5){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
  if(rows.length<2)return;
  const prices=rows.map(t=>t.quote), min=Math.min(...prices), max=Math.max(...prices), span=max-min||1;
  const startEpoch=rows[0].epoch,endEpoch=rows.at(-1).epoch;
  const xFor=e=>14+(e-startEpoch)/Math.max(1,endEpoch-startEpoch)*(width-28);
  const yFor=p=>height-22-(p-min)/span*(height-44);
  ctx.strokeStyle='rgba(215,220,229,.78)';ctx.lineWidth=1.6;ctx.beginPath();rows.forEach((t,i)=>{const x=14+i/(rows.length-1)*(width-28),y=yFor(t.quote);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  ctx.fillStyle='rgba(245,247,250,.92)';ctx.font='12px system-ui';ctx.fillText(`${mode} · STATE ${analysis?.state||'—'} · 200 ${analysis?.regime200||'—'} · 80 ${analysis?.authority80||'—'} · fixed 5T`,16,20);
  const visible=setups.filter(s=>Number(s.signalEpoch||s.createdEpoch||s.pivotEpoch)>=startEpoch&&Number(s.signalEpoch||s.createdEpoch||s.pivotEpoch)<=endEpoch);
  for(const s of visible){
    const pivotEpoch=Number(s.pivotEpoch), pivotQuote=Number(s.pivotQuote), bos=Number(s.bosLevel), signalEpoch=Number(s.signalEpoch);
    if(Number.isFinite(bos)){ctx.strokeStyle=s.legacy?'rgba(100,150,220,.22)':'rgba(80,160,255,.48)';ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(14,yFor(bos));ctx.lineTo(width-14,yFor(bos));ctx.stroke();ctx.setLineDash([]);}
    if(Number.isFinite(pivotEpoch)&&Number.isFinite(pivotQuote)){ctx.fillStyle=s.legacy?'rgba(200,205,215,.35)':'#79aefc';ctx.font='10px system-ui';ctx.fillText(s.pivotType||'PIVOT',xFor(pivotEpoch)+3,yFor(pivotQuote)+(s.pivotType==='HL'?13:-8));}
    if(Number.isFinite(signalEpoch)){
      const x=xFor(signalEpoch), y=yFor(Number(s.signalQuote||bos));
      ctx.fillStyle=s.legacy?'rgba(220,220,220,.38)':s.decision?.approved?'#67d99a':s.timingClass==='CHASE'?'#ff7474':'#f3c567';
      ctx.font='10px system-ui';ctx.fillText(s.legacy?'OLD':s.decision?.approved?'A':s.timingClass==='CHASE'?'C':'P',x+4,y-7);ctx.strokeStyle=ctx.fillStyle;ctx.strokeRect(x-4,y-4,8,8);
    }
    if(Number.isFinite(+s.actual?.entryEpoch)&&Number.isFinite(+s.actual?.entrySpot)){const x=xFor(+s.actual.entryEpoch),y=yFor(+s.actual.entrySpot);ctx.fillStyle='#67d99a';ctx.beginPath();ctx.moveTo(x,y-9);ctx.lineTo(x-6,y+5);ctx.lineTo(x+6,y+5);ctx.closePath();ctx.fill();ctx.fillText('E',x+7,y-6);}
    if(Number.isFinite(+s.actual?.exitEpoch)&&Number.isFinite(+s.actual?.exitSpot)){const x=xFor(+s.actual.exitEpoch),y=yFor(+s.actual.exitSpot);ctx.strokeStyle=s.actual.outcome==='WON'?'#67d99a':'#ff7474';ctx.beginPath();ctx.arc(x,y,5,0,Math.PI*2);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillText('X',x+7,y-6);}
  }
  if ($('masterCanvasCaption')) $('masterCanvasCaption').textContent = mode==='LIVE' ? 'LIVE worker state · setup lifecycle is persisted before BOS and after decision' : 'REPLAY · previous v7.3 plus imported old cohort setups';
}
function renderEngine(state, setups) {
  if (!state) return;
  $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.connected ? (state.running ? 'TRADING' : 'CONNECTED') : 'DISCONNECTED';
  $('ptPnl').textContent = money(state.sessionPnL); $('ptPnl').className = Number(state.sessionPnL||0)>=0?'positive':'negative'; $('ptWL').textContent = `${state.wins||0} / ${state.losses||0}`; $('ptOpen').textContent = String(Number(state.openContracts||0)+(state.pendingTrade?1:0));
  if ($('ptTradeRows')) $('ptTradeRows').innerHTML = state.trades?.length ? state.trades.map(t=>{ const s=setups.find(x=>Number(x.actual?.contractId)===Number(t.contractId)); return `<tr><td>#${t.contractId}</td><td>${esc(s?.direction||'—')}</td><td>${esc(t.direction)}</td><td>${esc(`${s?.pivotType||'—'}→BOS PRIME + Pattern`)}</td><td><span class="result ${t.status}">${esc(t.status)}</span></td><td>${t.duration}t</td><td>${s?`T+${s.executionOffset||1}→T+${(s.executionOffset||1)+5}`:'—'}</td><td>${s?.actual?.window||'—'}</td><td>${s?.actual?.latency||'—'}</td><td class="${Number(t.profit||0)>=0?'positive':'negative'}">${t.profit===undefined?'—':`${Number(t.profit)>=0?'+':''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs===undefined?'—':Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`; }).join('') : '<tr><td colspan="12" class="empty">No v7.3 actual trades yet.</td></tr>';
  if ($('ptLogs') && state.logs?.length) $('ptLogs').innerHTML=state.logs.slice(0,60).map(l=>`<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${esc(l.message==='Engine armed. Waiting for fresh BOS.'?'v7.3 worker sniper armed.':l.message)}</span></div>`).join('');
}
function render(data) { latest = { ...latest, ...data }; renderDecision(latest.analysis, latest.setups || []); renderMetrics(latest.setups || []); renderLedger(latest.setups || []); renderChart(latest.ticks || [], latest.setups || [], latest.analysis); renderEngine(latest.engine, latest.setups || []); }
export const V73UI = { install, render, onReplay, setMode };
