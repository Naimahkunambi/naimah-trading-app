import { estimateSmfnPlan, SMFN_CALIBRATION } from './core/smfn-brain.mjs';
import { routeSegments, tradeAuditPoint, visibleTickWindow } from './core/smfn-map-history.mjs';

const $ = id => document.getElementById(id);
const set = (id, value) => { if ($(id)) $(id).textContent = value; };
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const money = value => `${Number(value || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(value || 0)).toFixed(2)}`;
const pct = value => `${Number(value || 0).toFixed(1)}%`;
let currentChapter = 0;
let latest = { signals:[], ticks:[], engine:{}, trend:null, smfn:null };
const mapZoomLevels = [60,120,200,300,500];
let mapZoomIndex = 1;
let mapFrozen = false;
let mapSnapshot = null;
let mapHistoryOffset = 0;
let mapDrawEnabled = false;
let mapInkColor = '#ffd45b';
let mapInk = [];
let activeMapStroke = null;

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
    batch:Number($('ptCooldown')?.value || 2),
    maxTrades:Number($('ptMaxTrades')?.value || 200)
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

function groupedTradeAudits(signals = [], ticks = []) {
  return signals.flatMap(signal => {
    const trades = signal.actualTrades || [];
    if (!trades.length) return [];
    const audits = trades.map(trade => ({ trade, audit:tradeAuditPoint(signal, trade, ticks) }));
    const firstEntry = audits.find(row => Number.isFinite(row.audit.entryEpoch) && Number.isFinite(row.audit.entrySpot))?.audit || {};
    const lastExit = [...audits].reverse().find(row => Number.isFinite(row.audit.exitEpoch) && Number.isFinite(row.audit.exitSpot))?.audit || {};
    return [{
      signal,
      contracts:trades.length,
      wins:trades.filter(trade => trade.outcome === 'WON').length,
      losses:trades.filter(trade => trade.outcome === 'LOST').length,
      entryEpoch:firstEntry.entryEpoch,
      entrySpot:firstEntry.entrySpot,
      exitEpoch:lastExit.exitEpoch,
      exitSpot:lastExit.exitSpot
    }];
  });
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
  set('smfnMapPnl', money(brain.runPnl));
  set('smfnTickerText', `${mode} · ${direction} ${state} · ${lane === 'NONE' ? 'BOTS OFF' : `${lane} SIGNAL`} · ${brain.reason || 'WAITING'}`);
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
  set('smfnNarratorHeadline', lane !== 'NONE' ? `${lane} ENTRY FIRED` : 'WAITING FOR V8 ENTRY');
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
  set('smfnCmdCooldown', 'SIGNAL-BY-SIGNAL');
  const callActive = lane === 'CALL';
  const putActive = lane === 'PUT';
  $('smfnCallLane')?.classList.toggle('active', callActive);
  $('smfnPutLane')?.classList.toggle('active', putActive);
  set('smfnCallState', mode === 'MANUAL' ? 'MANUAL' : callActive ? 'FIRED' : 'READY');
  set('smfnPutState', mode === 'MANUAL' ? 'MANUAL' : putActive ? 'FIRED' : 'READY');
  set('smfnCallWhy', mode === 'MANUAL' ? 'Existing Milking logic decides every CALL.' : callActive ? 'The original v8 signal selected CALL for this entry only.' : 'Ready; it fires only when the next v8 entry says CALL.');
  set('smfnPutWhy', mode === 'MANUAL' ? 'Existing Milking logic decides every PUT.' : putActive ? 'The original v8 signal selected PUT for this entry only.' : 'Ready; it fires only when the next v8 entry says PUT.');
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

function ema(values, period) {
  if (!values.length) return [];
  const alpha = 2 / (Math.max(2, period) + 1);
  const out = [Number(values[0])];
  for (let i=1;i<values.length;i+=1) out.push(alpha * Number(values[i]) + (1-alpha) * out[i-1]);
  return out;
}

function displayedMap() {
  const source = mapFrozen && mapSnapshot ? mapSnapshot : latest;
  const window = visibleTickWindow(source.ticks || [], mapZoomLevels[mapZoomIndex], mapHistoryOffset);
  mapHistoryOffset = window.offset;
  const { ticks, start, end } = window;
  const orderedSignals = (source.signals || [])
    .filter(signal => Number.isFinite(Number(signal.signalEpoch)))
    .sort((a,b) => Number(a.signalEpoch) - Number(b.signalEpoch));
  const signals = orderedSignals.filter(signal => Number(signal.signalEpoch) >= start && Number(signal.signalEpoch) <= end);
  const anchorSignal = orderedSignals.filter(signal => Number(signal.signalEpoch) <= end).at(-1) || null;
  const anchorEntrySignal = orderedSignals.filter(signal => signal.approved && Number(signal.signalEpoch) <= end).at(-1) || null;
  const startSignal = orderedSignals.filter(signal => Number(signal.signalEpoch) <= start).at(-1) || null;
  const auditSignals = startSignal && !signals.includes(startSignal) ? [startSignal, ...signals] : signals;
  return { source, ticks, signals, auditSignals, anchorSignal, anchorEntrySignal, start, end, ...window };
}

function updateMapTag(frame = displayedMap()) {
  const mode = frame.offset > 0
    ? `HISTORY · ${frame.offset + frame.ticks.length}→${frame.offset + 1} TICKS AGO`
    : mapFrozen ? (mapDrawEnabled ? 'FROZEN · DRAW' : 'FROZEN') : 'LIVE';
  set('smfnChartTag', `${mode} · ${frame.ticks.length || mapZoomLevels[mapZoomIndex]} TICKS`);
  const freezeButton = $('smfnMapFreeze');
  freezeButton?.classList.toggle('active', mapFrozen);
  if (freezeButton) freezeButton.textContent = mapFrozen ? 'GO LIVE' : 'FREEZE MAP';
  if ($('smfnMapOlder')) $('smfnMapOlder').disabled = frame.maxOffset <= 0 || frame.offset >= frame.maxOffset;
  if ($('smfnMapNewer')) $('smfnMapNewer').disabled = frame.offset <= 0;
  $('smfnMapLive')?.classList.toggle('active', !mapFrozen && frame.offset === 0);
  $('smfnMapDraw')?.classList.toggle('active', mapDrawEnabled);
  $('smfnTrendCanvas')?.classList.toggle('drawing', mapDrawEnabled);
}

function freezeMap() {
  mapSnapshot = {
    ticks:(latest.ticks || []).slice(-10000).map(row => ({...row})),
    signals:(latest.signals || []).map(signal => ({...signal, actualTrades:(signal.actualTrades || []).map(trade => ({...trade}))})),
    trend:{...(latest.trend || {})},
    smfn:{...(latest.smfn || {})},
    engine:{...(latest.engine || {})}
  };
  mapFrozen = true;
  mapHistoryOffset = 0;
  updateMapTag();
  drawChart();
}

function setMapLive() {
  mapFrozen = false;
  mapSnapshot = null;
  mapHistoryOffset = 0;
  mapDrawEnabled = false;
  activeMapStroke = null;
  mapInk = [];
  updateMapTag();
  drawChart();
}

function moveMapHistory(direction) {
  if (!mapFrozen) freezeMap();
  const current = visibleTickWindow((mapSnapshot || latest).ticks || [], mapZoomLevels[mapZoomIndex], mapHistoryOffset);
  const step = Math.max(20, Math.floor(mapZoomLevels[mapZoomIndex] * .65));
  mapHistoryOffset = Math.max(0, Math.min(current.maxOffset, current.offset + direction * step));
  mapDrawEnabled = false;
  activeMapStroke = null;
  mapInk = [];
  drawChart();
}

function drawMapInk(ctx,width,height) {
  ctx.save();
  ctx.lineCap='round';ctx.lineJoin='round';
  for (const stroke of mapInk) {
    if (!stroke.points?.length) continue;
    ctx.strokeStyle=stroke.color || '#ffd45b';ctx.lineWidth=3;ctx.shadowColor=stroke.color || '#ffd45b';ctx.shadowBlur=3;
    ctx.beginPath();
    stroke.points.forEach((point,index) => { const x=point.x*width,y=point.y*height; index?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(ctx,x1,y1,x2,y2,color) {
  const angle=Math.atan2(y2-y1,x2-x1), size=10;
  ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=3;ctx.setLineDash([8,7]);
  ctx.beginPath();ctx.moveTo(x1,y1);ctx.bezierCurveTo(x1+(x2-x1)*.35,y1,x1+(x2-x1)*.7,y2,x2,y2);ctx.stroke();ctx.setLineDash([]);
  ctx.beginPath();ctx.moveTo(x2,y2);ctx.lineTo(x2-size*Math.cos(angle-.55),y2-size*Math.sin(angle-.55));ctx.lineTo(x2-size*Math.cos(angle+.55),y2-size*Math.sin(angle+.55));ctx.closePath();ctx.fill();
}

function drawChart() {
  const canvas = $('smfnTrendCanvas');
  if (!canvas || !canvas.offsetParent) return;
  const {ctx,width,height} = canvasSize(canvas);
  ctx.clearRect(0,0,width,height);
  ctx.fillStyle='#020a11';ctx.fillRect(0,0,width,height);
  const frame=displayedMap(), rows=frame.ticks;
  updateMapTag(frame);
  if(rows.length<2){ctx.fillStyle='#6e8da0';ctx.font='12px monospace';ctx.fillText('WAITING FOR LIVE TICKS',18,28);drawMapInk(ctx,width,height);return}
  const quotes=rows.map(row=>Number(row.quote));
  const smoothed=ema(quotes,Math.max(6,Math.round(rows.length/12)));
  const source=frame.source;
  const pastFrame=frame.offset>0;
  const trend=pastFrame ? (frame.anchorSignal?.milking || source.trend || {}) : (source.trend || latest.trend || {});
  let lane=pastFrame
    ? frame.anchorEntrySignal?.smfn?.allowedDirection || 'NONE'
    : source.smfn?.allowedDirection || latest.smfn?.allowedDirection;
  if (!['CALL','PUT'].includes(lane)) lane='NONE';
  const rawSpan=Math.max(...quotes)-Math.min(...quotes)||1;
  const footprintLookback=Math.min(smoothed.length-1,Math.max(12,Math.round(smoothed.length*.16)));
  const recentStart=smoothed[Math.max(0,smoothed.length-1-footprintLookback)];
  const footprintDelta=smoothed.at(-1)-recentStart;
  const direction=Math.abs(footprintDelta)>=rawSpan*.025
    ? (footprintDelta>0?'UP':'DOWN')
    : (trend.direction || 'FLAT');
  const sign=direction==='UP'?1:direction==='DOWN'?-1:Math.sign(footprintDelta)||1;
  const proposedStep=Math.min(rawSpan*.38,Math.max(Math.abs(footprintDelta)*.7,rawSpan*.06));
  const projected=smoothed.at(-1)+sign*proposedStep;
  const trades=groupedTradeAudits(frame.signals,rows);
  const allY=[...quotes,projected];
  for(const trade of trades){if(Number.isFinite(trade.entrySpot))allY.push(trade.entrySpot);if(Number.isFinite(trade.exitSpot))allY.push(trade.exitSpot)}
  const rawMin=Math.min(...allY),rawMax=Math.max(...allY),pad=(rawMax-rawMin||1)*.09,min=rawMin-pad,max=rawMax+pad,span=max-min||1;
  const start=frame.start,end=frame.end,left=24,top=38,bottom=height-32,plotRight=Math.max(left+120,width-(width<760?92:180));
  const xFor=epoch=>left+(Number(epoch)-start)/Math.max(1,end-start)*(plotRight-left);
  const yFor=quote=>bottom-(Number(quote)-min)/span*(bottom-top);
  ctx.strokeStyle='rgba(82,140,171,.16)';ctx.lineWidth=1;
  for(let x=left;x<=width;x+=(width-left)/10){ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke()}
  for(let i=0;i<=6;i+=1){const y=top+(bottom-top)*i/6;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(width-12,y);ctx.stroke()}
  ctx.fillStyle='rgba(255,212,91,.035)';ctx.fillRect(plotRight,top,width-plotRight-12,bottom-top);
  ctx.strokeStyle='rgba(255,212,91,.35)';ctx.setLineDash([4,6]);ctx.beginPath();ctx.moveTo(plotRight,top);ctx.lineTo(plotRight,bottom);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#6f8fa1';ctx.font='9px monospace';ctx.fillText(pastFrame?'PAST FRAME':'NOW',plotRight+6,top+12);
  for(const [value,y] of [[max,top+4],[(max+min)/2,(top+bottom)/2],[min,bottom]]){ctx.fillStyle='#567488';ctx.font='9px monospace';ctx.fillText(Number(value).toFixed(2),width-78,y);}
  ctx.strokeStyle='rgba(95,184,255,.78)';ctx.lineWidth=1.4;ctx.beginPath();rows.forEach((row,index)=>{const x=xFor(row.epoch),y=yFor(row.quote);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();
  const trendColor=direction==='DOWN'?'#ff6680':direction==='UP'?'#b6ff66':'#ffd45b';
  ctx.strokeStyle=trendColor;ctx.lineWidth=3.2;ctx.shadowColor=trendColor;ctx.shadowBlur=5;ctx.beginPath();rows.forEach((row,index)=>{const x=xFor(row.epoch),y=yFor(smoothed[index]);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.stroke();ctx.shadowBlur=0;
  drawArrow(ctx,plotRight,yFor(smoothed.at(-1)),width-30,yFor(projected),trendColor);
  ctx.fillStyle=trendColor;ctx.font='bold 10px monospace';ctx.fillText(`SMFN ${direction} PROPOSAL`,plotRight+8,Math.max(top+28,Math.min(bottom-8,yFor(projected)-9)));
  set('smfnMapProjection', `${direction} → ${Number(projected).toFixed(2)}`);
  for(const trade of trades){
    const {signal,entryEpoch,exitEpoch,entrySpot,exitSpot,contracts,wins,losses}=trade;
    if(Number.isFinite(entryEpoch)&&Number.isFinite(entrySpot)&&entryEpoch>=start&&entryEpoch<=end){const x=xFor(entryEpoch),y=yFor(entrySpot);ctx.fillStyle=signal.tradeDirection==='PUT'?'#ff6680':'#59f5ed';ctx.beginPath();ctx.moveTo(x,y-8);ctx.lineTo(x-7,y+6);ctx.lineTo(x+7,y+6);ctx.closePath();ctx.fill();ctx.fillStyle='#dffffc';ctx.font='bold 8px monospace';ctx.fillText(`E ${signal.tradeDirection||''}${contracts>1?` ×${contracts}`:''}`,x+9,y-6)}
    if(Number.isFinite(exitEpoch)&&Number.isFinite(exitSpot)&&exitEpoch>=start&&exitEpoch<=end){const x=xFor(exitEpoch),y=yFor(exitSpot),won=wins>losses,color=won?'#b6ff66':'#ff6680';ctx.strokeStyle=color;ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x-5,y-5);ctx.lineTo(x+5,y+5);ctx.moveTo(x+5,y-5);ctx.lineTo(x-5,y+5);ctx.stroke();ctx.fillStyle=color;ctx.font='bold 8px monospace';ctx.fillText(`${wins}W/${losses}L EXIT`,x+8,y-5)}
  }
  ctx.fillStyle='#59f5ed';ctx.font='bold 11px monospace';ctx.fillText(`${pastFrame?'PAST · ':''}${direction} FOOTPRINT · ${trend.state||'OBSERVE'} · ${lane==='NONE'?'WAITING ENTRY':`LAST ${lane}`} · H${trend.health||0} M${trend.maturity||0}% · ${rows.length} TICKS`,left,20);
  drawMapInk(ctx,width,height);
}

function mapPoint(event) {
  const rect=$('smfnTrendCanvas').getBoundingClientRect();
  return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};
}

function bindMapTools() {
  const canvas=$('smfnTrendCanvas');
  if(!canvas)return;
  canvas.addEventListener('pointerdown',event=>{if(!mapDrawEnabled)return;event.preventDefault();canvas.setPointerCapture?.(event.pointerId);activeMapStroke={color:mapInkColor,points:[mapPoint(event)]};mapInk.push(activeMapStroke);drawChart()});
  canvas.addEventListener('pointermove',event=>{if(!mapDrawEnabled||!activeMapStroke)return;event.preventDefault();activeMapStroke.points.push(mapPoint(event));drawChart()});
  const endStroke=()=>{activeMapStroke=null};canvas.addEventListener('pointerup',endStroke);canvas.addEventListener('pointercancel',endStroke);
  $('smfnZoomIn')?.addEventListener('click',()=>{mapZoomIndex=Math.max(0,mapZoomIndex-1);mapInk=[];drawChart()});
  $('smfnZoomOut')?.addEventListener('click',()=>{mapZoomIndex=Math.min(mapZoomLevels.length-1,mapZoomIndex+1);mapInk=[];drawChart()});
  $('smfnMapOlder')?.addEventListener('click',()=>moveMapHistory(1));
  $('smfnMapNewer')?.addEventListener('click',()=>moveMapHistory(-1));
  $('smfnMapLive')?.addEventListener('click',setMapLive);
  $('smfnMapFreeze')?.addEventListener('click',()=>{if(mapFrozen)setMapLive();else freezeMap()});
  $('smfnMapDraw')?.addEventListener('click',()=>{if(!mapFrozen)freezeMap();mapDrawEnabled=!mapDrawEnabled;updateMapTag()});
  $('smfnMapClearInk')?.addEventListener('click',()=>{mapInk=[];drawChart()});
  document.querySelectorAll('[data-map-color]').forEach(button=>button.addEventListener('click',()=>{mapInkColor=button.dataset.mapColor;document.querySelectorAll('[data-map-color]').forEach(item=>item.classList.toggle('active',item===button))}));
  $('smfnSaveMap')?.addEventListener('click',()=>canvas.toBlob(blob=>{if(blob)downloadMapBlob(blob,`smfn-map-${mapLabel()}-${safeMapTime()}.png`)},'image/png'));
  $('smfnSaveCase')?.addEventListener('click',()=>{const frame=displayedMap();const payload={version:'smfn-map-case-v2',createdAt:new Date().toISOString(),label:mapLabel(),symbol:$('obsSymbol')?.value||'1HZ25V',visibleTicks:frame.ticks.length,historyOffset:frame.offset,windowStartEpoch:frame.start,windowEndEpoch:frame.end,frozen:mapFrozen,trend:frame.offset>0?(frame.anchorSignal?.milking||frame.source.trend):(frame.source.trend||latest.trend),smfn:frame.source.smfn||latest.smfn,routeSegments:routeSegments(frame.auditSignals,frame.start,frame.end),ticks:frame.ticks,signals:frame.signals.map(signal=>({signalId:signal.signalId,signalEpoch:signal.signalEpoch,signalQuote:signal.signalQuote,tradeDirection:signal.tradeDirection,approved:signal.approved,smfnSniperReady:signal.smfnSniperReady,executionState:signal.executionState,milking:signal.milking,smfn:signal.smfn,actualTrades:(signal.actualTrades||[]).map(trade=>({...trade,audit:tradeAuditPoint(signal,trade,frame.ticks)}))})),annotations:mapInk};downloadMapBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`smfn-map-${mapLabel()}-${safeMapTime()}.json`)});
  updateMapTag();
}

function mapLabel(){return $('smfnMapLabel')?.value||'unlabelled'}
function safeMapTime(){return new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}
function downloadMapBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}

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
bindMapTools();
renderMode();
renderForecast();
renderBrain();
