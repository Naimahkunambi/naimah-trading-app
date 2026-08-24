import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const VERSION = 'v7.2';
const LEDGER_KEY = 'sani.masterTrader.signalLedger.v7.2';
const LEGACY_LEDGER_KEY = 'sani.masterTrader.signalLedger.v7.1';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const LONG = 200;
const AUTH = 80;
const FAST = 20;
const FIXED_DURATION = 5;
const MIN_MATCHES = 40;
const MIN_AVG_SIMILARITY = 88;
const MIN_PATTERN_STRENGTH = 58;
const MIN_PATTERN_MARGIN = 1.0;
const ASSUMED_NET_WIN = 0.92;
const MIN_EXPECTED_VALUE = 0.05;
const MAX_BREAK_EXTENSION_STEPS = 1.10;
const EARLY_ARM_STEPS = 0.50;
const VISUAL_TICKS = 220;
const REPLAY_STEP = 180;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastDiagnostics = null;
let lastSignalEpoch = 0;
let lastCandidateKey = '';
let replayOffset = 0;
let ledger = loadArray(LEDGER_KEY);
const legacyLedger = loadArray(LEGACY_LEDGER_KEY);
const contractToLedger = new Map();

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: FIXED_DURATION,
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

// Master/Pattern Lab owns the signal. The core BOS engine is deliberately silent here.
engine.onTick = function v72Tick(tick) {
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
  let sum = 0;
  for (let i = 1; i < p.length; i += 1) sum += Math.abs(p[i] - p[i - 1]);
  return sum / (p.length - 1);
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

function pivots(p, radius = 1) {
  const highs = [];
  const lows = [];
  for (let i = radius; i < p.length - radius; i += 1) {
    const left = p.slice(i - radius, i);
    const right = p.slice(i + 1, i + radius + 1);
    if (left.every(v => p[i] >= v) && right.every(v => p[i] >= v) && [...left, ...right].some(v => p[i] > v)) highs.push({ i, quote: p[i] });
    if (left.every(v => p[i] <= v) && right.every(v => p[i] <= v) && [...left, ...right].some(v => p[i] < v)) lows.push({ i, quote: p[i] });
  }
  return { highs, lows };
}

function swingStructure(p) {
  const x = pivots(p, 2);
  const h = x.highs.slice(-2);
  const l = x.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}

function metrics(rows) {
  const p = rows.map(x => x.quote);
  const step = avgStep(p);
  return {
    avgStep: step,
    slopeNorm: step ? linearSlope(p) / step : 0,
    efficiency: efficiency(p),
    turnRate: turnRate(p),
    net: p.at(-1) - p[0],
    structure: swingStructure(p)
  };
}

function directionFromMetrics(m, slopeFloor, efficiencyFloor) {
  if (Math.abs(m.slopeNorm) < slopeFloor || m.efficiency < efficiencyFloor) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0) return 'BEAR';
  return 'NEUTRAL';
}

function chopState(m80, m20) {
  const score = (
    clamp((.12 - m80.efficiency) / .12, 0, 1) +
    clamp((m80.turnRate - .58) / .25, 0, 1) +
    clamp((.05 - Math.abs(m80.slopeNorm)) / .05, 0, 1) +
    clamp((m20.turnRate - .78) / .15, 0, 1)
  ) / 4;
  return { score, blocked: score >= .82 };
}

function volatilityState(m200, m80, m20) {
  const shortVsMid = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const midVsLong = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (shortVsMid < .28 || midVsLong < .38) return 'DEAD';
  if (shortVsMid > 2.8 || m20.turnRate > .96) return 'CHAOTIC';
  return 'HEALTHY';
}

// v7.2 timing: strict 200+80 direction first, then HL/LH anchor, frozen BOS,
// then the FIRST break tick. PRIME is still the only live timing class.
function structureSetup(rows20, direction, step) {
  const p = rows20.map(x => x.quote);
  const n = p.length;
  const unit = step || avgStep(p) || 1;
  const empty = {
    ready: false, event: false, type: 'NONE', level: NaN, bosLevel: NaN,
    pullbackSteps: 0, breakDistanceSteps: NaN, timingClass: 'WAIT',
    pivotType: '', pivotQuote: NaN, pivotEpoch: NaN, setupId: ''
  };
  if (n < 14 || (direction !== 'BULL' && direction !== 'BEAR')) return empty;

  const current = p[n - 1];
  const previous = p[n - 2];
  const shelf = p.slice(n - 8, n - 2);
  const context = p.slice(n - 14, n - 2);
  const recentP = p.slice(-16);
  const recentRows = rows20.slice(-16);
  const pp = pivots(recentP, 1);
  const buffer = unit * .02;
  const signalEpoch = Number(rows20.at(-1)?.epoch || 0);

  if (direction === 'BULL') {
    const level = Math.max(...shelf);
    const low = Math.min(...context);
    const high = Math.max(...context);
    const pullbackSteps = (high - low) / unit;
    const lows = pp.lows.slice(-2);
    const lastLow = lows.at(-1);
    const previousLow = lows.length > 1 ? lows.at(-2) : null;
    const hl = !previousLow || !lastLow || lastLow.quote >= previousLow.quote - unit * .20;
    const pivotQuote = lastLow?.quote ?? low;
    const pivotEpoch = lastLow ? Number(recentRows[lastLow.i]?.epoch) : Number(rows20[n - 3]?.epoch || signalEpoch);

    const aboveNow = current > level + buffer;
    const aboveBefore = previous > level + buffer;
    const firstBreak = aboveNow && !aboveBefore;
    const breakDistanceSteps = aboveNow ? Math.max(0, (current - level) / unit) : Math.max(0, (level - current) / unit);
    const early = !aboveNow && current > previous && breakDistanceSteps <= EARLY_ARM_STEPS;
    const shapeOk = hl && pullbackSteps >= .65;
    const event = firstBreak && shapeOk;
    const timingClass = event
      ? (breakDistanceSteps <= MAX_BREAK_EXTENSION_STEPS ? 'PRIME' : 'CHASE')
      : aboveBefore ? 'CHASE'
        : early ? 'EARLY' : 'WAIT';
    const ready = event && timingClass === 'PRIME';

    return {
      ready,
      event,
      type: ready ? 'HL_BOS_FIRST_BREAK' : event ? 'HL_BOS_CHASE' : early ? 'HL_ARMED' : 'WAIT_BOS',
      level,
      bosLevel: level,
      pullbackSteps,
      breakDistanceSteps,
      timingClass,
      pivotType: 'HL',
      pivotQuote,
      pivotEpoch,
      firstBreak,
      structureText: !hl ? 'HL structure weak'
        : ready ? `HL → BOS first break · PRIME ${breakDistanceSteps.toFixed(2)}x`
          : event ? `HL → BOS but CHASE ${breakDistanceSteps.toFixed(2)}x`
            : early ? `HL armed · ${breakDistanceSteps.toFixed(2)}x below BOS`
              : 'HL found · waiting first BOS break',
      setupId: `B:${Math.round(level * 100)}:${Math.round(pivotQuote * 100)}:${signalEpoch}`
    };
  }

  const level = Math.min(...shelf);
  const high = Math.max(...context);
  const low = Math.min(...context);
  const pullbackSteps = (high - low) / unit;
  const highs = pp.highs.slice(-2);
  const lastHigh = highs.at(-1);
  const previousHigh = highs.length > 1 ? highs.at(-2) : null;
  const lh = !previousHigh || !lastHigh || lastHigh.quote <= previousHigh.quote + unit * .20;
  const pivotQuote = lastHigh?.quote ?? high;
  const pivotEpoch = lastHigh ? Number(recentRows[lastHigh.i]?.epoch) : Number(rows20[n - 3]?.epoch || signalEpoch);

  const belowNow = current < level - buffer;
  const belowBefore = previous < level - buffer;
  const firstBreak = belowNow && !belowBefore;
  const breakDistanceSteps = belowNow ? Math.max(0, (level - current) / unit) : Math.max(0, (current - level) / unit);
  const early = !belowNow && current < previous && breakDistanceSteps <= EARLY_ARM_STEPS;
  const shapeOk = lh && pullbackSteps >= .65;
  const event = firstBreak && shapeOk;
  const timingClass = event
    ? (breakDistanceSteps <= MAX_BREAK_EXTENSION_STEPS ? 'PRIME' : 'CHASE')
    : belowBefore ? 'CHASE'
      : early ? 'EARLY' : 'WAIT';
  const ready = event && timingClass === 'PRIME';

  return {
    ready,
    event,
    type: ready ? 'LH_BOS_FIRST_BREAK' : event ? 'LH_BOS_CHASE' : early ? 'LH_ARMED' : 'WAIT_BOS',
    level,
    bosLevel: level,
    pullbackSteps,
    breakDistanceSteps,
    timingClass,
    pivotType: 'LH',
    pivotQuote,
    pivotEpoch,
    firstBreak,
    structureText: !lh ? 'LH structure weak'
      : ready ? `LH → BOS first break · PRIME ${breakDistanceSteps.toFixed(2)}x`
        : event ? `LH → BOS but CHASE ${breakDistanceSteps.toFixed(2)}x`
          : early ? `LH armed · ${breakDistanceSteps.toFixed(2)}x above BOS`
            : 'LH found · waiting first BOS break',
    setupId: `S:${Math.round(level * 100)}:${Math.round(pivotQuote * 100)}:${signalEpoch}`
  };
}

