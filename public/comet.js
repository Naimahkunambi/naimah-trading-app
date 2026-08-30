import { analyzeMountain, mountainAllows } from './core/libra-mountain.mjs';
import { DemoMultiplierExecutor } from './core/demo-multiplier-executor.mjs';

const $ = id => document.getElementById(id);
const money = v => `${Number(v || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(v || 0)).toFixed(2)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const KEY = 'sani.comet.paper.v3';
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_TICKS = 5000;
const HISTORY_COUNT = 1200;
const TUNE_KEY = 'sani.comet.tuning.v1';
const DEFAULT_TUNING = Object.freeze({
  stake: 1,
  stopLoss: 1,
  targetR: 2,
  trailStartR: 1,
  structureTrailR: 1.5,
  trailLockR: 0.10,
  stopSteps: 6,
  entryStrategy: 'BALANCED',
  exitStrategy: 'BALANCED'
});

let ws = null;
let subscriptionId = null;
let manualDisconnect = true;
let reconnectTimer = null;
let reconnectAttempt = 0;
let ticks = [];
let page = 0;
let auto = false;
let position = null;
let session = loadSession();
let tuning = loadTuning();
let latestMountain = analyzeMountain([]);
let lastCloseEpoch = 0;
let chartFrozen = false;
let chartViewCount = 260;
let chartOffset = 0;
let inkMode = false;
let inkColor = '#8df5df';
let inkCanvas = null;
let drawCanvas = null;
let demoExecutor = null;

function freshSession() {
  return { pnl: 0, trades: [], tape: [], peak: 0, trough: 0, maxDrawdown: 0, equity: 0, usedEntryKeys: [] };
}
function loadSession() {
  try { return { ...freshSession(), ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) }; }
  catch { return freshSession(); }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch {}
}
function freshTuning() { return { ...DEFAULT_TUNING }; }
function loadTuning() {
  try { return { ...freshTuning(), ...(JSON.parse(localStorage.getItem(TUNE_KEY) || 'null') || {}) }; }
  catch { return freshTuning(); }
}
function saveTuning() { try { localStorage.setItem(TUNE_KEY, JSON.stringify(tuning)); } catch {} }
function tuneNumber(id, fallback, min, max) {
  const value = Number($(id)?.value);
  return clamp(Number.isFinite(value) ? value : fallback, min, max);
}
function syncTuningUi() {
  const values = {
    cometStake: tuning.stake, riskDollars: tuning.stopLoss, targetR: tuning.targetR,
    cometTrailStart: tuning.trailStartR, cometStructureTrail: tuning.structureTrailR,
    cometTrailLock: tuning.trailLockR, cometStopSteps: tuning.stopSteps
  };
  for (const [id, value] of Object.entries(values)) if ($(id)) $(id).value = value;
  if ($('cometEntryStrategy')) $('cometEntryStrategy').value = tuning.entryStrategy;
  if ($('cometExitStrategy')) $('cometExitStrategy').value = tuning.exitStrategy;
}
function readTuningUi() {
  const stake = tuneNumber('cometStake', tuning.stake, 0.1, 10000);
  tuning = {
    ...tuning,
    stake,
    stopLoss: Math.min(stake, tuneNumber('riskDollars', tuning.stopLoss, 0.1, 10000)),
    targetR: tuneNumber('targetR', tuning.targetR, 0.25, 8),
    trailStartR: tuneNumber('cometTrailStart', tuning.trailStartR, 0.1, 8),
    structureTrailR: tuneNumber('cometStructureTrail', tuning.structureTrailR, 0.1, 8),
    trailLockR: tuneNumber('cometTrailLock', tuning.trailLockR, 0, 4),
    stopSteps: Math.round(tuneNumber('cometStopSteps', tuning.stopSteps, 2, 30)),
    entryStrategy: $('cometEntryStrategy')?.value || tuning.entryStrategy,
    exitStrategy: $('cometExitStrategy')?.value || tuning.exitStrategy
  };
  tuning.structureTrailR = Math.max(tuning.trailStartR, tuning.structureTrailR);
  tuning.trailLockR = Math.min(tuning.trailLockR, tuning.trailStartR);
  saveTuning();
  syncTuningUi();
  renderAll();
}
function cometEntryAllowed(m) {
  if (tuning.entryStrategy === 'PULLBACK_ONLY') return m?.entryMode === 'PULLBACK_END';
  if (tuning.entryStrategy === 'MOMENTUM_ONLY') return m?.entryMode === 'EARLY_MOMENTUM';
  return ['PULLBACK_END', 'EARLY_MOMENTUM'].includes(m?.entryMode);
}
function cometReversalVotesNeeded() {
  if (tuning.exitStrategy === 'FAST') return 1;
  if (tuning.exitStrategy === 'PATIENT') return 3;
  if (tuning.exitStrategy === 'TARGET_STOP_ONLY') return 999;
  return 2;
}
function setCometTuneStatus(text) {
  const el = $('cometTuneStatus');
  if (el) el.textContent = text;
}
function applyCometTuneCommand(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) return setCometTuneStatus('Type a change, for example: decrease TP.');
  const changes = [];
  const number = rx => {
    const match = text.match(rx);
    return match ? Number(match[1]) : null;
  };
  let v;
  let setTp = false;
  if ((v = number(/\bstake\b[^0-9]*(\d+(?:\.\d+)?)/)) != null) {
    tuning.stake = clamp(v, 0.1, 10000);
    tuning.stopLoss = Math.min(tuning.stopLoss, tuning.stake);
    changes.push(`stake $${tuning.stake.toFixed(2)}`);
  }
  if ((v = number(/(?:stop loss|\bsl\b)[^0-9]*(\d+(?:\.\d+)?)/)) != null) {
    tuning.stopLoss = Math.min(tuning.stake, clamp(v, 0.1, 10000));
    changes.push(`SL $${tuning.stopLoss.toFixed(2)}`);
  }
  if ((v = number(/(?:take profit|\btp\b|target r?)[^0-9]*(\d+(?:\.\d+)?)/)) != null) {
    tuning.targetR = clamp(v, 0.25, 8); setTp = true;
    changes.push(`TP ${tuning.targetR.toFixed(2)}R`);
  }
  if (!setTp && /(?:decrease|lower|reduce|smaller).*(?:tp|take profit|target)|(?:tp|take profit|target).*(?:decrease|lower|reduce|smaller)/.test(text)) {
    tuning.targetR = clamp(tuning.targetR - 0.25, 0.25, 8);
    changes.push(`TP ↓ ${tuning.targetR.toFixed(2)}R`);
  }
  if (!setTp && /(?:increase|raise|higher|bigger).*(?:tp|take profit|target)|(?:tp|take profit|target).*(?:increase|raise|higher|bigger)/.test(text)) {
    tuning.targetR = clamp(tuning.targetR + 0.25, 0.25, 8);
    changes.push(`TP ↑ ${tuning.targetR.toFixed(2)}R`);
  }
  if (/trail(?:ing)?(?: stop)?.*(?:sooner|earlier|faster)|(?:sooner|earlier|faster).*trail/.test(text)) {
    tuning.trailStartR = clamp(tuning.trailStartR - 0.15, 0.1, 8);
    tuning.structureTrailR = clamp(Math.max(tuning.trailStartR, tuning.structureTrailR - 0.15), 0.1, 8);
    changes.push(`trail sooner @ ${tuning.trailStartR.toFixed(2)}R`);
  }
  if (/trail(?:ing)?(?: stop)?.*(?:later|slower)|(?:later|slower).*trail/.test(text)) {
    tuning.trailStartR = clamp(tuning.trailStartR + 0.15, 0.1, 8);
    tuning.structureTrailR = clamp(tuning.structureTrailR + 0.15, tuning.trailStartR, 8);
    changes.push(`trail later @ ${tuning.trailStartR.toFixed(2)}R`);
  }
  if (/(?:tighter|closer).*(?:sl|stop)|(?:sl|stop).*(?:tighter|closer)/.test(text)) {
    tuning.stopSteps = Math.max(2, tuning.stopSteps - 1);
    changes.push(`stop width ${tuning.stopSteps} steps`);
  }
  if (/(?:wider|looser).*(?:sl|stop)|(?:sl|stop).*(?:wider|looser)/.test(text)) {
    tuning.stopSteps = Math.min(30, tuning.stopSteps + 1);
    changes.push(`stop width ${tuning.stopSteps} steps`);
  }
  if (/entry.*(?:strict|pullback)|(?:strict|pullback).*entry/.test(text)) {
    tuning.entryStrategy = 'PULLBACK_ONLY'; changes.push('entry = pullback only');
  }
  if (/entry.*(?:momentum|early)|(?:momentum|early).*entry/.test(text)) {
    tuning.entryStrategy = 'MOMENTUM_ONLY'; changes.push('entry = early momentum only');
  }
  if (/entry.*(?:balanced|normal)|(?:balanced|normal).*entry/.test(text)) {
    tuning.entryStrategy = 'BALANCED'; changes.push('entry = balanced');
  }
  if (/(?:exit|cash).*(?:sooner|earlier|fast)|(?:sooner|earlier|fast).*(?:exit|cash)/.test(text)) {
    tuning.exitStrategy = 'FAST'; changes.push('exit = fast');
  }
  if (/(?:hold|exit).*(?:longer|patient)|(?:longer|patient).*(?:hold|exit)/.test(text)) {
    tuning.exitStrategy = 'PATIENT'; changes.push('exit = patient');
  }
  if (/target.*stop.*only|stop.*target.*only/.test(text)) {
    tuning.exitStrategy = 'TARGET_STOP_ONLY'; changes.push('exit = target/stop only');
  }
  if (/(?:reset|default).*(?:setting|tune|default)|^defaults?$/.test(text)) {
    tuning = freshTuning(); changes.splice(0, changes.length, 'settings reset to COMET defaults');
  }
  saveTuning(); syncTuningUi();
  const summary = changes.length ? changes.join(' · ') : 'No setting changed. Try: “decrease TP”, “trailing stop sooner”, “stake 2”, “SL 0.70”, “entry stricter”, or “hold longer”.';
  setCometTuneStatus(summary);
  if (changes.length) addTape('TUNE', summary);
  renderAll();
}
function resetCometBot() {
  auto = false;
  if (position) closePaperPosition('RESET CLOSE');
  else if (demoExecutor?.snapshot().contract) void demoExecutor.sell('RESET COMET');
  session = freshSession();
  position = null;
  lastCloseEpoch = 0;
  tuning = freshTuning();
  saveTuning();
  save();
  syncTuningUi();
  setCometTuneStatus('COMET reset: local results + tuning back to defaults. Deriv account history is untouched.');
  renderAll();
}
function addTape(type, text, extra = {}) {
  session.tape.unshift({ at: Date.now(), type, text, ...extra });
  session.tape = session.tape.slice(0, 500);
  save();
  renderTape();
}
function setFeedStatus(text, ok = false) {
  const el = $('cometFeedStatus'); if (!el) return;
  el.textContent = text; el.dataset.ok = ok ? '1' : '0';
}
function setAccountStatus(text, ok = false) {
  const el = $('cometAccountStatus'); if (!el) return;
  el.textContent = text; el.dataset.ok = ok ? '1' : '0';
}
function symbol() { return $('cometSymbol')?.value?.trim() || '1HZ25V'; }
function dedupe(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const epoch = Number(row?.epoch), quote = Number(row?.quote);
    if (Number.isFinite(epoch) && Number.isFinite(quote)) map.set(`${epoch}:${quote}`, { epoch, quote });
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
function tickStep(rows = ticks) {
  const d = [];
  for (let i = Math.max(1, rows.length - 80); i < rows.length; i++) d.push(Math.abs(rows[i].quote - rows[i - 1].quote));
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] || 1 : 1;
}
function allowedSide(m) {
  return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE';
}
function slimMountain(m) {
  return {
    direction: m?.direction || 'NONE', entryMode: m?.entryMode || 'NO_TRADE', confirmation: Number(m?.confirmation || 0),
    important: m?.important ? { ...m.important } : null, start: m?.start ? { ...m.start } : null,
    extreme: m?.extreme ? { ...m.extreme } : null, entryAnchor: m?.entryAnchor ? { ...m.entryAnchor } : null,
    efficiency34: Number(m?.efficiency34 || 0), reason: m?.reason || ''
  };
}
function entryKey(m, side) {
  const anchor = Number(m?.entryAnchor?.epoch || 0);
  const important = Number(m?.important?.epoch || 0);
  const extreme = Number(m?.extreme?.epoch || 0);
  const structural = anchor || important || extreme;
  return structural ? `${side}|${m.direction}|${m.entryMode}|${structural}` : '';
}
function hasUsedEntry(key) { return key && (session.usedEntryKeys || []).includes(key); }
function markEntryUsed(key) {
  if (!key) return;
  session.usedEntryKeys = [...new Set([...(session.usedEntryKeys || []), key])].slice(-300);
  save();
}

// COMET is deliberately NOT Libra's one-tick timing game.
// A normal directional position can afford to wait for a proper pullback turn.
// We therefore use Libra's own mountainAllows() contract: PULLBACK_END or
// genuinely EARLY_MOMENTUM, never WAIT_PULLBACK_END, never EXHAUSTION.
function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (!permission.allowed || !cometEntryAllowed(m)) return null;

  const current = ticks.at(-1);
  const quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
  if (!Number.isFinite(quote) || !epoch || epoch <= lastCloseEpoch) return null;

  const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
  const key = entryKey(m, side);
  if (hasUsedEntry(key)) return null;

  const riskDollars = Math.max(.1, Number(tuning.stopLoss || 1));
  const targetR = clamp(tuning.targetR || 2, 0.25, 8);
  const step = tickStep();
  const buffer = Math.max(step * 1.25, 1e-9);
  const minDistance = Math.max(step * tuning.stopSteps, 1e-9);
  const important = Number(m.important?.quote);

  let stop;
  if (side === 'LONG') {
    const structural = Number.isFinite(important) && important < quote ? important - buffer : quote - minDistance;
    stop = Math.min(structural, quote - minDistance);
  } else {
    const structural = Number.isFinite(important) && important > quote ? important + buffer : quote + minDistance;
    stop = Math.max(structural, quote + minDistance);
  }

  const riskDistance = Math.abs(quote - stop);
  if (!(riskDistance > 0)) return null;
  const target = side === 'LONG' ? quote + riskDistance * targetR : quote - riskDistance * targetR;
  const units = riskDollars / riskDistance;

  return {
    side, entry: quote, stop, trailStop: stop, target, units, riskDollars, targetR,
    openedAt: Date.now(), openedEpoch: epoch, entryKey: key, bestR: 0, reversalVotes: 0,
    entryContext: slimMountain(m), plannedRiskDistance: riskDistance
  };
}
function openPosition(c) {
  position = c;
  markEntryUsed(c.entryKey);
  addTape('ENTRY', `${c.side} @ ${c.entry.toFixed(2)} · ${c.entryContext.entryMode} · stop ${c.stop.toFixed(2)} · target ${c.target.toFixed(2)}`, { side: c.side });
  void demoExecutor?.buy({
    side: c.side,
    stake: tuning.stake,
    stopLoss: c.riskDollars,
    takeProfit: c.riskDollars * c.targetR,
    targetR: c.targetR,
    multiplier: Number($('cometMultiplier')?.value || 160),
    symbol: symbol(),
    context: c.entryContext.entryMode
  });
  renderAll();
}
function unrealized(p = position, quote = ticks.at(-1)?.quote) {
  if (!p || !Number.isFinite(Number(quote))) return { pnl: 0, r: 0 };
  const delta = p.side === 'LONG' ? Number(quote) - p.entry : p.entry - Number(quote);
  const pnl = delta * p.units;
  return { pnl, r: p.riskDollars ? pnl / p.riskDollars : 0 };
}
function closePaperPosition(reason, quote = ticks.at(-1)?.quote) {
  if (!position || !Number.isFinite(Number(quote))) return;
  const p = position;
  const q = Number(quote);
  const u = unrealized(p, q);
  const trade = {
    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitContext: slimMountain(latestMountain)
  };
  delete trade.reversalVotes;
  session.trades.unshift(trade);
  session.trades = session.trades.slice(0, 1000);
  session.pnl = Number((session.pnl + trade.pnl).toFixed(4));
  session.equity = session.pnl;
  session.peak = Math.max(session.peak, session.equity);
  session.trough = Math.min(session.trough, session.equity);
  session.maxDrawdown = Math.max(session.maxDrawdown, session.peak - session.equity);
  lastCloseEpoch = Number(ticks.at(-1)?.epoch || lastCloseEpoch);
  addTape('EXIT', `${trade.side} ${reason} · ${money(trade.pnl)} · ${trade.r.toFixed(2)}R`, { side: trade.side });
  void demoExecutor?.sell(reason);
  position = null;
  save();
  renderAll();
}
function managePosition(m) {
  if (!position) return;
  const q = Number(ticks.at(-1)?.quote);
  if (!Number.isFinite(q)) return;
  const u = unrealized(position, q);
  position.bestR = Math.max(position.bestR || 0, u.r);

  // Paper stop/target models server-side orders at their planned levels instead
  // of letting a browser tick overshoot turn a $1 risk into -4R/-5R.
  if (position.side === 'LONG' && q <= position.trailStop) return closePaperPosition('STOP / INVALIDATION', position.trailStop);
  if (position.side === 'SHORT' && q >= position.trailStop) return closePaperPosition('STOP / INVALIDATION', position.trailStop);
  if (position.side === 'LONG' && q >= position.target) return closePaperPosition('TARGET', position.target);
  if (position.side === 'SHORT' && q <= position.target) return closePaperPosition('TARGET', position.target);

  // Do not dump a directional position because one live read becomes CHOP.
  // The whole point of COMET is to hold through ordinary noise. Require two
  // consecutive locked opposite mountains before a thesis-reversal exit.
  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  position.reversalVotes = opposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);

  // Editable profit protection: first lock, then structural trail.
  if (u.r >= tuning.trailStartR) {
    const risk = Math.abs(position.entry - position.stop);
    const protect = position.side === 'LONG' ? position.entry + risk * tuning.trailLockR : position.entry - risk * tuning.trailLockR;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  }
  if (u.r >= tuning.structureTrailR && Number.isFinite(Number(m.important?.quote))) {
    const s = Number(m.important.quote);
    if (position.side === 'LONG' && s > position.trailStop && s < q) position.trailStop = s;
    if (position.side === 'SHORT' && s < position.trailStop && s > q) position.trailStop = s;
  }
}
function ingestTick(epoch, quote, render = true) {
  epoch = Number(epoch); quote = Number(quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const last = ticks.at(-1);
  if (last && last.epoch === epoch && last.quote === quote) return;
  ticks.push({ epoch, quote });
  if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
  latestMountain = analyzeMountain(ticks);
  const hadPosition = Boolean(position);
  managePosition(latestMountain);
  // Never close and reopen on the same market update.
  if (!position && !hadPosition) {
    const c = candidate(latestMountain);
    if (c) openPosition(c);
  }
  if (render) renderAll();
}
function ingestHistory(history) {
  const prices = history?.prices || [], times = history?.times || [];
  const rows = prices.map((quote, i) => ({ epoch: Number(times[i]), quote: Number(quote) }));
  ticks = dedupe([...ticks, ...rows]).slice(-MAX_TICKS);
  latestMountain = analyzeMountain(ticks);
  renderAll();
}

function closeFeed() {
  clearTimeout(reconnectTimer); reconnectTimer = null;
  if (!ws) return;
  try { if (subscriptionId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ forget: subscriptionId })); } catch {}
  try { ws.close(); } catch {}
  ws = null; subscriptionId = null;
}
function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer || reconnectAttempt >= 6) return;
  reconnectAttempt += 1;
  const delay = Math.min(12000, 700 * (2 ** (reconnectAttempt - 1)));
  setFeedStatus(`RETRY ${reconnectAttempt}/6`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; openFeed(); }, delay);
}
function openFeed() {
  closeFeed(); setFeedStatus('CONNECTING');
  try {
    ws = new WebSocket(PUBLIC_WS_URL);
    ws.onopen = () => {
      reconnectAttempt = 0; setFeedStatus('LOADING', true);
      const s = symbol();
      ws.send(JSON.stringify({ ticks_history: s, count: HISTORY_COUNT, end: 'latest', style: 'ticks', req_id: 1 }));
      ws.send(JSON.stringify({ ticks: s, subscribe: 1, req_id: 2 }));
    };
    ws.onmessage = event => {
      let d; try { d = JSON.parse(String(event.data)); } catch { return; }
      if (d.error) { setFeedStatus('ERROR'); addTape('ERROR', `Market feed: ${d.error.message || d.error.code || 'error'}`); return; }
      if (d.msg_type === 'history' && d.history) { ingestHistory(d.history); setFeedStatus('LIVE', true); addTape('SYSTEM', `Loaded ${ticks.length.toLocaleString()} ticks.`); }
      if (d.msg_type === 'tick' && d.tick) { subscriptionId = d.subscription?.id || subscriptionId; ingestTick(d.tick.epoch, d.tick.quote); setFeedStatus('LIVE', true); }
    };
    ws.onerror = () => { setFeedStatus('ERROR'); addTape('ERROR', 'Public market WebSocket error.'); };
    ws.onclose = () => { ws = null; subscriptionId = null; if (manualDisconnect) setFeedStatus('OFFLINE'); else scheduleReconnect(); };
  } catch (error) { setFeedStatus('ERROR'); addTape('ERROR', error?.message || 'Could not open market feed.'); scheduleReconnect(); }
}
function connect() {
  manualDisconnect = false; reconnectAttempt = 0; clearTimeout(reconnectTimer); reconnectTimer = null;
  addTape('SYSTEM', `Connecting ${symbol()} through Deriv public market feed.`); openFeed();
}
function disconnect() { manualDisconnect = true; closeFeed(); setFeedStatus('OFFLINE'); }

async function loadAccounts() {
  const appId = $('cometAppId')?.value?.trim(), token = $('cometToken')?.value?.trim();
  if (!appId || !token) { setAccountStatus('APP ID + TOKEN'); return; }
  const btn = $('cometLoadAccounts'); btn.disabled = true; setAccountStatus('LOADING');
  try {
    const r = await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, token }), cache: 'no-store' });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `Account load failed (${r.status})`);
    const accounts = Array.isArray(d.accounts) ? d.accounts : [], demos = accounts.filter(a => ['demo', 'virtual'].includes(String(a.account_type || '').toLowerCase()));
    const sel = $('cometAccount'); sel.innerHTML = '';
    if (!demos.length) sel.innerHTML = '<option value="">No Demo accounts</option>';
    for (const a of demos) { const o = document.createElement('option'); o.value = a.account_id; o.textContent = `DEMO · ${a.account_id} · ${a.currency || ''} ${a.balance ?? ''}`; sel.appendChild(o); }
    setAccountStatus(demos.length ? `${demos.length} DEMO READY` : 'NO DEMO', demos.length > 0);
    sessionStorage.setItem('sani.comet.token', token); localStorage.setItem('sani.comet.appId', appId);
    addTape('SYSTEM', demos.length ? `Loaded ${demos.length} Demo account(s).` : 'No Demo account returned.');
  } catch (error) { if ($('cometAccount')?.value) setAccountStatus('DEMO READY', true); else setAccountStatus('ERROR'); addTape('ERROR', `Account load: ${error?.message || 'unknown error'}`); }
  finally { btn.disabled = false; }
}

function switchPage(n) {
  page = clamp(n, 0, 5);
  document.querySelectorAll('[data-comet-page]').forEach((el, i) => { const on = i === page; el.classList.toggle('active', on); el.setAttribute('aria-hidden', String(!on)); });
  document.querySelectorAll('[data-comet-target]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.cometTarget) === page));
  if (page === 1) drawChart(true);
}
function renderAll() {
  const q = Number(ticks.at(-1)?.quote);
  $('cometTickCount').textContent = ticks.length.toLocaleString();
  $('cometLastQuote').textContent = Number.isFinite(q) ? `${symbol()} · ${q.toFixed(2)}` : 'waiting for price';
  $('mapMountain').textContent = latestMountain.direction || 'WARMING';
  $('mapPermission').textContent = `${allowedSide(latestMountain)} ONLY`;
  $('mapMoment').textContent = latestMountain.entryMode || '—';
  $('mapReason').textContent = latestMountain.reason || 'waiting for shape';

  const u = unrealized();
  $('mapHand').textContent = position ? position.side : auto ? 'SCANNING' : 'STAND DOWN';
  $('mapThesis').textContent = position ? `${position.side} thesis alive · trail ${position.trailStop.toFixed(2)}` : auto ? 'Waiting for a confirmed Libra pullback/early momentum window.' : 'Paper auto is paused.';
  $('mapR').textContent = `${u.r.toFixed(2)}R`;
  $('mapRisk').textContent = position ? `risk ${money(position.riskDollars)} · target ${position.targetR.toFixed(2)}R` : 'risk not armed';

  $('positionHeadline').textContent = position ? `${position.side} the mountain.` : 'Waiting for a worthy move.';
  $('positionSub').textContent = position ? 'Hold the leg. Noise does not equal reversal.' : 'COMET can watch forever. It does not need to manufacture a trade.';
  $('positionSide').textContent = position ? position.side : 'STAND DOWN';
  $('positionEntry').textContent = position ? position.entry.toFixed(2) : '—';
  $('positionStop').textContent = position ? position.trailStop.toFixed(2) : '—';
  $('positionTarget').textContent = position ? position.target.toFixed(2) : '—';
  $('positionPnl').textContent = money(u.pnl);
  $('positionR').textContent = `${u.r.toFixed(2)}R`;

  $('cometPnl').textContent = money(session.pnl + u.pnl);
  $('cometState').textContent = demoExecutor?.snapshot().armed ? 'DERIV DEMO EXECUTION' : auto ? 'PAPER ACTIVE' : 'PAPER LAB';
  const startBtn = $('startAuto'), pauseBtn = $('pauseAuto');
  if (startBtn) { startBtn.textContent = auto ? 'AUTO ACTIVE ✓' : 'START AUTO'; startBtn.disabled = auto; startBtn.setAttribute('aria-pressed', String(auto)); }
  if (pauseBtn) pauseBtn.disabled = !auto;
  const goal = Math.max(1, Number($('goalDollars')?.value || 650));
  $('goalFill').style.width = `${clamp(session.pnl / goal * 100, 0, 100)}%`;
  $('goalCaption').textContent = `${money(session.pnl)} / $${goal.toFixed(0)}`;
  $('footerGoal').textContent = `$${goal.toFixed(0)}`;
  renderResults(); renderTape();
  renderDemoExecution();
  if (page === 1 && !chartFrozen) drawChart();
}

function renderDemoExecution(snapshot = demoExecutor?.snapshot()) {
  if (!snapshot || !$('cometDemoStatus')) return;
  $('cometDemoStatus').textContent = snapshot.status;
  $('cometDemoStatus').dataset.ok = snapshot.armed ? '1' : '0';
  $('cometDemoBalance').textContent = snapshot.balance == null ? '—' : `${snapshot.currency} ${Number(snapshot.balance).toFixed(2)}`;
  $('cometDemoContract').textContent = snapshot.contract ? `${snapshot.contract.side} · ${snapshot.contract.contractId}` : 'FLAT';
  $('cometDemoLivePnl').textContent = money(snapshot.contract?.liveProfit || 0);
  $('cometDemoRealized').textContent = money(snapshot.realized || 0);
  $('cometArmDemo').disabled = snapshot.armed || snapshot.buyPending || snapshot.sellPending;
  $('cometDisarmDemo').disabled = !snapshot.armed || Boolean(snapshot.contract) || snapshot.buyPending || snapshot.sellPending;
  $('cometCloseDemo').disabled = !snapshot.contract || snapshot.sellPending;
}

async function armDemoExecution() {
  if (position) { addTape('DEMO REFUSED', 'Wait until the paper shadow is flat before arming Demo execution.'); return; }
  try {
    await demoExecutor.arm({
      appId: $('cometAppId')?.value?.trim(),
      token: $('cometToken')?.value?.trim(),
      accountId: $('cometAccount')?.value
    });
  } catch (error) {
    addTape('DEMO REFUSED', error?.message || 'Could not arm Deriv Demo execution.');
  }
}

function disarmDemoExecution() {
  try { demoExecutor.disarm(); }
  catch (error) { addTape('DEMO REFUSED', error?.message || 'Could not disarm Demo execution.'); }
}

function closeDemoExecution() {
  void demoExecutor.sell('MANUAL DEMO CLOSE');
}
function renderResults() {
  const trades = session.trades || [], wins = trades.filter(t => t.pnl > 0).length;
  $('statPnl').textContent = money(session.pnl);
  $('statTrades').textContent = trades.length;
  $('statWinRate').textContent = `${trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0'}%`;
  $('statBest').textContent = money(trades.length ? Math.max(...trades.map(t => t.pnl)) : 0);
  $('statWorst').textContent = money(trades.length ? Math.min(...trades.map(t => t.pnl)) : 0);
  $('statDrawdown').textContent = money(-Math.abs(session.maxDrawdown || 0));
  const body = $('resultsBody');
  if (!trades.length) { body.innerHTML = '<tr><td colspan="7">No positions closed yet.</td></tr>'; return; }
  body.innerHTML = trades.slice(0, 100).map(t => `<tr><td>${new Date(t.closedAt).toLocaleTimeString()}</td><td>${t.side}</td><td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td><td>${t.reason}</td><td>${t.r.toFixed(2)}R</td><td>${money(t.pnl)}</td></tr>`).join('');
}
function renderTape() {
  const list = $('tapeList'), rows = session.tape || [];
  $('tapeCount').textContent = `${rows.length} EVENTS`;
  list.innerHTML = rows.length ? rows.slice(0, 200).map(r => `<div class="tapeEvent"><span>${new Date(r.at).toLocaleTimeString()}</span><b>${r.type}</b><span>${r.text}</span><em>${r.side || ''}</em></div>`).join('') : '<p>Nothing yet.</p>';
}

