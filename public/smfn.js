import { estimateSmfnPlan, SMFN_CALIBRATION } from './core/smfn-brain.mjs';

const $ = id => document.getElementById(id);
const set = (id, value) => { if ($(id)) $(id).textContent = value; };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const money = value => `${Number(value || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(value || 0)).toFixed(2)}`;
const pct = value => `${Number(value || 0).toFixed(1)}%`;
let currentChapter = 0;
let latest = { signals:[], ticks:[], engine:{}, trend:null, smfn:null };

function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h,m,s].map(value => String(value).padStart(2,'0')).join(':');
}

function showChapter(index) {
  const chapters = [...document.querySelectorAll('[data-smfn-chapter]')];
  currentChapter = Math.max(0, Math.min(chapters.length - 1, Number(index) || 0));
  chapters.forEach((chapter, i) => {
    const active = i === currentChapter;
    chapter.classList.toggle('active', active);
    chapter.setAttribute('aria-hidden', String(!active));
  });
  document.querySelectorAll('[data-smfn-target]').forEach(button => button.classList.toggle('active', Number(button.dataset.smfnTarget) === currentChapter));
  set('smfnChapterLabel', `SCREEN ${currentChapter + 1} / ${chapters.length}`);
  if ($('smfnProgress')) $('smfnProgress').style.width = `${(currentChapter + 1) / chapters.length * 100}%`;
  if ($('smfnPrev')) $('smfnPrev').disabled = currentChapter === 0;
  if ($('smfnNext')) $('smfnNext').disabled = currentChapter === chapters.length - 1;
  requestAnimationFrame(drawChart);
}

function currentMode() {
  return document.querySelector('input[name="smfnMode"]:checked')?.value || 'AUTO';
}

function renderMode() {
  document.querySelectorAll('.smfnModeCard').forEach(card => card.classList.toggle('selected', Boolean(card.querySelector('input:checked'))));
  if ($('ptStart')) $('ptStart').textContent = currentMode() === 'AUTO' ? 'START SMFN' : 'START MANUAL MILKING';
}

function renderForecast() {
  const plan = estimateSmfnPlan({
    minutes:Number($('smfnDuration')?.value || 30),
    target:Number($('ptTakeProfit')?.value || 0),
    stake:Number($('ptStake')?.value || 1),
    batch:Number($('ptCooldown')?.value || 2)
  });
  set('smfnForecastRange', `${money(plan.lowProfit)} → ${money(plan.highProfit)}`);
  set('smfnForecastNote', `${plan.minutes} min · $${plan.stake.toFixed(2)} stake · ${plan.batch} per qualified entry`);
  set('smfnForecastTrades', `${plan.lowContracts}–${plan.highContracts}`);
  set('smfnForecastExpected', money(plan.expectedProfit));
  set('smfnSuggestedStake', `$${plan.suggestedStake.toFixed(2)}`);
  set('smfnBreakEven', `${plan.breakEvenRate.toFixed(1)}%`);
  const feasibility = $('smfnFeasibility');
  if (feasibility) {
    feasibility.classList.toggle('warn', !plan.feasible || plan.target > plan.expectedProfit);
    feasibility.textContent = !plan.target
      ? 'No profit target selected. SMFN will use the time and loss cap only.'
      : !plan.feasible
        ? `Target ${money(plan.target)} sits above today’s evidence band. Increase time—not hope—or lower the target.`
        : plan.target <= plan.lowProfit
          ? `Target ${money(plan.target)} falls inside the conservative evidence band, but loss remains possible.`
          : `Target ${money(plan.target)} is possible in today’s evidence band, not dependable. Suggested central stake: $${plan.suggestedStake.toFixed(2)}.`;
  }
  set('smfnCmdTarget', money(Number($('ptTakeProfit')?.value || 0)));
  set('smfnCmdStop', `-$${Math.abs(Number($('ptStopLoss')?.value || 0)).toFixed(2)}`);
}

