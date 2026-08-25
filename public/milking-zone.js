const $ = id => document.getElementById(id);
const chapters = [...document.querySelectorAll('[data-chapter]')];
const chapterButtons = [...document.querySelectorAll('[data-chapter-target]')];
const money = value => `${Number(value || 0) >= 0 ? '+' : ''}$${Number(value || 0).toFixed(2)}`;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
let currentChapter = Math.max(0, Math.min(chapters.length - 1, Number(location.hash.replace('#chapter-', '')) - 1 || 0));
let latest = { ticks:[], signals:[], engine:{}, analysis:null, trend:null };
let tradePage = 0;
let tickPage = 0;
let chartOffset = 0;
let chartWindow = 240;

function showChapter(index) {
  currentChapter = Math.max(0, Math.min(chapters.length - 1, index));
  chapters.forEach((chapter, position) => {
    const active = position === currentChapter;
    chapter.classList.toggle('active', active);
    chapter.setAttribute('aria-hidden', String(!active));
  });
  chapterButtons.forEach((button, position) => button.classList.toggle('active', position === currentChapter));
  $('mzChapterLabel').textContent = `CHAPTER ${currentChapter + 1} / ${chapters.length}`;
  $('mzProgress').style.width = `${(currentChapter + 1) / chapters.length * 100}%`;
  $('mzPrevChapter').disabled = currentChapter === 0;
  $('mzNextChapter').disabled = currentChapter === chapters.length - 1;
  history.replaceState(null, '', `#chapter-${currentChapter + 1}`);
  chapters[currentChapter].scrollTop = 0;
  requestAnimationFrame(drawCharts);
}

chapterButtons.forEach(button => button.addEventListener('click', () => showChapter(Number(button.dataset.chapterTarget))));
$('mzPrevChapter').addEventListener('click', () => showChapter(currentChapter - 1));
$('mzNextChapter').addEventListener('click', () => showChapter(currentChapter + 1));
window.addEventListener('keydown', event => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  if (event.key === 'ArrowRight') showChapter(currentChapter + 1);
  if (event.key === 'ArrowLeft') showChapter(currentChapter - 1);
});

function freshSignals() { return (latest.signals || []).filter(signal => !signal.legacy); }
function settledTrades() {
  return freshSignals().flatMap(signal => (signal.actualTrades || []).map(trade => ({ signal, trade })))
    .filter(row => ['WON', 'LOST'].includes(row.trade.outcome))
    .sort((left, right) => Number(right.trade.exitEpoch || right.signal.signalEpoch || 0) - Number(left.trade.exitEpoch || left.signal.signalEpoch || 0));
}

function setText(id, value) { if ($(id)) $(id).textContent = value; }
function setMeter(id, value) { if ($(id)) $(id).value = Number(value || 0); }

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function compactTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe} SEC`;
  const minutes = Math.max(1, Math.round(safe / 60));
  return `${minutes} MIN`;
}

function pulseEstimate(signals, ticks) {
  const entries = signals.filter(signal => signal.milkCandidate).map(signal => Number(signal.signalEpoch)).filter(Number.isFinite).sort((a, b) => a - b);
  if (entries.length < 3) return { label:'LEARNING ENTRY PACE', detail:`${entries.length}/3 recent entries` };
  const gaps = entries.slice(1).map((epoch, index) => epoch - entries[index]).filter(gap => gap > 0 && gap < 1800).slice(-10);
  const typical = median(gaps);
  if (!Number.isFinite(typical)) return { label:'LEARNING ENTRY PACE', detail:'waiting for clean intervals' };
  const marketNow = Number(ticks.at(-1)?.epoch || Date.now() / 1000);
  const elapsed = Math.max(0, marketNow - entries.at(-1));
  const remaining = Math.max(0, typical - elapsed);
  const low = Math.max(0, typical * .65 - elapsed);
  const high = Math.max(low, typical * 1.45 - elapsed);
  const label = elapsed > typical * 1.6
    ? 'ANY QUALIFYING TICK'
    : low < 15 ? `~${compactTime(high)}` : `~${compactTime(low)}–${compactTime(high)}`;
  return { label, detail:`recent median gap ${compactTime(typical)} · estimate only` };
}

function trendAlignment(signal, trend) {
  if (!signal?.milkCandidate) return `${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'} · SCANNING`;
  return signal.milking?.policy?.alignment || ((signal.tradeDirection === 'CALL' ? 'UP' : 'DOWN') === trend.direction ? 'ALIGNED' : 'COUNTER_TREND');
}

