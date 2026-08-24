const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const fmt = (v, n = 1) => Number.isFinite(+v) ? Number(v).toFixed(n) : '—';
const money = v => `${Number(v || 0) >= 0 ? '+' : ''}$${Number(v || 0).toFixed(2)}`;
let latest = { analysis:null, signals:[], ticks:[], engine:null, batchSize:2, maxConcurrent:6 };
let replayOffset = 0;
let replay = false;

function installStyles() {
  if ($('v8Styles')) return;
  const style = document.createElement('style');
  style.id = 'v8Styles';
  style.textContent = `
    html{overflow-anchor:none}.observatoryShell{max-width:1500px}.v8HeroNote{font-size:12px;color:#9ba2ae}.v8Strip{display:grid;grid-template-columns:1.1fr 1fr 1fr 1fr 1fr 1fr;gap:8px;margin:12px 0}.v8Cell{background:#0d1015;border:1px solid #252b35;border-radius:12px;padding:11px 12px;min-height:70px}.v8Cell span{display:block;color:#858e9c;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.v8Cell strong{display:block;margin-top:7px;font-size:14px;line-height:1.2;overflow-wrap:anywhere}.v8Cell.hot{border-color:rgba(103,217,154,.55)}.v8Cell.stop{border-color:rgba(255,116,116,.45)}.v8Action{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#10141a;border:1px solid #303744;border-radius:14px;padding:14px;margin:10px 0 14px}.v8Action strong{font-size:20px}.v8Action p{margin:4px 0 0;color:#9ba2ae;font-size:11px}.v8Stats{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:7px;margin:10px 0}.v8Stat{background:#0d1015;border:1px solid #222832;border-radius:10px;padding:9px}.v8Stat span{display:block;color:#828b99;font-size:9px}.v8Stat b{display:block;margin-top:5px;font-size:12px}.v8Replay{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:7px 0 10px}.v8Replay .tools{display:flex;gap:6px;align-items:center}.v8Replay small{color:#8d96a5}.v8Legend{display:flex;gap:12px;flex-wrap:wrap;color:#8d96a5;font-size:10px;margin-top:8px}.v8Legend b{color:#e9edf3}.v8Audit{height:390px;max-height:390px;overflow:auto;scrollbar-gutter:stable}.logs{height:220px!important;max-height:220px!important}.v8Collapsed>*:not(.sectionTitle){display:none!important}.v8Collapsible>.sectionTitle{cursor:pointer;user-select:none}.v8Collapsible>.sectionTitle:after{content:'▾';margin-left:auto;color:#7f8998}.v8Collapsed>.sectionTitle:after{content:'▸'}.v8Subtle{opacity:.75}.observatoryCanvasCard{min-height:500px}#masterCanvas{height:400px}.v8HideOld{display:none!important}
    @media(max-width:1050px){.v8Strip{grid-template-columns:repeat(3,1fr)}.v8Stats{grid-template-columns:repeat(4,1fr)}}
    @media(max-width:650px){.v8Strip{grid-template-columns:1fr 1fr}.v8Stats{grid-template-columns:1fr 1fr}.v8Action{align-items:flex-start;flex-direction:column}.v8Replay{align-items:flex-start;flex-direction:column}}
  `;
  document.head.appendChild(style);
}

function makeCollapsible(card, collapsed = true) {
  if (!card || card.dataset.v8Collapse === '1') return;
  card.dataset.v8Collapse = '1';
  card.classList.add('v8Collapsible');
  if (collapsed) card.classList.add('v8Collapsed');
  card.querySelector(':scope > .sectionTitle')?.addEventListener('click', () => card.classList.toggle('v8Collapsed'));
}