function flattenTrades(signals = []) {
  const rows = [];
  for (const signal of signals) {
    for (const trade of signal.actualTrades || []) {
      rows.push({ signal, trade, at:Number(trade.exitEpoch || trade.entryEpoch || signal.signalEpoch || 0) });
    }
  }
  return rows.sort((a,b) => b.at - a.at);
}

function renderResults(signals = []) {
  const trades = flattenTrades(signals);
  const settled = trades.filter(({trade}) => ['WON','LOST'].includes(trade.outcome));
  const wins = settled.filter(({trade}) => trade.outcome === 'WON').length;
  const losses = settled.filter(({trade}) => trade.outcome === 'LOST').length;
  const pnl = settled.reduce((sum,{trade}) => sum + Number(trade.profit || 0), 0);
  const calls = settled.filter(({signal}) => signal.tradeDirection === 'CALL').length;
  const puts = settled.filter(({signal}) => signal.tradeDirection === 'PUT').length;
  const blocks = signals.filter(signal => signal.milkCandidate && signal.smfn && !signal.smfn.approved).length;
  set('smfnContracts', settled.length);
  set('smfnWins', wins);
  set('smfnLosses', losses);
  set('smfnCalls', calls);
  set('smfnPuts', puts);
  set('smfnBlocks', blocks);
  set('smfnResultPnl', money(pnl));
  set('smfnResultRate', settled.length ? `${pct(wins / settled.length * 100)} win rate` : '0.0% win rate');
  set('smfnResultLane', latest.smfn?.allowedDirection || 'NONE');
  set('smfnResultStatus', latest.smfn?.status || 'IDLE');
  const body = $('smfnTradeBody');
  if (body) body.innerHTML = settled.length ? settled.slice(0,100).map(({signal,trade,at}) => {
    const outcomeClass = trade.outcome === 'WON' ? 'smfnWin' : 'smfnLoss';
    return `<tr><td>${new Date(at * 1000).toLocaleTimeString()}</td><td>${esc(signal.tradeDirection)}</td><td>${esc(signal.milking?.direction || 'NONE')}</td><td>${esc(signal.sniper?.grade || '—')}</td><td class="${outcomeClass}">${esc(trade.outcome)}</td><td>${esc(trade.entrySpot ?? '—')} → ${esc(trade.exitSpot ?? '—')}</td><td class="${Number(trade.profit || 0) >= 0 ? 'smfnWin' : 'smfnLoss'}">${money(trade.profit)}</td></tr>`;
  }).join('') : '<tr><td colspan="7">NO SMFN TRADES YET</td></tr>';
}

function renderTape(signals = []) {
  const body = $('smfnTapeBody');
  if (!body) return;
  body.innerHTML = signals.length ? signals.slice(0,180).map(signal => {
    const smfn = signal.smfn || {};
    const action = smfn.action || signal.executionState || 'WATCH';
    return `<tr><td>${new Date(signal.createdAt || Date.now()).toLocaleTimeString()}</td><td>${esc(smfn.status || 'IDLE')}</td><td>${esc(smfn.allowedDirection || 'NONE')}</td><td>${esc(signal.milking?.direction || 'NONE')}</td><td>${esc(signal.milking?.state || 'OBSERVE')}</td><td>${esc(signal.tradeDirection || '—')}</td><td class="${signal.approved ? 'smfnWin' : 'smfnBlocked'}">${esc(action)}</td><td>${esc(smfn.reason || signal.why || '—')}</td></tr>`;
  }).join('') : '<tr><td colspan="8">COLLECTING TICKS</td></tr>';
}