function harvestSummary(signals) {
  const ordered = [...signals].sort((left, right) => Number(left.signalEpoch || 0) - Number(right.signalEpoch || 0));
  const zones = [];
  const markers = [];
  const actionBySignal = new Map();
  let active = null;
  let brakes = 0;
  let resumes = 0;
  let flips = 0;
  for (const signal of ordered) {
    const epoch = Number(signal.signalEpoch);
    const harvest = signal.milking?.harvest || {};
    const direction = harvest.direction || signal.milking?.direction || 'NONE';
    const action = harvest.action || 'MILK';
    if (action === 'HARVEST_ENTER') {
      if (active) active.endEpoch = epoch;
      active = { startEpoch:epoch, endEpoch:null, direction, startQuote:Number(signal.signalQuote), reason:'ACTIVE' };
      zones.push(active);
      markers.push({ type:'H', epoch, quote:Number(signal.signalQuote), label:'STOP ADDING' });
      actionBySignal.set(signal.signalId, 'H STOP ADDING');
      brakes += 1;
    } else if (action === 'HARVEST_STOP') {
      actionBySignal.set(signal.signalId, signal.milkCandidate ? 'H ENTRY STOPPED' : 'H BUFFER ACTIVE');
    } else if (action === 'CONTINUE_RELEASE') {
      if (active) { active.endEpoch = epoch; active.reason = 'RESUME'; }
      markers.push({ type:'R', epoch, quote:Number(signal.signalQuote), label:'RESUME MILKING' });
      actionBySignal.set(signal.signalId, 'R RESUME MILKING');
      active = null;
      resumes += 1;
    } else if (action === 'FLIP_RELEASE') {
      if (active) { active.endEpoch = epoch; active.reason = 'FLIP'; }
      markers.push({ type:'↻', epoch, quote:Number(signal.signalQuote), label:'NEW SIDE' });
      actionBySignal.set(signal.signalId, '↻ NEW SIDE');
      active = null;
      flips += 1;
    } else actionBySignal.set(signal.signalId, signal.milkCandidate ? 'V8 MILK' : 'SCAN');
  }
  const stopped = ordered.filter(signal => signal.milkCandidate && signal.harvestBlocked);
  const settled = stopped.filter(signal => ['WON', 'LOST'].includes(signal.shadow?.outcome));
  const wins = settled.filter(signal => signal.shadow.outcome === 'WON').length;
  const losses = settled.filter(signal => signal.shadow.outcome === 'LOST').length;
  return {
    zones,
    markers,
    active,
    actionBySignal,
    stopped,
    settled,
    wins,
    losses,
    rate:settled.length ? wins / settled.length * 100 : NaN,
    brakes,
    resumes,
    flips
  };
}