function install() {
  installStyles();
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('SANI Pattern Campaign v8'));
  const intro = document.querySelector('.obsIntro');
  if (intro) {
    intro.querySelector('.eyebrow').textContent = 'PATTERN FIRST → STRUCTURE LOCATION → NEXT EXECUTABLE TICK → REPEAT';
    intro.querySelector('h2').textContent = 'Recognize early. Decide fast. Milk the recurring edge.';
    intro.querySelector('p').textContent = 'v8 removes 200/80/BOS as hard permission gates. Every fresh tick is matched against stored historical shapes. HH/HL/LH/LL describe where the pattern lives; they do not force us to wait. A qualified pattern can fire again on the next fresh recurrence.';
    const badges = intro.querySelectorAll('.obsBadges span');
    ['Demo only','pattern-first','1T contract','execution-aware','repeated entries','2-contract pulse'].forEach((t,i)=>{ if (badges[i]) badges[i].textContent=t; });
  }

  const traderCard = [...document.querySelectorAll('.card')].find(card => card.querySelector('#ptPnl'));
  if (traderCard && !$('v8Dashboard')) {
    const dash = document.createElement('div');
    dash.id = 'v8Dashboard';
    dash.innerHTML = `
      <div class="v8Strip">
        <div id="v8PatternCell" class="v8Cell"><span>Pattern family</span><strong id="v8Family">SEARCHING</strong></div>
        <div class="v8Cell"><span>Structure location</span><strong id="v8Structure">—</strong></div>
        <div class="v8Cell"><span>Historical edge</span><strong id="v8Edge">—</strong></div>
        <div class="v8Cell"><span>Nearest vote</span><strong id="v8Top10">—</strong></div>
        <div class="v8Cell"><span>Campaign</span><strong id="v8Campaign">NONE</strong></div>
        <div class="v8Cell"><span>Decision speed</span><strong id="v8DecisionMs">— ms</strong></div>
      </div>
      <div id="v8Action" class="v8Action"><div><strong id="v8ActionText">WATCH</strong><p id="v8Why">Building the pattern library.</p></div><div><b id="v8Pulse">0 contracts</b><p>fresh qualifying pulse</p></div></div>
      <div class="v8Stats">
        <div class="v8Stat"><span>Qualified pulses</span><b id="v8Qualified">0</b></div>
        <div class="v8Stat"><span>CALL pulses</span><b id="v8Calls">0</b></div>
        <div class="v8Stat"><span>PUT pulses</span><b id="v8Puts">0</b></div>
        <div class="v8Stat"><span>Actual contracts</span><b id="v8Contracts">0</b></div>
        <div class="v8Stat"><span>Actual W/L</span><b id="v8WL">0 / 0</b></div>
        <div class="v8Stat"><span>Actual P/L</span><b id="v8Pnl">+$0.00</b></div>
        <div class="v8Stat"><span>Shadow W/L</span><b id="v8Shadow">0 / 0</b></div>
        <div class="v8Stat"><span>Open / max</span><b id="v8Exposure">0 / 6</b></div>
      </div>`;
    traderCard.insertBefore(dash, $('ptSignal'));
  }

  const masterCard = $('masterCanvas')?.closest('.card');
  if (masterCard && !$('v8Replay')) {
    const bar = document.createElement('div');
    bar.id = 'v8Replay'; bar.className = 'v8Replay';
    bar.innerHTML = '<div><b>Pattern campaign chart</b><br><small id="v8ReplayLabel">LIVE · latest 220 ticks</small></div><div class="tools"><button id="v8Older" type="button">← Older</button><button id="v8Newer" type="button">Newer →</button><button id="v8Live" type="button">Live</button></div>';
    masterCard.insertBefore(bar, $('masterCanvas'));
    const legend = document.createElement('div'); legend.className = 'v8Legend'; legend.innerHTML = '<span><b>LL/HL/HH/LH</b> structure address</span><span><b>C×2</b> CALL pulse</span><span><b>P×2</b> PUT pulse</span><span><b>E</b> actual entry</span><span><b>X</b> expiry</span>';
    masterCard.appendChild(legend);
  }

  $('v8Older')?.addEventListener('click', () => { replay = true; replayOffset += 180; renderChart(); });
  $('v8Newer')?.addEventListener('click', () => { replayOffset = Math.max(0, replayOffset - 180); if (!replayOffset) replay=false; renderChart(); });
  $('v8Live')?.addEventListener('click', () => { replay=false; replayOffset=0; renderChart(); });

  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader') || x.textContent.includes('Pattern + Structure'));
  if (title) title.textContent = 'Pattern Campaign v8 · Demo Execution';
  if ($('ptStart')) $('ptStart').textContent = 'Start v8 Campaign';

  const cooldownLabel = $('ptCooldown')?.closest('label');
  if (cooldownLabel) cooldownLabel.childNodes[0].textContent = 'Batch contracts / pulse';
  if ($('ptCooldown')) { $('ptCooldown').min='1'; $('ptCooldown').max='3'; $('ptCooldown').step='1'; $('ptCooldown').value='2'; }
  const maxLabel = $('ptMaxTrades')?.closest('label'); if (maxLabel) maxLabel.childNodes[0].textContent = 'Persistent max contracts';

  const metricLabels = [...document.querySelectorAll('.metric span')];
  const names = ['Pattern context','Pattern location','Campaign direction','Pattern state','Structure feature','Execution mode','Measured entry','Bought contracts','Cohort signals','Actual W/L','Actual P/L','CALL pulses','PUT pulses','Qualified pulses','Observed / blocked'];
  metricLabels.slice(4, 19).forEach((el,i)=>{ if(names[i]) el.textContent=names[i]; });

  const tx = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('transactions'));
  if (tx) tx.textContent = 'v8 Actual 1-Tick Contracts';
  const ledgerTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Setup Ledger') || x.textContent.includes('Lifecycle') || x.textContent.includes('Candidate Audit'));
  if (ledgerTitle) ledgerTitle.textContent = 'v8 Pattern Pulse Audit';
  const ledgerTable = $('ptLedgerRows')?.closest('table');
  if (ledgerTable) {
    ledgerTable.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Action</th><th>Family</th><th>Location</th><th>Edge</th><th>Top10</th><th>80</th><th>200</th><th>Speed</th><th>Actual</th><th>Shadow</th><th>Why</th></tr>';
    ledgerTable.closest('.tableWrap')?.classList.add('v8Audit');
  }
  if ($('ptExportLedger')) $('ptExportLedger').textContent = 'Export v8 CSV';
  if ($('ptClearLedger')) $('ptClearLedger').textContent = 'Clear v8 cohort';

  const patternTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Pattern lens') || x.textContent.includes('Pattern Observatory'));
  if (patternTitle) patternTitle.textContent = 'Visible Pattern Research';

  // Keep the trading cockpit open. Research/detail cards start folded and stay easy to reveal.
  const cards = [...document.querySelectorAll('.card')];
  for (const card of cards) {
    if (card === traderCard || card === masterCard) continue;
    if (card.querySelector('#ptPnl')) continue;
    makeCollapsible(card, true);
  }

  const roadmap = document.querySelector('.observatoryRoadmap');
  if (roadmap) roadmap.innerHTML = `
    <div><b>1 · Recognize</b><span>Every fresh tick is compared with historical 8/12/20-tick shapes. No 200/80 permission gate.</span></div>
    <div><b>2 · Locate</b><span>HH, HL, LH, LL, second HH/LL and high/low zone are attached as the pattern address.</span></div>
    <div><b>3 · Calculate</b><span>Historical relatives are scored on the exact measured next executable 1-tick window.</span></div>
    <div><b>4 · Enter</b><span>If the family clears the live evidence floor, execute immediately. Default pulse is two Demo contracts.</span></div>
    <div><b>5 · Repeat</b><span>A new qualifying tick can fire again in the same direction. We do not wait for a fresh trend or BOS.</span></div>
    <div><b>6 · Flip</b><span>When a strong opposite pattern family appears, the campaign direction flips with the new evidence.</span></div>`;
}