function renderBrain() {
  const engine = latest.engine || {};
  const trend = latest.trend || {};
  const brain = latest.smfn || {};
  const decision = brain.lastDecision || {};
  const mode = brain.config?.mode || currentMode();
  const lane = brain.allowedDirection || 'NONE';
  const direction = trend.direction || 'NONE';
  const state = trend.state || 'OBSERVE';
  set('smfnArchiveCount', (latest.ticks || []).length.toLocaleString());
  set('smfnTraderConnection', engine.connected ? (engine.running ? 'ACTIVE' : 'CONNECTED') : 'OFFLINE');
  set('smfnHeaderState', brain.status || (engine.connected ? 'READY' : 'OFFLINE'));
  set('smfnHeaderPnl', money(engine.sessionPnL));
  set('smfnTickerText', `${mode} · ${direction} ${state} · ${lane} LANE · ${brain.reason || 'WAITING'}`);
  set('smfnDirection', direction === 'UP' ? '▲ UP' : direction === 'DOWN' ? '▼ DOWN' : '—');
  set('smfnTrendState', state);
  set('smfnDirectionReason', trend.reason || 'The map is forming.');
  set('smfnHealth', trend.health ?? 0); set('smfnMaturity', `${trend.maturity ?? 0}%`); set('smfnExhaustion', `${trend.exhaustion ?? 0}%`);
  if ($('smfnHealthMeter')) $('smfnHealthMeter').value = Number(trend.health || 0);
  if ($('smfnMaturityMeter')) $('smfnMaturityMeter').value = Number(trend.maturity || 0);
  if ($('smfnExhaustionMeter')) $('smfnExhaustionMeter').value = Number(trend.exhaustion || 0);
  const remaining = trend.remaining?.median;
  set('smfnRemaining', Number.isFinite(Number(remaining)) ? `~${Math.max(0,Math.round(Number(remaining) / 60)) || '<1'} MIN` : '—');
  set('smfnRemainingMeta', Number.isFinite(Number(remaining)) ? `${trend.remaining.low ?? 0}–${trend.remaining.high ?? 0}s historical range` : 'waiting for direction');
  set('smfnLiveLane', lane);
  set('smfnNarratorHeadline', lane !== 'NONE' ? `${lane} BOT HAS THE KEY` : state === 'MATURE' ? `LOCKING ${direction}` : `WAIT · ${state}`);
  set('smfnNarratorWhy', brain.reason || trend.reason || 'Connect live data to begin.');
  set('smfnCommandAction', decision.action || brain.status || 'NOT ARMED');
  set('smfnCommandReason', decision.reason || brain.reason || 'Connect, choose a plan, then start.');
  set('smfnRunPnl', money(brain.runPnl));
  set('smfnRunTrades', `${brain.runTrades || 0} contracts`);
  set('smfnRunClock', formatClock(brain.remainingMs));
  set('smfnRunPhase', brain.phase || 'IDLE');
  if ($('ptStart') && !engine.running) $('ptStart').textContent = mode === 'AUTO' ? 'START SMFN' : 'START MANUAL MILKING';
  set('smfnSafetyState', brain.phase === 'LANDING' ? 'SAFETY LANDING' : brain.status || 'READY');
  set('smfnCmdOpen', Number(engine.openContracts || 0));
  const cooldown = Number(brain.cooldownUntil || 0) - Date.now();
  set('smfnCmdCooldown', cooldown > 0 ? `${Math.ceil(cooldown/1000)}s` : 'READY');
  const callActive = lane === 'CALL';
  const putActive = lane === 'PUT';
  $('smfnCallLane')?.classList.toggle('active', callActive);
  $('smfnPutLane')?.classList.toggle('active', putActive);
  set('smfnCallState', mode === 'MANUAL' ? 'MANUAL' : callActive ? 'ACTIVE' : 'LOCKED');
  set('smfnPutState', mode === 'MANUAL' ? 'MANUAL' : putActive ? 'ACTIVE' : 'LOCKED');
  set('smfnCallWhy', mode === 'MANUAL' ? 'Existing Milking logic decides every CALL.' : callActive ? 'UP is the only permitted bot.' : 'Locked while SMFN scans or runs PUT.');
  set('smfnPutWhy', mode === 'MANUAL' ? 'Existing Milking logic decides every PUT.' : putActive ? 'DOWN is the only permitted bot.' : 'Locked while SMFN scans or runs CALL.');
  renderResults(latest.signals || []);
  renderTape(latest.signals || []);
}

function canvasSize(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width || 1000), height = Math.max(240, rect.height || 420);
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) { canvas.width=Math.round(width*dpr); canvas.height=Math.round(height*dpr); }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx,width,height};
}