function renderState() {
  const trend = latest.trend || {};
  const engine = latest.engine || {};
  const analysis = latest.analysis || {};
  const signals = freshSignals();
  const trades = settledTrades();
  const v8Entries = signals.filter(signal => signal.milkCandidate).length;
  const harvestStops = signals.filter(signal => signal.milkCandidate && signal.harvestBlocked).length;
  const wins = trades.filter(row => row.trade.outcome === 'WON').length;
  const losses = trades.filter(row => row.trade.outcome === 'LOST').length;
  const pnl = trades.reduce((sum, row) => sum + Number(row.trade.profit || 0), 0);
  const harvest = harvestSummary(signals);
  let equity = 0;
  let peak = 0;
  [...trades].reverse().forEach(row => { equity += Number(row.trade.profit || 0); peak = Math.max(peak, equity); });

  setText('mzHeaderState', trend.state || 'OBSERVE');
  setText('mzHeaderPnl', money(pnl));
  setText('mzArchiveCount', (latest.ticks || []).length.toLocaleString());
  setText('mzTraderConnection', engine.connected ? (engine.running ? 'MILKING' : 'READY') : 'OFFLINE');
  setText('mzDirection', trend.direction === 'UP' ? '▲ UP' : trend.direction === 'DOWN' ? '▼ DOWN' : '◆ WAIT');
  setText('mzDirectionReason', trend.reason || 'Collecting enough ticks to draw the first trend line.');
  setText('mzHealth', `${trend.health || 0}/100`);
  setText('mzMaturity', `${trend.maturity || 0}%`);
  setText('mzExhaustion', `${trend.exhaustion || 0}%`);
  setMeter('mzHealthMeter', trend.health);
  setMeter('mzMaturityMeter', trend.maturity);
  setMeter('mzExhaustionMeter', trend.exhaustion);
  const remaining = trend.remaining || {};
  setText('mzRemaining', Number.isFinite(remaining.median) ? `~${compactTime(remaining.median)}` : '—');
  setText('mzBudgetMeta', Number.isFinite(remaining.low) ? `${compactTime(remaining.low)}–${compactTime(remaining.high)} historical range · age ${compactTime(trend.ageSeconds || 0)}` : 'waiting for a locked drive');
  document.querySelectorAll('[data-state]').forEach(node => node.classList.toggle('active', node.dataset.state === (trend.state || 'OBSERVE')));

  setText('mzPnl', money(pnl));
  setText('mzWL', `${wins}W / ${losses}L`);
  setText('mzEngineState', engine.safeBlocked ? 'SAFE PAUSE' : engine.connected ? (engine.running ? 'MILKING' : 'READY') : 'DISCONNECTED');
  setText('mzOpen', Number(engine.openContracts || 0));
  setText('mzDecisionMs', Number.isFinite(Number(analysis.decisionMs)) ? `${Number(analysis.decisionMs).toFixed(2)} ms` : '— ms');
  setText('mzPattern', analysis.pattern?.familyId || 'SEARCHING');
  setText('mzSetups', v8Entries);
  setText('mzVetoes', harvestStops);
  setText('mzLiveTag', `${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'}`);
  const last = signals[0];
  const entryFound = Boolean(last?.milkCandidate);
  const harvestStopped = Boolean(last?.harvestBlocked);
  const orderSent = String(last?.executionState || '').startsWith('ORDER_SENT') || (last?.actualTrades || []).length > 0;
  const action = harvestStopped
    ? 'HARVEST · STOP ADDING'
    : entryFound
    ? orderSent ? `FIRE ${last.tradeDirection} ×${last.requestedBatch || 1}` : `${last.tradeDirection} ×${last.requestedBatch || 1} · ${last.executionState || 'QUALIFIED'}`
    : 'SCANNING';
  setText('mzAction', action);
  setText('mzActionWhy', entryFound ? last?.milking?.policy?.reason : last?.why || trend.reason || 'Connect live data first.');
  setText('mzAlignment', trendAlignment(last, trend));
  setText('mzHarvestStatus', harvest.active ? `H ACTIVE · ${harvest.active.direction}` : harvest.brakes ? `ARMED · ${harvest.brakes} USED` : 'ARMED · ACTIVE');
  setText('mzExact5Status', Number.isFinite(Number(trend.targetQuote?.median)) ? Number(trend.targetQuote.median).toFixed(2) : 'LEARNING');

  const pace = pulseEstimate(signals, latest.ticks || []);
  const narratorHeadline = !engine.connected
    ? 'CONNECT THE DEMO TRADER'
    : !engine.running
      ? 'READY · PRESS START MILKING'
      : harvestStopped
        ? 'HARVEST · PROTECT THE MILK'
      : entryFound
        ? action
        : 'SCANNING · NO V8 PATTERN THIS TICK';
  const narratorWhy = !engine.connected
    ? 'The market map can run, but no order can be sent until the Demo trader is connected.'
    : !engine.running
      ? 'The original frequent v8 entry engine is paused. The mountain map remains visible.'
      : harvestStopped
        ? `Original v8 qualified, but the active two-pulse Harvest buffer stopped this new ${last.tradeDirection} entry near the projected trend end.`
      : entryFound
        ? last?.milking?.policy?.reason
        : last?.why || analysis.reason || 'The next tick is being evaluated by the original frequent v8 pattern logic.';
  setText('mzNarratorHeadline', narratorHeadline);
  setText('mzNarratorWhy', narratorWhy);
  setText('mzNextPulse', engine.running ? pace.label : 'ENGINE NOT RUNNING');
  const driveWindow = trend.state === 'HARVEST'
    ? 'LATE STAGE NOW'
    : trend.state === 'TURNING'
      ? 'TURN IN PROGRESS'
      : Number.isFinite(remaining.median) ? `~${compactTime(remaining.median)}` : 'NO DRIVE YET';
  setText('mzDriveWindow', driveWindow);
  setText('mzDriveWindowMeta', `${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'} · ${pace.detail}`);

  setText('mzResultPnl', money(pnl));
  setText('mzResultRate', `${trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0'}% win rate`);
  setText('mzContracts', trades.length);
  setText('mzWins', wins);
  setText('mzLosses', losses);
  setText('mzPeak', money(peak));
  setText('mzGiveback', `$${Math.max(0, peak - pnl).toFixed(2)}`);
  setText('mzResultSetups', v8Entries);
  setText('mzResultVetoes', harvestStops);
  setText('mzShadowExitPnl', `${harvest.wins}W / ${harvest.losses}L`);
  setText('mzSavedGiveback', Number.isFinite(harvest.rate) ? `${harvest.rate.toFixed(1)}% WON` : 'LEARNING');
  setText('mzMissedContinuation', harvest.active ? `${harvest.active.direction} · STOPPED` : 'OPEN · MILKING');
  setText('mzHarvestCount', harvest.brakes);
  setText('mzExact5Extra', harvest.resumes);
  setText('mzExact5WL', harvest.flips);
  setText('mzExact5Rate', Number.isFinite(Number(trend.targetQuote?.median)) ? Number(trend.targetQuote.median).toFixed(2) : '—');
  renderTrades(trades);
  renderTickTape(signals);
  drawCharts();
}