function patternDecision(snapshot, structureDirection) {
  const matchCount = Number(snapshot?.matchCount || 0);
  const avgSimilarity = Number(snapshot?.avgSimilarity || 0);
  const horizons = Array.isArray(snapshot?.executionHorizons) ? snapshot.executionHorizons : [];
  const expectedBias = structureDirection === 'BULL' ? 'UP' : structureDirection === 'BEAR' ? 'DOWN' : 'NONE';

  if (matchCount < MIN_MATCHES) {
    return { ok: false, status: 'WEAK', reason: `Only ${matchCount}/${MIN_MATCHES} pattern relatives`, expectedBias, matchCount, avgSimilarity };
  }
  if (avgSimilarity < MIN_AVG_SIMILARITY) {
    return { ok: false, status: 'WEAK', reason: `Similarity ${avgSimilarity.toFixed(1)}% < ${MIN_AVG_SIMILARITY}%`, expectedBias, matchCount, avgSimilarity };
  }

  const decided = horizons
    .filter(h => Number(h.horizon) === FIXED_DURATION && Number(h.decided || 0) >= MIN_MATCHES && ['UP', 'DOWN'].includes(h.bias))
    .map(h => ({
      horizon: Number(h.horizon),
      bias: h.bias,
      strength: Number(h.strength || 0),
      decided: Number(h.decided || 0),
      up: Number(h.up || 0),
      down: Number(h.down || 0),
      startOffset: Number(h.startOffset ?? snapshot?.executionOffset ?? 1)
    }));

  if (!decided.length) {
    return { ok: false, status: 'WEAK', reason: `Need ${MIN_MATCHES}+ decided ${FIXED_DURATION}T outcomes`, expectedBias, matchCount, avgSimilarity };
  }

  const same = decided.find(h => h.bias === expectedBias);
  const opposite = decided.find(h => h.bias !== expectedBias);
  if (!same || same.strength < MIN_PATTERN_STRENGTH) {
    const strongest = decided.slice().sort((a, b) => b.strength - a.strength)[0];
    return {
      ok: false,
      status: strongest?.bias && strongest.bias !== expectedBias ? 'DISAGREE' : 'WEAK',
      reason: strongest ? `${strongest.bias} ${strongest.strength.toFixed(1)}% @ ${FIXED_DURATION}T` : 'No directional edge',
      expectedBias, matchCount, avgSimilarity, bestAgree: same, bestOppose: opposite, strongest,
      duration: FIXED_DURATION,
      startOffset: strongest?.startOffset ?? Number(snapshot?.executionOffset || 1)
    };
  }

  if (opposite && opposite.strength >= same.strength - MIN_PATTERN_MARGIN) {
    return {
      ok: false,
      status: 'CONFLICT',
      reason: `Pattern conflict ${same.strength.toFixed(1)}% vs ${opposite.strength.toFixed(1)}%`,
      expectedBias, matchCount, avgSimilarity, bestAgree: same, bestOppose: opposite,
      duration: FIXED_DURATION,
      startOffset: same.startOffset
    };
  }

  const winProbability = same.strength / 100;
  const expectedValue = winProbability * ASSUMED_NET_WIN - (1 - winProbability);
  if (expectedValue < MIN_EXPECTED_VALUE) {
    return {
      ok: false,
      status: 'EV_LOW',
      reason: `EV ${(expectedValue * 100).toFixed(1)}% < ${(MIN_EXPECTED_VALUE * 100).toFixed(0)}% floor`,
      expectedBias, matchCount, avgSimilarity, bestAgree: same, bestOppose: opposite,
      expectedValue,
      duration: FIXED_DURATION,
      startOffset: same.startOffset
    };
  }

  return {
    ok: true,
    status: 'AGREE',
    reason: `${expectedBias} ${same.strength.toFixed(1)}% @ ${FIXED_DURATION}T · EV +${(expectedValue * 100).toFixed(1)}%`,
    expectedBias,
    matchCount,
    avgSimilarity,
    bestAgree: same,
    bestOppose: opposite,
    expectedValue,
    duration: FIXED_DURATION,
    startOffset: same.startOffset
  };
}

