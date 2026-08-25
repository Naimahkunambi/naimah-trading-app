const $ = id => document.getElementById(id);
const chapters = [...document.querySelectorAll('[data-chapter]')];
const chapterButtons = [...document.querySelectorAll('[data-chapter-target]')];
const money = value => `${Number(value || 0) >= 0 ? '+' : ''}$${Number(value || 0).toFixed(2)}`;
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
let currentChapter = Math.max(0, Math.min(chapters.length - 1, Number(location.hash.replace('#chapter-', '')) - 1 || 0));
let latest = { ticks:[], signals:[], engine:{}, analysis:null, trend:null };
let tradePage = 0;
let tickPage = 0;

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

function renderState() {
  const trend = latest.trend || {};
  const engine = latest.engine || {};
  const analysis = latest.analysis || {};
  const signals = freshSignals();
  const trades = settledTrades();
  const wins = trades.filter(row => row.trade.outcome === 'WON').length;
  const losses = trades.filter(row => row.trade.outcome === 'LOST').length;
  const pnl = trades.reduce((sum, row) => sum + Number(row.trade.profit || 0), 0);
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
  setText('mzRemaining', Number.isFinite(remaining.median) ? `~${remaining.median} TICKS` : '—');
  setText('mzBudgetMeta', Number.isFinite(remaining.low) ? `${remaining.low}–${remaining.high} historical range · age ${trend.ageSeconds || 0}s` : 'waiting for a locked drive');
  document.querySelectorAll('[data-state]').forEach(node => node.classList.toggle('active', node.dataset.state === (trend.state || 'OBSERVE')));

  setText('mzPnl', money(pnl));
  setText('mzWL', `${wins}W / ${losses}L`);
  setText('mzEngineState', engine.safeBlocked ? 'SAFE PAUSE' : engine.connected ? (engine.running ? 'MILKING' : 'READY') : 'DISCONNECTED');
  setText('mzOpen', Number(engine.openContracts || 0));
  setText('mzDecisionMs', Number.isFinite(Number(analysis.decisionMs)) ? `${Number(analysis.decisionMs).toFixed(2)} ms` : '— ms');
  setText('mzPattern', analysis.pattern?.familyId || 'SEARCHING');
  setText('mzLiveTag', `${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'}`);
  const last = signals[0];
  const action = trend.state === 'HARVEST' ? 'BANK / WAIT' : last?.approved ? `${last.tradeDirection} ×${last.requestedBatch || 1}` : trend.state || 'OBSERVE';
  setText('mzAction', action);
  setText('mzActionWhy', last?.milking?.policy?.reason || trend.reason || 'Connect live data first.');

  setText('mzResultPnl', money(pnl));
  setText('mzResultRate', `${trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0'}% win rate`);
  setText('mzContracts', trades.length);
  setText('mzWins', wins);
  setText('mzLosses', losses);
  setText('mzPeak', money(peak));
  setText('mzGiveback', `$${Math.max(0, peak - pnl).toFixed(2)}`);
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
  $('mzTickBody').innerHTML = pageRows.length ? pageRows.map(row => `<tr><td>${new Date(row.createdAt || Date.now()).toLocaleTimeString()}</td><td>${esc(row.milking?.state || 'OBSERVE')}</td><td>${esc(row.milking?.direction || 'NONE')}</td><td>${row.milking?.health ?? '—'}</td><td>${row.milking?.maturity ?? '—'}%</td><td>${esc(row.pattern?.familyId || '—')}</td><td class="${row.approved ? 'mzWin' : ''}">${row.approved ? `${esc(row.tradeDirection)} ×${row.requestedBatch || 1}` : esc(row.executionState || 'WATCH')}</td><td>${esc(row.shadow?.outcome || 'OPEN')}</td><td>${Number.isFinite(Number(row.decisionMs)) ? Number(row.decisionMs).toFixed(2) : '—'}</td></tr>`).join('') : '<tr><td colspan="9">COLLECTING TICKS</td></tr>';
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
  const ticks = (latest.ticks || []).slice(compact ? -140 : -240);
  ctx.fillStyle = '#090515'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(111,84,171,.28)'; ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y <= height; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  if (ticks.length < 2) { ctx.fillStyle='#8f81af'; ctx.font='12px monospace'; ctx.fillText('CONNECT LIVE TO DRAW THE MOUNTAIN', 18, 30); return; }
  const quotes = ticks.map(tick => Number(tick.quote));
  const low = Math.min(...quotes), high = Math.max(...quotes), span = high - low || 1;
  const startEpoch = ticks[0].epoch, endEpoch = ticks.at(-1).epoch;
  const xFor = epoch => 12 + (Number(epoch) - startEpoch) / Math.max(1, endEpoch - startEpoch) * (width - 24);
  const yFor = quote => height - 16 - (Number(quote) - low) / span * (height - 34);
  const trend = latest.trend || {};
  ctx.strokeStyle = trend.direction === 'UP' ? '#62f58f' : trend.direction === 'DOWN' ? '#ff4f67' : '#f8f1d4';
  ctx.lineWidth = compact ? 2 : 2.5;
  ctx.beginPath();
  ticks.forEach((tick, index) => { const x=xFor(tick.epoch), y=yFor(tick.quote); index ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();
  const signals = freshSignals().filter(signal => Number(signal.signalEpoch) >= startEpoch && Number(signal.signalEpoch) <= endEpoch);
  for (const signal of signals) {
    const x=xFor(signal.signalEpoch), y=yFor(signal.signalQuote);
    if (signal.approved) {
      ctx.fillStyle = signal.tradeDirection === 'CALL' ? '#62f58f' : '#ff4f67';
      ctx.fillRect(Math.round(x)-3, Math.round(y)-3, 7, 7);
      ctx.font='bold 10px monospace'; ctx.fillText(signal.tradeDirection === 'CALL' ? 'C' : 'P', x+6, y-6);
    }
    for (const trade of signal.actualTrades || []) {
      if (Number.isFinite(Number(trade.entryEpoch)) && Number.isFinite(Number(trade.entrySpot))) { ctx.fillStyle='#ffd257'; ctx.fillRect(xFor(trade.entryEpoch)-2,yFor(trade.entrySpot)-2,5,5); }
      if (Number.isFinite(Number(trade.exitEpoch)) && Number.isFinite(Number(trade.exitSpot))) { ctx.strokeStyle=trade.outcome==='WON'?'#62f58f':'#ff4f67';ctx.strokeRect(xFor(trade.exitEpoch)-3,yFor(trade.exitSpot)-3,7,7); }
    }
  }
  ctx.fillStyle='#ffd257';ctx.font='bold 11px monospace';ctx.fillText(`${trend.direction || 'NONE'} · ${trend.state || 'OBSERVE'} · H${trend.health || 0} · M${trend.maturity || 0}%`,16,20);
}

function drawCharts() { drawCanvas($('mzTrendCanvas'), true); drawCanvas($('mzChart'), false); }

$('mzTradePrev').addEventListener('click', () => { tradePage=Math.max(0,tradePage-1); renderState(); });
$('mzTradeNext').addEventListener('click', () => { tradePage+=1; renderState(); });
$('mzTickPrev').addEventListener('click', () => { tickPage=Math.max(0,tickPage-1); renderState(); });
$('mzTickNext').addEventListener('click', () => { tickPage+=1; renderState(); });
window.addEventListener('resize', drawCharts);
window.addEventListener('sani-v81-ui-render', event => { latest = event.detail || latest; renderState(); });
showChapter(currentChapter);
renderState();