function renderTrades(rows) {
  const size = 9;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  tradePage = Math.min(tradePage, pages - 1);
  const pageRows = rows.slice(tradePage * size, tradePage * size + size);
  setText('mzTradePage', `PAGE ${tradePage + 1} / ${pages}`);
  $('mzTradePrev').disabled = tradePage === 0;
  $('mzTradeNext').disabled = tradePage >= pages - 1;
  $('mzTradeBody').innerHTML = pageRows.length ? pageRows.map(({ signal, trade }) => `<tr><td>${new Date(Number(trade.exitEpoch || signal.signalEpoch) * 1000).toLocaleTimeString()}</td><td>${esc(signal.tradeDirection)}</td><td>${esc(signal.milking?.state || '—')}</td><td>${esc(signal.pattern?.familyId || '—')}</td><td class="${trade.outcome === 'WON' ? 'mzWin' : 'mzLoss'}">${esc(trade.outcome)}</td><td>${trade.entrySpot ?? '—'} → ${trade.exitSpot ?? '—'}</td><td>${Number.isFinite(Number(trade.buyAckMs)) ? `${Number(trade.buyAckMs).toFixed(0)}ms` : '—'}</td><td class="${Number(trade.profit || 0) >= 0 ? 'mzWin' : 'mzLoss'}">${money(trade.profit)}</td></tr>`).join('') : '<tr><td colspan="8">NO TRADES YET</td></tr>';
}

