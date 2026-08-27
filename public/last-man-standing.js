import { analyzeMountain, mountainAllows } from './core/libra-mountain.mjs';

const $ = id => document.getElementById(id);
const money = v => `${Number(v || 0) >= 0 ? '+' : '-'}$${Math.abs(Number(v || 0)).toFixed(2)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const KEY = 'sani.last-man-standing.paper.v1';
const PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_TICKS = 5000;
const HISTORY_COUNT = 1200;
const MODES = {
  GRAB: { label: 'GRAB', minPower: 45, riskFraction: .40, targetR: .80, protectAt: .35, lockR: .05, trailAt: .60 },
  CRUISE: { label: 'CRUISE', minPower: 60, riskFraction: .70, targetR: 1.60, protectAt: .65, lockR: .08, trailAt: 1.05 },
  LAST_MAN: { label: 'LAST MAN', minPower: 75, riskFraction: 1.00, targetR: 3.00, protectAt: 1.00, lockR: .10, trailAt: 1.75 }
};

let ws = null;
let subscriptionId = null;
let manualDisconnect = true;
let reconnectTimer = null;
let reconnectAttempt = 0;
let ticks = [];
let page = 0;
let auto = false;
let requestedMode = 'AUTO';
let position = null;
let session = loadSession();
let latestMountain = analyzeMountain([]);
let latestPower = 0;
let latestRecommendedMode = 'STAND_DOWN';
let lastCloseEpoch = 0;
let chartFrozen = false;
let chartViewCount = 260;
let chartOffset = 0;
let inkMode = false;
let inkColor = '#87e7d4';
let inkCanvas = null;

function freshSession() {
  return { pnl: 0, trades: [], tape: [], peak: 0, trough: 0, maxDrawdown: 0, usedEntryKeys: [] };
}
function loadSession() {
  try { return { ...freshSession(), ...(JSON.parse(localStorage.getItem(KEY) || 'null') || {}) }; }
  catch { return freshSession(); }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(session)); } catch {} }
function addTape(type, text, extra = {}) {
  session.tape.unshift({ at: Date.now(), type, text, ...extra });
  session.tape = session.tape.slice(0, 700);
  save();
  renderTape();
}
function setFeedStatus(text, ok = false) { const el = $('lmsFeedStatus'); if (el) { el.textContent = text; el.dataset.ok = ok ? '1' : '0'; } }
function setAccountStatus(text, ok = false) { const el = $('lmsAccountStatus'); if (el) { el.textContent = text; el.dataset.ok = ok ? '1' : '0'; } }
function symbol() { return $('lmsSymbol')?.value?.trim() || '1HZ25V'; }
function mean(values = []) { return values.length ? values.reduce((s, v) => s + Number(v || 0), 0) / values.length : 0; }
function slope(values = []) {
  const n = values.length; if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(values); let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (values[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}
function pathEfficiency(values = []) {
  if (values.length < 2) return 0;
  let path = 0; for (let i = 1; i < values.length; i++) path += Math.abs(values[i] - values[i - 1]);
  return path ? Math.abs(values.at(-1) - values[0]) / path : 0;
}
function tickStep(rows = ticks) {
  const d = [];
  for (let i = Math.max(1, rows.length - 80); i < rows.length; i++) d.push(Math.abs(rows[i].quote - rows[i - 1].quote));
  d.sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] || 1 : 1;
}
function dedupe(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const epoch = Number(row?.epoch), quote = Number(row?.quote);
    if (Number.isFinite(epoch) && Number.isFinite(quote)) map.set(`${epoch}:${quote}`, { epoch, quote });
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
}
function allowedSide(m) { return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE'; }
function slimMountain(m) {
  return {
    direction: m?.direction || 'NONE', entryMode: m?.entryMode || 'NO_TRADE', confirmation: Number(m?.confirmation || 0),
    important: m?.important ? { ...m.important } : null, start: m?.start ? { ...m.start } : null,
    extreme: m?.extreme ? { ...m.extreme } : null, entryAnchor: m?.entryAnchor ? { ...m.entryAnchor } : null,
    efficiency34: Number(m?.efficiency34 || 0), reason: m?.reason || ''
  };
}

function trendPower(m = latestMountain, rows = ticks) {
  if (!m?.ready || !['UP', 'DOWN'].includes(m.direction) || rows.length < 34) return 0;
  const q = rows.map(r => Number(r.quote)).filter(Number.isFinite);
  const step = tickStep(rows) || 1;
  const sign = m.direction === 'UP' ? 1 : -1;
  const s5 = slope(q.slice(-5)) / step * sign;
  const s13 = slope(q.slice(-13)) / step * sign;
  const s34 = slope(q.slice(-34)) / step * sign;
  const eff13 = pathEfficiency(q.slice(-13));
  const eff34 = pathEfficiency(q.slice(-34));
  const confirmation = clamp(Number(m.confirmation || 0) / 6, 0, 1);
  const coherence = [s5 > 0, s13 > 0, s34 > 0].filter(Boolean).length / 3;
  const acceleration = clamp((s5 - s13 + 1) / 2, 0, 1);
  const slopeEnergy = clamp((Math.max(0, s5) * .45 + Math.max(0, s13) * .35 + Math.max(0, s34) * .20) / .55, 0, 1);
  let moment = 0;
  if (m.entryMode === 'EARLY_MOMENTUM') moment = 1;
  else if (m.entryMode === 'PULLBACK_END') moment = .88;
  else if (m.entryMode === 'WAIT_PULLBACK_END') moment = .58;
  else if (m.entryMode === 'LATE_OR_WAIT') moment = .28;
  else if (m.entryMode === 'EXHAUSTION') moment = .08;
  const raw = 100 * (coherence * .22 + slopeEnergy * .22 + eff13 * .13 + eff34 * .15 + confirmation * .11 + acceleration * .07 + moment * .10);
  return Math.round(clamp(raw, 0, 100));
}
function autoMode(power, m = latestMountain) {
  if (!m?.ready || !['UP', 'DOWN'].includes(m.direction)) return 'STAND_DOWN';
  if (m.entryMode === 'EXHAUSTION' || m.entryMode === 'LATE_OR_WAIT') return 'STAND_DOWN';
  if (power >= MODES.LAST_MAN.minPower) return 'LAST_MAN';
  if (power >= MODES.CRUISE.minPower) return 'CRUISE';
  if (power >= MODES.GRAB.minPower) return 'GRAB';
  return 'STAND_DOWN';
}
function selectedMode(power, m = latestMountain) {
  const recommended = autoMode(power, m);
  if (requestedMode === 'AUTO') return recommended;
  if (recommended === 'STAND_DOWN') return 'STAND_DOWN';
  const rule = MODES[requestedMode];
  return power >= rule.minPower ? requestedMode : 'STAND_DOWN';
}
function modeReason(mode, power, m = latestMountain) {
  if (mode === 'STAND_DOWN') {
    if (!m?.ready) return 'Mountain not locked.';
    if (m.entryMode === 'EXHAUSTION') return 'Direction exists, but the move is exhausted. No greed entry.';
    if (m.entryMode === 'LATE_OR_WAIT') return 'Correct side, wrong location. Do not chase the middle.';
    return `Trend power ${power}/100 has not earned risk.`;
  }
  if (mode === 'GRAB') return `Power ${power}/100: tradable, but not strong enough to marry. Smaller risk, shorter objective.`;
  if (mode === 'CRUISE') return `Power ${power}/100: healthy structure. Give it room, then protect.`;
  return `Power ${power}/100: strong coherent trend. Full capped risk and a wider runner target are justified.`;
}
function entryKey(m, side, mode) {
  const structural = Number(m?.entryAnchor?.epoch || m?.important?.epoch || m?.extreme?.epoch || 0);
  return structural ? `${side}|${m.direction}|${m.entryMode}|${mode}|${structural}` : '';
}
function hasUsedEntry(key) { return key && (session.usedEntryKeys || []).includes(key); }
function markEntryUsed(key) {
  if (!key) return;
  session.usedEntryKeys = [...new Set([...(session.usedEntryKeys || []), key])].slice(-400);
  save();
}
function modeConfig(mode) { return MODES[mode] || null; }

function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (!permission.allowed) return null;

  const current = ticks.at(-1), quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
  if (!Number.isFinite(quote) || !epoch || epoch <= lastCloseEpoch) return null;

  const power = trendPower(m, ticks);
  const mode = selectedMode(power, m);
  const cfg = modeConfig(mode);
  if (!cfg) return null;

  const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
  const key = entryKey(m, side, mode);
  if (hasUsedEntry(key)) return null;

  const riskCap = Math.max(.1, Number($('riskCap')?.value || 1));
  const riskDollars = Number((riskCap * cfg.riskFraction).toFixed(4));
  const step = tickStep();
  const buffer = Math.max(step * 1.25, 1e-9);
  const minDistance = Math.max(step * 6, 1e-9);
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
  const target = side === 'LONG' ? quote + riskDistance * cfg.targetR : quote - riskDistance * cfg.targetR;
  const units = riskDollars / riskDistance;
  return {
    side, mode, currentMode: mode, entryPower: power, currentPower: power, entry: quote, stop, trailStop: stop,
    target, targetR: cfg.targetR, originalTargetR: cfg.targetR, units, riskDollars, riskCap, openedAt: Date.now(), openedEpoch: epoch,
    entryKey: key, bestR: 0, lockedR: -1, reversalVotes: 0, targetExtended: false, entryContext: slimMountain(m), plannedRiskDistance: riskDistance
  };
}
function openPosition(c) {
  position = c;
  markEntryUsed(c.entryKey);
  addTape('ENTRY', `${c.mode} ${c.side} @ ${c.entry.toFixed(2)} · power ${c.entryPower}/100 · risk ${money(c.riskDollars)} · target ${c.targetR.toFixed(2)}R`, { side: c.side, mode: c.mode });
  renderAll();
}
function unrealized(p = position, quote = ticks.at(-1)?.quote) {
  if (!p || !Number.isFinite(Number(quote))) return { pnl: 0, r: 0 };
  const delta = p.side === 'LONG' ? Number(quote) - p.entry : p.entry - Number(quote);
  const pnl = delta * p.units;
  return { pnl, r: p.riskDollars ? pnl / p.riskDollars : 0 };
}
function lockedRFromStop(p = position) {
  if (!p) return 0;
  const d = p.side === 'LONG' ? p.trailStop - p.entry : p.entry - p.trailStop;
  return p.plannedRiskDistance ? d / p.plannedRiskDistance : 0;
}
function stopForLockedR(p, r) {
  return p.side === 'LONG' ? p.entry + p.plannedRiskDistance * r : p.entry - p.plannedRiskDistance * r;
}
function advanceStop(p, candidateStop, label = '') {
  const old = p.trailStop;
  if (p.side === 'LONG') p.trailStop = Math.max(p.trailStop, candidateStop);
  else p.trailStop = Math.min(p.trailStop, candidateStop);
  p.lockedR = Math.max(p.lockedR, lockedRFromStop(p));
  if (p.trailStop !== old && label) addTape('PROTECT', `${label} · stop ${old.toFixed(2)} → ${p.trailStop.toFixed(2)} · locked ${p.lockedR.toFixed(2)}R`, { side: p.side, mode: p.currentMode });
}
function extendTarget(p, newTargetR, label) {
  if (newTargetR <= p.targetR) return;
  p.targetR = newTargetR;
  p.target = p.side === 'LONG' ? p.entry + p.plannedRiskDistance * newTargetR : p.entry - p.plannedRiskDistance * newTargetR;
  addTape('EXTEND', `${label} · target extended to ${newTargetR.toFixed(2)}R`, { side: p.side, mode: p.currentMode });
}
function closePaperPosition(reason, quote = ticks.at(-1)?.quote) {
  if (!position || !Number.isFinite(Number(quote))) return;
  const p = position, q = Number(quote), u = unrealized(p, q);
  const trade = {
    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitPower: latestPower, exitRecommendedMode: latestRecommendedMode, exitContext: slimMountain(latestMountain)
  };
  delete trade.reversalVotes;
  session.trades.unshift(trade); session.trades = session.trades.slice(0, 1200);
  session.pnl = Number((session.pnl + trade.pnl).toFixed(4));
  session.peak = Math.max(session.peak, session.pnl);
  session.trough = Math.min(session.trough, session.pnl);
  session.maxDrawdown = Math.max(session.maxDrawdown, session.peak - session.pnl);
  lastCloseEpoch = Number(ticks.at(-1)?.epoch || lastCloseEpoch);
  addTape('EXIT', `${trade.currentMode} ${trade.side} ${reason} · ${money(trade.pnl)} · ${trade.r.toFixed(2)}R`, { side: trade.side, mode: trade.currentMode });
  position = null; save(); renderAll();
}

function managePosition(m) {
  if (!position) return;
  const q = Number(ticks.at(-1)?.quote); if (!Number.isFinite(q)) return;
  const p = position, u = unrealized(p, q);
  p.bestR = Math.max(p.bestR || 0, u.r);
  p.currentPower = trendPower(m, ticks);
  const recommended = autoMode(p.currentPower, m);

  if (p.side === 'LONG' && q <= p.trailStop) return closePaperPosition('PROTECTED STOP', p.trailStop);
  if (p.side === 'SHORT' && q >= p.trailStop) return closePaperPosition('PROTECTED STOP', p.trailStop);
  if (p.side === 'LONG' && q >= p.target) return closePaperPosition('DYNAMIC TARGET', p.target);
  if (p.side === 'SHORT' && q <= p.target) return closePaperPosition('DYNAMIC TARGET', p.target);

  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= 2) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);

  // AUTO may promote a live winner when the trend itself becomes stronger.
  // Risk never increases after entry. Only target room and protection cadence adapt.
  if (requestedMode === 'AUTO') {
    if (p.currentMode === 'GRAB' && p.currentPower >= 68 && u.r >= .20) {
      p.currentMode = 'CRUISE'; extendTarget(p, MODES.CRUISE.targetR, 'TREND PROMOTION → CRUISE');
    }
    if (p.currentMode !== 'LAST_MAN' && p.currentPower >= 82 && u.r >= .70) {
      p.currentMode = 'LAST_MAN'; extendTarget(p, MODES.LAST_MAN.targetR, 'TREND PROMOTION → LAST MAN');
    }
  }

  // Strong Last Man runners may earn one more target extension, never by greed alone.
  if (p.currentMode === 'LAST_MAN' && !p.targetExtended && p.currentPower >= 88 && u.r >= 1.50 && m.direction === p.entryContext.direction) {
    p.targetExtended = true; extendTarget(p, 4.00, 'RUNNER BONUS');
  }

  const cfg = MODES[p.currentMode] || MODES.GRAB;
  if (u.r >= cfg.protectAt) advanceStop(p, stopForLockedR(p, cfg.lockR), `${p.currentMode} FIRST LOCK`);

  if (p.currentMode === 'GRAB') {
    if (u.r >= .58) advanceStop(p, stopForLockedR(p, .25), 'GRAB CASH GUARD');
  }
  if (p.currentMode === 'CRUISE') {
    if (u.r >= 1.00) advanceStop(p, stopForLockedR(p, .30), 'CRUISE PROFIT LOCK');
    if (u.r >= 1.25) advanceStop(p, stopForLockedR(p, .55), 'CRUISE SECOND LOCK');
  }
  if (p.currentMode === 'LAST_MAN') {
    if (u.r >= 1.50) advanceStop(p, stopForLockedR(p, .35), 'LAST MAN FIRST VAULT');
    if (u.r >= 2.00) advanceStop(p, stopForLockedR(p, .80), 'LAST MAN SECOND VAULT');
    if (u.r >= 2.75) advanceStop(p, stopForLockedR(p, 1.50), 'LAST MAN RUNNER LOCK');
  }

  // Structural trailing only after the mode has earned enough R.
  if (u.r >= cfg.trailAt && Number.isFinite(Number(m.important?.quote))) {
    const s = Number(m.important.quote);
    if (p.side === 'LONG' && s > p.trailStop && s < q) advanceStop(p, s, 'IMPORTANT HL TRAIL');
    if (p.side === 'SHORT' && s < p.trailStop && s > q) advanceStop(p, s, 'IMPORTANT LH TRAIL');
  }

  // Greed firewall: when a profitable position loses its trend power, cash or tighten.
  if (p.currentPower < 42 && u.r >= .45) return closePaperPosition('POWER FADE · CASH OUT', q);
  if (p.currentPower < 55 && u.r >= .80) advanceStop(p, stopForLockedR(p, Math.max(.35, u.r * .45)), 'POWER FADE LOCK');
  if (recommended === 'STAND_DOWN' && m.entryMode === 'EXHAUSTION' && u.r >= 1.20) advanceStop(p, stopForLockedR(p, Math.max(.60, u.r * .55)), 'EXHAUSTION LOCK');
}

function ingestTick(epoch, quote, render = true) {
  epoch = Number(epoch); quote = Number(quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const last = ticks.at(-1); if (last && last.epoch === epoch && last.quote === quote) return;
  ticks.push({ epoch, quote }); if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
  latestMountain = analyzeMountain(ticks);
  latestPower = trendPower(latestMountain, ticks);
  latestRecommendedMode = autoMode(latestPower, latestMountain);
  const hadPosition = Boolean(position);
  managePosition(latestMountain);
  if (!position && !hadPosition) { const c = candidate(latestMountain); if (c) openPosition(c); }
  if (render) renderAll();
}
function ingestHistory(history) {
  const prices = history?.prices || [], times = history?.times || [];
  const rows = prices.map((quote, i) => ({ epoch: Number(times[i]), quote: Number(quote) }));
  ticks = dedupe([...ticks, ...rows]).slice(-MAX_TICKS);
  latestMountain = analyzeMountain(ticks); latestPower = trendPower(latestMountain, ticks); latestRecommendedMode = autoMode(latestPower, latestMountain); renderAll();
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
  reconnectAttempt += 1; const delay = Math.min(12000, 700 * (2 ** (reconnectAttempt - 1)));
  setFeedStatus(`RETRY ${reconnectAttempt}/6`); reconnectTimer = setTimeout(() => { reconnectTimer = null; openFeed(); }, delay);
}
function openFeed() {
  closeFeed(); setFeedStatus('CONNECTING');
  try {
    ws = new WebSocket(PUBLIC_WS_URL);
    ws.onopen = () => {
      reconnectAttempt = 0; setFeedStatus('LOADING', true); const s = symbol();
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
function connect() { manualDisconnect = false; reconnectAttempt = 0; clearTimeout(reconnectTimer); reconnectTimer = null; addTape('SYSTEM', `Connecting ${symbol()} live market.`); openFeed(); }
function disconnect() { manualDisconnect = true; closeFeed(); setFeedStatus('OFFLINE'); }

async function loadAccounts() {
  const appId = $('lmsAppId')?.value?.trim(), token = $('lmsToken')?.value?.trim();
  if (!appId || !token) { setAccountStatus('APP ID + TOKEN'); return; }
  const btn = $('lmsLoadAccounts'); btn.disabled = true; setAccountStatus('LOADING');
  try {
    const r = await fetch('/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId, token }), cache: 'no-store' });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const accounts = Array.isArray(d.accounts) ? d.accounts : [], demos = accounts.filter(a => String(a.account_type || '').toLowerCase() !== 'real');
    const sel = $('lmsAccount'); sel.innerHTML = '';
    if (!demos.length) sel.innerHTML = '<option value="">No Demo accounts</option>';
    for (const a of demos) { const o = document.createElement('option'); o.value = a.account_id; o.textContent = `DEMO · ${a.account_id} · ${a.currency || ''} ${a.balance ?? ''}`; sel.appendChild(o); }
    setAccountStatus(demos.length ? `${demos.length} DEMO READY` : 'NO DEMO', demos.length > 0);
    sessionStorage.setItem('sani.lms.token', token); localStorage.setItem('sani.lms.appId', appId);
  } catch (error) { if ($('lmsAccount')?.value) setAccountStatus('DEMO READY', true); else setAccountStatus('ERROR'); addTape('ERROR', `Account load: ${error?.message || 'unknown error'}`); }
  finally { btn.disabled = false; }
}

function switchPage(n) {
  page = clamp(n, 0, 5);
  document.querySelectorAll('[data-lms-page]').forEach((el, i) => { const on = i === page; el.classList.toggle('active', on); el.setAttribute('aria-hidden', String(!on)); });
  document.querySelectorAll('[data-lms-target]').forEach(btn => btn.classList.toggle('active', Number(btn.dataset.lmsTarget) === page));
  if (page === 1) drawChart(true);
}
function modeDisplay(mode) { return mode === 'LAST_MAN' ? 'LAST MAN' : mode === 'STAND_DOWN' ? 'STAND DOWN' : mode; }
function renderAll() {
  const q = Number(ticks.at(-1)?.quote), u = unrealized(), locked = position ? Math.max(0, lockedRFromStop(position)) : 0;
  latestPower = trendPower(latestMountain, ticks); latestRecommendedMode = autoMode(latestPower, latestMountain);
  $('lmsTickCount').textContent = ticks.length.toLocaleString();
  $('lmsLastQuote').textContent = Number.isFinite(q) ? `${symbol()} · ${q.toFixed(2)}` : 'waiting for price';
  $('trendMountain').textContent = latestMountain.direction || 'WARMING'; $('trendPermission').textContent = `${allowedSide(latestMountain)} ONLY`;
  $('trendMoment').textContent = latestMountain.entryMode || '—'; $('trendReason').textContent = latestMountain.reason || 'waiting for shape';
  $('trendPower').textContent = `${latestPower}/100`; $('powerFill').style.width = `${latestPower}%`;
  $('trendMode').textContent = modeDisplay(latestRecommendedMode); $('trendModeReason').textContent = modeReason(latestRecommendedMode, latestPower, latestMountain);
  $('trendHand').textContent = position ? position.side : auto ? 'SCANNING' : 'STAND DOWN';
  $('trendThesis').textContent = position ? `${modeDisplay(position.currentMode)} · ${position.side} · live power ${position.currentPower}/100` : auto ? 'Waiting for a risk-worthy directional window.' : 'Paper auto paused.';

  $('positionHeadline').textContent = position ? `${modeDisplay(position.currentMode)} is still standing.` : 'Waiting for somebody worth defending.';
  $('positionSub').textContent = position ? 'Risk is fixed. Target room and profit protection adapt to the living trend.' : 'No trade is a valid position.';
  $('positionMode').textContent = position ? modeDisplay(position.currentMode) : modeDisplay(latestRecommendedMode);
  $('positionSide').textContent = position ? position.side : 'NO POSITION'; $('positionPower').textContent = `${position ? position.currentPower : latestPower}/100 POWER`;
  $('positionRisk').textContent = position ? money(position.riskDollars) : '$0.00'; $('positionEntry').textContent = position ? position.entry.toFixed(2) : '—';
  $('positionStop').textContent = position ? position.trailStop.toFixed(2) : '—'; $('positionTarget').textContent = position ? `${position.target.toFixed(2)} · ${position.targetR.toFixed(2)}R` : '—';
  $('positionR').textContent = `${u.r.toFixed(2)}R`; $('positionLocked').textContent = `${locked.toFixed(2)}R`; $('positionPnl').textContent = money(u.pnl);
  $('positionReason').textContent = position ? `Entered ${position.mode} at ${position.entryPower}/100 power. Current trend power ${position.currentPower}/100. Stop can only move toward profit.` : modeReason(latestRecommendedMode, latestPower, latestMountain);
  $('protectFill').style.width = `${clamp((locked + 1) / 4 * 100, 0, 100)}%`; $('protectCaption').textContent = position ? `locked ${locked.toFixed(2)}R · best ${position.bestR.toFixed(2)}R` : 'waiting to earn protection';

  $('lmsPnl').textContent = money(session.pnl + u.pnl); $('lmsState').textContent = auto ? 'PAPER ACTIVE' : 'PAPER LAB';
  const goal = Math.max(1, Number($('goalDollars')?.value || 650)); $('goalFill').style.width = `${clamp(session.pnl / goal * 100, 0, 100)}%`; $('goalCaption').textContent = `${money(session.pnl)} / $${goal.toFixed(0)}`; $('footerGoal').textContent = `$${goal.toFixed(0)}`;
  renderResults(); renderTape(); if (page === 1 && !chartFrozen) drawChart();
}
function renderResults() {
  const trades = session.trades || [], wins = trades.filter(t => t.pnl > 0).length, totalR = trades.reduce((s, t) => s + Number(t.r || 0), 0), gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0), gl = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  $('statPnl').textContent = money(session.pnl); $('statTrades').textContent = trades.length; $('statWinRate').textContent = `${trades.length ? (wins / trades.length * 100).toFixed(1) : '0.0'}%`; $('statAvgR').textContent = `${trades.length ? (totalR / trades.length).toFixed(2) : '0.00'}R`; $('statPf').textContent = gl ? (gp / gl).toFixed(2) : gp ? '∞' : '0.00'; $('statDrawdown').textContent = money(-Math.abs(session.maxDrawdown || 0));
  const group = mode => trades.filter(t => t.mode === mode || t.currentMode === mode); const ms = $('modeStats')?.children || [];
  ['GRAB','CRUISE','LAST_MAN'].forEach((m, i) => { const rows = group(m), pnl = rows.reduce((s,t)=>s+t.pnl,0); if (ms[i]) ms[i].querySelector('b').textContent = `${rows.length}T · ${money(pnl)}`; });
  const body = $('resultsBody'); if (!trades.length) { body.innerHTML = '<tr><td colspan="8">No positions closed yet.</td></tr>'; return; }
  body.innerHTML = trades.slice(0,120).map(t => `<tr><td>${new Date(t.closedAt).toLocaleTimeString()}</td><td>${modeDisplay(t.currentMode || t.mode)}</td><td>${t.side}</td><td>${t.entryPower}</td><td>${money(t.riskDollars)}</td><td>${t.reason}</td><td>${t.r.toFixed(2)}R</td><td>${money(t.pnl)}</td></tr>`).join('');
}
function renderTape() {
  const rows = session.tape || [], list = $('tapeList'); $('tapeCount').textContent = `${rows.length} EVENTS`;
  list.innerHTML = rows.length ? rows.slice(0,250).map(r => `<div class="tapeEvent"><span>${new Date(r.at).toLocaleTimeString()}</span><b>${r.type}</b><span>${r.text}</span><em>${r.mode || r.side || ''}</em></div>`).join('') : '<p>Nothing yet.</p>';
}

function visibleRows() { const end = Math.max(0, ticks.length - chartOffset), start = Math.max(0, end - chartViewCount); return ticks.slice(start, end); }
function drawChart(force = false) {
  const c = $('lmsChart'); if (!c || (chartFrozen && !force)) return;
  const dpr = window.devicePixelRatio || 1, w = Math.max(600, c.clientWidth), h = Math.max(380, c.clientHeight);
  if (c.width !== Math.round(w*dpr) || c.height !== Math.round(h*dpr)) { c.width = Math.round(w*dpr); c.height = Math.round(h*dpr); }
  const ctx = c.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h); ctx.fillStyle='#070607'; ctx.fillRect(0,0,w,h);
  const rows = visibleRows(); if (rows.length < 2) { ctx.fillStyle='#b998a5'; ctx.font='12px monospace'; ctx.fillText('CONNECT LIVE MARKET TO START',28,40); return; }
  const pad={l:42,r:92,t:30,b:36}, extra=position?[position.trailStop,position.target,position.entry]:[], qs=[...rows.map(r=>r.quote),...extra.filter(Number.isFinite)], lo=Math.min(...qs), hi=Math.max(...qs), range=hi-lo||1;
  const x=i=>pad.l+i/(rows.length-1)*(w-pad.l-pad.r), y=q=>pad.t+(hi-q)/range*(h-pad.t-pad.b);
  ctx.strokeStyle='rgba(242,166,200,.10)'; for(let i=0;i<6;i++){const yy=pad.t+i/5*(h-pad.t-pad.b);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke()}
  ctx.strokeStyle='#87e7d4';ctx.lineWidth=1.8;ctx.beginPath();rows.forEach((r,i)=>i?ctx.lineTo(x(i),y(r.quote)):ctx.moveTo(x(i),y(r.quote)));ctx.stroke();
  const m=analyzeMountain(rows),piv=m.pivots||[]; if(piv.length>1){ctx.strokeStyle='#e795b7';ctx.lineWidth=1.2;ctx.setLineDash([7,6]);ctx.beginPath();let started=false;for(const p of piv){const idx=rows.findIndex(r=>r.epoch===p.epoch&&r.quote===p.quote);if(idx<0)continue;if(!started){ctx.moveTo(x(idx),y(p.quote));started=true}else ctx.lineTo(x(idx),y(p.quote))}ctx.stroke();ctx.setLineDash([])}
  const line=(q,color,label)=>{if(!Number.isFinite(Number(q)))return;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(pad.l,y(q));ctx.lineTo(w-pad.r,y(q));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='10px monospace';ctx.fillText(label,w-pad.r+8,y(q)+3)};
  if(position){line(position.trailStop,'#ee6c84','PROTECTED STOP');line(position.target,'#80dfa5',`${modeDisplay(position.currentMode)} TARGET`);line(position.entry,'#efb4cf','ENTRY')}
  for(const t of (session.trades||[]).slice(0,70)){const idx=rows.findIndex(r=>r.epoch===t.openedEpoch);if(idx<0)continue;ctx.fillStyle=t.side==='LONG'?'#80dfa5':'#ee6c84';ctx.beginPath();if(t.side==='LONG'){ctx.moveTo(x(idx),y(t.entry)-8);ctx.lineTo(x(idx)-6,y(t.entry)+5);ctx.lineTo(x(idx)+6,y(t.entry)+5)}else{ctx.moveTo(x(idx),y(t.entry)+8);ctx.lineTo(x(idx)-6,y(t.entry)-5);ctx.lineTo(x(idx)+6,y(t.entry)-5)}ctx.closePath();ctx.fill()}
  ctx.fillStyle='#f1adc9';ctx.font='11px monospace';ctx.fillText(`LIBRA: ${m.direction} · ${m.entryMode} · POWER ${trendPower(m,rows)}/100 · ${chartFrozen?'FROZEN':'LIVE'}`,pad.l,18);
}
function saveMapPng(){const base=$('lmsChart'),ink=$('lmsInk');if(!base)return;const out=document.createElement('canvas');out.width=base.width;out.height=base.height;const ctx=out.getContext('2d');ctx.drawImage(base,0,0);if(ink)ctx.drawImage(ink,0,0,out.width,out.height);out.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`last-man-map-${Date.now()}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)})}
function saveTrainingCase(){const payload={savedAt:new Date().toISOString(),symbol:symbol(),rows:visibleRows(),mountain:analyzeMountain(visibleRows()),power:trendPower(analyzeMountain(visibleRows()),visibleRows()),position,requestedMode,sessionPnl:session.pnl};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`last-man-training-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}
function exportCsv(){const headers=['closed_at','entry_mode','final_mode','side','entry_power','exit_power','risk','entry','initial_stop','final_stop','target_r','exit','reason','r','pnl','entry_mountain','entry_moment','entry_confirmation','exit_mountain','exit_moment'];const esc=v=>`"${String(v??'').replaceAll('"','""')}"`;const rows=(session.trades||[]).slice().reverse().map(t=>[new Date(t.closedAt).toISOString(),t.mode,t.currentMode,t.side,t.entryPower,t.exitPower,t.riskDollars,t.entry,t.stop,t.trailStop,t.targetR,t.exit,t.reason,t.r,t.pnl,t.entryContext?.direction,t.entryContext?.entryMode,t.entryContext?.confirmation,t.exitContext?.direction,t.exitContext?.entryMode]);const csv=[headers,...rows].map(r=>r.map(esc).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`last-man-standing-${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500)}

function installInk(){inkCanvas=$('lmsInk');const c=$('lmsChart');if(!inkCanvas||!c)return;const resize=()=>{const dpr=window.devicePixelRatio||1;inkCanvas.width=Math.round(c.clientWidth*dpr);inkCanvas.height=Math.round(c.clientHeight*dpr)};resize();let drawing=false,last=null;const point=e=>{const r=inkCanvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(inkCanvas.width/r.width),y:(e.clientY-r.top)*(inkCanvas.height/r.height)}};inkCanvas.addEventListener('pointerdown',e=>{if(!inkMode)return;drawing=true;last=point(e);inkCanvas.setPointerCapture(e.pointerId)});inkCanvas.addEventListener('pointermove',e=>{if(!drawing||!inkMode)return;const p=point(e),ctx=inkCanvas.getContext('2d');ctx.strokeStyle=inkColor;ctx.lineWidth=Math.max(3,inkCanvas.width/700);ctx.lineCap='round';ctx.beginPath();ctx.moveTo(last.x,last.y);ctx.lineTo(p.x,p.y);ctx.stroke();last=p});const stop=()=>{drawing=false;last=null};inkCanvas.addEventListener('pointerup',stop);inkCanvas.addEventListener('pointercancel',stop);window.addEventListener('resize',()=>{resize();if(page===1)drawChart(true)})}
function bindMapTools(){const tools=$('lmsMapTools');if(!tools)return;tools.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.color){inkColor=b.dataset.color;return}const act=b.dataset.act;if(act==='older'){chartFrozen=true;chartOffset=Math.min(Math.max(0,ticks.length-20),chartOffset+Math.max(20,Math.floor(chartViewCount*.55)));drawChart(true)}if(act==='newer'){chartOffset=Math.max(0,chartOffset-Math.max(20,Math.floor(chartViewCount*.55)));if(!chartOffset)chartFrozen=false;drawChart(true)}if(act==='live'){chartOffset=0;chartFrozen=false;drawChart(true)}if(act==='zin'){chartViewCount=Math.max(60,Math.floor(chartViewCount*.75));drawChart(true)}if(act==='zout'){chartViewCount=Math.min(900,Math.floor(chartViewCount*1.35));drawChart(true)}if(act==='freeze'){chartFrozen=!chartFrozen;b.classList.toggle('on',chartFrozen);b.textContent=chartFrozen?'FROZEN':'FREEZE';if(!chartFrozen){chartOffset=0;drawChart(true)}}if(act==='draw'){inkMode=!inkMode;b.classList.toggle('on',inkMode);inkCanvas.classList.toggle('drawOn',inkMode)}if(act==='clear')inkCanvas.getContext('2d').clearRect(0,0,inkCanvas.width,inkCanvas.height);if(act==='png')saveMapPng();if(act==='case')saveTrainingCase()})}
function setRequestedMode(mode){requestedMode=mode;document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));$('modeControlLabel').textContent=modeDisplay(mode);addTape('MODE',`Control mode set to ${modeDisplay(mode)}. Safety thresholds remain active.`);renderAll()}
function bind(){document.querySelectorAll('[data-lms-target]').forEach(b=>b.addEventListener('click',()=>switchPage(Number(b.dataset.lmsTarget))));document.querySelectorAll('[data-next]').forEach(b=>b.addEventListener('click',()=>switchPage(page+1)));document.querySelectorAll('[data-prev]').forEach(b=>b.addEventListener('click',()=>switchPage(page-1)));document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setRequestedMode(b.dataset.mode)));$('lmsConnect').addEventListener('click',connect);$('lmsDisconnect').addEventListener('click',disconnect);$('lmsLoadAccounts').addEventListener('click',loadAccounts);$('startAuto').addEventListener('click',()=>{auto=true;addTape('SYSTEM','AUTO PAPER armed. Trend strength controls risk appetite.');renderAll()});$('pauseAuto').addEventListener('click',()=>{auto=false;addTape('SYSTEM','AUTO PAPER paused.');renderAll()});$('closePosition').addEventListener('click',()=>closePaperPosition('MANUAL CLOSE'));$('resetLms').addEventListener('click',()=>{if(position)closePaperPosition('RESET CLOSE');session=freshSession();position=null;auto=false;lastCloseEpoch=0;save();renderAll()});$('lmsExportCsv').addEventListener('click',exportCsv);['riskCap','goalDollars'].forEach(id=>$(id).addEventListener('input',renderAll));bindMapTools();installInk()}
function boot(){const id=localStorage.getItem('sani.lms.appId')||localStorage.getItem('sani.comet.appId');if(id)$('lmsAppId').value=id;const tok=sessionStorage.getItem('sani.lms.token')||sessionStorage.getItem('sani.comet.token');if(tok)$('lmsToken').value=tok;bind();switchPage(0);renderAll();setFeedStatus('OFFLINE')}

window.LAST_MAN_STANDING={getSession:()=>structuredClone(session),getTicks:()=>structuredClone(ticks),getMountain:()=>structuredClone(latestMountain),getTrendPower:()=>latestPower,exportCsv};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
