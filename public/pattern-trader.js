import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const nowPerf = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.8';
const VISUAL_KEY = 'sani.masterTrader.visualSetups.v6.8';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const LONG = 200;
const AUTH = 80;
const FAST = 20;
const WAVE = 56;
const HARD_DAMAGE = 0.786;
const CORE_MIN = 0.382;
const CORE_MAX = 0.618;
const FIRE_MIN = 0.32;
const FIRE_MAX = 0.68;
const SLOPE80_TOL = 0.015;
const MACRO_CONFLICT = 0.09;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastDiagnostics = null;
let lastSignalEpoch = 0;
let cooldownUntil = 0;
let ledger = loadArray(LEDGER_KEY);
let visualHistory = loadArray(VISUAL_KEY);
const contractToLedger = new Map();
const waveMemory = new Map();
const strategy = { session: 'NEUTRAL', neutralTicks: 0, sessionId: 0 };

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: 3,
  durationUnit: 't',
  executionMethod: 'direct',
  oneOpenContract: true,
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 100,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  maxSignalToSendMs: 250,
  reconnect: true,
  maxReconnectAttempts: 8
});
engine.onTick = function masterTick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  this.emit();
};

function loadArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function saveLedger() {
  ledger = ledger.slice(0, 5000);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {}
}
function saveVisuals() {
  visualHistory = visualHistory.slice(0, 1400);
  try { localStorage.setItem(VISUAL_KEY, JSON.stringify(visualHistory)); } catch {}
}
function symbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function ticks() {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol()}`) || '[]');
    return Array.isArray(rows)
      ? rows.map(x => ({ epoch: +x.epoch, quote: +x.quote }))
        .filter(x => Number.isFinite(x.epoch) && Number.isFinite(x.quote))
        .sort((a, b) => a.epoch - b.epoch)
      : [];
  } catch { return []; }
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function avgStep(p) {
  if (p.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < p.length; i += 1) s += Math.abs(p[i] - p[i - 1]);
  return s / (p.length - 1);
}
function efficiency(p) {
  if (p.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < p.length; i += 1) path += Math.abs(p[i] - p[i - 1]);
  return path ? Math.abs(p.at(-1) - p[0]) / path : 0;
}
function turnRate(p) {
  const signs = [];
  for (let i = 1; i < p.length; i += 1) {
    const d = p[i] - p[i - 1];
    if (d) signs.push(Math.sign(d));
  }
  if (signs.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < signs.length; i += 1) if (signs[i] !== signs[i - 1]) n += 1;
  return n / (signs.length - 1);
}
function linearSlope(p) {
  const n = p.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(p);
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xm;
    num += dx * (p[i] - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}
function pivots(p, r = 2) {
  const highs = [], lows = [];
  for (let i = r; i < p.length - r; i += 1) {
    const left = p.slice(i - r, i), right = p.slice(i + 1, i + r + 1);
    const hi = left.every(v => p[i] >= v) && right.every(v => p[i] >= v) && [...left, ...right].some(v => p[i] > v);
    const lo = left.every(v => p[i] <= v) && right.every(v => p[i] <= v) && [...left, ...right].some(v => p[i] < v);
    if (hi) highs.push({ i, quote: p[i] });
    if (lo) lows.push({ i, quote: p[i] });
  }
  return { highs, lows };
}
function structure(p, r = 3) {
  const x = pivots(p, r), h = x.highs.slice(-2), l = x.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}
function metrics(rows, r = 3) {
  const p = rows.map(x => x.quote), step = avgStep(p), slope = linearSlope(p);
  return { slopeNorm: step ? slope / step : 0, efficiency: efficiency(p), turnRate: turnRate(p), avgStep: step, net: p.at(-1) - p[0], structure: structure(p, r) };
}
function trend200(m) {
  const bull = [m.slopeNorm >= .055, m.efficiency >= .10, m.net > 0, m.structure === 'BULL'].filter(Boolean).length;
  const bear = [m.slopeNorm <= -.055, m.efficiency >= .10, m.net < 0, m.structure === 'BEAR'].filter(Boolean).length;
  if (bull >= 3 && m.slopeNorm > 0) return 'BULL';
  if (bear >= 3 && m.slopeNorm < 0) return 'BEAR';
  return 'NEUTRAL';
}
function trend80(m) {
  if (Math.abs(m.slopeNorm) < .072 || m.efficiency < .055) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0 && (m.structure === 'BULL' || m.slopeNorm >= .12)) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0 && (m.structure === 'BEAR' || m.slopeNorm <= -.12)) return 'BEAR';
  return 'NEUTRAL';
}
function fastTrend(m) {
  if (Math.abs(m.slopeNorm) < .055 || m.efficiency < .06) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0) return 'BEAR';
  return 'NEUTRAL';
}
function chop(m80, m20) {
  const score = (
    clamp((.14 - m80.efficiency) / .14, 0, 1) +
    clamp((m80.turnRate - .52) / .25, 0, 1) +
    clamp((.055 - Math.abs(m80.slopeNorm)) / .055, 0, 1) +
    clamp((m20.turnRate - .72) / .18, 0, 1)
  ) / 4;
  return { score, isChop: score >= .76 };
}
function volatility(m200, m80, m20) {
  const a = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const b = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (a < .36 || b < .46) return 'DEAD';
  if (a > 2.35 || m20.turnRate > .91) return 'CHAOTIC';
  return 'HEALTHY';
}
function updateSession(active80, fast, isChop, volState) {
  if (isChop || volState !== 'HEALTHY') {
    strategy.neutralTicks += 1;
    if (strategy.neutralTicks >= 2) strategy.session = 'NEUTRAL';
    return;
  }
  const authority = active80 !== 'NEUTRAL' ? active80 : fast;
  if (authority === 'NEUTRAL') {
    strategy.neutralTicks += 1;
    if (strategy.neutralTicks >= 2) strategy.session = 'NEUTRAL';
    return;
  }
  strategy.neutralTicks = 0;
  if (strategy.session !== authority) {
    strategy.session = authority;
    strategy.sessionId += 1;
  }
}
function waveFrom(rows, direction, start, end, step) {
  const p = rows.map(x => x.quote);
  const range = direction === 'BULL' ? end.quote - start.quote : start.quote - end.quote;
  if (!(range > 0)) return null;
  const after = p.slice(end.i + 1), current = p.at(-1);
  const retraces = after.map(v => direction === 'BULL' ? (end.quote - v) / range : (v - end.quote) / range);
  return {
    direction, start, end, step, range, retraces,
    maxRetrace: retraces.length ? Math.max(...retraces) : 0,
    currentRetrace: direction === 'BULL' ? (end.quote - current) / range : (current - end.quote) / range
  };
}
function liveWave(rows, direction) {
  const p = rows.map(x => x.quote), step = avgStep(p) || 1, x = pivots(p, 2);
  if (direction === 'BULL') {
    for (const low of [...x.lows].reverse()) {
      const future = p.slice(low.i + 1);
      if (future.length < 3) continue;
      const high = Math.max(...future), i = low.i + 1 + future.indexOf(high);
      if (high - low.quote >= step * 3.0 && i - low.i >= 3) return waveFrom(rows, direction, low, { i, quote: high }, step);
    }
  } else if (direction === 'BEAR') {
    for (const high of [...x.highs].reverse()) {
      const future = p.slice(high.i + 1);
      if (future.length < 3) continue;
      const low = Math.min(...future), i = high.i + 1 + future.indexOf(low);
      if (high.quote - low >= step * 3.0 && i - high.i >= 3) return waveFrom(rows, direction, high, { i, quote: low }, step);
    }
  }
  return null;
}
function fibPrice(w, ratio) { return w.direction === 'BULL' ? w.end.quote - w.range * ratio : w.end.quote + w.range * ratio; }
function waveKey(w, rows) { return w ? `${strategy.sessionId}:${w.direction}:${rows[w.start.i]?.epoch}` : ''; }
function alreadyTraded(key) { return ledger.some(r => r.waveKey === key && Number.isFinite(+r.contractId)); }
function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function durationFor(key) { return hashKey(key) % 2 === 0 ? 3 : 5; }
function firstTurn(rows, direction, step) {
  const p = rows.map(x => x.quote), n = p.length;
  if (n < 3) return { ok: false, strength: 0, kind: 'NONE' };
  const current = p[n - 1], prev = p[n - 2], prev2 = p[n - 3], unit = step || 1;
  if (direction === 'BULL') {
    const ok = prev < prev2 && current > prev && current - prev >= unit * .04;
    return { ok, strength: Math.max(0, current - prev) / unit, kind: ok ? 'FIRST_UP' : 'NONE' };
  }
  if (direction === 'BEAR') {
    const ok = prev > prev2 && current < prev && prev - current >= unit * .04;
    return { ok, strength: Math.max(0, prev - current) / unit, kind: ok ? 'FIRST_DOWN' : 'NONE' };
  }
  return { ok: false, strength: 0, kind: 'NONE' };
}
function directionLock(session, regime200, active80, fast, m200, m80) {
  if (session !== 'BULL' && session !== 'BEAR') return { ok: false, reason: 'No active direction' };
  const bull = session === 'BULL';
  const slope80Ok = bull ? m80.slopeNorm >= -SLOPE80_TOL : m80.slopeNorm <= SLOPE80_TOL;
  const macroConflict = bull
    ? regime200 === 'BEAR' || m200.slopeNorm <= -MACRO_CONFLICT
    : regime200 === 'BULL' || m200.slopeNorm >= MACRO_CONFLICT;
  const activeConflict = bull ? active80 === 'BEAR' : active80 === 'BULL';
  const liveAuthority = active80 === session || (active80 === 'NEUTRAL' && fast === session);
  if (!slope80Ok) return { ok: false, reason: `80 slope ${m80.slopeNorm.toFixed(3)} opposes ${session}` };
  if (activeConflict) return { ok: false, reason: `80 trend is ${active80}` };
  if (macroConflict) return { ok: false, reason: `200 macro conflicts · slope ${m200.slopeNorm.toFixed(3)} · regime ${regime200}` };
  if (!liveAuthority) return { ok: false, reason: `No live authority · 80 ${active80} · FAST ${fast}` };
  return { ok: true, reason: `LOCKED ${session}` };
}
function reanchor(all, direction) {
  for (const width of [48, 38, 30, 24, 20]) {
    const rows = all.slice(-width), wave = liveWave(rows, direction);
    if (wave && wave.currentRetrace <= HARD_DAMAGE && wave.maxRetrace <= HARD_DAMAGE) return { rows, wave };
  }
  return null;
}
function quality(d) {
  if (!d.wave) return 0;
  let q = 0;
  const r = d.wave.currentRetrace;
  q += r >= CORE_MIN && r <= CORE_MAX ? 35 : r >= FIRE_MIN && r <= FIRE_MAX ? 24 : 0;
  q += d.m80.efficiency >= .16 ? 16 : d.m80.efficiency >= .09 ? 10 : 5;
  q += Math.abs(d.m80.slopeNorm) >= .18 ? 13 : Math.abs(d.m80.slopeNorm) >= .10 ? 9 : 4;
  q += d.fast === d.session ? 10 : 4;
  q += d.trigger.strength >= .5 ? 14 : d.trigger.strength >= .18 ? 10 : 6;
  q += d.chopScore <= .18 ? 8 : d.chopScore <= .35 ? 5 : 2;
  if (d.regime200 === d.session) q += 4;
  return clamp(Math.round(q), 0, 100);
}
function pushVisual(d, state, reason) {
  if (!d?.waveKey || !Number.isFinite(+d.epoch) || !Number.isFinite(+d.quote)) return;
  const unique = `${d.waveKey}:${state}`;
  if (visualHistory.some(v => v.unique === unique)) return;
  visualHistory.unshift({
    unique, at: Date.now(), epoch: d.epoch, quote: d.quote, direction: d.session,
    state, reason, waveKey: d.waveKey, retrace: d.wave?.currentRetrace, quality: d.quality,
    duration: d.duration
  });
  saveVisuals();
}
function rememberVisual(d) {
  if (!d?.wave || !d.waveKey) return;
  const memory = waveMemory.get(d.waveKey) || { armed: false, terminal: false, signaled: false, dirBlocked: false };
  if (d.inFire && !memory.armed) {
    memory.armed = true;
    pushVisual(d, 'ARMED', `${d.duration}t entered 32–68% pocket`);
  }
  if (memory.armed && !memory.terminal && d.phase === 'WAIT_POCKET') {
    memory.terminal = true;
    pushVisual(d, 'MISSED', 'Left pocket before first-turn trigger');
  }
  if (memory.armed && !memory.terminal && (d.phase === 'DEEP' || d.phase === 'INVALID')) {
    memory.terminal = true;
    pushVisual(d, 'INVALID', d.phase === 'INVALID' ? 'Past 78.6%' : 'Beyond fire pocket');
  }
  if (d.trigger?.ok && d.inFire && !d.dirLock?.ok && !memory.dirBlocked) {
    memory.dirBlocked = true;
    pushVisual(d, 'BLOCKED', `DIR LOCK: ${d.dirLock.reason}`);
  }
  if (d.ready && !memory.signaled) {
    memory.signaled = true;
    pushVisual(d, 'SIGNAL', `FIRST TURN · ${d.duration}t`);
  }
  waveMemory.set(d.waveKey, memory);
}
function evaluate(snapshot) {
  const all = ticks();
  if (all.length < LONG) return { ready: false, reason: `Need ${LONG} ticks (${all.length}/${LONG})`, phase: 'WARMING', rows: all };
  const r200 = all.slice(-LONG), r80 = all.slice(-AUTH), r20 = all.slice(-FAST);
  const m200 = metrics(r200, 4), m80 = metrics(r80, 3), m20 = metrics(r20, 2);
  const regime200 = trend200(m200), active80 = trend80(m80), fast = fastTrend(m20);
  const c = chop(m80, m20), volState = volatility(m200, m80, m20);
  updateSession(active80, fast, c.isChop, volState);
  const session = strategy.session;
  let waveRows = all.slice(-WAVE);
  let wave = session === 'BULL' || session === 'BEAR' ? liveWave(waveRows, session) : null;
  if (wave && (wave.maxRetrace > HARD_DAMAGE || wave.currentRetrace > HARD_DAMAGE)) {
    const fresh = reanchor(all, session);
    if (fresh) { waveRows = fresh.rows; wave = fresh.wave; }
  }
  const key = waveKey(wave, waveRows);
  const duration = key ? durationFor(key) : 3;
  const trigger = firstTurn(r20, session, wave?.step || m20.avgStep || 1);
  const dirLock = directionLock(session, regime200, active80, fast, m200, m80);
  const inFire = Boolean(wave && wave.currentRetrace >= FIRE_MIN && wave.currentRetrace <= FIRE_MAX);
  let phase = 'SEARCHING';
  if (wave) {
    if (wave.maxRetrace > HARD_DAMAGE || wave.currentRetrace > HARD_DAMAGE) phase = 'INVALID';
    else if (wave.currentRetrace < 0) phase = 'EXTENDING';
    else if (wave.currentRetrace < FIRE_MIN) phase = 'WAIT_POCKET';
    else if (wave.currentRetrace <= FIRE_MAX) phase = trigger.ok ? (dirLock.ok ? 'TURN_SNIPER' : 'DIR_BLOCK') : 'ARMED';
    else phase = 'DEEP';
  }
  const permission = session !== 'NEUTRAL' && !c.isChop && volState === 'HEALTHY' && dirLock.ok;
  const duplicate = alreadyTraded(key);
  const ready = Boolean(permission && wave && inFire && trigger.ok && !duplicate && phase === 'TURN_SNIPER');
  const d = {
    ready, rows: all, waveRows, epoch: all.at(-1).epoch, quote: all.at(-1).quote,
    regime200, active80, fast, session, phase, chop: c.isChop, chopScore: c.score,
    volatility: volState, m200, m80, m20, wave, trigger, dirLock, waveKey: key,
    duration, durationCohort: `${duration}T`, inFire
  };
  d.quality = quality(d);
  if (c.isChop) d.reason = `CHOP veto ${(c.score * 100).toFixed(0)}%`;
  else if (volState !== 'HEALTHY') d.reason = `Volatility ${volState}`;
  else if (session === 'NEUTRAL') d.reason = `No direction · 80 ${active80} · FAST ${fast}`;
  else if (!dirLock.ok) d.reason = `DIRECTION BLOCK · ${dirLock.reason}`;
  else if (!wave) d.reason = 'Building fresh impulse';
  else if (phase === 'INVALID') d.reason = `INVALID ${(wave.currentRetrace * 100).toFixed(1)}% > 78.6%`;
  else if (phase === 'WAIT_POCKET') d.reason = `Waiting pocket · NOW ${(wave.currentRetrace * 100).toFixed(1)}% · next=${duration}t`;
  else if (phase === 'DEEP') d.reason = `Deep retrace ${(wave.currentRetrace * 100).toFixed(1)}%`;
  else if (phase === 'ARMED') d.reason = `ARMED ${(wave.currentRetrace * 100).toFixed(1)}% · waiting first reversal tick · ${duration}t cohort`;
  else if (duplicate) d.reason = 'Wave already traded';
  else if (ready) d.reason = `FIRST TURN · ${duration}t · FIRE`;
  else d.reason = 'Scanning';
  rememberVisual(d);
  return d;
}

function offsets() { return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50); }
function offsetEstimate() {
  const a = offsets().map(v => Math.max(1, Math.min(10, Math.round(v)))).sort((x, y) => x - y);
  if (!a.length) return 1;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
function recordOffset(v) {
  if (!Number.isFinite(+v)) return;
  const a = offsets();
  a.push(Math.max(1, Math.min(10, Math.round(+v))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(a.slice(-50))); } catch {}
}
function actualOffset(t) {
  const s = +t?.signalEpoch, e = +t?.entryTickTime;
  if (Number.isFinite(s) && Number.isFinite(e)) return Math.max(1, Math.round(e - s));
  const st = +t?.startTime;
  if (Number.isFinite(s) && Number.isFinite(st)) return Math.max(1, Math.round(st - s) + 1);
}
function latency(o) { return !Number.isFinite(+o) ? 'UNKNOWN' : +o <= 1 ? 'CLEAN' : +o === 2 ? 'LATE +1' : 'LATE +2+'; }
function makeSignal(snapshot, d) {
  if (!d.ready) return null;
  const off = +(snapshot?.executionOffset ?? offsetEstimate());
  return {
    symbol: symbol(), epoch: +(snapshot?.epoch ?? d.epoch), quote: +(snapshot?.quote ?? d.quote),
    signalEpoch: +(snapshot?.epoch ?? d.epoch), signalQuote: +(snapshot?.quote ?? d.quote),
    direction: d.session === 'BULL' ? 'CALL' : 'PUT', session: d.session, phase: d.phase,
    entryMode: 'FIRST_TURN_LOCKED', duration: d.duration, durationCohort: d.durationCohort,
    waveKey: d.waveKey, fibEntryRetrace: d.wave.currentRetrace,
    quality: d.quality, triggerKind: d.trigger.kind, triggerStrength: d.trigger.strength,
    regime200: d.regime200, active80: d.active80, fast: d.fast,
    slope200: d.m200.slopeNorm, slope80: d.m80.slopeNorm, efficiency80: d.m80.efficiency,
    chopScore: d.chopScore, volatility: d.volatility, directionLockReason: d.dirLock.reason,
    waveStart: d.wave.start.quote, waveEnd: d.wave.end.quote, waveStep: d.wave.step,
    targetPrice: d.wave.end.quote, invalidationPrice: fibPrice(d.wave, HARD_DAMAGE),
    executionOffset: off
  };
}
function ensureRow(s) {
  const key = `${s.symbol}:${s.epoch}:${s.waveKey}`;
  let row = ledger.find(x => x.signalKey === key);
  if (row) return row;
  row = {
    id: `mt68-${s.epoch}-${Date.now()}`, cohort: 'v6.8-direction-lock-duration', signalKey: key,
    observedAt: Date.now(), ...s,
    expectedWindow: `T+${s.executionOffset}→T+${s.executionOffset + s.duration}`,
    status: 'QUALIFIED'
  };
  ledger.unshift(row);
  saveLedger();
  return row;
}
function patchRow(id, patch) {
  const row = ledger.find(x => x.id === id);
  if (row) { Object.assign(row, patch, { updatedAt: Date.now() }); saveLedger(); }
}
function recordBlocked(s, state) {
  const unique = `${s.waveKey}:BLOCKED:${s.epoch}:${state}`;
  if (visualHistory.some(v => v.unique === unique)) return;
  visualHistory.unshift({ unique, at: Date.now(), epoch: s.epoch, quote: s.quote, direction: s.session, state: 'BLOCKED', reason: state, waveKey: s.waveKey, retrace: s.fibEntryRetrace, quality: s.quality, duration: s.duration });
  saveVisuals();
}
function bought() { return ledger.filter(r => Number.isFinite(+r.contractId)).length; }
function cohort() {
  const settled = ledger.filter(r => r.status === 'WON' || r.status === 'LOST');
  const wins = settled.filter(r => r.status === 'WON').length;
  const losses = settled.filter(r => r.status === 'LOST').length;
  const pnl = settled.reduce((s, r) => s + (+r.profit || 0), 0);
  const d3 = settled.filter(r => +r.duration === 3);
  const d5 = settled.filter(r => +r.duration === 5);
  return {
    wins, losses, pnl,
    d3W: d3.filter(r => r.status === 'WON').length, d3L: d3.filter(r => r.status === 'LOST').length,
    d5W: d5.filter(r => r.status === 'WON').length, d5L: d5.filter(r => r.status === 'LOST').length,
    d3Pnl: d3.reduce((s, r) => s + (+r.profit || 0), 0), d5Pnl: d5.reduce((s, r) => s + (+r.profit || 0), 0)
  };
}
function pathStats(meta, trade) {
  const start = +trade?.entryTickTime, end = +trade?.exitTickTime, entry = +trade?.entrySpot;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(entry)) return {};
  const path = ticks().filter(x => x.epoch >= start && x.epoch <= end).map(x => x.quote);
  if (!path.length) return {};
  const max = Math.max(...path), min = Math.min(...path), call = meta?.direction === 'CALL';
  const mfe = call ? max - entry : entry - min;
  const mae = call ? entry - min : max - entry;
  const target = +meta?.targetPrice;
  const targetTouched = Number.isFinite(target) ? (call ? max >= target : min <= target) : false;
  return { mfe, mae, targetTouched, pathTicks: path.length, pathHigh: max, pathLow: min };
}
function traderConfig() {
  const c = {
    ...engine.config, symbol: symbol(), stake: +$('ptStake').value,
    takeProfit: +$('ptTakeProfit').value, stopLoss: +$('ptStopLoss').value,
    maxTrades: +$('ptMaxTrades').value, duration: 3, durationUnit: 't',
    executionMethod: 'direct', oneOpenContract: true, maxSignalToSendMs: 250,
    currency: selectedAccount?.currency || 'USD', reconnect: true, maxReconnectAttempts: 8
  };
  if (!(c.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!engine.snapshot().running) engine.setConfig(c);
  return c;
}
function auth() {
  const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim(), accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  if (String(selectedAccount.account_type).toLowerCase() === 'real') throw new Error('Master v6.8 is Demo-only.');
  return { appId, token, accountId };
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `API ${response.status}`);
  return json;
}
async function freshWs() {
  const data = await api('otp', lastOtpContext || auth());
  if (!data.url) throw new Error('OTP response missing WebSocket URL.');
  return data.url;
}
function showError(message) { $('traderError').textContent = message; $('traderError').classList.remove('hidden'); }
function clearError() { $('traderError').textContent = ''; $('traderError').classList.add('hidden'); }
function renderAccounts() {
  const select = $('ptAccount');
  select.innerHTML = accounts.length ? '' : '<option value="">No accounts found</option>';
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = a.account_id;
    o.textContent = `${String(a.account_type).toUpperCase()} · ${a.account_id} · ${a.currency} ${a.balance}`;
    select.appendChild(o);
  }
  const saved = localStorage.getItem('sani.deriv.accountId');
  if (saved && accounts.some(a => a.account_id === saved)) select.value = saved;
  if (!select.value || String(accounts.find(a => a.account_id === select.value)?.account_type).toLowerCase() === 'real') {
    const demo = accounts.find(a => String(a.account_type).toLowerCase() !== 'real');
    if (demo) select.value = demo.account_id;
  }
  selectedAccount = accounts.find(a => a.account_id === select.value) || null;
  renderGate();
}
function renderGate() {
  selectedAccount = accounts.find(a => a.account_id === $('ptAccount').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('ptRealGate').classList.toggle('hidden', !real);
  $('ptAccountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
  $('ptConnect').disabled = !selectedAccount || real;
}
function maybeTrade(snapshot) {
  const d = evaluate(snapshot);
  lastDiagnostics = d;
  renderState(d);
  draw();
  renderLedger();
  const s = makeSignal(snapshot, d);
  if (!s) return;
  const row = ensureRow(s), state = engine.snapshot();
  if (s.epoch <= lastSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) { patchRow(row.id, { status: 'SKIP STALE' }); recordBlocked(s, 'STALE'); return; }
  if (state.safeBlocked) { patchRow(row.id, { status: 'SKIP SAFE PAUSE' }); recordBlocked(s, 'SAFE PAUSE'); return; }
  if (!state.running) { const status = state.connected ? 'OBSERVED' : 'SKIP DISCONNECTED'; patchRow(row.id, { status }); if (!state.connected) recordBlocked(s, 'DISCONNECTED'); return; }
  if (bought() >= +($('ptMaxTrades').value || 100)) { patchRow(row.id, { status: 'SKIP COHORT COMPLETE' }); recordBlocked(s, 'COHORT COMPLETE'); engine.pause(); return; }
  const cd = +($('ptCooldown').value || 0);
  if (s.epoch < cooldownUntil) { patchRow(row.id, { status: 'SKIP COOLDOWN' }); recordBlocked(s, 'COOLDOWN'); return; }
  if (state.pendingTrade || state.openContracts > 0) { patchRow(row.id, { status: 'SKIP OPEN' }); recordBlocked(s, 'OPEN CONTRACT'); return; }
  try {
    traderConfig();
    engine.config.duration = s.duration;
    engine.config.durationUnit = 't';
    lastSignalEpoch = s.epoch;
    cooldownUntil = s.epoch + cd;
    patchRow(row.id, { status: 'ORDER SENT' });
    engine.execute({
      direction: s.direction,
      structure: `master-v6.8-direction-lock-${s.duration}t`,
      epoch: s.epoch, quote: s.quote, detectedPerf: nowPerf(), detectedWallMs: Date.now(),
      patternMeta: { ...s, ledgerId: row.id, expectedWindow: row.expectedWindow }
    });
    engine.log('success', `MASTER v6.8 LOCKED ${s.session} ${s.direction} · FIRST TURN ${(s.fibEntryRetrace * 100).toFixed(1)}% · ${s.duration}t · 80 ${s.slope80.toFixed(3)} · 200 ${s.slope200.toFixed(3)}`);
  } catch (e) {
    patchRow(row.id, { status: 'ERROR', error: e.message });
    recordBlocked(s, `ERROR ${e.message}`);
    showError(e.message);
    engine.pause();
  }
}

function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function renderState(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d ? `${d.active80}${d.active80 === 'NEUTRAL' && d.fast !== 'NEUTRAL' ? ' · FAST ' + d.fast : ''}` : '—');
  set('mtSession', d?.session && d.session !== 'NEUTRAL' ? `${d.session} · ${d.phase}` : 'NEUTRAL');
  if (!d?.wave) set('mtEntry20', 'SEARCH');
  else if (d.phase === 'INVALID') set('mtEntry20', 'INVALID');
  else if (d.phase === 'DIR_BLOCK') set('mtEntry20', 'BLOCK DIR');
  else if (d.ready) set('mtEntry20', `FIRE ${d.duration}T ${(d.wave.currentRetrace * 100).toFixed(0)}%`);
  else if (d.phase === 'ARMED') set('mtEntry20', `ARMED ${d.duration}T ${(d.wave.currentRetrace * 100).toFixed(0)}%`);
  else set('mtEntry20', 'WAIT');
  set('mtChop', d ? `${d.chop ? 'VETO' : 'CLEAR'} · ${(d.chopScore * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');
  if (!d || !d.ready) {
    const retrace = d?.wave ? ` · NOW ${(d.wave.currentRetrace * 100).toFixed(1)}%` : '';
    $('ptSignal').innerHTML = `<b>WAIT · ${esc(d?.phase || 'SEARCHING')}</b><span>${esc(d?.reason || 'Scanning')}${retrace}</span>`;
  } else {
    $('ptSignal').innerHTML = `<b class="${d.session === 'BULL' ? 'positive' : 'negative'}">LOCKED ${d.session === 'BULL' ? 'CALL' : 'PUT'} · ${d.duration}T</b><span>SIGNAL NOW ${(d.wave.currentRetrace * 100).toFixed(1)}% · FIRST TURN · expected entry T+${offsetEstimate()}</span>`;
  }
}
function renderLedger() {
  const s = cohort();
  $('ptQualified').textContent = String(ledger.length);
  $('ptSkipped').textContent = String(ledger.filter(r => String(r.status).startsWith('SKIP')).length);
  $('ptBought').textContent = String(bought());
  $('ptEntryOffset').textContent = `T+${offsetEstimate()}`;
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = `${s.d3W} / ${s.d3L} · ${s.d3Pnl >= 0 ? '+' : ''}$${s.d3Pnl.toFixed(2)}`;
  $('ptBearWL').textContent = `${s.d5W} / ${s.d5L} · ${s.d5Pnl >= 0 ? '+' : ''}$${s.d5Pnl.toFixed(2)}`;
  $('ptLedgerRows').innerHTML = ledger.length ? ledger.slice(0, 100).map(r => {
    const tm = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const window = r.actualWindow ? `${r.expectedWindow} → ${r.actualWindow}` : r.expectedWindow;
    const entry = `${r.duration || '—'}T · ${r.triggerKind || '—'} · Q${r.quality ?? '—'} · ${(Number(r.fibEntryRetrace || 0) * 100).toFixed(0)}%`;
    return `<tr><td>${tm}</td><td>${esc(`${r.session || '—'} · ${r.phase || '—'}`)}</td><td>${r.direction || '—'}</td><td>${esc(entry)}</td><td>${Number.isFinite(+r.slope200) ? (+r.slope200).toFixed(3) : '—'}</td><td>${Number.isFinite(+r.slope80) ? (+r.slope80).toFixed(3) : '—'}</td><td>${Number.isFinite(+r.chopScore) ? (+r.chopScore * 100).toFixed(0) + '%' : '—'}</td><td>${r.volatility || '—'}</td><td>${window || '—'}</td><td>${r.latencyClass || '—'}</td><td>${r.status || '—'}${Number.isFinite(+r.mfe) ? ` · MFE ${(+r.mfe).toFixed(1)} / MAE ${(+r.mae).toFixed(1)}` : ''}</td><td>${r.contractId ? '#' + r.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.8 direction-lock setups yet.</td></tr>';
}
function exportCsv() {
  const headers = ['cohort','duration','observed_at','symbol','signal_epoch','signal_quote','session','phase','direction','wave_key','fib_entry_retrace','quality','trigger_kind','trigger_strength','regime_200','active_80','fast','slope_200','slope_80','efficiency_80','direction_lock_reason','chop_score','volatility','target_price','invalidation_price','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot','mfe','mae','target_touched','path_ticks','path_high','path_low'];
  const rows = ledger.map(r => [r.cohort,r.duration,new Date(r.observedAt).toISOString(),r.symbol,r.signalEpoch ?? r.epoch,r.signalQuote ?? r.quote,r.session,r.phase,r.direction,r.waveKey,r.fibEntryRetrace,r.quality,r.triggerKind,r.triggerStrength,r.regime200,r.active80,r.fast,r.slope200,r.slope80,r.efficiency80,r.directionLockReason,r.chopScore,r.volatility,r.targetPrice,r.invalidationPrice,r.expectedWindow,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'',r.mfe??'',r.mae??'',r.targetTouched??'',r.pathTicks??'',r.pathHigh??'',r.pathLow??'']);
  const csv = [headers, ...rows].map(a => a.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' })), a = document.createElement('a');
  a.href = url;
  a.download = `master-v6.8-direction-duration-${new Date().toISOString().replaceAll(':','-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function scale(ctx, canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1), rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width || canvas.width), h = Math.max(180, rect.height || canvas.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function drawMarker(ctx, v, x, y) {
  if (v.state === 'ARMED') {
    ctx.strokeStyle = '#f3c567'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(x,y-5); ctx.lineTo(x+5,y); ctx.lineTo(x,y+5); ctx.lineTo(x-5,y); ctx.closePath(); ctx.stroke();
  } else if (v.state === 'MISSED' || v.state === 'INVALID') {
    ctx.strokeStyle = v.state === 'INVALID' ? '#ff7474' : 'rgba(200,206,216,.75)'; ctx.lineWidth = 1.7;
    ctx.beginPath(); ctx.moveTo(x-4,y-4); ctx.lineTo(x+4,y+4); ctx.moveTo(x+4,y-4); ctx.lineTo(x-4,y+4); ctx.stroke();
  } else if (v.state === 'BLOCKED') {
    ctx.strokeStyle = '#ff9c6e'; ctx.lineWidth = 1.5; ctx.strokeRect(x-4,y-4,8,8);
  } else if (v.state === 'SIGNAL') {
    ctx.fillStyle = v.direction === 'BULL' ? '#67d99a' : '#ff7474';
    ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill();
    ctx.font = '10px system-ui'; ctx.fillText(`S${v.duration || '?'}`, x + 6, y - 6);
  }
}
function draw() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const rows = ticks().slice(-220), ctx = canvas.getContext('2d'), { w, h } = scale(ctx, canvas);
  ctx.clearRect(0, 0, w, h);
  const d = lastDiagnostics, session = d?.session || 'NEUTRAL';
  ctx.fillStyle = session === 'BULL' ? 'rgba(61,191,126,.05)' : session === 'BEAR' ? 'rgba(235,87,87,.05)' : 'rgba(146,153,168,.025)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  for (let x = 0; x <= w; x += w / 8) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y = 0; y <= h; y += h / 5) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  if (rows.length < 2) return;
  const prices = rows.map(x => x.quote), min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const xFor = epoch => 12 + (epoch - rows[0].epoch) / Math.max(1, rows.at(-1).epoch - rows[0].epoch) * (w - 24);
  const yFor = price => h - 18 - (price - min) / span * (h - 36);
  ctx.strokeStyle = 'rgba(215,220,229,.72)'; ctx.lineWidth = 1.5; ctx.beginPath();
  rows.forEach((t,i) => { const x = 12 + i / (rows.length - 1) * (w - 24), y = yFor(t.quote); i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();

  const nowRetrace = d?.wave ? d.wave.currentRetrace * 100 : null;
  ctx.fillStyle = 'rgba(245,247,250,.88)'; ctx.font = '12px system-ui';
  ctx.fillText(`200 ${d?.regime200 || '—'}   80 ${d?.active80 || '—'} ${Number.isFinite(d?.m80?.slopeNorm) ? '('+d.m80.slopeNorm.toFixed(3)+')' : ''}   FAST ${d?.fast || '—'}   ${session}   ${d?.duration || '—'}T   ${d?.phase || '—'}   ${Number.isFinite(nowRetrace) ? 'NOW '+nowRetrace.toFixed(1)+'%' : ''}`, 16, 22);

  if (d?.wave && d?.waveRows) {
    const se = d.waveRows[d.wave.start.i]?.epoch, ee = d.waveRows[d.wave.end.i]?.epoch;
    if (Number.isFinite(se) && Number.isFinite(ee)) {
      const sx = xFor(se), ex = xFor(ee), sy = yFor(d.wave.start.quote), ey = yFor(d.wave.end.quote);
      ctx.strokeStyle = 'rgba(230,195,92,.82)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.fillStyle = '#e6c35c';
      for (const [x,y] of [[sx,sy],[ex,ey]]) { ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); }
      const fireTop = yFor(fibPrice(d.wave, FIRE_MIN)), fireBottom = yFor(fibPrice(d.wave, FIRE_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.15)'; ctx.fillRect(ex, Math.min(fireTop, fireBottom), Math.max(0, w - 12 - ex), Math.abs(fireBottom - fireTop));
      const coreTop = yFor(fibPrice(d.wave, CORE_MIN)), coreBottom = yFor(fibPrice(d.wave, CORE_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.10)'; ctx.fillRect(ex, Math.min(coreTop, coreBottom), Math.max(0, w - 12 - ex), Math.abs(coreBottom - coreTop));
      for (const [ratio,label] of [[FIRE_MIN,'FIRE 32'],[.382,'38.2'],[.5,'50'],[.618,'61.8'],[FIRE_MAX,'FIRE 68'],[.786,'78.6 INVALID']]) {
        const y = yFor(fibPrice(d.wave, ratio));
        ctx.strokeStyle = ratio === .786 ? 'rgba(255,116,116,.72)' : (ratio === FIRE_MIN || ratio === FIRE_MAX) ? 'rgba(255,215,105,.95)' : 'rgba(230,195,92,.38)';
        ctx.lineWidth = ratio === FIRE_MIN || ratio === FIRE_MAX ? 1.4 : .8;
        ctx.setLineDash(ratio === .786 ? [4,4] : []); ctx.beginPath(); ctx.moveTo(ex,y); ctx.lineTo(w - 12,y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = ratio === .786 ? '#ff7474' : '#f3c567'; ctx.font = '10px system-ui'; ctx.fillText(label + (label.includes('FIRE') || label.includes('INVALID') ? '' : '%'), w - 82, y - 3);
      }
    }
  }

  const visibleStart = rows[0].epoch, visibleEnd = rows.at(-1).epoch;
  for (const v of visualHistory.filter(v => +v.epoch >= visibleStart && +v.epoch <= visibleEnd)) drawMarker(ctx, v, xFor(+v.epoch), yFor(+v.quote));

  const recent = rows.slice(-20), pp = pivots(recent.map(x => x.quote), 2);
  const labelPivots = (arr, type) => {
    let previous;
    for (const q of arr.slice(-3)) {
      const text = previous === undefined ? type : type === 'H' ? (q.quote > previous ? 'HH' : 'LH') : (q.quote > previous ? 'HL' : 'LL');
      previous = q.quote;
      const t = recent[q.i];
      if (t) { ctx.fillStyle = 'rgba(245,247,250,.88)'; ctx.font = '11px system-ui'; ctx.fillText(text, xFor(t.epoch)+4, yFor(t.quote)+(type === 'H' ? -7 : 14)); }
    }
  };
  labelPivots(pp.highs, 'H'); labelPivots(pp.lows, 'L');

  for (const r of ledger.filter(r => Number.isFinite(+r.contractId) && Number(r.entryTickTime ?? r.epoch) >= visibleStart && Number(r.entryTickTime ?? r.epoch) <= visibleEnd)) {
    const sx = xFor(Number(r.signalEpoch ?? r.epoch)), sy = yFor(Number(r.signalQuote ?? r.quote));
    ctx.fillStyle = r.direction === 'CALL' ? '#67d99a' : '#ff7474'; ctx.font = '10px system-ui'; ctx.fillText(`S${r.duration || '?'}`, sx + 5, sy - 7);
    const ep = Number(r.entryTickTime ?? r.epoch), price = Number(r.entrySpot ?? r.quote), x = xFor(ep), y = yFor(price), call = r.direction === 'CALL';
    ctx.fillStyle = call ? '#67d99a' : '#ff7474'; ctx.beginPath();
    if (call) { ctx.moveTo(x,y-10); ctx.lineTo(x-6,y+5); ctx.lineTo(x+6,y+5); }
    else { ctx.moveTo(x,y+10); ctx.lineTo(x-6,y-5); ctx.lineTo(x+6,y-5); }
    ctx.closePath(); ctx.fill(); ctx.font = '10px system-ui'; ctx.fillText('E', x + 7, y - 7);
    const ee = +r.exitTickTime, xp = +r.exitSpot;
    if (Number.isFinite(ee) && Number.isFinite(xp) && ee >= visibleStart && ee <= visibleEnd) {
      const ex = xFor(ee), ey = yFor(xp);
      ctx.strokeStyle = r.status === 'WON' ? '#67d99a' : '#ff7474'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex,ey,5,0,Math.PI*2); ctx.stroke(); ctx.fillStyle = r.status === 'WON' ? '#67d99a' : '#ff7474';
      ctx.fillText(`X${r.duration || '?'} ${Number(r.profit || 0) >= 0 ? '+' : ''}${Number(r.profit || 0).toFixed(2)}`, ex + 7, ey - 7);
    }
  }
  $('masterCanvasCaption').textContent = `${session} · ${d?.dirLock?.ok ? 'DIR LOCKED' : 'DIR BLOCK'} · ${d?.duration || '—'}T · ${d?.phase || 'SEARCHING'} · S=signal · E=Deriv entry · X=expiry · square=blocked · ${rows.length} ticks`;
}

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onMasterBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : null;
  baseBuy(message);
  const id = Number(message?.buy?.contract_id), trade = this.trades.find(x => Number(x.contractId) === id);
  if (!trade || !meta) return;
  trade.patternMeta = meta; trade.ledgerId = meta.ledgerId; trade.expectedWindow = meta.expectedWindow;
  contractToLedger.set(id, meta.ledgerId);
  patchRow(meta.ledgerId, { status:'BOUGHT', contractId:id, buyAckMs:trade.sendToAckMs, duration: trade.duration });
  this.emit();
};
const baseContract = engine.onContract.bind(engine);
engine.onContract = function onMasterContract(contract) {
  const id = Number(contract?.contract_id);
  baseContract(contract);
  const trade = this.trades.find(x => Number(x.contractId) === id);
  if (!trade?.patternMeta || !(contract?.is_sold || contract?.is_expired)) return;
  const o = actualOffset(trade);
  if (!trade.offsetRecorded && Number.isFinite(o)) { trade.offsetRecorded = true; recordOffset(o); }
  const dur = Number(trade.duration || trade.patternMeta.duration || 3);
  trade.actualWindow = Number.isFinite(o) ? `T+${o}→T+${o + dur}` : 'unknown';
  trade.latencyClass = latency(o);
  const path = pathStats(trade.patternMeta, trade);
  patchRow(trade.ledgerId || contractToLedger.get(id), {
    status: String(trade.status || 'sold').toUpperCase(), profit: trade.profit,
    actualWindow: trade.actualWindow, latencyClass: trade.latencyClass,
    entrySpot: trade.entrySpot, exitSpot: trade.exitSpot,
    entryTickTime: trade.entryTickTime, exitTickTime: trade.exitTickTime,
    duration: dur, ...path
  });
  draw(); this.emit();
};

$('ptLoadAccounts').onclick = async () => {
  clearError();
  try {
    const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim();
    if (!appId || !token) throw new Error('App ID and trade token are required.');
    $('ptLoadAccounts').disabled = true;
    const data = await api('accounts', { appId, token });
    accounts = data.accounts || [];
    localStorage.setItem('sani.deriv.appId', appId); sessionStorage.setItem('sani.deriv.token', token); renderAccounts();
  } catch (e) { showError(e.message); }
  finally { $('ptLoadAccounts').disabled = false; }
};
$('ptAccount').onchange = () => { localStorage.setItem('sani.deriv.accountId', $('ptAccount').value); lastOtpContext = null; renderGate(); };
$('ptConnect').onclick = async () => {
  clearError();
  try { traderConfig(); lastOtpContext = auth(); $('ptConnect').disabled = true; await engine.connect(freshWs); }
  catch (e) { showError(e.message); }
  finally { renderGate(); }
};
$('ptDisconnect').onclick = () => { engine.disconnect(); lastOtpContext = null; };
$('ptStart').onclick = () => {
  clearError();
  try {
    auth(); traderConfig();
    if (bought() >= +($('ptMaxTrades').value || 100)) throw new Error('v6.8 cohort cap reached.');
    engine.start();
    engine.log('info', 'Master v6.8 armed: first-turn entry + hard direction coherence + deterministic 3t/5t duration split.');
  } catch (e) { showError(e.message); }
};
$('ptPause').onclick = () => engine.pause();
$('ptStop').onclick = () => engine.stop();
$('ptReset').onclick = () => { try { engine.resetSession(); lastSignalEpoch = 0; cooldownUntil = 0; } catch (e) { showError(e.message); } };
$('ptClearLedger').onclick = () => {
  if (confirm('Clear fresh v6.8 direction/duration cohort and visual trail?')) {
    ledger = []; visualHistory = []; waveMemory.clear();
    localStorage.removeItem(LEDGER_KEY); localStorage.removeItem(VISUAL_KEY);
    strategy.session = 'NEUTRAL'; strategy.neutralTicks = 0; renderLedger(); draw();
  }
};
$('ptResetCalibration').onclick = () => { if (confirm('Reset execution calibration?')) { localStorage.removeItem(OFFSET_KEY); renderLedger(); } };
$('ptExportLedger').onclick = exportCsv;
for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) {
  $(id).addEventListener('change', () => { try { if (!engine.snapshot().running) traderConfig(); } catch (e) { showError(e.message); } });
}
window.addEventListener('sani-observatory-analysis', e => maybeTrade(e.detail));
window.addEventListener('resize', draw);

engine.subscribe(state => {
  $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.status === 'reconnecting' ? 'RECONNECTING' : state.connected ? (state.running ? 'TRADING' : 'CONNECTED') : 'DISCONNECTED';
  $('ptPnl').textContent = `${Number(state.sessionPnL || 0) >= 0 ? '+' : ''}$${Number(state.sessionPnL || 0).toFixed(2)}`;
  $('ptPnl').className = Number(state.sessionPnL || 0) >= 0 ? 'positive' : 'negative';
  $('ptWL').textContent = `${state.wins || 0} / ${state.losses || 0}`;
  $('ptOpen').textContent = Number(state.openContracts || 0) + (state.pendingTrade ? 1 : 0);
  $('ptStart').disabled = !state.connected || state.running || state.safeBlocked || !state.portfolioChecked;
  $('ptPause').disabled = !state.running;
  $('ptStop').disabled = !state.connected;
  $('ptReset').disabled = state.running || Number(state.openContracts || 0) > 0;
  $('ptTradeRows').innerHTML = state.trades.length ? state.trades.map(t => {
    const m = t.patternMeta || {}, expected = t.expectedWindow || m.expectedWindow || '—', actual = t.actualWindow || '—';
    const row = ledger.find(r => Number(r.contractId) === Number(t.contractId));
    return `<tr><td>#${t.contractId}</td><td>${esc(`${m.session || '—'} · DIR LOCK`)}</td><td>${t.direction}</td><td>${esc(`${t.duration || m.duration || '—'}T · ${m.triggerKind || '—'} · ${(Number(m.fibEntryRetrace || 0) * 100).toFixed(0)}% · Q${m.quality ?? '—'}`)}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${expected}</td><td>${actual}</td><td>${t.latencyClass || '—'}</td><td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0) + 'ms'}</td><td>S ${m.signalQuote ?? m.quote ?? '—'} → E ${t.entrySpot ?? '—'} → X ${t.exitSpot ?? '—'}${row && Number.isFinite(+row.mfe) ? ` · MFE ${(+row.mfe).toFixed(1)}/MAE ${(+row.mae).toFixed(1)}` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.8 trades yet.</td></tr>';
  if (state.logs?.[0]) $('ptLogs').innerHTML = state.logs.slice(0, 70).map(l => `<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${esc(l.message === 'Engine armed. Waiting for fresh BOS.' ? 'Master v6.8 execution engine armed.' : l.message)}</span></div>`).join('');
  renderLedger(); draw();
});

window.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.8'));
  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader v6'));
  if (title) title.textContent = 'Master Trader v6.8 · Direction-Lock + Duration Lab';
  const rules = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Frozen v6'));
  if (rules) rules.textContent = 'Frozen v6.8 direction-lock / 3t–5t rules';
  if ($('ptStart')) $('ptStart').textContent = 'Start Master Trader v6.8';
  if ($('ptCooldown')) $('ptCooldown').value = '0';
  const labels = [...document.querySelectorAll('.label, .statLabel, .metricLabel, small')];
  const bullLabel = labels.find(x => x.textContent.trim() === 'BULL W/L' || x.textContent.includes('A FIRST-TURN'));
  if (bullLabel) bullLabel.textContent = '3T W/L · P/L';
  const bearLabel = labels.find(x => x.textContent.trim() === 'BEAR W/L' || x.textContent.includes('B PRE-TURN'));
  if (bearLabel) bearLabel.textContent = '5T W/L · P/L';
  const fixedText = [...document.querySelectorAll('.muted')].find(x => x.textContent.includes('v6.7') || x.textContent.includes('v6.6:') || x.textContent.includes('Fixed internals:'));
  if (fixedText) fixedText.textContent = 'v6.8: first-turn entry only. Hard direction lock blocks CALL when 80-tick slope materially points down and PUT when it materially points up; strong 200-tick conflict also vetoes. Qualified waves are deterministically split 3t vs 5t so duration becomes the controlled exit test. Same Demo stake, zero default cooldown, one-open lock.';
  const stateTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('v6') && x.textContent.includes('state machine'));
  if (stateTitle) stateTitle.textContent = 'v6.8 direction-lock / duration state machine';
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger(); draw();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snap = window.SaniObservatory?.getSnapshot?.();
  if (snap) { lastDiagnostics = evaluate(snap); renderState(lastDiagnostics); draw(); }
});