function drawChart() {
  const canvas = $('smfnTrendCanvas');
  if (!canvas || !canvas.offsetParent) return;
  const {ctx,width,height} = canvasSize(canvas);
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#020a11';ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='rgba(82,140,171,.16)';ctx.lineWidth=1;
  for(let x=0;x<=width;x+=width/12){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke()}
  for(let y=0;y<=height;y+=height/7){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke()}
  const rows=(latest.ticks||[]).slice(-300);
  if(rows.length<2){ctx.fillStyle='#6e8da0';ctx.font='12px monospace';ctx.fillText('WAITING FOR LIVE TICKS',18,28);return}
  const quotes=rows.map(row=>Number(row.quote));
  const min=Math.min(...quotes),max=Math.max(...quotes),span=max-min||1;
  const start=Number(rows[0].epoch),end=Number(rows.at(-1).epoch);
  const xFor=epoch=>16+(Number(epoch)-start)/Math.max(1,end-start)*(width-32);
  const yFor=quote=>height-20-(Number(quote)-min)/span*(height-44);
  const lane=latest.smfn?.allowedDirection;
  if(lane==='CALL'||lane==='PUT'){
    ctx.fillStyle=lane==='CALL'?'rgba(182,255,102,.07)':'rgba(255,102,128,.07)';ctx.fillRect(0,0,width,height);
  }
  ctx.strokeStyle='#5fb8ff';ctx.lineWidth=2;ctx.beginPath();rows.forEach((row,index)=>{const x=xFor(row.epoch),y=yFor(row.quote);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  const signals=(latest.signals||[]).filter(signal=>Number(signal.signalEpoch)>=start&&Number(signal.signalEpoch)<=end);
  for(const signal of signals){
    if(!Number.isFinite(Number(signal.signalQuote)))continue;
    const x=xFor(signal.signalEpoch),y=yFor(signal.signalQuote);
    if(signal.smfn?.approved){ctx.fillStyle=signal.tradeDirection==='CALL'?'#b6ff66':'#ff6680';ctx.fillRect(x-4,y-4,9,9);ctx.fillStyle='#f1f7dc';ctx.font='bold 9px monospace';ctx.fillText(signal.tradeDirection==='CALL'?'C':'P',x+6,y-7)}
    else if(signal.milkCandidate&&signal.smfn){ctx.fillStyle='rgba(255,212,91,.55)';ctx.fillRect(x-2,y-2,5,5)}
  }
  ctx.fillStyle='#59f5ed';ctx.font='bold 11px monospace';ctx.fillText(`${latest.trend?.direction||'NONE'} · ${latest.trend?.state||'OBSERVE'} · ${lane||'NO BOT'} · H${latest.trend?.health||0} M${latest.trend?.maturity||0}%`,16,18);
}

document.querySelectorAll('[data-smfn-target]').forEach(button => button.addEventListener('click', () => showChapter(button.dataset.smfnTarget)));
$('smfnPrev')?.addEventListener('click', () => showChapter(currentChapter - 1));
$('smfnNext')?.addEventListener('click', () => showChapter(currentChapter + 1));
document.querySelectorAll('input[name="smfnMode"]').forEach(input => input.addEventListener('change', () => { renderMode(); renderForecast(); renderBrain(); }));
for (const id of ['smfnDuration','ptTakeProfit','ptStake','ptStopLoss','ptMaxTrades','ptCooldown','smfnLandingMinutes','smfnRecoveryTarget']) $(id)?.addEventListener('input', renderForecast);
window.addEventListener('smfn-state', event => { latest = { ...latest, ...(event.detail || {}) }; renderBrain(); drawChart(); });
window.addEventListener('resize', drawChart);
setInterval(() => {
  const snapshot = window.SMFN?.getSnapshot?.();
  if (snapshot) latest = { ...latest, ...snapshot, smfn:snapshot.brain };
  renderBrain();
},1000);

showChapter(0);
renderMode();
renderForecast();
renderBrain();