function set(id, value) { if ($(id)) $(id).textContent = value; }

function summarize(signals) {
  const fresh = signals.filter(x => !x.legacy);
  const approved = fresh.filter(x => x.approved);
  const actual = fresh.flatMap(x => x.actualTrades || []);
  const settled = actual.filter(t => ['WON','LOST'].includes(t.outcome));
  const wins = settled.filter(t => t.outcome === 'WON').length, losses = settled.filter(t => t.outcome === 'LOST').length;
  const pnl = settled.reduce((s,t)=>s+(+t.profit||0),0);
  const shadow = fresh.filter(x => ['WON','LOST'].includes(x.shadow?.outcome));
  return { fresh, approved, actual, wins, losses, pnl, shadowWins:shadow.filter(x=>x.shadow.outcome==='WON').length, shadowLosses:shadow.filter(x=>x.shadow.outcome==='LOST').length };
}

function renderDashboard() {
  const { analysis, signals, engine, batchSize, maxConcurrent } = latest;
  const s = summarize(signals);
  const p = analysis?.pattern;
  const st = analysis?.structure;
  set('v8Family', p?.familyId || 'SEARCHING');
  set('v8Structure', st ? `${st.tag} · ${st.phase}` : '—');
  set('v8Edge', p ? `${fmt(p.edge)}% · ${p.matchCount||0} matches` : '—');
  set('v8Top10', p ? `${p.top10Agree||0}/${p.top10Total||0}` : '—');
  set('v8Campaign', analysis?.campaign?.direction && analysis.campaign.direction !== 'NONE' ? `${analysis.campaign.direction} · ${analysis.campaign.pulses} pulses` : 'NONE');
  set('v8DecisionMs', `${fmt(analysis?.decisionMs,2)} ms`);
  set('v8ActionText', analysis?.state === 'ENTER' ? `${p?.direction === 'UP' ? 'CALL' : 'PUT'} NOW` : 'WATCH');
  set('v8Why', analysis?.reason || 'Building pattern memory.');
  set('v8Pulse', analysis?.state === 'ENTER' ? `${batchSize} contracts` : '0 contracts');
  $('v8Action')?.classList.toggle('positive', analysis?.state === 'ENTER' && p?.direction === 'UP');
  $('v8Action')?.classList.toggle('negative', analysis?.state === 'ENTER' && p?.direction === 'DOWN');
  $('v8PatternCell')?.classList.toggle('hot', Boolean(p?.ok));
  set('v8Qualified', s.approved.length);
  set('v8Calls', s.approved.filter(x=>x.tradeDirection==='CALL').length);
  set('v8Puts', s.approved.filter(x=>x.tradeDirection==='PUT').length);
  set('v8Contracts', s.actual.filter(t=>t.contractId).length);
  set('v8WL', `${s.wins} / ${s.losses}`);
  set('v8Pnl', money(s.pnl));
  set('v8Shadow', `${s.shadowWins} / ${s.shadowLosses}`);
  set('v8Exposure', `${Number(engine?.openContracts||0)} / ${maxConcurrent}`);

  set('mtRegime200', analysis?.context200 || 'FEATURE');
  set('mtTrend80', analysis?.context80 || 'FEATURE');
  set('mtSession', analysis?.campaign?.direction || 'NONE');
  set('mtEntry20', p?.familyId || 'SEARCH');
  set('mtChop', st?.tag || '—');
  set('mtVolatility', 'PATTERN-FIRST');
  set('ptEntryOffset', `T+${Number(analysis?.config?.executionOffset || 1)}`);
  set('ptBought', s.actual.filter(t=>t.contractId).length);
  set('ptCohortN', s.fresh.length);
  set('ptCohortWL', `${s.wins} / ${s.losses}`);
  set('ptCohortPnl', money(s.pnl));
  set('ptBullWL', String(s.approved.filter(x=>x.tradeDirection==='CALL').length));
  set('ptBearWL', String(s.approved.filter(x=>x.tradeDirection==='PUT').length));
  set('ptQualified', String(s.approved.length));
  set('ptSkipped', String(s.fresh.length - s.approved.length));

  if ($('ptSignal')) $('ptSignal').innerHTML = analysis?.state === 'ENTER'
    ? `<b class="${p?.direction==='UP'?'positive':'negative'}">${p?.direction==='UP'?'CALL':'PUT'} · FIRE ${batchSize}</b><span>${esc(p?.familyId||'pattern')} · ${fmt(p?.edge)}% · ${esc(st?.tag||'')} · decision ${fmt(analysis?.decisionMs,2)}ms</span>`
    : `<b>WATCH</b><span>${esc(analysis?.reason || 'Waiting for a statistically qualified pattern.')}</span>`;
}