function evaluate(snapshot) {
  const all = ticks();
  if (all.length < LONG) {
    return { ready: false, structureEvent: false, structureReady: false, reason: `Need ${LONG} ticks (${all.length}/${LONG})`, phase: 'WARMING', rows: all };
  }

  const r200 = all.slice(-LONG);
  const r80 = all.slice(-AUTH);
  const r20 = all.slice(-FAST);
  const m200 = metrics(r200);
  const m80 = metrics(r80);
  const m20 = metrics(r20);
  const regime200 = directionFromMetrics(m200, .045, .06);
  const authority80 = directionFromMetrics(m80, .065, .055);
  const fast20 = directionFromMetrics(m20, .05, .05);
  const chop = chopState(m80, m20);
  const vol = volatilityState(m200, m80, m20);

  // Clean rule: 200 and 80 must both be directional and must agree.
  const direction = regime200 !== 'NEUTRAL' && regime200 === authority80 ? regime200 : 'NEUTRAL';

  const setup = structureSetup(r20, direction, m20.avgStep);
  const environmentOk = Boolean(direction !== 'NEUTRAL' && !chop.blocked && vol === 'HEALTHY');
  const structureEvent = Boolean(environmentOk && setup.event);
  const structureReady = Boolean(structureEvent && setup.ready);
  const pattern = structureReady
    ? patternDecision(snapshot, direction)
    : { ok: false, status: 'WAIT', reason: direction === 'NEUTRAL' ? 'Need strict 200 + 80 alignment' : setup.timingClass === 'CHASE' ? 'CHASE blocked' : 'Waiting for PRIME BOS' };
  const ready = Boolean(structureReady && pattern.ok);

  let phase = 'WAIT_STRUCTURE';
  if (chop.blocked) phase = 'CHOP';
  else if (vol !== 'HEALTHY') phase = vol;
  else if (direction === 'NEUTRAL') phase = 'NO_ALIGNMENT';
  else if (setup.event && setup.timingClass === 'CHASE') phase = 'CHASE_BLOCK';
  else if (setup.timingClass === 'EARLY') phase = 'ARMED_EARLY';
  else if (!setup.ready) phase = 'WAIT_BOS';
  else if (!pattern.ok) phase = `PATTERN_${pattern.status}`;
  else phase = 'AGREEMENT';

  return {
    ready,
    structureEvent,
    structureReady,
    phase,
    rows: all,
    epoch: Number(snapshot?.epoch ?? all.at(-1).epoch),
    quote: Number(snapshot?.quote ?? all.at(-1).quote),
    direction,
    regime200,
    authority80,
    fast20,
    m200,
    m80,
    m20,
    chop,
    volatility: vol,
    setup,
    pattern,
    duration: FIXED_DURATION,
    expectedOffset: Number(snapshot?.executionOffset ?? pattern.startOffset ?? 1),
    reason: ready
      ? `FIRE ${direction}: 200+80 aligned · ${setup.pivotType}→BOS PRIME · ${pattern.reason}`
      : structureReady
        ? `PRIME BOS · ${pattern.reason}`
        : `${phase} · ${setup.structureText || ''}`
  };
}

function candidateKey(d) {
  return `${d.direction}:${d.setup?.setupId || 'none'}`;
}

function makeRow(d, snapshot) {
  const duration = FIXED_DURATION;
  const offset = Number(snapshot?.executionOffset ?? d.expectedOffset ?? 1);
  const timingBlocked = d.setup?.timingClass === 'CHASE' || !d.setup?.ready;
  const agreement = Boolean(d.setup?.ready && d.pattern?.ok);
  return {
    id: `v72-${d.epoch}-${Date.now()}`,
    cohort: 'v7.2-clean-strict-align-prime-pattern-5t',
    observedAt: Date.now(),
    signalEpoch: d.epoch,
    signalQuote: d.quote,
    symbol: symbol(),
    structureDirection: d.direction,
    direction: d.direction === 'BULL' ? 'CALL' : 'PUT',
    setupType: d.setup.type,
    setupId: d.setup.setupId,
    structureLevel: d.setup.level,
    bosLevel: d.setup.bosLevel,
    pullbackSteps: d.setup.pullbackSteps,
    timingClass: d.setup.timingClass,
    breakDistanceSteps: d.setup.breakDistanceSteps,
    pivotType: d.setup.pivotType,
    pivotQuote: d.setup.pivotQuote,
    pivotEpoch: d.setup.pivotEpoch,
    regime200: d.regime200,
    authority80: d.authority80,
    fast20: d.fast20,
    slope200: d.m200.slopeNorm,
    slope80: d.m80.slopeNorm,
    chopScore: d.chop.score,
    volatility: d.volatility,
    patternStatus: d.pattern.status,
    patternReason: d.pattern.reason,
    patternMatchCount: d.pattern.matchCount,
    patternAvgSimilarity: d.pattern.avgSimilarity,
    patternBias: d.pattern.bestAgree?.bias || d.pattern.strongest?.bias || '',
    patternStrength: d.pattern.bestAgree?.strength ?? d.pattern.strongest?.strength,
    patternOpposingStrength: d.pattern.bestOppose?.strength,
    expectedValue: d.pattern.expectedValue,
    duration,
    executionOffset: offset,
    expectedWindow: `T+${offset}→T+${offset + duration}`,
    agreement,
    status: timingBlocked ? 'BLOCK TIMING CHASE' : agreement ? 'AGREEMENT' : `BLOCK PATTERN ${d.pattern.status}`,
    shadowPending: !agreement
  };
}

function addCandidate(d, snapshot) {
  const key = candidateKey(d);
  if (key === lastCandidateKey) return null;
  lastCandidateKey = key;
  const row = makeRow(d, snapshot);
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

function findTickAtOrAfter(rows, epoch) {
  return rows.find(t => t.epoch >= epoch);
}

function resolveShadowRows() {
  const all = ticks();
  if (!all.length) return;
  let changed = false;
  for (const row of ledger) {
    if (!row.shadowPending || row.shadowOutcome || Number.isFinite(+row.contractId)) continue;
    const offset = Number(row.executionOffset || 1);
    const start = findTickAtOrAfter(all, Number(row.signalEpoch) + offset);
    const end = findTickAtOrAfter(all, Number(row.signalEpoch) + offset + Number(row.duration || FIXED_DURATION));
    if (!start || !end) continue;
    const up = end.quote > start.quote;
    const down = end.quote < start.quote;
    const predictedUp = row.direction === 'CALL';
    row.shadowEntry = start.quote;
    row.shadowExit = end.quote;
    row.shadowOutcome = up === down ? 'FLAT' : (predictedUp === up ? 'WON' : 'LOST');
    row.shadowPending = false;
    changed = true;
  }
  if (changed) saveLedger();
}

function boughtCount() {
  return ledger.filter(r => Number.isFinite(+r.contractId)).length;
}

function stats() {
  const settled = ledger.filter(r => r.status === 'WON' || r.status === 'LOST');
  const wins = settled.filter(r => r.status === 'WON').length;
  const losses = settled.filter(r => r.status === 'LOST').length;
  const pnl = settled.reduce((s, r) => s + (+r.profit || 0), 0);
  const bull = settled.filter(r => r.structureDirection === 'BULL');
  const bear = settled.filter(r => r.structureDirection === 'BEAR');
  const patternBlocked = ledger.filter(r => String(r.status).startsWith('BLOCK PATTERN') && ['WON', 'LOST'].includes(r.shadowOutcome));
  const timingBlocked = ledger.filter(r => String(r.status).startsWith('BLOCK TIMING') && ['WON', 'LOST'].includes(r.shadowOutcome));
  const summarize = rows => ({ saved: rows.filter(r => r.shadowOutcome === 'LOST').length, missed: rows.filter(r => r.shadowOutcome === 'WON').length });
  const wl = rows => `${rows.filter(r => r.status === 'WON').length} / ${rows.filter(r => r.status === 'LOST').length}`;
  return { wins, losses, pnl, bullWL: wl(bull), bearWL: wl(bear), pattern: summarize(patternBlocked), timing: summarize(timingBlocked) };
}

function offsets() {
  return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50);
}