function visibleRows() {
  const end = Math.max(0, ticks.length - chartOffset);
  const start = Math.max(0, end - chartViewCount);
  return ticks.slice(start, end);
}
function drawChart(force = false) {
  const c = $('cometChart'); if (!c || (chartFrozen && !force)) return;
  drawCanvas = c;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(600, c.clientWidth), h = Math.max(380, c.clientHeight);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#080709'; ctx.fillRect(0, 0, w, h);

  const rows = visibleRows();
  if (rows.length < 2) { ctx.fillStyle = '#b98ca0'; ctx.font = '12px monospace'; ctx.fillText('CONNECT LIVE MARKET TO DRAW COMET', 28, 40); return; }
  const pad = { l: 42, r: 84, t: 30, b: 36 };
  const extra = position ? [position.trailStop, position.target, position.entry] : [];
  const qs = [...rows.map(r => r.quote), ...extra.filter(Number.isFinite)], lo = Math.min(...qs), hi = Math.max(...qs), range = hi - lo || 1;
  const x = i => pad.l + i / (rows.length - 1) * (w - pad.l - pad.r);
  const y = q => pad.t + (hi - q) / range * (h - pad.t - pad.b);

  ctx.strokeStyle = 'rgba(255,183,216,.10)'; ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) { const yy = pad.t + i / 5 * (h - pad.t - pad.b); ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke(); }

  ctx.strokeStyle = '#8df5df'; ctx.lineWidth = 1.8; ctx.beginPath();
  rows.forEach((r, i) => i ? ctx.lineTo(x(i), y(r.quote)) : ctx.moveTo(x(i), y(r.quote))); ctx.stroke();

  const m = analyzeMountain(rows), piv = m.pivots || [];
  if (piv.length > 1) {
    ctx.strokeStyle = '#ff8fc3'; ctx.lineWidth = 1.3; ctx.setLineDash([7, 6]); ctx.beginPath(); let started = false;
    for (const p of piv) { const idx = rows.findIndex(r => r.epoch === p.epoch && r.quote === p.quote); if (idx < 0) continue; if (!started) { ctx.moveTo(x(idx), y(p.quote)); started = true; } else ctx.lineTo(x(idx), y(p.quote)); }
    ctx.stroke(); ctx.setLineDash([]);
  }

  const line = (q, color, label) => {
    if (!Number.isFinite(Number(q))) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(pad.l, y(q)); ctx.lineTo(w - pad.r, y(q)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '10px monospace'; ctx.fillText(label, w - pad.r + 8, y(q) + 3);
  };
  if (position) { line(position.trailStop, '#ff6677', 'STOP'); line(position.target, '#67e7a0', 'TARGET'); line(position.entry, '#ffacd0', 'ENTRY'); }

  for (const t of (session.trades || []).slice(0, 80)) {
    const idx = rows.findIndex(r => r.epoch === t.openedEpoch); if (idx < 0) continue;
    ctx.fillStyle = t.side === 'LONG' ? '#79f0b4' : '#ff687a'; ctx.beginPath();
    if (t.side === 'LONG') { ctx.moveTo(x(idx), y(t.entry) - 8); ctx.lineTo(x(idx) - 6, y(t.entry) + 5); ctx.lineTo(x(idx) + 6, y(t.entry) + 5); }
    else { ctx.moveTo(x(idx), y(t.entry) + 8); ctx.lineTo(x(idx) - 6, y(t.entry) - 5); ctx.lineTo(x(idx) + 6, y(t.entry) - 5); }
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = '#ffb3d2'; ctx.font = '11px monospace';
  ctx.fillText(`LIBRA MOUNTAIN: ${m.direction} · ${m.entryMode} · ${allowedSide(m)} · ${chartFrozen ? 'FROZEN' : 'LIVE'}`, pad.l, 18);
}

function exportCsv() {
  const headers = ['row_type','closed_at','side','entry','initial_stop','target','exit','exit_reason','r','pnl','risk_dollars','target_r','opened_at','opened_epoch','entry_mountain','entry_moment','entry_confirmation','entry_important','exit_mountain','exit_moment'];
  const rows = [[ 'SUMMARY', new Date().toISOString(), '', '', '', '', '', '', '', session.pnl, '', '', '', '', '', '', '', '', '', '' ]];
  for (const t of [...(session.trades || [])].reverse()) {
    rows.push(['TRADE', new Date(t.closedAt).toISOString(), t.side, t.entry, t.stop, t.target, t.exit, t.reason, t.r, t.pnl, t.riskDollars, t.targetR, new Date(t.openedAt).toISOString(), t.openedEpoch, t.entryContext?.direction, t.entryContext?.entryMode, t.entryContext?.confirmation, t.entryContext?.important?.quote, t.exitContext?.direction, t.exitContext?.entryMode]);
  }
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  const csv = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `comet-paper-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 600);
}
function saveMapPng() {
  const base = $('cometChart'); if (!base) return;
  const out = document.createElement('canvas'); out.width = base.width; out.height = base.height;
  const ctx = out.getContext('2d'); ctx.drawImage(base, 0, 0);
  if (inkCanvas) ctx.drawImage(inkCanvas, 0, 0, out.width, out.height);
  out.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `comet-map-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500); });
}
function saveTrainingCase() {
  const payload = { savedAt: new Date().toISOString(), symbol: symbol(), frozen: chartFrozen, rows: visibleRows(), mountain: analyzeMountain(visibleRows()), openPosition: position, realizedPnl: session.pnl };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `comet-training-${Date.now()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 500);
}
function installResultsExport() {
  const card = document.querySelector('.tableCard .cometCardBar'); if (!card || $('cometExportCsv')) return;
  const btn = document.createElement('button'); btn.id = 'cometExportCsv'; btn.className = 'cometMiniButton'; btn.textContent = 'EXPORT CSV'; btn.addEventListener('click', exportCsv); card.appendChild(btn);
}
function installMapTools() {
  const c = $('cometChart'); if (!c || $('cometMapTools')) return;
  const css = document.createElement('style'); css.textContent = `
    .cometMapTools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px;border-bottom:1px solid rgba(255,143,195,.35);background:#0c080c}
    .cometMapTools button,.cometMiniButton{font:600 11px/1 monospace;letter-spacing:.08em;color:#f7bed8;background:#180c14;border:1px solid #8f4569;padding:10px 12px;cursor:pointer}
    .cometMapTools button.on{background:#f18ab8;color:#15070e}.cometMapTools .swatch{width:30px;height:30px;padding:0}.cometChartWrap{position:relative}.cometInk{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.cometInk.drawOn{pointer-events:auto;cursor:crosshair}
  `; document.head.appendChild(css);

  const toolbar = document.createElement('div'); toolbar.id = 'cometMapTools'; toolbar.className = 'cometMapTools';
  toolbar.innerHTML = `<button data-act="older">◀ OLDER</button><button data-act="newer">NEWER ▶</button><button data-act="live">LIVE NOW</button><button data-act="zin">ZOOM +</button><button data-act="zout">ZOOM −</button><button data-act="freeze">FREEZE</button><button data-act="draw">DRAW</button><button data-act="clear">CLEAR INK</button><button class="swatch" data-color="#8df5df" style="background:#8df5df"></button><button class="swatch" data-color="#d29af4" style="background:#d29af4"></button><button class="swatch" data-color="#f2ca67" style="background:#f2ca67"></button><button data-act="png">SAVE MAP PNG</button><button data-act="case">SAVE TRAINING CASE</button>`;
  c.parentElement.insertBefore(toolbar, c);

  const wrap = document.createElement('div'); wrap.className = 'cometChartWrap';
  c.parentNode.insertBefore(wrap, c); wrap.appendChild(c);
  inkCanvas = document.createElement('canvas'); inkCanvas.className = 'cometInk'; wrap.appendChild(inkCanvas);
  const resizeInk = () => { const dpr = window.devicePixelRatio || 1; inkCanvas.width = Math.round(c.clientWidth * dpr); inkCanvas.height = Math.round(c.clientHeight * dpr); };
  resizeInk();

  let drawing = false, last = null;
  const point = e => { const r = inkCanvas.getBoundingClientRect(); return { x: (e.clientX-r.left)*(inkCanvas.width/r.width), y: (e.clientY-r.top)*(inkCanvas.height/r.height) }; };
  inkCanvas.addEventListener('pointerdown', e => { if (!inkMode) return; drawing = true; last = point(e); inkCanvas.setPointerCapture(e.pointerId); });
  inkCanvas.addEventListener('pointermove', e => { if (!drawing || !inkMode) return; const p = point(e), ctx = inkCanvas.getContext('2d'); ctx.strokeStyle = inkColor; ctx.lineWidth = Math.max(3, inkCanvas.width / 700); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last = p; });
  const stop = () => { drawing = false; last = null; }; inkCanvas.addEventListener('pointerup', stop); inkCanvas.addEventListener('pointercancel', stop);

  toolbar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.color) { inkColor = b.dataset.color; return; }
    const act = b.dataset.act;
    if (act==='older') { chartFrozen = true; chartOffset = Math.min(Math.max(0,ticks.length-20), chartOffset + Math.max(20,Math.floor(chartViewCount*.55))); drawChart(true); }
    if (act==='newer') { chartOffset = Math.max(0, chartOffset - Math.max(20,Math.floor(chartViewCount*.55))); if (!chartOffset) chartFrozen=false; drawChart(true); }
    if (act==='live') { chartOffset=0; chartFrozen=false; drawChart(true); }
    if (act==='zin') { chartViewCount=Math.max(60,Math.floor(chartViewCount*.75)); drawChart(true); }
    if (act==='zout') { chartViewCount=Math.min(900,Math.floor(chartViewCount*1.35)); drawChart(true); }
    if (act==='freeze') { chartFrozen=!chartFrozen; b.classList.toggle('on',chartFrozen); b.textContent=chartFrozen?'FROZEN':'FREEZE'; if (!chartFrozen) { chartOffset=0; drawChart(true); } }
    if (act==='draw') { inkMode=!inkMode; b.classList.toggle('on',inkMode); inkCanvas.classList.toggle('drawOn',inkMode); }
    if (act==='clear') { inkCanvas.getContext('2d').clearRect(0,0,inkCanvas.width,inkCanvas.height); }
    if (act==='png') saveMapPng();
    if (act==='case') saveTrainingCase();
  });
  window.addEventListener('resize', () => { resizeInk(); if (page===1) drawChart(true); });
}

function bind() {
  document.querySelectorAll('[data-comet-target]').forEach(b => b.addEventListener('click', () => switchPage(Number(b.dataset.cometTarget))));
  document.querySelectorAll('[data-next]').forEach(b => b.addEventListener('click', () => switchPage(page + 1)));
  document.querySelectorAll('[data-prev]').forEach(b => b.addEventListener('click', () => switchPage(page - 1)));
  $('cometConnect').addEventListener('click', connect);
  $('cometDisconnect').addEventListener('click', disconnect);
  $('cometLoadAccounts').addEventListener('click', loadAccounts);
  $('cometArmDemo').addEventListener('click', armDemoExecution);
  $('cometDisarmDemo').addEventListener('click', disarmDemoExecution);
  $('cometCloseDemo').addEventListener('click', closeDemoExecution);
  $('startAuto').addEventListener('click', () => {
    if (!auto) {
      auto = true;
      if (manualDisconnect || !ws || ws.readyState !== WebSocket.OPEN) connect();
      addTape('SYSTEM', demoExecutor?.snapshot().armed ? 'AUTO ACTIVE · live feed + actual Deriv Demo multiplier execution.' : 'AUTO PAPER ACTIVE · live feed started automatically. Arm DEMO EXECUTION separately for actual Demo contracts.');
    }
    renderAll();
  });
  $('pauseAuto').addEventListener('click', () => { auto = false; addTape('SYSTEM', 'AUTO PAPER paused.'); renderAll(); });
  $('closePosition').addEventListener('click', () => closePaperPosition('MANUAL CLOSE'));
  $('resetComet').addEventListener('click', resetCometBot);
  $('cometApplyTune')?.addEventListener('click', () => applyCometTuneCommand($('cometTuneCommand')?.value));
  $('cometTuneCommand')?.addEventListener('keydown', event => { if (event.key === 'Enter') applyCometTuneCommand(event.currentTarget.value); });
  document.querySelectorAll('[data-comet-command]').forEach(button => button.addEventListener('click', () => applyCometTuneCommand(button.dataset.cometCommand)));
  ['cometStake','riskDollars','targetR','cometTrailStart','cometStructureTrail','cometTrailLock','cometStopSteps','cometEntryStrategy','cometExitStrategy'].forEach(id => $(id)?.addEventListener('input', readTuningUi));
  $('goalDollars').addEventListener('input', renderAll);
}
function boot() {
  const savedId = localStorage.getItem('sani.comet.appId'); if (savedId) $('cometAppId').value = savedId;
  const tok = sessionStorage.getItem('sani.comet.token'); if (tok) $('cometToken').value = tok;
  demoExecutor = new DemoMultiplierExecutor({
    engine: 'COMET',
    onStatus: renderDemoExecution,
    onEvent: event => addTape(event.type, event.text, { side: event.side })
  });
  syncTuningUi();
  bind(); installMapTools(); installResultsExport(); switchPage(0); renderAll(); setFeedStatus('OFFLINE');
  const sel = $('cometAccount'); if (sel?.value) setAccountStatus('DEMO READY', true);
}

window.COMET_RUNTIME = { getSession: () => structuredClone(session), getTuning: () => structuredClone(tuning), getTicks: () => structuredClone(ticks), getMountain: () => structuredClone(latestMountain), getDemoExecution: () => demoExecutor?.snapshot(), exportCsv, drawChart, saveMapPng };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