function renderLedger() {
  if (!$('ptLedgerRows')) return;
  const rows = latest.signals.slice(0,250);
  $('ptLedgerRows').innerHTML = rows.length ? rows.map(r => {
    const actual = (r.actualTrades||[]);
    const aw = actual.filter(t=>t.outcome==='WON').length, al = actual.filter(t=>t.outcome==='LOST').length;
    const ap = actual.reduce((s,t)=>s+(+t.profit||0),0);
    const act = actual.length ? `${aw}W/${al}L ${money(ap)}` : (r.executionState || '—');
    return `<tr class="${r.legacy?'v73Legacy':''}"><td>${new Date(r.createdAt||Date.now()).toLocaleTimeString()}</td><td>${r.approved?esc(r.tradeDirection):'WATCH'}</td><td>${esc(r.pattern?.familyId||'—')}</td><td>${esc(r.structure?.tag||'—')} ${esc(r.structure?.phase||'')}</td><td>${Number.isFinite(+r.pattern?.edge)?fmt(r.pattern.edge)+'%':'—'}</td><td>${r.pattern?`${r.pattern.top10Agree||0}/${r.pattern.top10Total||0}`:'—'}</td><td>${esc(r.context80||'—')}</td><td>${esc(r.context200||'—')}</td><td>${Number.isFinite(+r.decisionMs)?fmt(r.decisionMs,2)+'ms':'—'}</td><td>${act}</td><td>${r.shadow?.outcome||'—'}</td><td>${esc(r.why||'—')}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v8 pattern pulses yet.</td></tr>';
}

function renderTrades() {
  if (!$('ptTradeRows')) return;
  const rows = latest.signals.filter(x=>!x.legacy).flatMap(s => (s.actualTrades||[]).map(t=>({s,t}))).sort((a,b)=>(b.t.contractId||0)-(a.t.contractId||0)).slice(0,100);
  $('ptTradeRows').innerHTML = rows.length ? rows.map(({s,t}) => `<tr><td>#${t.contractId||'—'}</td><td>${esc(s.campaign?.direction||s.tradeDirection||'—')}</td><td>${esc(s.tradeDirection||'—')}</td><td>${esc(s.pattern?.familyId||'—')} · ${esc(s.structure?.tag||'—')}</td><td><span class="result ${String(t.outcome||'').toLowerCase()}">${esc(t.outcome||'OPEN')}</span></td><td>1t</td><td>T+${s.executionOffset||1}→T+${(s.executionOffset||1)+1}</td><td>${esc(t.window||'—')}</td><td>${esc(t.latency||'—')}</td><td class="${(+t.profit||0)>=0?'positive':'negative'}">${Number.isFinite(+t.profit)?money(t.profit):'—'}</td><td>${Number.isFinite(+t.buyAckMs)?fmt(t.buyAckMs,0)+'ms':'—'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`).join('') : '<tr><td colspan="12" class="empty">No v8 actual contracts yet.</td></tr>';
}

function scaleCanvas(ctx, canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1), rect = canvas.getBoundingClientRect(), w = Math.max(300, rect.width || canvas.width), h = Math.max(220, rect.height || canvas.height);
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) { canvas.width=Math.round(w*dpr); canvas.height=Math.round(h*dpr); }
  ctx.setTransform(dpr,0,0,dpr,0,0); return {w,h};
}