function recordOffset(value) {
  if (!Number.isFinite(+value)) return;
  const a = offsets();
  a.push(Math.max(1, Math.min(10, Math.round(+value))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(a.slice(-50))); } catch {}
}

function actualOffset(trade) {
  const signal = +trade?.signalEpoch;
  const entry = +trade?.entryTickTime;
  if (Number.isFinite(signal) && Number.isFinite(entry)) return Math.max(1, Math.round(entry - signal));
  const start = +trade?.startTime;
  if (Number.isFinite(signal) && Number.isFinite(start)) return Math.max(1, Math.round(start - signal) + 1);
}

function latency(offset) {
  return !Number.isFinite(+offset) ? 'UNKNOWN' : +offset <= 1 ? 'CLEAN' : +offset === 2 ? 'LATE +1' : 'LATE +2+';
}

function traderConfig() {
  const config = {
    ...engine.config,
    symbol: symbol(),
    stake: +$('ptStake').value,
    takeProfit: +$('ptTakeProfit').value,
    stopLoss: +$('ptStopLoss').value,
    maxTrades: +$('ptMaxTrades').value,
    cooldownTicks: +($('ptCooldown')?.value || 0),
    duration: FIXED_DURATION,
    durationUnit: 't',
    executionMethod: 'direct',
    oneOpenContract: true,
    maxSignalToSendMs: 250,
    currency: selectedAccount?.currency || 'USD',
    reconnect: true,
    maxReconnectAttempts: 8
  };
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
  if (String(selectedAccount.account_type).toLowerCase() === 'real') throw new Error('v7.2 Clean Sniper is Demo-only.');
  return { appId, token, accountId };
}

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `API ${response.status}`);
  return json;
}

async function freshWs() {
  const data = await api('otp', lastOtpContext || auth());
  if (!data.url) throw new Error('OTP response missing WebSocket URL.');
  return data.url;
}

function showError(message) {
  $('traderError').textContent = message;
  $('traderError').classList.remove('hidden');
}

