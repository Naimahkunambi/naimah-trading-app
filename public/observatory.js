const $ = id => document.getElementById(id);
const HORIZONS = [3, 5, 8, 10];
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const MAX_RECONNECT_ATTEMPTS = 8;
let ws;
let ticks = [];
let matches = [];
let analysisQueued = false;
let subscriptionId;
let lastSnapshot;
let manualDisconnect = true;
let reconnectAttempts = 0;
let reconnectTimer;

const stateKey = symbol => `sani.observatory.ticks.${symbol}`;

function setStatus(text, ok = false) {
  $('obsStatus').textContent = text;
  $('obsDot').classList.toggle('ok', ok);
}
function showError(message) {
  $('obsError').textContent = message;
  $('obsError').classList.remove('hidden');
}
function clearError() {
  $('obsError').textContent = '';
  $('obsError').classList.add('hidden');
}
function currentSymbol() { return $('obsSymbol').value.trim() || '1HZ25V'; }
function archiveLimit() { return Number($('archiveLimit').value || 5000); }
function patternLength() { return Number($('patternLength').value || 20); }
function similarityFloor() { return Number($('similarityFloor').value || 0.82); }
function maxMatches() { return Number($('maxMatches').value || 80); }
function executionOffsetEstimate() {
  try {
    const rows = JSON.parse(localStorage.getItem(OFFSET_KEY) || '[]')
      .map(Number)
      .filter(Number.isFinite)
      .map(v => Math.max(1, Math.min(10, Math.round(v))))
      .slice(-30)
      .sort((a, b) => a - b);
    if (!rows.length) return 1;
    const mid = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2);
  } catch {
    return 1;
  }
}
function persistTicks() {
  try { localStorage.setItem(stateKey(currentSymbol()), JSON.stringify(ticks.slice(-archiveLimit()))); } catch {}
}
function loadTicks() {
  try {
    const rows = JSON.parse(localStorage.getItem(stateKey(currentSymbol())) || '[]');
    ticks = Array.isArray(rows) ? rows.filter(t => Number.isFinite(Number(t.quote)) && Number.isFinite(Number(t.epoch))) : [];
  } catch { ticks = []; }
  ticks = dedupeTicks(ticks).slice(-archiveLimit());
}
function dedupeTicks(rows) {
  const map = new Map();
  for (const t of rows) map.set(`${Number(t.epoch)}:${Number(t.quote)}`, { epoch: Number(t.epoch), quote: Number(t.quote) });
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
function addTick(epoch, quote, persist = true) {
  epoch = Number(epoch); quote = Number(quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const last = ticks.at(-1);
  if (last && last.epoch === epoch && last.quote === quote) return;
  ticks.push({ epoch, quote });
  if (ticks.length > archiveLimit()) ticks.splice(0, ticks.length - archiveLimit());
  if (persist) persistTicks();
  queueAnalysis();
}

function normalizeShape(quotes) {
  if (!quotes.length) return [];
  const base = quotes[0];
  const path = quotes.map(q => Number(q) - base);
  const rms = Math.sqrt(path.reduce((s, v) => s + v * v, 0) / Math.max(1, path.length));
  if (!Number.isFinite(rms) || rms === 0) return path.map(() => 0);
  return path.map(v => v / rms);
}
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  if (!aa || !bb) return 0;
  return dot / Math.sqrt(aa * bb);
}
function directionBetween(startIndex, endIndex) {
  const start = ticks[startIndex]?.quote;
  const end = ticks[endIndex]?.quote;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  if (end > start) return 'UP';
  if (end < start) return 'DOWN';
  return 'FLAT';
}
function rawOutcome(endIndex, horizon) {
  return directionBetween(endIndex, endIndex + horizon);
}
function executionOutcome(endIndex, startOffset, duration) {
  return directionBetween(endIndex + startOffset, endIndex + startOffset + duration);
}
function statsFromOutcomes(outcomes, horizon, extra = {}) {
  const up = outcomes.filter(v => v === 'UP').length;
  const down = outcomes.filter(v => v === 'DOWN').length;
  const flat = outcomes.filter(v => v === 'FLAT').length;
  const decided = up + down;
  const upPct = decided ? up / decided * 100 : 0;
  const downPct = decided ? down / decided * 100 : 0;
  const bias = !decided ? 'NONE' : upPct > downPct ? 'UP' : downPct > upPct ? 'DOWN' : 'EVEN';
  return { horizon, up, down, flat, decided, upPct, downPct, bias, strength: decided ? Math.max(upPct, downPct) : 0, ...extra };
}
function horizonStats(h) {
  return statsFromOutcomes(matches.map(m => rawOutcome(m.end, h)), h, { startOffset: 0 });
}
function executionHorizonStats(h) {
  const startOffset = executionOffsetEstimate();
  return statsFromOutcomes(matches.map(m => executionOutcome(m.end, startOffset, h)), h, { startOffset });
}
function buildSnapshot() {
  const last = ticks.at(-1);
  const executionOffset = executionOffsetEstimate();
  return {
    at: Date.now(),
    symbol: currentSymbol(),
    epoch: Number(last?.epoch),
    quote: Number(last?.quote),
    archiveCount: ticks.length,
    patternLength: patternLength(),
    matchCount: matches.length,
    avgSimilarity: matches.length ? matches.reduce((s, m) => s + m.similarity, 0) / matches.length * 100 : 0,
    executionOffset,
    horizons: HORIZONS.map(horizonStats),
    executionHorizons: HORIZONS.map(executionHorizonStats)
  };
}
function publishSnapshot() {
  lastSnapshot = buildSnapshot();
  window.dispatchEvent(new CustomEvent('sani-observatory-analysis', { detail: lastSnapshot }));
}
window.SaniObservatory = {
  getSnapshot: () => lastSnapshot ? structuredClone(lastSnapshot) : buildSnapshot(),
  getTicks: () => ticks.map(tick => ({ epoch:Number(tick.epoch), quote:Number(tick.quote) }))
};

function analyze() {
  analysisQueued = false;
  const n = patternLength();
  const executionOffset = executionOffsetEstimate();
  $('patternSizeStat').textContent = String(n);
  $('archiveCount').textContent = String(ticks.length);
  $('executionOffsetStat').textContent = `T+${executionOffset}`;
  drawTickCanvas();
  if (ticks.length < n + 30) {
    matches = [];
    renderAnalysis();
    return;
  }

  const currentStart = ticks.length - n;
  const currentShape = normalizeShape(ticks.slice(currentStart).map(t => t.quote));
  const floor = similarityFloor();
  const maxLookahead = executionOffset + Math.max(...HORIZONS);
  const candidates = [];

  for (let start = 0; start + n - 1 + maxLookahead < currentStart; start += 1) {
    const end = start + n - 1;
    const shape = normalizeShape(ticks.slice(start, start + n).map(t => t.quote));
    const sim = cosine(currentShape, shape);
    if (sim >= floor) candidates.push({ start, end, similarity: sim, shape, epoch: ticks[end].epoch });
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  const chosen = [];
  for (const c of candidates) {
    if (chosen.some(x => Math.abs(x.end - c.end) < Math.max(3, Math.floor(n / 3)))) continue;
    chosen.push(c);
    if (chosen.length >= maxMatches()) break;
  }
  matches = chosen;
  renderAnalysis(currentShape);
}
function queueAnalysis() {
  if (analysisQueued) return;
  analysisQueued = true;
  requestAnimationFrame(analyze);
}

function renderGrid(targetId, statsFn, executionAware = false) {
  const target = $(targetId);
  if (!matches.length) {
    target.innerHTML = '<div class="empty">No historical relatives above the current similarity floor yet.</div>';
    return;
  }
  target.innerHTML = HORIZONS.map(h => {
    const s = statsFn(h);
    const bias = s.bias === 'NONE' ? 'NO DATA' : s.bias;
    const windowText = executionAware ? `T+${s.startOffset}→T+${s.startOffset + h}` : `T0→T+${h}`;
    return `<div class="horizonBox"><span>${windowText}</span><strong>${s.decided ? s.strength.toFixed(1) + '%' : '—'}</strong><b class="${bias === 'UP' ? 'positive' : bias === 'DOWN' ? 'negative' : ''}">${bias}</b><small>${s.up} up · ${s.down} down${s.flat ? ` · ${s.flat} flat` : ''}</small></div>`;
  }).join('');
}
function renderAnalysis(currentShape) {
  const executionOffset = executionOffsetEstimate();
  $('matchCount').textContent = String(matches.length);
  $('avgSimilarity').textContent = matches.length
    ? `${(matches.reduce((s, m) => s + m.similarity, 0) / matches.length * 100).toFixed(1)}%`
    : '—';
  $('executionOffsetStat').textContent = `T+${executionOffset}`;
  $('executionWindowCaption').textContent = `using measured entry offset T+${executionOffset}`;
  $('canvasCaption').textContent = ticks.length
    ? `${currentSymbol()} · ${ticks.at(-1).quote} · ${ticks.length.toLocaleString()} ticks archived`
    : 'waiting for ticks';

  drawPatternCanvas(currentShape || (ticks.length >= patternLength() ? normalizeShape(ticks.slice(-patternLength()).map(t => t.quote)) : []));
  renderGrid('horizonGrid', horizonStats, false);
  renderGrid('executionHorizonGrid', executionHorizonStats, true);
  renderMatches();
  publishSnapshot();
}
function renderMatches() {
  if (!matches.length) {
    $('patternRows').innerHTML = '<tr><td colspan="7" class="empty">No pattern matches above the similarity floor.</td></tr>';
    return;
  }
  $('patternRows').innerHTML = matches.slice(0, 25).map((m, i) => {
    const seen = new Date(m.epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cells = HORIZONS.map(h => {
      const outcome = rawOutcome(m.end, h);
      return `<td class="${outcome === 'UP' ? 'positive' : outcome === 'DOWN' ? 'negative' : ''}">${outcome}</td>`;
    }).join('');
    return `<tr><td>#${i + 1}</td><td>${(m.similarity * 100).toFixed(1)}%</td><td>${seen}</td>${cells}</tr>`;
  }).join('');
}

function canvasScale(ctx, canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, rect.width || canvas.width);
  const height = Math.max(180, rect.height || canvas.height);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width, height };
}
function drawGrid(ctx, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y <= height; y += height / 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
}
function drawTickCanvas() {
  const canvas = $('tickCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d'); const { width, height } = canvasScale(ctx, canvas); drawGrid(ctx, width, height);
  if (ticks.length < 2) return;
  const visible = ticks.slice(-220);
  const vals = visible.map(t => t.quote);
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const n = patternLength();
  const patternStart = Math.max(0, visible.length - n);
  ctx.strokeStyle = 'rgba(200,206,216,.45)'; ctx.lineWidth = 1.4; ctx.beginPath();
  visible.forEach((t, i) => {
    const x = 12 + i / (visible.length - 1) * (width - 24);
    const y = height - 14 - (t.quote - min) / span * (height - 28);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }); ctx.stroke();
  ctx.strokeStyle = '#f5f7fa'; ctx.lineWidth = 2.8; ctx.beginPath();
  visible.slice(patternStart).forEach((t, j) => {
    const i = patternStart + j;
    const x = 12 + i / (visible.length - 1) * (width - 24);
    const y = height - 14 - (t.quote - min) / span * (height - 28);
    if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }); ctx.stroke();
}
function drawPatternCanvas(currentShape) {
  const canvas = $('patternCanvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d'); const { width, height } = canvasScale(ctx, canvas); drawGrid(ctx, width, height);
  const family = matches.slice(0, 8).map(m => m.shape);
  const all = [...family, currentShape].filter(x => x?.length);
  if (!all.length) return;
  const vals = all.flat(); const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const draw = (shape, stroke, lineWidth, alpha) => {
    ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.beginPath();
    shape.forEach((v, i) => {
      const x = 12 + i / (shape.length - 1) * (width - 24);
      const y = height - 14 - (v - min) / span * (height - 28);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }); ctx.stroke(); ctx.restore();
  };
  family.forEach(shape => draw(shape, '#9299a8', 1.2, .22));
  if (currentShape?.length) draw(currentShape, '#f5f7fa', 3, 1);
}

function closeFeed() {
  if (!ws) return;
  try {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (subscriptionId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget: subscriptionId }));
  } catch {}
  try { ws.close(); } catch {}
  ws = undefined;
  subscriptionId = undefined;
}
function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (!manualDisconnect && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('Reconnect limit reached');
      showError('Observatory feed reconnect limit reached. Press Connect Observatory to retry.');
    }
    return;
  }
  reconnectAttempts += 1;
  const delay = Math.min(15000, 750 * (2 ** (reconnectAttempts - 1)));
  setStatus(`Reconnecting ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    openFeed();
  }, delay);
}
function openFeed() {
  closeFeed();
  const symbol = currentSymbol();
  setStatus(reconnectAttempts ? 'Reconnecting…' : 'Connecting…');
  try {
    ws = new WebSocket(PUBLIC_WS_URL);
    ws.onopen = () => {
      reconnectAttempts = 0;
      clearError();
      setStatus('Loading history…', true);
      ws.send(JSON.stringify({ ticks_history: symbol, count: archiveLimit(), end: 'latest', style: 'ticks', req_id: 1 }));
      ws.send(JSON.stringify({ ticks: symbol, subscribe: 1, req_id: 2 }));
    };
    ws.onmessage = event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.error) { showError(message.error.message || 'Deriv market-data error'); return; }
      if (message.msg_type === 'history' && message.history) {
        const prices = message.history.prices || []; const times = message.history.times || [];
        const history = prices.map((quote, i) => ({ quote: Number(quote), epoch: Number(times[i]) }));
        ticks = dedupeTicks([...ticks, ...history]).slice(-archiveLimit()); persistTicks(); queueAnalysis(); clearError(); setStatus('Live', true);
      }
      if (message.msg_type === 'tick' && message.tick) {
        subscriptionId = message.subscription?.id || subscriptionId;
        addTick(message.tick.epoch, message.tick.quote); clearError(); setStatus('Live', true);
      }
    };
    ws.onerror = () => showError('Market-data WebSocket error. Automatic reconnect will retry if the connection closes.');
    ws.onclose = () => {
      ws = undefined;
      subscriptionId = undefined;
      if (manualDisconnect) setStatus('Disconnected');
      else scheduleReconnect();
    };
  } catch (error) {
    showError(error.message);
    scheduleReconnect();
  }
}
function connect() {
  clearError();
  manualDisconnect = false;
  reconnectAttempts = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  loadTicks();
  queueAnalysis();
  openFeed();
}
function disconnect() {
  manualDisconnect = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectAttempts = 0;
  closeFeed();
  setStatus('Disconnected');
}

$('obsConnect').onclick = connect;
$('obsDisconnect').onclick = disconnect;
$('clearTickArchive').onclick = () => {
  disconnect(); ticks = []; matches = []; localStorage.removeItem(stateKey(currentSymbol())); queueAnalysis();
};
$('reanalyzeBtn').onclick = analyze;
$('patternLength').onchange = analyze;
$('similarityFloor').onchange = analyze;
$('maxMatches').onchange = analyze;
$('archiveLimit').onchange = () => { ticks = ticks.slice(-archiveLimit()); persistTicks(); analyze(); };
$('obsSymbol').onchange = () => { disconnect(); loadTicks(); analyze(); };
window.addEventListener('resize', queueAnalysis);
window.addEventListener('storage', event => { if (event.key === OFFSET_KEY) analyze(); });
window.addEventListener('sani-pattern-offset-updated', analyze);
window.addEventListener('DOMContentLoaded', () => { loadTicks(); analyze(); });
