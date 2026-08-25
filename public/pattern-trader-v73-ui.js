const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const fmt = (v, n = 1) => Number.isFinite(+v) ? Number(v).toFixed(n) : '—';
const money = v => `${Number(v || 0) >= 0 ? '+' : ''}$${Number(v || 0).toFixed(2)}`;
let latest = { analysis:null, signals:[], ticks:[], engine:null, batchSize:2, maxConcurrent:6, accountType:'DEMO' };
let replayOffset = 0;
let replay = false;

function installStyles() {
  if ($('v8Styles')) return;
  const style = document.createElement('style');
  style.id = 'v8Styles';
  style.textContent = `
    html{overflow-anchor:none}.observatoryShell{max-width:1500px}.v8HeroNote{font-size:12px;color:#9ba2ae}.v8Strip{display:grid;grid-template-columns:1.35fr .8fr 1fr 1fr 1fr .8fr;gap:8px;margin:12px 0}.v8Cell{background:#0d1015;border:1px solid #252b35;border-radius:12px;padding:11px 12px;min-height:70px}.v8Cell span{display:block;color:#858e9c;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.v8Cell strong{display:block;margin-top:7px;font-size:14px;line-height:1.2;overflow-wrap:anywhere}.v8Cell.hot{border-color:rgba(103,217,154,.55)}.v8Action{display:flex;align-items:center;justify-content:space-between;gap:12px;background:#10141a;border:1px solid #303744;border-radius:14px;padding:14px;margin:10px 0 14px}.v8Action strong{font-size:20px}.v8Action p{margin:4px 0 0;color:#9ba2ae;font-size:11px}.v8Stats{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:7px;margin:10px 0}.v8Stat{background:#0d1015;border:1px solid #222832;border-radius:10px;padding:9px}.v8Stat span{display:block;color:#828b99;font-size:9px}.v8Stat b{display:block;margin-top:5px;font-size:12px}.v81Scoreboard{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin:10px 0}.v81Lane{background:#0a0d11;border:1px solid #202630;border-radius:9px;padding:8px}.v81Lane span{display:block;font-size:8px;color:#7f8998;text-transform:uppercase}.v81Lane b{display:block;font-size:11px;margin-top:4px}.v81Lane.winner{border-color:rgba(103,217,154,.55)}.v81RealMode{margin-top:8px;padding:9px;border:1px solid rgba(255,116,116,.45);border-radius:9px;background:rgba(255,116,116,.06)}.v81RealMode label{display:flex;gap:8px;align-items:flex-start;font-size:11px}.v8Replay{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:7px 0 10px}.v8Replay .tools{display:flex;gap:6px;align-items:center}.v8Replay small{color:#8d96a5}.v8Legend{display:flex;gap:12px;flex-wrap:wrap;color:#8d96a5;font-size:10px;margin-top:8px}.v8Legend b{color:#e9edf3}.v8Audit{height:390px;max-height:390px;overflow:auto;scrollbar-gutter:stable}.logs{height:220px!important;max-height:220px!important}.v8Collapsed>*:not(.sectionTitle){display:none!important}.v8Collapsible>.sectionTitle{cursor:pointer;user-select:none}.v8Collapsible>.sectionTitle:after{content:'▾';margin-left:auto;color:#7f8998}.v8Collapsed>.sectionTitle:after{content:'▸'}.v8Subtle{opacity:.75}.observatoryCanvasCard{min-height:460px}#masterCanvas{height:360px}.v8HideOld{display:none!important}
    @media(max-width:1050px){.v8Strip{grid-template-columns:repeat(3,1fr)}.v8Stats{grid-template-columns:repeat(4,1fr)}.v81Scoreboard{grid-template-columns:repeat(4,1fr)}}
    @media(max-width:650px){.v8Strip{grid-template-columns:1fr 1fr}.v8Stats{grid-template-columns:1fr 1fr}.v81Scoreboard{grid-template-columns:1fr 1fr}.v8Action{align-items:flex-start;flex-direction:column}.v8Replay{align-items:flex-start;flex-direction:column}}
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
  const lab = document.body?.dataset?.lab;
  const isSmfn = lab === 'smfn';
  const isMilkingZone = ['milking-zone','smfn'].includes(lab);
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('SANI Sniper Campaign v8.1'));
  const intro = document.querySelector('.obsIntro');
  if (intro) {
    intro.querySelector('.eyebrow').textContent = 'SEED → REPEAT → FIRE → LOCK → FLIP';
    intro.querySelector('h2').textContent = 'Many patterns are seen. Only repeated evidence earns the shot.';
    intro.querySelector('p').textContent = 'v8.1 keeps the fast pattern-first engine, then adds family identity, repeat confirmation, length priority, calibrated memory, campaign hysteresis and structure scoring. The full sniper lane alone may buy; six comparison lanes remain shadow-only.';
    const badges = intro.querySelectorAll('.obsBadges span');
    ['Demo + guarded Real','pattern-first','1T contract','7 shadow lanes','campaign lock','earned ×2'].forEach((t,i)=>{ if (badges[i]) badges[i].textContent=t; });
  }

  const traderCard = [...document.querySelectorAll('.card')].find(card => card.querySelector('#ptPnl'));
  if (traderCard && !$('v8Dashboard')) {
    const dash = document.createElement('div');
    dash.id = 'v8Dashboard';
    dash.innerHTML = `
      <div class="v8Strip">
        <div id="v8PatternCell" class="v8Cell"><span>Pattern family</span><strong id="v8Family">SEARCHING</strong></div>
        <div class="v8Cell"><span>Sniper state</span><strong id="v81State">WATCH</strong></div>
        <div class="v8Cell"><span>Historical edge</span><strong id="v8Edge">—</strong></div>
        <div class="v8Cell"><span>Family / address</span><strong id="v81Memory">—</strong></div>
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
      </div>
      <div class="sectionTitle"><span>Seven-lane shadow test</span><small>same ticks · exact executable window</small></div>
      <div id="v81Scoreboard" class="v81Scoreboard"></div>`;
    traderCard.insertBefore(dash, $('ptSignal'));
  }

  const masterCard = $('masterCanvas')?.closest('.card');
  if (masterCard && !$('v8Replay')) {
    const bar = document.createElement('div');
    bar.id = 'v8Replay'; bar.className = 'v8Replay';
    bar.innerHTML = '<div><b>Pattern campaign chart</b><br><small id="v8ReplayLabel">LIVE · latest 220 ticks</small></div><div class="tools"><button id="v8Older" type="button">← Older</button><button id="v8Newer" type="button">Newer →</button><button id="v8Live" type="button">Live</button></div>';
    masterCard.insertBefore(bar, $('masterCanvas'));
    const legend = document.createElement('div'); legend.className = 'v8Legend'; legend.innerHTML = '<span><b>S</b> seed</span><span><b>F×1 / F×2</b> sniper fire</span><span><b>↻</b> confirmed campaign flip</span><span><b>E</b> Deriv entry</span><span><b>X</b> expiry</span><span><b>HL/LH/HH/LL</b> fired address only</span>';
    masterCard.appendChild(legend);
  }

  $('v8Older')?.addEventListener('click', () => { replay = true; replayOffset += 180; renderChart(); });
  $('v8Newer')?.addEventListener('click', () => { replayOffset = Math.max(0, replayOffset - 180); if (!replayOffset) replay=false; renderChart(); });
  $('v8Live')?.addEventListener('click', () => { replay=false; replayOffset=0; renderChart(); });

  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader') || x.textContent.includes('Sniper Campaign') || x.textContent.includes('Pattern + Structure'));
  if (title) title.textContent = 'Sniper Campaign v8.1 · Controlled Execution';
  if ($('ptStart')) $('ptStart').textContent = isSmfn ? 'START SMFN' : isMilkingZone ? 'START MILKING' : 'Start v8.1 Sniper';

  const cooldownLabel = $('ptCooldown')?.closest('label');
  if (cooldownLabel) cooldownLabel.childNodes[0].textContent = isSmfn ? 'Bot contracts / pulse' : 'Batch contracts / pulse';
  if ($('ptCooldown')) { $('ptCooldown').min='1'; $('ptCooldown').max='2'; $('ptCooldown').step='1'; $('ptCooldown').value='2'; }
  const maxLabel = $('ptMaxTrades')?.closest('label'); if (maxLabel) maxLabel.childNodes[0].textContent = isSmfn ? 'Max contracts this run' : 'Persistent max contracts';

  if ($('ptRealGate')) {
    $('ptRealGate').innerHTML = '<strong>Guarded Real-money experiment</strong><p>Only the full v8.1 sniper lane can buy. Mandatory SL, 50-contract cap, $5 maximum stake, two open contracts maximum, and a 30-tick pause after three losses.</p><div id="v81RealMode" class="v81RealMode"><label><input id="v81RealConfirm" type="checkbox"> <span>I understand this is an unproven experiment and Real losses are possible.</span></label></div>';
  }

  const metricLabels = [...document.querySelectorAll('.metric span')];
  const names = ['Pattern context','Pattern location','Campaign direction','Pattern state','Structure feature','Execution mode','Measured entry','Bought contracts','Cohort signals','Actual W/L','Actual P/L','CALL pulses','PUT pulses','Qualified pulses','Observed / blocked'];
  metricLabels.slice(4, 19).forEach((el,i)=>{ if(names[i]) el.textContent=names[i]; });

  const tx = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('transactions'));
  if (tx) tx.textContent = 'v8.1 Actual Sniper Contracts';
  const ledgerTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Setup Ledger') || x.textContent.includes('Lifecycle') || x.textContent.includes('Candidate Audit'));
  if (ledgerTitle) ledgerTitle.textContent = 'v8.1 Sniper Decision Audit';
  const ledgerTable = $('ptLedgerRows')?.closest('table');
  if (ledgerTable) {
    const ledgerHead = ledgerTable.querySelector('thead');
    if (ledgerHead) ledgerHead.innerHTML = '<tr><th>Time</th><th>Event</th><th>Family</th><th>Address</th><th>Score</th><th>Memory</th><th>Campaign</th><th>Batch</th><th>Speed</th><th>Actual</th><th>Shadow</th><th>Why</th></tr>';
    ledgerTable.closest('.tableWrap')?.classList.add('v8Audit');
  }
  if ($('ptExportLedger')) $('ptExportLedger').textContent = isSmfn ? 'DOWNLOAD SMFN CSV' : isMilkingZone ? 'DOWNLOAD MILK CSV' : 'Export v8.1 CSV';
  if ($('ptClearLedger')) $('ptClearLedger').textContent = isSmfn ? 'CLEAR SMFN RESULTS' : isMilkingZone ? 'CLEAR MILK RESULTS' : 'Clear v8.1 cohort';

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
    <div><b>1 · Seed</b><span>The first qualified family is marked S and stored. It does not spend money.</span></div>
    <div><b>2 · Repeat</b><span>The same shape family and direction must recur inside three fresh ticks.</span></div>
    <div><b>3 · Weight</b><span>12T is primary, 20T supports persistence, and 8T must overcome a stricter score.</span></div>
    <div><b>4 · Remember</b><span>Every family and family-at-address keeps an execution-aware live W/L memory.</span></div>
    <div><b>5 · Lock</b><span>One opposite signal cannot flip a campaign. Two opposing votes inside three ticks are required.</span></div>
    <div><b>6 · Modify</b><span>HH/HL/LH/LL changes the score; structure never becomes a permission gate.</span></div>
    <div><b>7 · Earn ×2</b><span>B-grade fire sends one contract. Only an A-grade repeated shot earns the second.</span></div>`;
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

function variantScore(signals, key) {
  const rows = signals.filter(row => !row.legacy && row.variants?.[key] && ['WON','LOST'].includes(row.variantOutcomes?.[key] || row.shadow?.outcome));
  const wins = rows.filter(row => (row.variantOutcomes?.[key] || row.shadow?.outcome) === 'WON').length;
  const losses = rows.length - wins;
  return { wins, losses, total:rows.length, rate:rows.length ? wins / rows.length * 100 : 0 };
}

function renderScoreboard(signals) {
  const board = $('v81Scoreboard');
  if (!board) return;
  const lanes = [['control','Control v8'],['repeat','Seed-repeat'],['length','Length weight'],['memory','Family memory'],['hysteresis','Campaign lock'],['structure','Structure modifier'],['sniper','Full sniper']];
  const scored = lanes.map(([key,label]) => ({ key, label, ...variantScore(signals,key) }));
  const mature = scored.filter(row => row.total >= 10);
  const best = mature.sort((left,right)=>right.rate-left.rate || right.total-left.total)[0]?.key;
  board.innerHTML = scored.map(row => `<div class="v81Lane ${row.key===best?'winner':''}"><span>${esc(row.label)}</span><b>${row.total ? `${row.wins}W/${row.losses}L · ${fmt(row.rate)}%` : 'collecting'}</b></div>`).join('');
}

function renderDashboard() {
  const { analysis, signals, engine, batchSize, maxConcurrent } = latest;
  const s = summarize(signals);
  const p = analysis?.pattern;
  const st = analysis?.structure;
  const sniper = analysis?.sniper;
  set('v8Family', p?.familyId || 'SEARCHING');
  set('v81State', sniper ? `${sniper.event} · ${sniper.grade} · ${fmt(sniper.score)}` : 'WATCH');
  set('v8Edge', p ? `${fmt(p.edge)}% · ${p.matchCount||0} matches` : '—');
  set('v81Memory', sniper ? `${sniper.familyMemory?.wins||0}/${sniper.familyMemory?.losses||0} · ${st?.tag||'—'} ${sniper.addressMemory?.wins||0}/${sniper.addressMemory?.losses||0}` : '—');
  set('v8Campaign', analysis?.campaign?.direction && analysis.campaign.direction !== 'NONE' ? `${analysis.campaign.direction} · ${analysis.campaign.fires||0} fires` : 'NONE');
  set('v8DecisionMs', `${fmt(analysis?.decisionMs,2)} ms`);
  set('v8ActionText', analysis?.state === 'ENTER' ? `${p?.direction === 'UP' ? 'CALL' : 'PUT'} · ${sniper?.event} ${sniper?.grade}` : sniper?.event || 'WATCH');
  set('v8Why', analysis?.reason || 'Building pattern memory.');
  set('v8Pulse', analysis?.state === 'ENTER' ? `${Math.min(batchSize,sniper?.batch||1)} contract${Math.min(batchSize,sniper?.batch||1)===1?'':'s'}` : '0 contracts');
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
  renderScoreboard(signals);

  set('mtRegime200', analysis?.context200 || 'FEATURE');
  set('mtTrend80', analysis?.context80 || 'FEATURE');
  set('mtSession', analysis?.campaign?.direction || 'NONE');
  set('mtEntry20', p?.familyId || 'SEARCH');
  set('mtChop', st?.tag || '—');
  set('mtVolatility', `${latest.accountType} · SNIPER`);
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
    ? `<b class="${p?.direction==='UP'?'positive':'negative'}">${p?.direction==='UP'?'CALL':'PUT'} · ${esc(sniper?.event||'FIRE')} ×${Math.min(batchSize,sniper?.batch||1)}</b><span>${esc(p?.familyId||'pattern')} · grade ${esc(sniper?.grade||'—')} · score ${fmt(sniper?.score)} · ${esc(st?.tag||'')} · ${fmt(analysis?.decisionMs,2)}ms</span>`
    : `<b>${esc(sniper?.event || 'WATCH')}</b><span>${esc(analysis?.reason || 'Waiting for a statistically qualified repeat.')}</span>`;
}

function renderLedger() {
  if (!$('ptLedgerRows')) return;
  const rows = latest.signals.slice(0,250);
  $('ptLedgerRows').innerHTML = rows.length ? rows.map(r => {
    const actual = (r.actualTrades||[]);
    const aw = actual.filter(t=>t.outcome==='WON').length, al = actual.filter(t=>t.outcome==='LOST').length;
    const ap = actual.reduce((s,t)=>s+(+t.profit||0),0);
    const act = actual.length ? `${aw}W/${al}L ${money(ap)}` : (r.executionState || '—');
    return `<tr class="${r.legacy?'v73Legacy':''}"><td>${new Date(r.createdAt||Date.now()).toLocaleTimeString()}</td><td>${esc(r.sniper?.event || (r.approved?'FIRE':'WATCH'))}</td><td>${esc(r.pattern?.familyId||'—')}</td><td>${esc(r.structure?.tag||'—')} ${esc(r.structure?.phase||'')}</td><td>${Number.isFinite(+r.sniper?.score)?`${esc(r.sniper.grade)} ${fmt(r.sniper.score)}`:'—'}</td><td>${r.sniper?`F ${r.sniper.familyMemory?.wins||0}/${r.sniper.familyMemory?.losses||0} · A ${r.sniper.addressMemory?.wins||0}/${r.sniper.addressMemory?.losses||0}`:'—'}</td><td>${esc(r.campaign?.direction||'NONE')} ${r.campaign?.fires||0}</td><td>${r.approved?`×${r.requestedBatch||1}`:'—'}</td><td>${Number.isFinite(+r.decisionMs)?fmt(r.decisionMs,2)+'ms':'—'}</td><td>${act}</td><td>${r.shadow?.outcome||'—'}</td><td>${esc(r.why||'—')}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v8.1 sniper decisions yet.</td></tr>';
}

function renderTrades() {
  if (!$('ptTradeRows')) return;
  const rows = latest.signals.filter(x=>!x.legacy).flatMap(s => (s.actualTrades||[]).map(t=>({s,t}))).sort((a,b)=>(b.t.contractId||0)-(a.t.contractId||0)).slice(0,100);
  $('ptTradeRows').innerHTML = rows.length ? rows.map(({s,t}) => `<tr><td>#${t.contractId||'—'}</td><td>${esc(s.campaign?.direction||s.tradeDirection||'—')}</td><td>${esc(s.tradeDirection||'—')}</td><td>${esc(t.slotRole||'BASE')} · ${esc(s.pattern?.familyId||'—')} · ${esc(s.structure?.tag||'—')}</td><td><span class="result ${String(t.outcome||'').toLowerCase()}">${esc(t.outcome||'OPEN')}</span></td><td>1t</td><td>T+${s.executionOffset||1}→T+${(s.executionOffset||1)+1}</td><td>${esc(t.window||'—')}</td><td>${esc(t.latency||'—')}</td><td class="${(+t.profit||0)>=0?'positive':'negative'}">${Number.isFinite(+t.profit)?money(t.profit):'—'}</td><td>${Number.isFinite(+t.buyAckMs)?fmt(t.buyAckMs,0)+'ms':'—'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`).join('') : '<tr><td colspan="12" class="empty">No v8.1 actual contracts yet.</td></tr>';
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
  for (const s of visible) {
    const x = xFor(+s.signalEpoch), y = yFor(+s.signalQuote), event = s.sniper?.event;
    if (event === 'SEED') {
      ctx.fillStyle = 'rgba(245,247,250,.55)'; ctx.font = 'bold 9px system-ui'; ctx.fillText('S', x + 3, y - 6);
    }
    if (s.approved) {
      ctx.fillStyle = s.tradeDirection === 'CALL' ? '#67d99a' : '#ff7474'; ctx.font = 'bold 10px system-ui';
      ctx.fillText(event === 'FLIP' ? `↻ F×${s.requestedBatch||1}` : `F×${s.requestedBatch||1}`, x + 4, y - 7);
      if (Number.isFinite(+s.structure?.pivotEpoch) && Number.isFinite(+s.structure?.pivotQuote) && +s.structure.pivotEpoch >= startEpoch && +s.structure.pivotEpoch <= endEpoch) {
        ctx.fillStyle = 'rgba(126,165,215,.82)'; ctx.font = '9px system-ui';
        ctx.fillText(s.structure.tag || s.structure.pivotType, xFor(+s.structure.pivotEpoch) + 3, yFor(+s.structure.pivotQuote) - 6);
      }
    }
    for (const t of s.actualTrades || []) {
      if (Number.isFinite(+t.entryEpoch) && Number.isFinite(+t.entrySpot)) { const ex=xFor(+t.entryEpoch), ey=yFor(+t.entrySpot); ctx.fillStyle=s.tradeDirection==='CALL'?'#67d99a':'#ff7474'; ctx.fillText('E',ex,ey-5); }
      if (Number.isFinite(+t.exitEpoch) && Number.isFinite(+t.exitSpot)) { const xx=xFor(+t.exitEpoch), xy=yFor(+t.exitSpot); ctx.fillStyle=t.outcome==='WON'?'#67d99a':'#ff7474'; ctx.fillText('X',xx,xy+12); }
    }
  }
  ctx.fillStyle='rgba(245,247,250,.9)';ctx.font='12px system-ui';ctx.fillText(`${replayOffset?'REPLAY':'LIVE'} · ${latest.analysis?.sniper?.event||'WATCH'} ${latest.analysis?.sniper?.grade||''} · ${latest.analysis?.campaign?.direction||'NONE'} · ${latest.accountType}`,16,20);
}

function render(data = {}) {
  latest = { ...latest, ...data, signals:data.signals || latest.signals || [] };
  renderDashboard(); renderLedger(); renderTrades(); renderChart();
  window.dispatchEvent(new CustomEvent('sani-v81-ui-render', { detail:latest }));
}

export const V73UI = { install, render };