function clearError() {
  $('traderError').textContent = '';
  $('traderError').classList.add('hidden');
}

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
  resolveShadowRows();
  const d = evaluate(snapshot);
  lastDiagnostics = d;
  renderDecision(d);
  renderLedger();
  draw();

  // Only real first-BOS events enter the audit trail. EARLY/WAIT states remain visual only.
  if (!d.structureEvent) return;

  const row = addCandidate(d, snapshot);
  if (!row) return;
  renderLedger();
  draw();

  if (!d.setup.ready) return;
  if (!d.pattern.ok) return;

  const state = engine.snapshot();
  if (d.epoch <= lastSignalEpoch) return;
  if (Date.now() - Number(snapshot?.at || 0) > 2500) { patchRow(row.id, { status: 'SKIP STALE', shadowPending: true }); return; }
  if (state.safeBlocked) { patchRow(row.id, { status: 'SKIP SAFE PAUSE', shadowPending: true }); return; }
  if (!state.running) { patchRow(row.id, { status: state.connected ? 'OBSERVED AGREEMENT' : 'SKIP DISCONNECTED', shadowPending: true }); return; }
  if (boughtCount() >= +($('ptMaxTrades').value || 100)) { patchRow(row.id, { status: 'SKIP COHORT COMPLETE', shadowPending: true }); engine.pause(); return; }
  if (state.pendingTrade || state.openContracts > 0) { patchRow(row.id, { status: 'SKIP OPEN', shadowPending: true }); return; }

  try {
    traderConfig();
    engine.config.duration = FIXED_DURATION;
    engine.config.durationUnit = 't';
    lastSignalEpoch = d.epoch;
    patchRow(row.id, { status: 'ORDER SENT', shadowPending: false });
    engine.execute({
      direction: d.direction === 'BULL' ? 'CALL' : 'PUT',
      structure: `v72-${d.setup.pivotType.toLowerCase()}-bos-prime-${FIXED_DURATION}t`,
      epoch: d.epoch,
      quote: d.quote,
      detectedPerf: perfNow(),
      detectedWallMs: Date.now(),
      patternMeta: { ...row, ledgerId: row.id }
    });
    engine.log('success', `v7.2 ${row.direction} · 200+80 aligned · ${row.pivotType}→BOS PRIME · pattern ${row.patternStrength?.toFixed?.(1) ?? '—'}% · ${FIXED_DURATION}T.`);
  } catch (error) {
    patchRow(row.id, { status: 'ERROR', error: error.message, shadowPending: true });
    showError(error.message);
    engine.pause();
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function whyText(d) {
  if (!d) return 'Waiting for analysis.';
  if (d.regime200 === 'NEUTRAL') return '200t is NEUTRAL. No live direction.';
  if (d.authority80 === 'NEUTRAL') return '80t is NEUTRAL. No live direction.';
  if (d.regime200 !== d.authority80) return `200t ${d.regime200} conflicts with 80t ${d.authority80}.`;
  if (d.chop.blocked) return `CHOP veto ${(d.chop.score * 100).toFixed(0)}%.`;
  if (d.volatility !== 'HEALTHY') return `Volatility is ${d.volatility}.`;
  if (d.setup?.timingClass === 'CHASE') return `BOS broke too late: ${Number(d.setup.breakDistanceSteps || 0).toFixed(2)}x beyond the PRIME window.`;
  if (!d.structureReady) return d.setup?.structureText || 'Waiting for HL/LH and PRIME BOS.';
  if (!d.pattern.ok) return `Pattern ${d.pattern.status}: ${d.pattern.reason}`;
  return 'All gates passed.';
}

function renderDecision(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d?.authority80 || '—');
  set('mtSession', d?.direction || 'NEUTRAL');
  set('mtEntry20', d?.setup ? `${d.setup.timingClass} · ${d.setup.pivotType || '—'}→BOS` : 'WAIT');
  set('mtChop', d ? `${d.chop.blocked ? 'VETO' : 'CLEAR'} · ${(d.chop.score * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');

  const aligned = d && d.regime200 !== 'NEUTRAL' && d.regime200 === d.authority80;
  const bosMeta = Number.isFinite(+d?.setup?.bosLevel)
    ? `${d.setup.pivotType} ${Number(d.setup.pivotQuote).toFixed(2)} → BOS ${Number(d.setup.bosLevel).toFixed(2)} · Δ${Number(d.setup.breakDistanceSteps || 0).toFixed(2)}x`
    : 'Waiting for HL/LH anchor and frozen BOS';

  set('dbContext', aligned ? `${d.direction} LOCKED` : 'WAIT');
  set('dbStructure', d?.structureReady ? `PRIME ${d.setup.pivotType}→BOS` : d?.setup?.timingClass === 'CHASE' ? 'CHASE BLOCK' : d?.setup?.timingClass === 'EARLY' ? 'ARMED EARLY' : 'WAIT');
  set('dbPattern', d?.structureReady ? `${d.pattern.status} · ${d.pattern.reason}` : 'WAIT');
  set('dbAgreement', d?.ready ? 'YES' : 'NO');
  set('dbAction', d?.ready ? `${d.direction === 'BULL' ? 'CALL' : 'PUT'} · ${FIXED_DURATION}T` : 'WAIT');
  set('dbWhy', whyText(d));
  set('dbPatternMeta', d?.structureReady
    ? `${bosMeta} · ${d.pattern.matchCount ?? 0} relatives · ${Number(d.pattern.avgSimilarity || 0).toFixed(1)}% sim · min edge ${MIN_PATTERN_STRENGTH}% · fixed ${FIXED_DURATION}T`
    : `${bosMeta} · live gate = 200+80 aligned + PRIME BOS + Pattern + EV`);

  if ($('ptSignal')) {
    if (d?.ready) {
      $('ptSignal').innerHTML = `<b class="${d.direction === 'BULL' ? 'positive' : 'negative'}">FIRE · ${d.direction === 'BULL' ? 'CALL' : 'PUT'} ${FIXED_DURATION}T</b><span>200+80 aligned · ${esc(d.setup.pivotType)}→BOS PRIME · ${esc(d.pattern.reason)}</span>`;
    } else {
      $('ptSignal').innerHTML = `<b>WAIT · ${esc(d?.phase || 'SEARCHING')}</b><span>${esc(whyText(d))}</span>`;
    }
  }
}

function renderLedger() {
  const s = stats();
  $('ptQualified').textContent = String(ledger.length);
  $('ptSkipped').textContent = String(ledger.filter(r => String(r.status).startsWith('BLOCK') || String(r.status).startsWith('SKIP')).length);
  $('ptBought').textContent = String(boughtCount());
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = s.bullWL;
  $('ptBearWL').textContent = `${s.bearWL} · P ${s.pattern.saved}/${s.pattern.missed} · T ${s.timing.saved}/${s.timing.missed}`;

  if ($('ptEntryOffset')) {
    const snap = window.SaniObservatory?.getSnapshot?.();
    $('ptEntryOffset').textContent = `T+${Number(snap?.executionOffset || 1)}`;
  }

  const rows = ledger.slice(0, 250);
  $('ptLedgerRows').innerHTML = rows.length ? rows.map(r => {
    const tm = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const p = Number.isFinite(+r.patternStrength) ? `${(+r.patternStrength).toFixed(1)}% ${r.patternBias || ''}` : r.patternStatus || '—';
    const ev = Number.isFinite(+r.expectedValue) ? `${(+r.expectedValue * 100).toFixed(1)}%` : '—';
    const result = Number.isFinite(+r.contractId) ? r.status : (r.shadowOutcome ? `${r.status} · shadow ${r.shadowOutcome}` : r.status);
    const delta = Number.isFinite(+r.breakDistanceSteps) ? (+r.breakDistanceSteps).toFixed(2) + 'x' : '—';
    return `<tr><td>${tm}</td><td>${esc(r.structureDirection)}</td><td>${esc(r.pivotType || '—')}→BOS</td><td>${esc(r.timingClass || '—')}</td><td>${delta}</td><td>${esc(p)}</td><td>${r.patternMatchCount ?? '—'}</td><td>${Number.isFinite(+r.patternAvgSimilarity) ? (+r.patternAvgSimilarity).toFixed(1) + '%' : '—'}</td><td>${ev}</td><td>${r.expectedWindow || '—'}</td><td>${esc(result)}</td><td>${r.contractId ? '#' + r.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v7.2 candidates yet.</td></tr>';
}

function updateReplayControls() {
  const all = ticks();
  const maxOffset = Math.max(0, all.length - Math.min(VISUAL_TICKS, all.length));
  replayOffset = clamp(replayOffset, 0, maxOffset);
  if ($('replayLive')) $('replayLive').disabled = replayOffset === 0;
  if ($('replayNewer')) $('replayNewer').disabled = replayOffset === 0;
  if ($('replayOlder')) $('replayOlder').disabled = replayOffset >= maxOffset;
  if ($('replayWindowText')) $('replayWindowText').textContent = replayOffset === 0 ? 'LIVE · latest 220 ticks' : `${replayOffset} ticks behind live`;
}

function scaleCanvas(ctx, canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width || canvas.width);
  const h = Math.max(220, rect.height || canvas.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function draw() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const all = ticks();
  updateReplayControls();
  const end = Math.max(0, all.length - replayOffset);
  const start = Math.max(0, end - VISUAL_TICKS);
  const rows = all.slice(start, end);
  const ctx = canvas.getContext('2d');
  const { w, h } = scaleCanvas(ctx, canvas);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  for (let x = 0; x <= w; x += w / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y <= h; y += h / 5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  if (rows.length < 2) return;

  const prices = rows.map(x => x.quote);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const startEpoch = rows[0].epoch;
  const endEpoch = rows.at(-1).epoch;
  const xFor = epoch => 14 + (epoch - startEpoch) / Math.max(1, endEpoch - startEpoch) * (w - 28);
  const yFor = price => h - 22 - (price - min) / span * (h - 44);

  ctx.strokeStyle = 'rgba(215,220,229,.76)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  rows.forEach((t, i) => {
    const x = 14 + i / (rows.length - 1) * (w - 28);
    const y = yFor(t.quote);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();

  const d = lastDiagnostics;
  ctx.fillStyle = 'rgba(245,247,250,.92)';
  ctx.font = '12px system-ui';
  ctx.fillText(`200 ${d?.regime200 || '—'} · 80 ${d?.authority80 || '—'} · ${d?.direction || 'NO LOCK'} · ${d?.setup?.timingClass || 'WAIT'} · PATTERN ${d?.pattern?.status || 'WAIT'} · ${replayOffset ? 'REPLAY' : 'LIVE'}`, 16, 20);

  if (!replayOffset && d?.setup && Number.isFinite(+d.setup.bosLevel)) {
    const levelY = yFor(+d.setup.bosLevel);
    const pivotX = Number.isFinite(+d.setup.pivotEpoch) ? clamp(xFor(+d.setup.pivotEpoch), 14, w - 14) : w * .72;
    const pivotY = Number.isFinite(+d.setup.pivotQuote) ? yFor(+d.setup.pivotQuote) : levelY;
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#63b8ff';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(Math.max(14, pivotX), levelY); ctx.lineTo(w - 14, levelY); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#63b8ff';
    ctx.font = '10px system-ui';
    ctx.fillText(`BOS ${Number(d.setup.bosLevel).toFixed(2)}`, Math.min(w - 130, Math.max(18, pivotX + 8)), levelY - 6);

    if (Number.isFinite(+d.setup.pivotQuote)) {
      ctx.strokeStyle = d.direction === 'BULL' ? '#67d99a' : '#ff9b72';
      ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.arc(pivotX, pivotY, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = d.direction === 'BULL' ? '#67d99a' : '#ff9b72';
      ctx.fillText(`${d.setup.pivotType} anchor`, pivotX + 8, pivotY + (d.direction === 'BULL' ? 15 : -9));
    }
  }

  const visibleCandidates = [...legacyLedger, ...ledger].filter(r => Number(r.signalEpoch) >= startEpoch && Number(r.signalEpoch) <= endEpoch);
  for (const r of visibleCandidates) {
    const x = xFor(Number(r.signalEpoch));
    const y = yFor(Number(r.signalQuote));
    const agree = Boolean(r.agreement);
    const timingBlocked = String(r.status).startsWith('BLOCK TIMING');
    ctx.strokeStyle = agree ? '#67d99a' : timingBlocked ? '#ff7474' : '#f3c567';
    ctx.fillStyle = agree ? '#67d99a' : timingBlocked ? '#ff7474' : '#f3c567';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(x - 4, y - 4, 8, 8);
    ctx.font = '10px system-ui';
    const tag = String(r.cohort || '').includes('v7.1') ? 'OLD' : agree ? `A${r.duration || FIXED_DURATION}` : timingBlocked ? 'CHASE' : 'P';
    ctx.fillText(tag, x + 6, y - 7);

    if (Number.isFinite(+r.entrySpot) && Number.isFinite(+r.entryTickTime)) {
      const ex = xFor(+r.entryTickTime);
      const ey = yFor(+r.entrySpot);
      ctx.fillStyle = r.direction === 'CALL' ? '#67d99a' : '#ff7474';
      ctx.beginPath();
      if (r.direction === 'CALL') { ctx.moveTo(ex, ey - 10); ctx.lineTo(ex - 6, ey + 5); ctx.lineTo(ex + 6, ey + 5); }
      else { ctx.moveTo(ex, ey + 10); ctx.lineTo(ex - 6, ey - 5); ctx.lineTo(ex + 6, ey - 5); }
      ctx.closePath(); ctx.fill();
      ctx.fillText('E', ex + 7, ey - 6);
    }

    if (Number.isFinite(+r.exitSpot) && Number.isFinite(+r.exitTickTime)) {
      const xx = xFor(+r.exitTickTime);
      const xy = yFor(+r.exitSpot);
      ctx.strokeStyle = r.status === 'WON' ? '#67d99a' : '#ff7474';
      ctx.beginPath(); ctx.arc(xx, xy, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = r.status === 'WON' ? '#67d99a' : '#ff7474';
      ctx.fillText('X', xx + 7, xy - 6);
    }
  }

  const recent = rows.slice(-28);
  const pp = pivots(recent.map(x => x.quote), 2);
  const label = (items, type) => {
    let prev;
    for (const p of items.slice(-5)) {
      const text = prev === undefined ? type : type === 'H' ? (p.quote > prev ? 'HH' : 'LH') : (p.quote > prev ? 'HL' : 'LL');
      prev = p.quote;
      const t = recent[p.i];
      if (!t) continue;
      ctx.fillStyle = 'rgba(245,247,250,.82)';
      ctx.font = '10px system-ui';
      ctx.fillText(text, xFor(t.epoch) + 3, yFor(t.quote) + (type === 'H' ? -7 : 13));
    }
  };
  label(pp.highs, 'H');
  label(pp.lows, 'L');

  if ($('masterCanvasCaption')) $('masterCanvasCaption').textContent = 'STRICT 200+80 → HL/LH anchor → PRIME BOS → fixed 5T Pattern audit · OLD=v7.1 replay · A=agreement · E=entry · X=expiry';
}

function exportCsv() {
  const headers = ['cohort','observed_at','symbol','signal_epoch','signal_quote','structure_direction','pivot_type','pivot_quote','pivot_epoch','bos_level','timing_class','break_distance_steps','setup_type','regime_200','authority_80','fast_20','slope_200','slope_80','chop_score','volatility','pattern_status','pattern_reason','pattern_matches','pattern_avg_similarity','pattern_bias','pattern_strength','pattern_opposing_strength','expected_value','duration','execution_offset','expected_window','agreement','status','contract_id','profit','actual_window','latency','entry_spot','exit_spot','entry_tick_time','exit_tick_time','shadow_outcome','shadow_entry','shadow_exit'];
  const rows = ledger.map(r => [r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.signalEpoch,r.signalQuote,r.structureDirection,r.pivotType,r.pivotQuote,r.pivotEpoch,r.bosLevel,r.timingClass,r.breakDistanceSteps,r.setupType,r.regime200,r.authority80,r.fast20,r.slope200,r.slope80,r.chopScore,r.volatility,r.patternStatus,r.patternReason,r.patternMatchCount,r.patternAvgSimilarity,r.patternBias,r.patternStrength,r.patternOpposingStrength,r.expectedValue,r.duration,r.executionOffset,r.expectedWindow,r.agreement,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'',r.entryTickTime??'',r.exitTickTime??'',r.shadowOutcome??'',r.shadowEntry??'',r.shadowExit??'']);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `master-v7.2-clean-sniper-5t-${new Date().toISOString().replaceAll(':','-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onAgreementBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : null;
  baseBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade || !meta) return;
  trade.patternMeta = meta;
  trade.ledgerId = meta.ledgerId;
  contractToLedger.set(contractId, meta.ledgerId);
  patchRow(meta.ledgerId, { status: 'BOUGHT', contractId, buyAckMs: trade.sendToAckMs });
  this.emit();
};

const baseContract = engine.onContract.bind(engine);
engine.onContract = function onAgreementContract(contract) {
  const id = Number(contract?.contract_id);
  baseContract(contract);
  const trade = this.trades.find(t => Number(t.contractId) === id);
  if (!trade?.patternMeta || !(contract?.is_sold || contract?.is_expired)) return;
  const offset = actualOffset(trade);
  if (Number.isFinite(offset)) recordOffset(offset);
  const duration = Number(trade.duration || trade.patternMeta.duration || FIXED_DURATION);
  const actualWindow = Number.isFinite(offset) ? `T+${offset}→T+${offset + duration}` : 'unknown';
  patchRow(trade.ledgerId || contractToLedger.get(id), {
    status: String(trade.status || 'sold').toUpperCase(),
    profit: trade.profit,
    actualWindow,
    latencyClass: latency(offset),
    entrySpot: trade.entrySpot,
    exitSpot: trade.exitSpot,
    entryTickTime: trade.entryTickTime,
    exitTickTime: trade.exitTickTime,
    duration
  });
  draw();
  this.emit();
};

function installV72UI() {
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Pattern + Structure Sniper v7.2'));

  const hero = document.querySelector('.obsIntro');
  if (hero) {
    const eyebrow = hero.querySelector('.eyebrow');
    if (eyebrow) eyebrow.textContent = '200 + 80 ALIGN → HL/LH → PRIME BOS → PATTERN 5T → TRADE';
    const h2 = hero.querySelector('h2');
    if (h2) h2.textContent = 'Sniper means fewer excuses, not fewer trades by accident.';
    const p = hero.querySelector('p');
    if (p) p.textContent = 'v7.2 is the clean cohort: 200t and 80t must align first, HL/LH freezes the BOS level, only the PRIME first break can trade, and Pattern audits one fixed 5-tick execution window before a Demo buy.';
    const badges = hero.querySelectorAll('.obsBadges span');
    const texts = ['Demo only','200+80 strict','HL/LH anchor','PRIME BOS','Pattern active gate','fixed 5 ticks'];
    badges.forEach((el, i) => { if (texts[i]) el.textContent = texts[i]; });
  }

  const patternLens = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Pattern lens'));
  if (patternLens) patternLens.textContent = 'Pattern lens · ACTIVE GATE';
  const patternCard = patternLens?.closest('.card');
  if (patternCard) {
    const p = patternCard.querySelector('.muted');
    if (p) p.textContent = `Pattern audits PRIME BOS only after strict 200+80 alignment. Gate: ${MIN_MATCHES}+ matches, ${MIN_AVG_SIMILARITY}%+ similarity, ${MIN_PATTERN_STRENGTH}%+ fixed-${FIXED_DURATION}T edge and positive EV.`;
  }

  const scoreNote = [...document.querySelectorAll('p.muted')].find(p => p.textContent.includes('does not use these pattern scores'));
  if (scoreNote) scoreNote.textContent = 'v7.2 uses Pattern only as the final audit. Structure creates the candidate. Pattern can approve or veto, never invent direction.';

  const canvasCard = $('masterCanvas')?.closest('.card');
  if (canvasCard && !$('replayBar')) {
    const bar = document.createElement('div');
    bar.id = 'replayBar';
    bar.className = 'replayBar';
    bar.innerHTML = '<div><b>Setup replay</b><span id="replayWindowText">LIVE · latest 220 ticks</span></div><div class="actions compact"><button id="replayOlder" type="button">← Older setups</button><button id="replayNewer" type="button">Newer →</button><button id="replayLive" type="button">Live</button></div>';
    canvasCard.insertBefore(bar, $('masterCanvas'));
  }
  if (canvasCard) {
    const note = canvasCard.querySelector('p.muted');
    if (note) note.textContent = 'Replay now overlays older v7.1 setups and the fresh v7.2 cohort. Blue BOS line = frozen break level. OLD = legacy setup, A = agreement, E = actual entry, X = expiry.';
  }

  const masterSection = [...document.querySelectorAll('.card')].find(card => card.querySelector('#ptPnl'));
  if (masterSection && !$('decisionBoard')) {
    const board = document.createElement('div');
    board.id = 'decisionBoard';
    board.className = 'decisionBoard';
    board.innerHTML = `
      <div class="decisionCard"><span>1 · CONTEXT</span><strong id="dbContext">WAIT</strong><small>200 + 80 must agree</small></div>
      <div class="decisionCard"><span>2 · STRUCTURE</span><strong id="dbStructure">WAIT</strong><small>HL/LH → PRIME BOS</small></div>
      <div class="decisionCard"><span>3 · PATTERN</span><strong id="dbPattern">WAIT</strong><small>Fixed 5T historical edge</small></div>
      <div class="decisionCard"><span>4 · AGREEMENT</span><strong id="dbAgreement">NO</strong><small>Every gate must pass</small></div>
      <div class="decisionCard action"><span>5 · ACTION</span><strong id="dbAction">WAIT</strong><small>Demo buy only here</small></div>
      <div class="whyCard"><span>WHY NOT?</span><strong id="dbWhy">Waiting for analysis</strong></div>
      <div id="dbPatternMeta" class="decisionMeta">Building clean v7.2 map…</div>`;
    masterSection.insertBefore(board, $('ptSignal'));
  }

  const masterTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader v6'));
  if (masterTitle) masterTitle.textContent = 'Pattern + Structure Sniper v7.2 · Clean Sniper 5T';
  if ($('ptStart')) $('ptStart').textContent = 'Start v7.2 Clean Sniper';
  if ($('ptCooldown')) $('ptCooldown').value = '0';

  const metrics = [...document.querySelectorAll('.metric span')];
  const replacements = new Map([
    ['200t regime','200t context'],
    ['80t trend','80t authority'],
    ['Active session','Direction lock'],
    ['20t entry','Entry timing'],
    ['Bought v6','Bought v7.2'],
    ['BULL W/L','BULL W/L'],
    ['BEAR W/L','BEAR W/L · blocks']
  ]);
  for (const span of metrics) if (replacements.has(span.textContent.trim())) span.textContent = replacements.get(span.textContent.trim());

  const txTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('transactions'));
  if (txTitle) txTitle.textContent = 'v7.2 actual PRIME agreement trades · fixed 5T';
  const ledgerTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Setup Ledger'));
  if (ledgerTitle) ledgerTitle.textContent = 'v7.2 Candidate Audit Trail';

  const ledgerTable = $('ptLedgerRows')?.closest('table');
  if (ledgerTable) {
    ledgerTable.querySelector('thead').innerHTML = '<tr><th>Time</th><th>Dir</th><th>Anchor</th><th>Timing</th><th>BOS Δ</th><th>Pattern</th><th>Matches</th><th>Similarity</th><th>EV</th><th>Window</th><th>Decision / result</th><th>Contract</th></tr>';
    ledgerTable.closest('.tableWrap')?.classList.add('auditHistory');
  }

  const roadmap = document.querySelector('.observatoryRoadmap');
  if (roadmap) roadmap.innerHTML = `
    <div><b>1 · Strict context</b><span>200 ticks and 80 ticks must BOTH be BULL or BOTH be BEAR. NEUTRAL at either level means no live trade. FAST 20 is diagnostic only.</span></div>
    <div><b>2 · HL/LH anchor</b><span>BULL needs a Higher Low. BEAR needs a Lower High. That pivot is the launch pad, not the entry.</span></div>
    <div><b>3 · Freeze BOS</b><span>The break level comes from ticks that existed before the current move. The breakout cannot move its own goalpost.</span></div>
    <div><b>4 · PRIME timing</b><span>Only the first BOS break inside ${MAX_BREAK_EXTENSION_STEPS.toFixed(2)} average tick is live-tradable. Late CHASE breaks stay in shadow audit.</span></div>
    <div><b>5 · Pattern + EV</b><span>Need ${MIN_MATCHES}+ relatives, ${MIN_AVG_SIMILARITY}%+ similarity, ${MIN_PATTERN_STRENGTH}%+ directional edge on fixed ${FIXED_DURATION}T and EV above ${(MIN_EXPECTED_VALUE*100).toFixed(0)}%.</span></div>
    <div><b>6 · Demo execution</b><span>Only full agreement reaches Deriv. One open contract, no martingale, fresh v7.2 cohort. v7.1 remains visible in replay for comparison.</span></div>`;

  const style = document.createElement('style');
  style.id = 'v72Style';
  style.textContent = `
    html{overflow-anchor:none}
    .decisionBoard{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:16px 0;min-height:150px}
    .decisionCard,.whyCard{background:#0f1115;border:1px solid #2a2e37;border-radius:14px;padding:14px;min-width:0}
    .decisionCard span,.decisionCard small,.whyCard span{display:block;color:#9299a8;font-size:10px}.decisionCard strong,.whyCard strong{display:block;margin:7px 0;font-size:15px;line-height:1.25;overflow-wrap:anywhere}.decisionCard.action{border-color:#4a5260}
    .whyCard{grid-column:1/3;border-color:#3b3030}.whyCard strong{font-size:13px}
    .decisionMeta{grid-column:3/-1;color:#9299a8;font-size:11px;padding:10px 4px;min-height:34px}
    .replayBar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:4px 0 10px;min-height:52px}.replayBar>div:first-child{display:flex;flex-direction:column;gap:3px}.replayBar span{color:#9299a8;font-size:11px}
    .auditHistory{height:420px;max-height:420px;overflow:auto;scrollbar-gutter:stable}.logs{height:250px!important;max-height:250px!important}.observatoryCanvasCard{min-height:540px}#masterCanvas{height:430px}.metricRow{align-items:stretch}.metric{min-height:68px}
    @media(max-width:1050px){.decisionBoard{grid-template-columns:repeat(2,1fr)}.whyCard,.decisionMeta{grid-column:1/-1}}
    @media(max-width:900px){.replayBar{align-items:flex-start;flex-direction:column}.observatoryCanvasCard{min-height:510px}}
    @media(max-width:560px){.decisionBoard{grid-template-columns:1fr}.whyCard,.decisionMeta{grid-column:1}.observatoryCanvasCard{min-height:480px}#masterCanvas{height:370px}}
  `;
  document.head.appendChild(style);

  $('replayOlder')?.addEventListener('click', () => { replayOffset += REPLAY_STEP; draw(); });
  $('replayNewer')?.addEventListener('click', () => { replayOffset = Math.max(0, replayOffset - REPLAY_STEP); draw(); });
  $('replayLive')?.addEventListener('click', () => { replayOffset = 0; draw(); });
}

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
  } catch (error) {
    showError(error.message);
  } finally {
    $('ptLoadAccounts').disabled = false;
  }
};

$('ptAccount').onchange = () => {
  localStorage.setItem('sani.deriv.accountId', $('ptAccount').value);
  lastOtpContext = null;
  renderGate();
};

$('ptConnect').onclick = async () => {
  clearError();
  try {
    traderConfig();
    lastOtpContext = auth();
    $('ptConnect').disabled = true;
    await engine.connect(freshWs);
  } catch (error) {
    showError(error.message);
  } finally {
    renderGate();
  }
};

$('ptDisconnect').onclick = () => {
  engine.disconnect();
  lastOtpContext = null;
};

$('ptStart').onclick = () => {
  clearError();
  try {
    auth();
    traderConfig();
    if (boughtCount() >= +($('ptMaxTrades').value || 100)) throw new Error('v7.2 cohort cap reached.');
    engine.start();
    engine.log('info', 'v7.2 armed: strict 200+80 → HL/LH → PRIME BOS → fixed 5T Pattern + EV → Demo buy.');
  } catch (error) {
    showError(error.message);
  }
};

$('ptPause').onclick = () => engine.pause();
$('ptStop').onclick = () => engine.stop();
$('ptReset').onclick = () => {
  try {
    engine.resetSession();
    lastSignalEpoch = 0;
    lastCandidateKey = '';
  } catch (error) {
    showError(error.message);
  }
};

$('ptClearLedger').onclick = () => {
  if (confirm('Clear the fresh v7.2 cohort? Older v7.1 replay history stays intact.')) {
    ledger = [];
    localStorage.removeItem(LEDGER_KEY);
    lastCandidateKey = '';
    renderLedger();
    draw();
  }
};

$('ptResetCalibration').onclick = () => {
  if (confirm('Reset measured execution offset?')) {
    localStorage.removeItem(OFFSET_KEY);
    renderLedger();
  }
};

$('ptExportLedger').onclick = exportCsv;

for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) {
  $(id)?.addEventListener('change', () => {
    try { if (!engine.snapshot().running) traderConfig(); } catch (error) { showError(error.message); }
  });
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
    const expected = meta.expectedWindow || '—';
    const row = ledger.find(r => Number(r.contractId) === Number(trade.contractId));
    const entryType = `${meta.pivotType || '—'}→BOS ${meta.timingClass || '—'} Δ${Number.isFinite(+meta.breakDistanceSteps) ? (+meta.breakDistanceSteps).toFixed(2) + 'x' : '—'} + PATTERN ${Number.isFinite(+meta.patternStrength) ? (+meta.patternStrength).toFixed(1) + '%' : '—'}`;
    return `<tr><td>#${trade.contractId}</td><td>${esc(meta.structureDirection || '—')}</td><td>${trade.direction}</td><td>${esc(entryType)}</td><td><span class="result ${trade.status}">${trade.status}</span></td><td>${trade.duration}t</td><td>${expected}</td><td>${row?.actualWindow || '—'}</td><td>${row?.latencyClass || '—'}</td><td class="${(trade.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${trade.profit === undefined ? '—' : `${trade.profit >= 0 ? '+' : ''}${Number(trade.profit).toFixed(2)}`}</td><td>${trade.sendToAckMs === undefined ? '—' : Number(trade.sendToAckMs).toFixed(0) + 'ms'}</td><td>${trade.entrySpot ?? '—'} → ${trade.exitSpot ?? '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v7.2 PRIME agreement trades yet.</td></tr>';

  if (state.logs?.[0]) $('ptLogs').innerHTML = state.logs.slice(0, 60).map(log => `<div class="log ${log.level}"><time>${new Date(log.at).toLocaleTimeString()}</time><span>${esc(log.message === 'Engine armed. Waiting for fresh BOS.' ? 'v7.2 clean sniper armed.' : log.message)}</span></div>`).join('');
  renderLedger();
  draw();
});

window.addEventListener('DOMContentLoaded', () => {
  installV72UI();
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger();
  draw();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snapshot = window.SaniObservatory?.getSnapshot?.();
  if (snapshot) {
    lastDiagnostics = evaluate(snapshot);
    renderDecision(lastDiagnostics);
    draw();
  }
});