function renderChart() {
  const canvas = $('masterCanvas'); if (!canvas) return;
  const all = latest.ticks || [];
  const maxOffset = Math.max(0, all.length - Math.min(220, all.length)); replayOffset = Math.min(replayOffset,maxOffset);
  const end = Math.max(0, all.length - replayOffset), start = Math.max(0,end-220), rows = all.slice(start,end);
  set('v8ReplayLabel', replayOffset ? `${replayOffset} ticks behind live` : 'LIVE · latest 220 ticks');
  const ctx = canvas.getContext('2d'), {w,h}=scaleCanvas(ctx,canvas); ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='rgba(146,153,168,.10)'; for(let x=0;x<=w;x+=w/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()} for(let y=0;y<=h;y+=h/5){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
  if(rows.length<2)return;
  const prices=rows.map(x=>x.quote), min=Math.min(...prices), max=Math.max(...prices), span=max-min||1, startEpoch=rows[0].epoch, endEpoch=rows.at(-1).epoch;
  const xFor=e=>14+(e-startEpoch)/Math.max(1,endEpoch-startEpoch)*(w-28), yFor=q=>h-20-(q-min)/span*(h-42);
  ctx.strokeStyle='rgba(215,220,229,.78)';ctx.lineWidth=1.5;ctx.beginPath();rows.forEach((t,i)=>{const x=14+i/(rows.length-1)*(w-28),y=yFor(t.quote);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  const visible=(latest.signals||[]).filter(s=>Number(s.signalEpoch)>=startEpoch&&Number(s.signalEpoch)<=endEpoch);
  for(const s of visible){const x=xFor(+s.signalEpoch),y=yFor(+s.signalQuote);if(s.approved){ctx.fillStyle=s.tradeDirection==='CALL'?'#67d99a':'#ff7474';ctx.font='bold 10px system-ui';ctx.fillText(`${s.tradeDirection==='CALL'?'C':'P'}×${s.requestedBatch||2}`,x+4,y-7)} if(Number.isFinite(+s.structure?.pivotEpoch)&&Number.isFinite(+s.structure?.pivotQuote)&&+s.structure.pivotEpoch>=startEpoch&&+s.structure.pivotEpoch<=endEpoch){ctx.fillStyle='rgba(126,165,215,.9)';ctx.font='10px system-ui';ctx.fillText(s.structure.tag||s.structure.pivotType,xFor(+s.structure.pivotEpoch)+3,yFor(+s.structure.pivotQuote)-6)} for(const t of s.actualTrades||[]){if(Number.isFinite(+t.entryEpoch)&&Number.isFinite(+t.entrySpot)){const ex=xFor(+t.entryEpoch),ey=yFor(+t.entrySpot);ctx.fillStyle=s.tradeDirection==='CALL'?'#67d99a':'#ff7474';ctx.fillText('E',ex,ey-5)} if(Number.isFinite(+t.exitEpoch)&&Number.isFinite(+t.exitSpot)){const xx=xFor(+t.exitEpoch),xy=yFor(+t.exitSpot);ctx.fillStyle=t.outcome==='WON'?'#67d99a':'#ff7474';ctx.fillText('X',xx,xy+12)}}}
  ctx.fillStyle='rgba(245,247,250,.9)';ctx.font='12px system-ui';ctx.fillText(`${replayOffset?'REPLAY':'LIVE'} · ${latest.analysis?.pattern?.familyId||'SEARCHING'} · ${latest.analysis?.structure?.tag||'—'} · ${latest.analysis?.state||'WARMING'}`,16,20);
}

function render(data = {}) {
  latest = { ...latest, ...data, signals:data.signals || latest.signals || [] };
  renderDashboard(); renderLedger(); renderTrades(); renderChart();
}

export const V73UI = { install, render };