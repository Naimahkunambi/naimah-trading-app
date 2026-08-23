import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const VERSION = 'v6.11';
const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.11';
const VISUAL_KEY = 'sani.masterTrader.visualSetups.v6.11';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';

const LONG = 200;
const AUTH = 80;
const FAST = 20;
const SHALLOW_MIN = 0.08;
const PULLBACK_MIN = 0.32;
const PULLBACK_MAX = 0.68;
const CORE_MIN = 0.382;
const CORE_MAX = 0.618;
const HARD_DAMAGE = 0.786;
const SLOPE80_TOL = 0.025;
const MACRO_CONFLICT = 0.11;

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
  duration: 5,
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
  } catch {
    return [];
  }
}

function saveLedger() {
  ledger = ledger.slice(0, 5000);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {}
}

function saveVisuals() {
  visualHistory = visualHistory.slice(0, 2200);
  try { localStorage.setItem(VISUAL_KEY, JSON.stringify(visualHistory)); } catch {}
}

function symbol() {
  return $('obsSymbol')?.value?.trim() || '1HZ25V';
}

function ticks() {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol()}`) || '[]');
    return Array.isArray(rows)
      ? rows.map(x => ({ epoch: +x.epoch, quote: +x.quote }))
        .filter(x => Number.isFinite(x.epoch) && Number.isFinite(x.quote))
        .sort((a, b) => a.epoch - b.epoch)
      : [];
  } catch {
    return [];
  }
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }

function avgStep(p) {
  if (p.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < p.length; i += 1) total += Math.abs(p[i] - p[i - 1]);
  return total / (p.length - 1);
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
    const delta = p[i] - p[i - 1];
    if (delta) signs.push(Math.sign(delta));
  }
  if (signs.length < 2) return 0;
  let turns = 0;
  for (let i = 1; i < signs.length; i += 1) if (signs[i] !== signs[i - 1]) turns += 1;
  return turns / (signs.length - 1);
}

function linearSlope(p) {
  const n = p.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(p);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xm;
    num += dx * (p[i] - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}

function pivots(p, radius = 2) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < p.length - radius; i += 1) {
    const left = p.slice(i - radius, i);
    const right = p.slice(i + 1, i + radius + 1);
    const high = left.every(v => p[i] >= v) && right.every(v => p[i] >= v) && [...left, ...right].some(v => p[i] > v);
    const low = left.every(v => p[i] <= v) && right.every(v => p[i] <= v) && [...left, ...right].some(v => p[i] < v);
    if (high) highs.push({ i, quote: p[i] });
    if (low) lows.push({ i, quote: p[i] });
  }
  return { highs, lows };
}

function structure(p, radius = 3) {
  const x = pivots(p, radius);
  const highs = x.highs.slice(-2);
  const lows = x.lows.slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'MIXED';
  if (highs[1].quote > highs[0].quote && lows[1].quote > lows[0].quote) return 'BULL';
  if (highs[1].quote < highs[0].quote && lows[1].quote < lows[0].quote) return 'BEAR';
  return 'MIXED';
}

function metrics(rows, radius = 3) {
  const p = rows.map(x => x.quote);
  const step = avgStep(p);
  const slope = linearSlope(p);
  return {
    slopeNorm: step ? slope / step : 0,
    efficiency: efficiency(p),
    turnRate: turnRate(p),
    avgStep: step,
    net: p.at(-1) - p[0],
    structure: structure(p, radius)
  };
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
  if (Math.abs(m.slopeNorm) < .05 || m.efficiency < .05) return 'NEUTRAL';
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
  return { score, isChop: score >= .80 };
}

function volatility(m200, m80, m20) {
  const shortVsMid = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const midVsLong = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (shortVsMid < .32 || midVsLong < .42) return 'DEAD';
  if (shortVsMid > 2.55 || m20.turnRate > .94) return 'CHAOTIC';
  return 'HEALTHY';
}

function updateSession(active80, fast, isChop, volState) {
  if (isChop || volState !== 'HEALTHY') {
    strategy.neutralTicks += 1;
    if (strategy.neutralTicks >= 3) strategy.session = 'NEUTRAL';
    return;
  }
  const authority = active80 !== 'NEUTRAL' ? active80 : fast;
  if (authority === 'NEUTRAL') {
    strategy.neutralTicks += 1;
    if (strategy.neutralTicks >= 3) strategy.session = 'NEUTRAL';
    return;
  }
  strategy.neutralTicks = 0;
  if (strategy.session !== authority) {
    strategy.session = authority;
    strategy.sessionId += 1;
  }
}

function internalPullback(segment, direction, step) {
  if (segment.length < 4) return { distance: 0, ratio: 0, steps: 0 };
  let maxCounter = 0;
  if (direction === 'BULL') {
    let runningHigh = segment[0];
    for (const value of segment.slice(1)) {
      runningHigh = Math.max(runningHigh, value);
      maxCounter = Math.max(maxCounter, runningHigh - value);
    }
  } else {
    let runningLow = segment[0];
    for (const value of segment.slice(1)) {
      runningLow = Math.min(runningLow, value);
      maxCounter = Math.max(maxCounter, value - runningLow);
    }
  }
  const range = Math.abs(segment.at(-1) - segment[0]) || 1;
  return { distance: maxCounter, ratio: maxCounter / range, steps: step ? maxCounter / step : 0 };
}

function waveFrom(rows, direction, start, end, step) {
  const p = rows.map(x => x.quote);
  const range = direction === 'BULL' ? end.quote - start.quote : start.quote - end.quote;
  if (!(range > 0)) return null;
  const after = p.slice(end.i + 1);
  const current = p.at(-1);
  const retraces = after.map(v => direction === 'BULL' ? (end.quote - v) / range : (v - end.quote) / range);
  const internal = internalPullback(p.slice(start.i, end.i + 1), direction, step);
  return {
    direction, start, end, step, range, retraces,
    maxRetrace: retraces.length ? Math.max(...retraces) : 0,
    currentRetrace: direction === 'BULL' ? (end.quote - current) / range : (current - end.quote) / range,
    endAge: p.length - 1 - end.i,
    internalPullbackRatio: internal.ratio,
    internalPullbackSteps: internal.steps
  };
}

function scanWaveCandidates(rows, direction) {
  const p = rows.map(x => x.quote);
  const step = avgStep(p) || 1;
  const x = pivots(p, 2);
  const starts = direction === 'BULL' ? x.lows : x.highs;
  const valid = [];
  let retired = 0;
  for (const start of starts) {
    const future = p.slice(start.i + 1);
    if (future.length < 3) continue;
    const endQuote = direction === 'BULL' ? Math.max(...future) : Math.min(...future);
    const endIndexInFuture = future.indexOf(endQuote);
    const end = { i: start.i + 1 + endIndexInFuture, quote: endQuote };
    const impulse = direction === 'BULL' ? end.quote - start.quote : start.quote - end.quote;
    if (end.i - start.i < 3 || impulse < step * 2.05) continue;
    const wave = waveFrom(rows, direction, start, end, step);
    if (!wave) continue;
    const damaged = wave.currentRetrace > HARD_DAMAGE || wave.maxRetrace > HARD_DAMAGE;
    if (damaged) { retired += 1; continue; }
    if (wave.endAge > 30) continue;
    valid.push(wave);
  }
  valid.sort((a, b) => a.endAge - b.endAge || b.end.i - a.end.i || (b.range / b.step) - (a.range / a.step));
  return { valid, retired };
}

function findFreshWave(all, direction) {
  if (direction !== 'BULL' && direction !== 'BEAR') return { rows: [], wave: null, retired: 0 };
  const seen = new Set();
  const candidates = [];
  let retired = 0;
  for (const width of [80, 68, 56, 44, 34, 26, 20, 16]) {
    if (all.length < width) continue;
    const rows = all.slice(-width);
    const scan = scanWaveCandidates(rows, direction);
    retired += scan.retired;
    for (const wave of scan.valid) {
      const startEpoch = rows[wave.start.i]?.epoch;
      const endEpoch = rows[wave.end.i]?.epoch;
      if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) continue;
      const id = `${startEpoch}:${endEpoch}`;
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ rows, wave, startEpoch, endEpoch, endAge: all.at(-1).epoch - endEpoch });
    }
  }
  candidates.sort((a, b) => a.endAge - b.endAge || b.endEpoch - a.endEpoch || (b.wave.range / b.wave.step) - (a.wave.range / a.wave.step));
  const best = candidates[0];
  return best ? { rows: best.rows, wave: best.wave, retired } : { rows: [], wave: null, retired };
}

function fibPrice(wave, ratio) {
  return wave.direction === 'BULL' ? wave.end.quote - wave.range * ratio : wave.end.quote + wave.range * ratio;
}

function waveKey(wave, rows) {
  if (!wave) return '';
  const startEpoch = rows[wave.start.i]?.epoch;
  const endEpoch = rows[wave.end.i]?.epoch;
  return `${strategy.sessionId}:${wave.direction}:${startEpoch}:${endEpoch}`;
}

function alreadyTraded(key) {
  return ledger.some(row => row.waveKey === key && Number.isFinite(+row.contractId));
}

function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function durationFor(key) { return hashKey(key) % 2 === 0 ? 5 : 8; }

function microResumption(rows, direction, step) {
  const p = rows.map(x => x.quote);
  const n = p.length;
  const unit = step || avgStep(p) || 1;
  if (n < 9 || (direction !== 'BULL' && direction !== 'BEAR')) {
    return { ok: false, firstBreak: false, kind: 'SEARCH', level: NaN, strength: 0, structureSize: 0, holdTicks: 0 };
  }
  const current = p[n - 1];
  const previous = p[n - 2];
  const shelf = p.slice(n - 7, n - 2);
  const context = p.slice(n - 10, n - 1);
  const buffer = unit * .015;
  if (direction === 'BULL') {
    const level = Math.max(...shelf);
    const low = Math.min(...context);
    const structureSize = (level - low) / unit;
    const brokePrevious = previous > level + buffer;
    const firstBreak = !brokePrevious && current > level + buffer;
    const held = current > level - buffer;
    const notDumping = current >= previous - unit * .42;
    const ok = brokePrevious && held && notDumping && structureSize >= .30;
    return { ok, firstBreak, kind: ok ? 'BREAK_HOLD_UP' : firstBreak ? 'FIRST_BREAK_UP' : brokePrevious ? 'BREAK_WAIT_HOLD' : 'WAIT_MICRO_HIGH', level, extreme: low, strength: Math.max(0, current - level) / unit, structureSize, holdTicks: ok ? 2 : (firstBreak || brokePrevious) ? 1 : 0 };
  }
  const level = Math.min(...shelf);
  const high = Math.max(...context);
  const structureSize = (high - level) / unit;
  const brokePrevious = previous < level - buffer;
  const firstBreak = !brokePrevious && current < level - buffer;
  const held = current < level + buffer;
  const notRipping = current <= previous + unit * .42;
  const ok = brokePrevious && held && notRipping && structureSize >= .30;
  return { ok, firstBreak, kind: ok ? 'BREAK_HOLD_DOWN' : firstBreak ? 'FIRST_BREAK_DOWN' : brokePrevious ? 'BREAK_WAIT_HOLD' : 'WAIT_MICRO_LOW', level, extreme: high, strength: Math.max(0, level - current) / unit, structureSize, holdTicks: ok ? 2 : (firstBreak || brokePrevious) ? 1 : 0 };
}

function directionLock(session, regime200, active80, fast, m200, m80) {
  if (session !== 'BULL' && session !== 'BEAR') return { ok: false, reason: 'No active direction' };
  const bull = session === 'BULL';
  const slope80Ok = bull ? m80.slopeNorm >= -SLOPE80_TOL : m80.slopeNorm <= SLOPE80_TOL;
  const macroConflict = bull ? regime200 === 'BEAR' || m200.slopeNorm <= -MACRO_CONFLICT : regime200 === 'BULL' || m200.slopeNorm >= MACRO_CONFLICT;
  const activeConflict = bull ? active80 === 'BEAR' : active80 === 'BULL';
  const liveAuthority = active80 === session || (active80 === 'NEUTRAL' && fast === session);
  if (!slope80Ok) return { ok: false, reason: `80 slope ${m80.slopeNorm.toFixed(3)} opposes ${session}` };
  if (activeConflict) return { ok: false, reason: `80 trend is ${active80}` };
  if (macroConflict) return { ok: false, reason: `200 macro conflict · ${m200.slopeNorm.toFixed(3)} · ${regime200}` };
  if (!liveAuthority) return { ok: false, reason: `No live authority · 80 ${active80} · FAST ${fast}` };
  return { ok: true, reason: `LOCKED ${session}` };
}

function chooseEntryLane({ wave, trigger, session, fast, m20, dirLock }) {
  if (!wave || !dirLock.ok) return { mode: 'NONE', ready: false, reason: 'No valid wave/direction' };
  const r = wave.currentRetrace;
  if (r >= PULLBACK_MIN && r <= PULLBACK_MAX && trigger.ok) return { mode: 'PULLBACK_HOLD', ready: true, reason: '32–68% pullback + break hold' };
  if (r >= SHALLOW_MIN && r < PULLBACK_MIN && trigger.ok) return { mode: 'SHALLOW_RESUME', ready: true, reason: '8–32% shallow retrace + break hold' };
  const nearExtreme = r >= -0.04 && r < SHALLOW_MIN;
  const hadInternalPause = wave.internalPullbackSteps >= .60;
  const notMessy = wave.internalPullbackRatio <= .38;
  const liveFast = fast === session;
  const microDirectional = trigger.firstBreak || trigger.ok;
  const momentum = nearExtreme && hadInternalPause && notMessy && liveFast && microDirectional && m20.efficiency >= .055;
  if (momentum) return { mode: 'MOMENTUM_REBREAK', ready: true, reason: 'fresh extreme after internal pause + micro re-break' };
  return { mode: 'NONE', ready: false, reason: 'Waiting for shallow/deep retrace or momentum re-break' };
}

function quality(d) {
  if (!d.wave) return 0;
  let q = 0;
  const r = d.wave.currentRetrace;
  if (d.entryMode === 'PULLBACK_HOLD') q += r >= CORE_MIN && r <= CORE_MAX ? 28 : 22;
  else if (d.entryMode === 'SHALLOW_RESUME') q += 20;
  else if (d.entryMode === 'MOMENTUM_REBREAK') q += 18;
  else if (r >= SHALLOW_MIN && r <= PULLBACK_MAX) q += 8;
  q += d.m80.efficiency >= .16 ? 14 : d.m80.efficiency >= .09 ? 9 : 4;
  q += Math.abs(d.m80.slopeNorm) >= .18 ? 12 : Math.abs(d.m80.slopeNorm) >= .10 ? 8 : 4;
  q += d.fast === d.session ? 11 : 3;
  q += d.trigger.ok ? 20 : d.trigger.firstBreak ? 13 : d.trigger.holdTicks === 1 ? 8 : 0;
  q += d.trigger.structureSize >= 1.2 ? 8 : d.trigger.structureSize >= .6 ? 5 : 2;
  q += d.chopScore <= .18 ? 6 : d.chopScore <= .35 ? 4 : 1;
  q += d.wave.internalPullbackSteps >= 1.2 ? 6 : d.wave.internalPullbackSteps >= .6 ? 4 : 0;
  if (d.regime200 === d.session) q += 4;
  return clamp(Math.round(q), 0, 100);
}

function pushVisual(d, state, reason) {
  if (!d?.waveKey || !Number.isFinite(+d.epoch) || !Number.isFinite(+d.quote)) return;
  const unique = `${d.waveKey}:${state}:${d.entryMode || 'NONE'}`;
  if (visualHistory.some(v => v.unique === unique)) return;
  visualHistory.unshift({ unique, at: Date.now(), epoch: d.epoch, quote: d.quote, direction: d.session, state, reason, waveKey: d.waveKey, retrace: d.wave?.currentRetrace, quality: d.quality, duration: d.duration, entryMode: d.entryMode, breakLevel: d.trigger?.level });
  saveVisuals();
}

function rememberVisual(d) {
  if (!d?.wave || !d.waveKey) return;
  const memory = waveMemory.get(d.waveKey) || { shallowArmed: false, deepArmed: false, breakSeen: false, signaled: false, dirBlocked: false };
  if (d.wave.currentRetrace >= SHALLOW_MIN && d.wave.currentRetrace < PULLBACK_MIN && !memory.shallowArmed) { memory.shallowArmed = true; pushVisual(d, 'SHALLOW', '8–32% continuation zone'); }
  if (d.wave.currentRetrace >= PULLBACK_MIN && d.wave.currentRetrace <= PULLBACK_MAX && !memory.deepArmed) { memory.deepArmed = true; pushVisual(d, 'ARMED', '32–68% pullback zone'); }
  if ((d.trigger?.firstBreak || d.trigger?.holdTicks === 1) && !memory.breakSeen) { memory.breakSeen = true; pushVisual(d, 'BREAK', d.trigger.firstBreak ? 'First micro break' : 'Break awaiting hold'); }
  if ((d.trigger?.ok || d.trigger?.firstBreak) && !d.dirLock?.ok && !memory.dirBlocked) { memory.dirBlocked = true; pushVisual(d, 'BLOCKED', `DIR LOCK: ${d.dirLock.reason}`); }
  if (d.ready && !memory.signaled) { memory.signaled = true; pushVisual(d, 'SIGNAL', `${d.entryMode} · ${d.duration}t`); }
  waveMemory.set(d.waveKey, memory);
}

function evaluate(snapshot) {
  const all = ticks();
  if (all.length < LONG) return { ready: false, reason: `Need ${LONG} ticks (${all.length}/${LONG})`, phase: 'WARMING', rows: all };
  const r200 = all.slice(-LONG);
  const r80 = all.slice(-AUTH);
  const r20 = all.slice(-FAST);
  const m200 = metrics(r200, 4);
  const m80 = metrics(r80, 3);
  const m20 = metrics(r20, 2);
  const regime200 = trend200(m200);
  const active80 = trend80(m80);
  const fast = fastTrend(m20);
  const c = chop(m80, m20);
  const volState = volatility(m200, m80, m20);
  updateSession(active80, fast, c.isChop, volState);
  const session = strategy.session;
  const fresh = findFreshWave(all, session);
  const waveRows = fresh.rows;
  const wave = fresh.wave;
  const key = waveKey(wave, waveRows);
  const duration = key ? durationFor(key) : 5;
  const trigger = microResumption(r20, session, wave?.step || m20.avgStep || 1);
  const dirLock = directionLock(session, regime200, active80, fast, m200, m80);
  const lane = chooseEntryLane({ wave, trigger, session, fast, m20, dirLock });
  const permission = session !== 'NEUTRAL' && !c.isChop && volState === 'HEALTHY' && dirLock.ok;
  const duplicate = alreadyTraded(key);
  const ready = Boolean(permission && wave && lane.ready && !duplicate);
  let phase = 'SEARCHING';
  if (session !== 'NEUTRAL' && !wave) phase = fresh.retired > 0 ? 'REANCHOR' : 'BUILDING';
  else if (wave) {
    if (ready) phase = lane.mode;
    else if (wave.currentRetrace > HARD_DAMAGE) phase = 'REANCHOR';
    else if (wave.currentRetrace >= PULLBACK_MIN && wave.currentRetrace <= PULLBACK_MAX) phase = 'PULLBACK_ARMED';
    else if (wave.currentRetrace >= SHALLOW_MIN && wave.currentRetrace < PULLBACK_MIN) phase = 'SHALLOW_ARMED';
    else if (wave.currentRetrace < SHALLOW_MIN && wave.internalPullbackSteps >= .60) phase = 'MOMENTUM_WATCH';
    else if (wave.currentRetrace < SHALLOW_MIN) phase = 'EXTENDING';
    else phase = 'DEEP';
  }
  const d = { ready, rows: all, waveRows, epoch: all.at(-1).epoch, quote: all.at(-1).quote, regime200, active80, fast, session, phase, entryMode: lane.mode, laneReason: lane.reason, chop: c.isChop, chopScore: c.score, volatility: volState, m200, m80, m20, wave, trigger, dirLock, waveKey: key, duration, durationCohort: `${duration}T`, retiredWaves: fresh.retired };
  d.quality = quality(d);
  if (c.isChop) d.reason = `CHOP veto ${(c.score * 100).toFixed(0)}%`;
  else if (volState !== 'HEALTHY') d.reason = `Volatility ${volState}`;
  else if (session === 'NEUTRAL') d.reason = `No direction · 80 ${active80} · FAST ${fast}`;
  else if (!dirLock.ok) d.reason = `DIRECTION BLOCK · ${dirLock.reason}`;
  else if (!wave && fresh.retired > 0) d.reason = `Old wave retired · hunting newest ${session} impulse`;
  else if (!wave) d.reason = `Building fresh ${session} impulse`;
  else if (duplicate) d.reason = 'This fresh impulse already traded · waiting next extension/re-anchor';
  else if (ready) d.reason = `${lane.mode} READY · ${lane.reason} · ${duration}t`;
  else if (phase === 'PULLBACK_ARMED') d.reason = `Deep lane armed ${(wave.currentRetrace * 100).toFixed(1)}% · waiting break/hold`;
  else if (phase === 'SHALLOW_ARMED') d.reason = `Shallow lane armed ${(wave.currentRetrace * 100).toFixed(1)}% · waiting break/hold`;
  else if (phase === 'MOMENTUM_WATCH') d.reason = `Momentum lane watching re-break · internal pause ${wave.internalPullbackSteps.toFixed(1)} steps`;
  else if (phase === 'EXTENDING') d.reason = 'Strong extension · waiting micro pause/re-break or 8% retrace';
  else if (phase === 'DEEP') d.reason = `Retrace ${(wave.currentRetrace * 100).toFixed(1)}% beyond active lanes · re-anchor soon`;
  else d.reason = 'Scanning fresh wave';
  rememberVisual(d);
  return d;
}

function offsets() { return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50); }
function offsetEstimate() {
  const values = offsets().map(v => Math.max(1, Math.min(10, Math.round(v)))).sort((a, b) => a - b);
  if (!values.length) return 1;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : Math.round((values[middle - 1] + values[middle]) / 2);
}
function recordOffset(value) {
  if (!Number.isFinite(+value)) return;
  const values = offsets();
  values.push(Math.max(1, Math.min(10, Math.round(+value))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(values.slice(-50))); } catch {}
}
function actualOffset(trade) {
  const signal = +trade?.signalEpoch;
  const entry = +trade?.entryTickTime;
  if (Number.isFinite(signal) && Number.isFinite(entry)) return Math.max(1, Math.round(entry - signal));
  const start = +trade?.startTime;
  if (Number.isFinite(signal) && Number.isFinite(start)) return Math.max(1, Math.round(start - signal) + 1);
}
function latency(offset) { return !Number.isFinite(+offset) ? 'UNKNOWN' : +offset <= 1 ? 'CLEAN' : +offset === 2 ? 'LATE +1' : 'LATE +2+'; }

function makeSignal(snapshot, d) {
  if (!d.ready) return null;
  const off = +(snapshot?.executionOffset ?? offsetEstimate());
  return {
    symbol: symbol(), epoch: +(snapshot?.epoch ?? d.epoch), quote: +(snapshot?.quote ?? d.quote), signalEpoch: +(snapshot?.epoch ?? d.epoch), signalQuote: +(snapshot?.quote ?? d.quote),
    direction: d.session === 'BULL' ? 'CALL' : 'PUT', session: d.session, phase: d.phase, entryMode: d.entryMode, duration: d.duration, durationCohort: d.durationCohort, waveKey: d.waveKey,
    fibEntryRetrace: d.wave.currentRetrace, internalPullbackSteps: d.wave.internalPullbackSteps, internalPullbackRatio: d.wave.internalPullbackRatio, quality: d.quality,
    triggerKind: d.trigger.kind, triggerStrength: d.trigger.strength, triggerLevel: d.trigger.level, triggerStructureSize: d.trigger.structureSize,
    regime200: d.regime200, active80: d.active80, fast: d.fast, slope200: d.m200.slopeNorm, slope80: d.m80.slopeNorm, efficiency80: d.m80.efficiency,
    chopScore: d.chopScore, volatility: d.volatility, directionLockReason: d.dirLock.reason, waveStart: d.wave.start.quote, waveEnd: d.wave.end.quote, waveStep: d.wave.step,
    targetPrice: d.wave.end.quote, invalidationPrice: fibPrice(d.wave, HARD_DAMAGE), executionOffset: off
  };
}

function ensureRow(signal) {
  const key = `${signal.symbol}:${signal.epoch}:${signal.waveKey}:${signal.entryMode}`;
  let row = ledger.find(x => x.signalKey === key);
  if (row) return row;
  row = { id: `mt611-${signal.epoch}-${Date.now()}`, cohort: 'v6.11-three-lane-entry', signalKey: key, observedAt: Date.now(), ...signal, expectedWindow: `T+${signal.executionOffset}→T+${signal.executionOffset + signal.duration}`, status: 'QUALIFIED' };
  ledger.unshift(row);
  saveLedger();
  return row;
}
function patchRow(id, patch) {
  const row = ledger.find(x => x.id === id);
  if (!row) return;
  Object.assign(row, patch, { updatedAt: Date.now() });
  saveLedger();
}
function recordBlocked(signal, state) {
  const unique = `${signal.waveKey}:BLOCKED:${signal.epoch}:${signal.entryMode}:${state}`;
  if (visualHistory.some(v => v.unique === unique)) return;
  visualHistory.unshift({ unique, at: Date.now(), epoch: signal.epoch, quote: signal.quote, direction: signal.session, state: 'BLOCKED', reason: state, waveKey: signal.waveKey, retrace: signal.fibEntryRetrace, quality: signal.quality, duration: signal.duration, entryMode: signal.entryMode, breakLevel: signal.triggerLevel });
  saveVisuals();
}
function bought() { return ledger.filter(row => Number.isFinite(+row.contractId)).length; }
function cohort() {
  const settled = ledger.filter(row => row.status === 'WON' || row.status === 'LOST');
  const wins = settled.filter(row => row.status === 'WON').length;
  const losses = settled.filter(row => row.status === 'LOST').length;
  const pnl = settled.reduce((sum, row) => sum + (+row.profit || 0), 0);
  const d5 = settled.filter(row => +row.duration === 5);
  const d8 = settled.filter(row => +row.duration === 8);
  return { wins, losses, pnl, d5W: d5.filter(row => row.status === 'WON').length, d5L: d5.filter(row => row.status === 'LOST').length, d8W: d8.filter(row => row.status === 'WON').length, d8L: d8.filter(row => row.status === 'LOST').length, d5Pnl: d5.reduce((sum, row) => sum + (+row.profit || 0), 0), d8Pnl: d8.reduce((sum, row) => sum + (+row.profit || 0), 0) };
}
function pathStats(meta, trade) {
  const start = +trade?.entryTickTime;
  const end = +trade?.exitTickTime;
  const entry = +trade?.entrySpot;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(entry)) return {};
  const path = ticks().filter(x => x.epoch >= start && x.epoch <= end).map(x => x.quote);
  if (!path.length) return {};
  const max = Math.max(...path), min = Math.min(...path);
  const call = meta?.direction === 'CALL';
  const mfe = call ? max - entry : entry - min;
  const mae = call ? entry - min : max - entry;
  const target = +meta?.targetPrice;
  const targetTouched = Number.isFinite(target) ? (call ? max >= target : min <= target) : false;
  return { mfe, mae, targetTouched, pathTicks: path.length, pathHigh: max, pathLow: min };
}

function traderConfig() {
  const config = { ...engine.config, symbol: symbol(), stake: +$('ptStake').value, takeProfit: +$('ptTakeProfit').value, stopLoss: +$('ptStopLoss').value, maxTrades: +$('ptMaxTrades').value, duration: 5, durationUnit: 't', executionMethod: 'direct', oneOpenContract: true, maxSignalToSendMs: 250, currency: selectedAccount?.currency || 'USD', reconnect: true, maxReconnectAttempts: 8 };
  if (!(config.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!engine.snapshot().running) engine.setConfig(config);
  return config;
}
function auth() {
  const appId = $('ptAppId').value.trim();
  const token = $('ptToken').value.trim();
  const accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  if (String(selectedAccount.account_type).toLowerCase() === 'real') throw new Error('Master v6.11 is Demo-only.');
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
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.account_id;
    option.textContent = `${String(account.account_type).toUpperCase()} · ${account.account_id} · ${account.currency} ${account.balance}`;
    select.appendChild(option);
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
  const signal = makeSignal(snapshot, d);
  if (!signal) return;
  const row = ensureRow(signal);
  const state = engine.snapshot();
  if (signal.epoch <= lastSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) { patchRow(row.id, { status: 'SKIP STALE' }); recordBlocked(signal, 'STALE'); return; }
  if (state.safeBlocked) { patchRow(row.id, { status: 'SKIP SAFE PAUSE' }); recordBlocked(signal, 'SAFE PAUSE'); return; }
  if (!state.running) { const status = state.connected ? 'OBSERVED' : 'SKIP DISCONNECTED'; patchRow(row.id, { status }); if (!state.connected) recordBlocked(signal, 'DISCONNECTED'); return; }
  if (bought() >= +($('ptMaxTrades').value || 100)) { patchRow(row.id, { status: 'SKIP COHORT COMPLETE' }); recordBlocked(signal, 'COHORT COMPLETE'); engine.pause(); return; }
  const cooldown = +($('ptCooldown').value || 0);
  if (signal.epoch < cooldownUntil) { patchRow(row.id, { status: 'SKIP COOLDOWN' }); recordBlocked(signal, 'COOLDOWN'); return; }
  if (state.pendingTrade || state.openContracts > 0) { patchRow(row.id, { status: 'SKIP OPEN' }); recordBlocked(signal, 'OPEN CONTRACT'); return; }
  try {
    traderConfig();
    engine.config.duration = signal.duration;
    engine.config.durationUnit = 't';
    lastSignalEpoch = signal.epoch;
    cooldownUntil = signal.epoch + cooldown;
    patchRow(row.id, { status: 'ORDER SENT' });
    engine.execute({ direction: signal.direction, structure: `master-v6.11-${signal.entryMode.toLowerCase()}-${signal.duration}t`, epoch: signal.epoch, quote: signal.quote, detectedPerf: perfNow(), detectedWallMs: Date.now(), patternMeta: { ...signal, ledgerId: row.id, expectedWindow: row.expectedWindow } });
    engine.log('success', `MASTER v6.11 ${signal.session} ${signal.direction} · ${signal.entryMode} · ${(signal.fibEntryRetrace * 100).toFixed(1)}% · ${signal.duration}t`);
  } catch (error) {
    patchRow(row.id, { status: 'ERROR', error: error.message });
    recordBlocked(signal, `ERROR ${error.message}`);
    showError(error.message);
    engine.pause();
  }
}

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c])); }
function renderState(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d ? `${d.active80}${d.active80 === 'NEUTRAL' && d.fast !== 'NEUTRAL' ? ' · FAST ' + d.fast : ''}` : '—');
  set('mtSession', d?.session && d.session !== 'NEUTRAL' ? `${d.session} · ${d.phase}` : 'NEUTRAL');
  if (!d?.wave) set('mtEntry20', d?.phase === 'REANCHOR' ? 'REANCHOR' : 'SEARCH');
  else if (d.ready) set('mtEntry20', `FIRE ${d.entryMode.replaceAll('_', ' ')} ${d.duration}T`);
  else if (d.phase === 'PULLBACK_ARMED') set('mtEntry20', 'DEEP ARMED');
  else if (d.phase === 'SHALLOW_ARMED') set('mtEntry20', 'SHALLOW ARMED');
  else if (d.phase === 'MOMENTUM_WATCH') set('mtEntry20', 'MOMENTUM WATCH');
  else set('mtEntry20', 'WAIT');
  set('mtChop', d ? `${d.chop ? 'VETO' : 'CLEAR'} · ${(d.chopScore * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');
  if (!d || !d.ready) {
    const retrace = d?.wave ? ` · NOW ${(d.wave.currentRetrace * 100).toFixed(1)}%` : '';
    const internal = d?.wave ? ` · internal pause ${d.wave.internalPullbackSteps.toFixed(1)} steps` : '';
    $('ptSignal').innerHTML = `<b>WAIT · ${esc(d?.phase || 'SEARCHING')}</b><span>${esc(d?.reason || 'Scanning')}${retrace}${internal}</span>`;
  } else {
    $('ptSignal').innerHTML = `<b class="${d.session === 'BULL' ? 'positive' : 'negative'}">${d.entryMode.replaceAll('_', ' ')} ${d.session === 'BULL' ? 'CALL' : 'PUT'} · ${d.duration}T</b><span>${esc(d.laneReason)} · retrace ${(d.wave.currentRetrace * 100).toFixed(1)}% · expected entry T+${offsetEstimate()}</span>`;
  }
}
function renderLedger() {
  const s = cohort();
  $('ptQualified').textContent = String(ledger.length);
  $('ptSkipped').textContent = String(ledger.filter(row => String(row.status).startsWith('SKIP')).length);
  $('ptBought').textContent = String(bought());
  $('ptEntryOffset').textContent = `T+${offsetEstimate()}`;
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = `${s.d5W} / ${s.d5L} · ${s.d5Pnl >= 0 ? '+' : ''}$${s.d5Pnl.toFixed(2)}`;
  $('ptBearWL').textContent = `${s.d8W} / ${s.d8L} · ${s.d8Pnl >= 0 ? '+' : ''}$${s.d8Pnl.toFixed(2)}`;
  $('ptLedgerRows').innerHTML = ledger.length ? ledger.slice(0, 100).map(row => {
    const time = new Date(row.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const window = row.actualWindow ? `${row.expectedWindow} → ${row.actualWindow}` : row.expectedWindow;
    const entry = `${row.entryMode || '—'} · ${row.duration || '—'}T · Q${row.quality ?? '—'} · ${(Number(row.fibEntryRetrace || 0) * 100).toFixed(0)}%`;
    return `<tr><td>${time}</td><td>${esc(`${row.session || '—'} · ${row.phase || '—'}`)}</td><td>${row.direction || '—'}</td><td>${esc(entry)}</td><td>${Number.isFinite(+row.slope200) ? (+row.slope200).toFixed(3) : '—'}</td><td>${Number.isFinite(+row.slope80) ? (+row.slope80).toFixed(3) : '—'}</td><td>${Number.isFinite(+row.chopScore) ? (+row.chopScore * 100).toFixed(0) + '%' : '—'}</td><td>${row.volatility || '—'}</td><td>${window || '—'}</td><td>${row.latencyClass || '—'}</td><td>${row.status || '—'}${Number.isFinite(+row.mfe) ? ` · MFE ${(+row.mfe).toFixed(1)} / MAE ${(+row.mae).toFixed(1)}` : ''}</td><td>${row.contractId ? '#' + row.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.11 three-lane trades yet.</td></tr>';
}
function exportCsv() {
  const headers = ['cohort','entry_mode','duration','observed_at','symbol','signal_epoch','signal_quote','session','phase','direction','wave_key','fib_entry_retrace','internal_pullback_steps','internal_pullback_ratio','quality','trigger_kind','trigger_strength','trigger_level','trigger_structure_size','regime_200','active_80','fast','slope_200','slope_80','efficiency_80','direction_lock_reason','chop_score','volatility','target_price','invalidation_price','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot','mfe','mae','target_touched','path_ticks','path_high','path_low'];
  const rows = ledger.map(row => [row.cohort,row.entryMode,row.duration,new Date(row.observedAt).toISOString(),row.symbol,row.signalEpoch ?? row.epoch,row.signalQuote ?? row.quote,row.session,row.phase,row.direction,row.waveKey,row.fibEntryRetrace,row.internalPullbackSteps,row.internalPullbackRatio,row.quality,row.triggerKind,row.triggerStrength,row.triggerLevel,row.triggerStructureSize,row.regime200,row.active80,row.fast,row.slope200,row.slope80,row.efficiency80,row.directionLockReason,row.chopScore,row.volatility,row.targetPrice,row.invalidationPrice,row.expectedWindow,row.status,row.contractId??'',row.profit??'',row.actualWindow??'',row.latencyClass??'',row.entrySpot??'',row.exitSpot??'',row.mfe??'',row.mae??'',row.targetTouched??'',row.pathTicks??'',row.pathHigh??'',row.pathLow??'']);
  const csv = [headers, ...rows].map(values => values.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `master-v6.11-three-lane-${new Date().toISOString().replaceAll(':','-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function scaleCanvas(ctx, canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width || canvas.width);
  const h = Math.max(180, rect.height || canvas.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function drawMarker(ctx, marker, x, y) {
  if (marker.state === 'ARMED') { ctx.strokeStyle = '#f3c567'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.stroke(); }
  else if (marker.state === 'SHALLOW') { ctx.strokeStyle = '#7fc8ff'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke(); }
  else if (marker.state === 'BREAK') { ctx.fillStyle = '#7fc8ff'; ctx.font = '10px system-ui'; ctx.fillText('B', x + 4, y - 5); ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill(); }
  else if (marker.state === 'BLOCKED') { ctx.strokeStyle = '#ff9c6e'; ctx.lineWidth = 1.5; ctx.strokeRect(x - 4, y - 4, 8, 8); }
  else if (marker.state === 'SIGNAL') {
    ctx.fillStyle = marker.direction === 'BULL' ? '#67d99a' : '#ff7474';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = '10px system-ui';
    const mode = marker.entryMode === 'MOMENTUM_REBREAK' ? 'M' : marker.entryMode === 'SHALLOW_RESUME' ? 'S' : 'P';
    ctx.fillText(`${mode}${marker.duration || '?'}`, x + 6, y - 6);
  }
}
function draw() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const rows = ticks().slice(-220);
  const ctx = canvas.getContext('2d');
  const { w, h } = scaleCanvas(ctx, canvas);
  ctx.clearRect(0, 0, w, h);
  const d = lastDiagnostics;
  const session = d?.session || 'NEUTRAL';
  ctx.fillStyle = session === 'BULL' ? 'rgba(61,191,126,.05)' : session === 'BEAR' ? 'rgba(235,87,87,.05)' : 'rgba(146,153,168,.025)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  for (let x = 0; x <= w; x += w / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += h / 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  if (rows.length < 2) return;
  const prices = rows.map(x => x.quote);
  const min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const xFor = epoch => 12 + (epoch - rows[0].epoch) / Math.max(1, rows.at(-1).epoch - rows[0].epoch) * (w - 24);
  const yFor = price => h - 18 - (price - min) / span * (h - 36);
  ctx.strokeStyle = 'rgba(215,220,229,.72)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  rows.forEach((tick, index) => { const x = 12 + index / (rows.length - 1) * (w - 24); const y = yFor(tick.quote); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  const nowRetrace = d?.wave ? d.wave.currentRetrace * 100 : null;
  ctx.fillStyle = 'rgba(245,247,250,.88)';
  ctx.font = '12px system-ui';
  ctx.fillText(`200 ${d?.regime200 || '—'}   80 ${d?.active80 || '—'}   FAST ${d?.fast || '—'}   ${session}   ${d?.phase || 'SEARCHING'}   ${d?.entryMode || 'NONE'}   ${Number.isFinite(nowRetrace) ? 'NOW ' + nowRetrace.toFixed(1) + '%' : ''}`, 16, 22);
  if (d?.wave && d?.waveRows?.length) {
    const startEpoch = d.waveRows[d.wave.start.i]?.epoch;
    const endEpoch = d.waveRows[d.wave.end.i]?.epoch;
    if (Number.isFinite(startEpoch) && Number.isFinite(endEpoch)) {
      const sx = xFor(startEpoch), ex = xFor(endEpoch), sy = yFor(d.wave.start.quote), ey = yFor(d.wave.end.quote);
      ctx.strokeStyle = 'rgba(230,195,92,.82)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = '#e6c35c'; for (const [x, y] of [[sx, sy], [ex, ey]]) { ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }
      const shallowTop = yFor(fibPrice(d.wave, SHALLOW_MIN));
      const pullbackTop = yFor(fibPrice(d.wave, PULLBACK_MIN));
      ctx.fillStyle = 'rgba(91,180,255,.10)'; ctx.fillRect(ex, Math.min(shallowTop, pullbackTop), Math.max(0, w - 12 - ex), Math.abs(pullbackTop - shallowTop));
      const fireTop = yFor(fibPrice(d.wave, PULLBACK_MIN));
      const fireBottom = yFor(fibPrice(d.wave, PULLBACK_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.15)'; ctx.fillRect(ex, Math.min(fireTop, fireBottom), Math.max(0, w - 12 - ex), Math.abs(fireBottom - fireTop));
      const coreTop = yFor(fibPrice(d.wave, CORE_MIN));
      const coreBottom = yFor(fibPrice(d.wave, CORE_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.10)'; ctx.fillRect(ex, Math.min(coreTop, coreBottom), Math.max(0, w - 12 - ex), Math.abs(coreBottom - coreTop));
      for (const [ratio, label] of [[SHALLOW_MIN,'SHALLOW 8'],[PULLBACK_MIN,'DEEP 32'],[.382,'38.2'],[.5,'50'],[.618,'61.8'],[PULLBACK_MAX,'DEEP 68'],[HARD_DAMAGE,'78.6 RETIRE']]) {
        const y = yFor(fibPrice(d.wave, ratio));
        ctx.strokeStyle = ratio === HARD_DAMAGE ? 'rgba(255,116,116,.72)' : ratio === SHALLOW_MIN ? 'rgba(127,200,255,.85)' : (ratio === PULLBACK_MIN || ratio === PULLBACK_MAX) ? 'rgba(255,215,105,.95)' : 'rgba(230,195,92,.38)';
        ctx.lineWidth = ratio === SHALLOW_MIN || ratio === PULLBACK_MIN || ratio === PULLBACK_MAX ? 1.2 : .8;
        ctx.setLineDash(ratio === HARD_DAMAGE ? [4, 4] : []); ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(w - 12, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = ratio === HARD_DAMAGE ? '#ff7474' : ratio === SHALLOW_MIN ? '#7fc8ff' : '#f3c567'; ctx.font = '10px system-ui'; ctx.fillText(label + (label.includes('SHALLOW') || label.includes('DEEP') || label.includes('RETIRE') ? '' : '%'), w - 92, y - 3);
      }
    }
  }
  if (Number.isFinite(d?.trigger?.level)) {
    const y = yFor(d.trigger.level); ctx.strokeStyle = 'rgba(127,200,255,.82)'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(w * .72, y); ctx.lineTo(w - 12, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#7fc8ff'; ctx.font = '10px system-ui'; ctx.fillText(`MICRO ${d.trigger.firstBreak ? 'FIRST BREAK' : 'BREAK'} ${d.trigger.level.toFixed(2)}`, w * .72 + 4, y - 4);
  }
  const visibleStart = rows[0].epoch, visibleEnd = rows.at(-1).epoch;
  for (const marker of visualHistory.filter(v => +v.epoch >= visibleStart && +v.epoch <= visibleEnd)) drawMarker(ctx, marker, xFor(+marker.epoch), yFor(+marker.quote));
  const recent = rows.slice(-20);
  const pp = pivots(recent.map(x => x.quote), 2);
  const labelPivots = (items, type) => {
    let previous;
    for (const pivot of items.slice(-3)) {
      const text = previous === undefined ? type : type === 'H' ? (pivot.quote > previous ? 'HH' : 'LH') : (pivot.quote > previous ? 'HL' : 'LL');
      previous = pivot.quote;
      const tick = recent[pivot.i];
      if (tick) { ctx.fillStyle = 'rgba(245,247,250,.88)'; ctx.font = '11px system-ui'; ctx.fillText(text, xFor(tick.epoch) + 4, yFor(tick.quote) + (type === 'H' ? -7 : 14)); }
    }
  };
  labelPivots(pp.highs, 'H'); labelPivots(pp.lows, 'L');
  for (const row of ledger.filter(r => Number.isFinite(+r.contractId) && Number(r.entryTickTime ?? r.epoch) >= visibleStart && Number(r.entryTickTime ?? r.epoch) <= visibleEnd)) {
    const sx = xFor(Number(row.signalEpoch ?? row.epoch)), sy = yFor(Number(row.signalQuote ?? row.quote));
    const mode = row.entryMode === 'MOMENTUM_REBREAK' ? 'M' : row.entryMode === 'SHALLOW_RESUME' ? 'S' : 'P';
    ctx.fillStyle = row.direction === 'CALL' ? '#67d99a' : '#ff7474'; ctx.font = '10px system-ui'; ctx.fillText(`${mode}${row.duration || '?'}`, sx + 5, sy - 7);
    const entryEpoch = Number(row.entryTickTime ?? row.epoch), entryPrice = Number(row.entrySpot ?? row.quote), x = xFor(entryEpoch), y = yFor(entryPrice), call = row.direction === 'CALL';
    ctx.fillStyle = call ? '#67d99a' : '#ff7474'; ctx.beginPath();
    if (call) { ctx.moveTo(x, y - 10); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5); } else { ctx.moveTo(x, y + 10); ctx.lineTo(x - 6, y - 5); ctx.lineTo(x + 6, y - 5); }
    ctx.closePath(); ctx.fill(); ctx.font = '10px system-ui'; ctx.fillText('E', x + 7, y - 7);
    const exitEpoch = +row.exitTickTime, exitPrice = +row.exitSpot;
    if (Number.isFinite(exitEpoch) && Number.isFinite(exitPrice) && exitEpoch >= visibleStart && exitEpoch <= visibleEnd) {
      const ex = xFor(exitEpoch), ey = yFor(exitPrice); ctx.strokeStyle = row.status === 'WON' ? '#67d99a' : '#ff7474'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke(); ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.stroke(); ctx.fillStyle = row.status === 'WON' ? '#67d99a' : '#ff7474'; ctx.fillText(`X${row.duration || '?'} ${Number(row.profit || 0) >= 0 ? '+' : ''}${Number(row.profit || 0).toFixed(2)}`, ex + 7, ey - 7);
    }
  }
  $('masterCanvasCaption').textContent = `${session} · ${d?.phase || 'SEARCHING'} · lane ${d?.entryMode || 'NONE'} · blue=8–32 shallow · gold=32–68 deep · M/S/P=momentum/shallow/pullback signal · E=entry · X=expiry · ${rows.length} ticks`;
}

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onMasterBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : null;
  baseBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(x => Number(x.contractId) === contractId);
  if (!trade || !meta) return;
  trade.patternMeta = meta; trade.ledgerId = meta.ledgerId; trade.expectedWindow = meta.expectedWindow; contractToLedger.set(contractId, meta.ledgerId);
  patchRow(meta.ledgerId, { status: 'BOUGHT', contractId, buyAckMs: trade.sendToAckMs, duration: trade.duration });
  this.emit();
};
const baseContract = engine.onContract.bind(engine);
engine.onContract = function onMasterContract(contract) {
  const contractId = Number(contract?.contract_id);
  baseContract(contract);
  const trade = this.trades.find(x => Number(x.contractId) === contractId);
  if (!trade?.patternMeta || !(contract?.is_sold || contract?.is_expired)) return;
  const offset = actualOffset(trade);
  if (!trade.offsetRecorded && Number.isFinite(offset)) { trade.offsetRecorded = true; recordOffset(offset); }
  const duration = Number(trade.duration || trade.patternMeta.duration || 5);
  trade.actualWindow = Number.isFinite(offset) ? `T+${offset}→T+${offset + duration}` : 'unknown';
  trade.latencyClass = latency(offset);
  const path = pathStats(trade.patternMeta, trade);
  patchRow(trade.ledgerId || contractToLedger.get(contractId), { status: String(trade.status || 'sold').toUpperCase(), profit: trade.profit, actualWindow: trade.actualWindow, latencyClass: trade.latencyClass, entrySpot: trade.entrySpot, exitSpot: trade.exitSpot, entryTickTime: trade.entryTickTime, exitTickTime: trade.exitTickTime, duration, ...path });
  draw(); this.emit();
};

$('ptLoadAccounts').onclick = async () => {
  clearError();
  try {
    const appId = $('ptAppId').value.trim();
    const token = $('ptToken').value.trim();
    if (!appId || !token) throw new Error('App ID and trade token are required.');
    $('ptLoadAccounts').disabled = true;
    const data = await api('accounts', { appId, token });
    accounts = data.accounts || [];
    localStorage.setItem('sani.deriv.appId', appId);
    sessionStorage.setItem('sani.deriv.token', token);
    renderAccounts();
  } catch (error) { showError(error.message); } finally { $('ptLoadAccounts').disabled = false; }
};
$('ptAccount').onchange = () => { localStorage.setItem('sani.deriv.accountId', $('ptAccount').value); lastOtpContext = null; renderGate(); };
$('ptConnect').onclick = async () => {
  clearError();
  try { traderConfig(); lastOtpContext = auth(); $('ptConnect').disabled = true; await engine.connect(freshWs); }
  catch (error) { showError(error.message); }
  finally { renderGate(); }
};
$('ptDisconnect').onclick = () => { engine.disconnect(); lastOtpContext = null; };
$('ptStart').onclick = () => {
  clearError();
  try {
    auth(); traderConfig();
    if (bought() >= +($('ptMaxTrades').value || 100)) throw new Error('v6.11 cohort cap reached.');
    engine.start();
    engine.log('info', 'Master v6.11 armed: momentum re-break + shallow 8–32% resume + deep 32–68% pullback. Demo only, 5t/8t split.');
  } catch (error) { showError(error.message); }
};
$('ptPause').onclick = () => engine.pause();
$('ptStop').onclick = () => engine.stop();
$('ptReset').onclick = () => { try { engine.resetSession(); lastSignalEpoch = 0; cooldownUntil = 0; } catch (error) { showError(error.message); } };
$('ptClearLedger').onclick = () => {
  if (confirm('Clear fresh v6.11 cohort and visual trail?')) {
    ledger = []; visualHistory = []; waveMemory.clear(); localStorage.removeItem(LEDGER_KEY); localStorage.removeItem(VISUAL_KEY); strategy.session = 'NEUTRAL'; strategy.neutralTicks = 0; strategy.sessionId += 1; renderLedger(); draw();
  }
};
$('ptResetCalibration').onclick = () => { if (confirm('Reset execution calibration?')) { localStorage.removeItem(OFFSET_KEY); renderLedger(); } };
$('ptExportLedger').onclick = exportCsv;
for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) {
  $(id).addEventListener('change', () => { try { if (!engine.snapshot().running) traderConfig(); } catch (error) { showError(error.message); } });
}
window.addEventListener('sani-observatory-analysis', event => maybeTrade(event.detail));
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
  $('ptTradeRows').innerHTML = state.trades.length ? state.trades.map(trade => {
    const meta = trade.patternMeta || {};
    const expected = trade.expectedWindow || meta.expectedWindow || '—';
    const actual = trade.actualWindow || '—';
    const row = ledger.find(r => Number(r.contractId) === Number(trade.contractId));
    return `<tr><td>#${trade.contractId}</td><td>${esc(`${meta.session || '—'} · ${meta.entryMode || '—'}`)}</td><td>${trade.direction}</td><td>${esc(`${trade.duration || meta.duration || '—'}T · ${meta.triggerKind || '—'} · ${(Number(meta.fibEntryRetrace || 0) * 100).toFixed(0)}% · Q${meta.quality ?? '—'}`)}</td><td><span class="result ${trade.status}">${trade.status}</span></td><td>${trade.duration}t</td><td>${expected}</td><td>${actual}</td><td>${trade.latencyClass || '—'}</td><td class="${(trade.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${trade.profit === undefined ? '—' : `${trade.profit >= 0 ? '+' : ''}${Number(trade.profit).toFixed(2)}`}</td><td>${trade.sendToAckMs === undefined ? '—' : Number(trade.sendToAckMs).toFixed(0) + 'ms'}</td><td>S ${meta.signalQuote ?? meta.quote ?? '—'} → E ${trade.entrySpot ?? '—'} → X ${trade.exitSpot ?? '—'}${row && Number.isFinite(+row.mfe) ? ` · MFE ${(+row.mfe).toFixed(1)}/MAE ${(+row.mae).toFixed(1)}` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.11 trades yet.</td></tr>';
  if (state.logs?.[0]) $('ptLogs').innerHTML = state.logs.slice(0, 70).map(log => `<div class="log ${log.level}"><time>${new Date(log.at).toLocaleTimeString()}</time><span>${esc(log.message === 'Engine armed. Waiting for fresh BOS.' ? 'Master v6.11 execution engine armed.' : log.message)}</span></div>`).join('');
  renderLedger(); draw();
});

function patchStaticCopy() {
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.11'));
  const hero = document.querySelector('.obsIntro');
  if (hero) {
    const p = hero.querySelector('p');
    if (p) p.textContent = 'v6.11 stops requiring every trend to retrace deeply. It has three separately logged Demo entry lanes: momentum re-break near a fresh extreme, shallow 8–32% continuation, and deep 32–68% pullback. Direction still comes from the 80/FAST authority with macro conflict, CHOP and volatility protection.';
    const badges = hero.querySelectorAll('.obsBadges span');
    const texts = ['Demo only', 'momentum re-break', '8–32% shallow', '32–68% deep', 'fresh-wave re-anchor', '5t / 8t'];
    badges.forEach((el, i) => { if (texts[i]) el.textContent = texts[i]; });
  }
  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader v6'));
  if (title) title.textContent = 'Master Trader v6.11 · Three-Lane Entry + 5T/8T Lab';
  const rules = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Frozen v6'));
  if (rules) rules.textContent = 'Frozen v6.11 momentum / shallow / deep entry rules';
  if ($('ptStart')) $('ptStart').textContent = 'Start Master Trader v6.11';
  if ($('ptCooldown')) $('ptCooldown').value = '0';
  const metricSpans = [...document.querySelectorAll('.metric span')];
  const bullLabel = metricSpans.find(x => x.textContent.trim() === 'BULL W/L');
  const bearLabel = metricSpans.find(x => x.textContent.trim() === 'BEAR W/L');
  if (bullLabel) bullLabel.textContent = '5T W/L · P/L';
  if (bearLabel) bearLabel.textContent = '8T W/L · P/L';
  for (const p of document.querySelectorAll('p.muted')) {
    if (p.textContent.includes('Fixed internals:') || p.textContent.includes('v6.10:')) p.textContent = 'v6.11 entry lanes: MOMENTUM RE-BREAK can fire near a fresh trend extreme after a measurable internal pause; SHALLOW RESUME uses an 8–32% retrace plus break/hold; PULLBACK HOLD uses 32–68% plus break/hold. Each mode is written to the fresh ledger so we can kill the losing lane later instead of mixing everything together. Demo only, one-open lock, zero default cooldown, 5T/8T deterministic split.';
    if (p.textContent.includes('Visualizer keeps previous setups') || p.textContent.includes('Triangles mark actual entries')) p.textContent = 'Visualizer keeps previous setups in the 220-tick window. Blue band is the shallow 8–32% lane, gold is the deep 32–68% lane. M/S/P labels mark momentum, shallow, and pullback signals; triangle E is actual Deriv entry and X is expiry.';
  }
  const stateTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('v6') && x.textContent.includes('state machine'));
  if (stateTitle) stateTitle.textContent = 'v6.11 three-lane entry state machine';
}

window.addEventListener('DOMContentLoaded', () => {
  patchStaticCopy();
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger();
  draw();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snapshot = window.SaniObservatory?.getSnapshot?.();
  if (snapshot) { lastDiagnostics = evaluate(snapshot); renderState(lastDiagnostics); draw(); }
});