function renderTickTape(rows) {
  const size = 11;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  tickPage = Math.min(tickPage, pages - 1);
  const pageRows = rows.slice(tickPage * size, tickPage * size + size);
  setText('mzTickPage', `PAGE ${tickPage + 1} / ${pages}`);
  $('mzTickPrev').disabled = tickPage === 0;
  $('mzTickNext').disabled = tickPage >= pages - 1;
  const harvest = harvestSummary(rows);
  $('mzTickBody').innerHTML = pageRows.length ? pageRows.map(row => {
    const harvestAction = harvest.actionBySignal.get(row.signalId);
    const context = `${trendAlignment(row, row.milking || {})}${harvestAction ? ` · ${harvestAction}` : ''}`;
    return `<tr><td>${new Date(row.createdAt || Date.now()).toLocaleTimeString()}</td><td>${esc(row.milking?.state || 'OBSERVE')}</td><td>${esc(row.milking?.direction || 'NONE')}</td><td>${esc(context)}</td><td>${row.milking?.health ?? '—'}</td><td>${esc(row.pattern?.familyId || '—')}</td><td class="${row.approved ? 'mzWin' : ''}">${row.approved ? `${esc(row.tradeDirection)} ×${row.requestedBatch || 1}` : esc(row.executionState || 'WATCH')}</td><td>${esc(row.shadow?.outcome || 'OPEN')}</td><td>${Number.isFinite(Number(row.decisionMs)) ? Number(row.decisionMs).toFixed(2) : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="9">COLLECTING TICKS</td></tr>';
}

function canvasSize(canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, rect.width || 800);
  const height = Math.max(170, rect.height || 300);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const context = canvas.getContext('2d');
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width, height };
}

function drawCanvas(canvas, compact = false) {
  if (!canvas || !canvas.offsetParent) return;
  const { context:ctx, width, height } = canvasSize(canvas);
  const allTicks = latest.ticks || [];
  const windowSize = compact ? Math.min(140, chartWindow) : chartWindow;
  const maxOffset = Math.max(0, allTicks.length - Math.min(windowSize, allTicks.length));
  chartOffset = Math.min(chartOffset, maxOffset);
  const end = Math.max(0, allTicks.length - chartOffset);
  const start = Math.max(0, end - windowSize);
  const ticks = allTicks.slice(start, end);
  document.querySelectorAll('.mzChartWindow').forEach(label => {
    label.textContent = chartOffset ? `${chartOffset} TICKS BEHIND LIVE` : `LIVE · LATEST ${Math.min(windowSize, allTicks.length)} TICKS`;
  });
  document.querySelectorAll('[data-chart-nav="newer"], [data-chart-nav="live"]').forEach(button => { button.disabled = chartOffset === 0; });
  document.querySelectorAll('[data-chart-nav="older"]').forEach(button => { button.disabled = chartOffset >= maxOffset; });
  ctx.fillStyle = '#090515'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(111,84,171,.28)'; ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y <= height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  if (ticks.length < 2) { ctx.fillStyle='#8f81af'; ctx.font='12px monospace'; ctx.fillText('CONNECT LIVE TO DRAW THE MOUNTAIN', 18, 30); return; }
  const quotes = ticks.map(tick => Number(tick.quote));
  const rawLow = Math.min(...quotes), rawHigh = Math.max(...quotes), rawSpan = rawHigh - rawLow || 1;
  const trend = latest.trend || {};
  const target = trend.targetQuote || {};
  const visibleTargets = [target.low, target.median, target.high]
    .map(Number)
    .filter(Number.isFinite)
    .map(value => Math.max(rawLow - rawSpan * .45, Math.min(rawHigh + rawSpan * .45, value)));
  const domainLow = Math.min(rawLow, ...visibleTargets);
  const domainHigh = Math.max(rawHigh, ...visibleTargets);
  const pad = Math.max((domainHigh - domainLow) * .10, rawSpan * .06);
  const low = domainLow - pad, high = domainHigh + pad, span = high - low || 1;
  const startEpoch = ticks[0].epoch, endEpoch = ticks.at(-1).epoch;
  const xFor = epoch => 12 + (Number(epoch) - startEpoch) / Math.max(1, endEpoch - startEpoch) * (width - 24);
  const yFor = quote => height - 12 - (Number(quote) - low) / span * (height - 24);
  if (trend.direction && trend.direction !== 'NONE' && Number.isFinite(Number(target.median))) {
    const targetLow = Number.isFinite(Number(target.low)) ? Number(target.low) : Number(target.median);
    const targetHigh = Number.isFinite(Number(target.high)) ? Number(target.high) : Number(target.median);
    const bandTop = Math.min(yFor(targetLow), yFor(targetHigh));
    const bandBottom = Math.max(yFor(targetLow), yFor(targetHigh));
    const targetY = yFor(target.median);
    ctx.fillStyle = trend.state === 'HARVEST' ? 'rgba(255,79,103,.20)' : 'rgba(255,210,87,.13)';
    ctx.fillRect(width * .72, Math.max(2, bandTop), width * .28 - 12, Math.max(7, Math.min(height - 4, bandBottom) - Math.max(2, bandTop)));
    ctx.strokeStyle = trend.state === 'HARVEST' ? '#ff4f67' : '#ffd257';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(width * .72, targetY); ctx.lineTo(width - 12, targetY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = trend.state === 'HARVEST' ? '#ff4f67' : '#ffd257';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(`PROJECTED TURN ${Number(target.median).toFixed(2)}`, Math.max(16, width - 180), Math.max(14, targetY - 6));
  }
  ctx.strokeStyle = trend.direction === 'UP' ? '#62f58f' : trend.direction === 'DOWN' ? '#ff4f67' : '#f8f1d4';
  ctx.lineWidth = compact ? 2 : 2.5;
  ctx.beginPath();
  ticks.forEach((tick, index) => { const x=xFor(tick.epoch), y=yFor(tick.quote); index ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();
  const signals = freshSignals().filter(signal => Number(signal.signalEpoch) >= startEpoch && Number(signal.signalEpoch) <= endEpoch);
  const harvest = harvestSummary(freshSignals());
  for (const zone of harvest.zones) {
    const zoneStart = Math.max(startEpoch, zone.startEpoch);
    const zoneEnd = Math.min(endEpoch, zone.endEpoch == null ? endEpoch : zone.endEpoch);
    if (zoneEnd < startEpoch || zoneStart > endEpoch) continue;
    ctx.fillStyle = 'rgba(79,244,210,.055)';
    ctx.fillRect(xFor(zoneStart), 0, Math.max(2, xFor(zoneEnd) - xFor(zoneStart)), height);
  }
  for (const signal of signals) {
    const x=xFor(signal.signalEpoch), y=yFor(signal.signalQuote);
    if (signal.approved) {
      ctx.fillStyle = signal.tradeDirection === 'CALL' ? '#62f58f' : '#ff4f67';
      ctx.fillRect(Math.round(x)-3, Math.round(y)-3, 7, 7);
      ctx.font='bold 10px monospace'; ctx.fillText(signal.tradeDirection === 'CALL' ? 'C' : 'P', x+6, y-6);
    }
    for (const trade of signal.actualTrades || []) {
      const hasEntry = Number.isFinite(Number(trade.entryEpoch)) && Number.isFinite(Number(trade.entrySpot));
      const hasExit = Number.isFinite(Number(trade.exitEpoch)) && Number.isFinite(Number(trade.exitSpot));
      if (hasEntry && hasExit) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = trade.outcome === 'WON' ? '#62f58f' : '#ff4f67';
        ctx.beginPath();
        ctx.moveTo(xFor(trade.entryEpoch), yFor(trade.entrySpot));
        ctx.lineTo(xFor(trade.exitEpoch), yFor(trade.exitSpot));
        ctx.stroke();
        ctx.restore();
      }
      if (hasEntry) {
        const entryX=xFor(trade.entryEpoch), entryY=yFor(trade.entrySpot);
        ctx.fillStyle='#ffd257'; ctx.fillRect(entryX-3,entryY-3,7,7);
        ctx.font='bold 10px monospace'; ctx.fillText('E',entryX+6,entryY-7);
      }
      if (hasExit) {
        const exitX=xFor(trade.exitEpoch), exitY=yFor(trade.exitSpot);
        ctx.strokeStyle=trade.outcome==='WON'?'#62f58f':'#ff4f67';ctx.strokeRect(exitX-4,exitY-4,9,9);
        ctx.fillStyle=trade.outcome==='WON'?'#62f58f':'#ff4f67';ctx.font='bold 10px monospace';ctx.fillText('X',exitX+7,exitY-7);
      }
    }
  }
  for (const marker of harvest.markers) {
    if (marker.epoch < startEpoch || marker.epoch > endEpoch || !Number.isFinite(marker.quote)) continue;
    const markerX = xFor(marker.epoch), markerY = yFor(marker.quote);
    ctx.fillStyle = marker.type === 'H' ? '#ffd257' : '#4ff4d2';
    ctx.strokeStyle = '#090414';
    ctx.fillRect(markerX - 6, markerY - 6, 13, 13);
    ctx.strokeRect(markerX - 6, markerY - 6, 13, 13);
    ctx.fillStyle = '#160b32';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(marker.type, markerX - 3, markerY + 4);
  }
  ctx.fillStyle='#ffd257';ctx.font='bold 11px monospace';ctx.fillText(`${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'} · H${trend.health || 0} · M${trend.maturity || 0}%`,16,20);
}

function drawCharts() { drawCanvas($('mzTrendCanvas'), true); drawCanvas($('mzChart'), false); }

$('mzTradePrev').addEventListener('click', () => { tradePage=Math.max(0,tradePage-1); renderState(); });
$('mzTradeNext').addEventListener('click', () => { tradePage+=1; renderState(); });
$('mzTradeLatest').addEventListener('click', () => { tradePage=0; renderState(); });
$('mzTickPrev').addEventListener('click', () => { tickPage=Math.max(0,tickPage-1); renderState(); });
$('mzTickNext').addEventListener('click', () => { tickPage+=1; renderState(); });
$('mzTickLatest').addEventListener('click', () => { tickPage=0; renderState(); });
document.querySelectorAll('[data-chart-nav]').forEach(button => button.addEventListener('click', () => {
  const action = button.dataset.chartNav;
  const step = Math.max(60, Math.floor(chartWindow * .75));
  if (action === 'older') chartOffset += step;
  if (action === 'newer') chartOffset = Math.max(0, chartOffset - step);
  if (action === 'live') chartOffset = 0;
  drawCharts();
}));
document.querySelectorAll('[data-chart-window]').forEach(button => button.addEventListener('click', () => {
  chartWindow = Math.max(60, Number(button.dataset.chartWindow) || 240);
  chartOffset = 0;
  document.querySelectorAll('[data-chart-window]').forEach(node => node.classList.toggle('active', node === button));
  drawCharts();
}));
document.querySelectorAll('[data-chart-fit]').forEach(button => button.addEventListener('click', () => {
  const focused = document.body.classList.toggle('mzChartFocus');
  button.textContent = focused ? 'EXIT FIT' : 'FIT CHART';
  requestAnimationFrame(drawCharts);
}));
window.addEventListener('resize', drawCharts);
window.addEventListener('sani-v81-ui-render', event => { latest = event.detail || latest; renderState(); });
showChapter(currentChapter);
renderState();
