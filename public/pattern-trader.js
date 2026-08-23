import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.2';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const MAX_LEDGER = 5000;
const FIXED_HORIZON = 3;
const LONG_WINDOW = 200;
const MEDIUM_WINDOW = 80;
const ENTRY_WINDOW = 20;
const CONFIRMED_SESSION_TICKS = 3;
const TRANSITION_SESSION_TICKS = 5;
const INVALIDATION_TICKS = 4;
const NEUTRAL_BUFFER_TICKS = 2;
const MIN_QUALITY = 60;
const MAX_TRADES_PER_SESSION = 2;
const PRIME_DELAY_AFTER_PROOF = 4;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastAnalysis = null;
let lastDiagnostics = null;
let lastTradeSignalEpoch = 0;
let cooldownUntilEpoch = 0;
let signalLedger = loadArray(LEDGER_KEY);
const contractToLedger = new Map();

const strategyState = {
  session: 'NEUTRAL',
  sessionMode: 'NEUTRAL',
  phase: 'NEUTRAL',
  candidate: 'NEUTRAL',
  candidateMode: 'NEUTRAL',
  candidateCount: 0,
  invalidationCount: 0,
  neutralUntilEpoch: 0,
  sessionId: 0,
  sessionTradeCount: 0,
  proofEpoch: 0,
  proofSetupKey: '',
  lastSetupKey: ''
};

const config = {
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: FIXED_HORIZON,
  durationUnit: 't',
  executionMethod: 'direct',
  oneOpenContract: true,
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 100,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  maxSignalToSendMs: 500,
  reconnect: true,
  maxReconnectAttempts: 8
};

const engine = new SaniEngine(config);
engine.onTick = function masterTraderTick(tick) {
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
  signalLedger = signalLedger.slice(0, MAX_LEDGER);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(signalLedger)); } catch {}
}
function rawTicks(symbol = currentSymbol()) {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol}`) || '[]');
    return Array.isArray(rows)
      ? rows.map(t => ({ epoch: Number(t.epoch), quote: Number(t.quote) }))
        .filter(t => Number.isFinite(t.epoch) && Number.isFinite(t.quote))
        .sort((a, b) => a.epoch - b.epoch)
      : [];
  } catch { return []; }
}
function currentSymbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function entryOffsets() {
  return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50);
}
function entryOffsetEstimate() {
  const rows = entryOffsets().map(v => Math.max(1, Math.min(10, Math.round(v)))).sort((a, b) => a - b);
  if (!rows.length) return 1;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : Math.round((rows[mid - 1] + rows[mid]) / 2);
}
function recordEntryOffset(value) {
  value = Number(value);
  if (!Number.isFinite(value)) return;
  const rows = entryOffsets();
  rows.push(Math.max(1, Math.min(10, Math.round(value))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(rows.slice(-50))); } catch {}
  window.dispatchEvent(new CustomEvent('sani-pattern-offset-updated'));
}
function actualEntryOffset(trade) {
  const signalEpoch = Number(trade?.signalEpoch);
  const entryTick = Number(trade?.entryTickTime);
  if (Number.isFinite(signalEpoch) && Number.isFinite(entryTick)) return Math.max(1, Math.round(entryTick - signalEpoch));
  const startTime = Number(trade?.startTime);
  if (Number.isFinite(signalEpoch) && Number.isFinite(startTime)) return Math.max(1, Math.round(startTime - signalEpoch) + 1);
  return undefined;
}
function latencyClass(offset) {
  offset = Number(offset);
  if (!Number.isFinite(offset)) return 'UNKNOWN';
  if (offset <= 1) return 'CLEAN';
  if (offset === 2) return 'LATE +1';
  return 'LATE +2+';
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(values) { return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0; }
function avgStep(prices) {
  if (prices.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < prices.length; i += 1) sum += Math.abs(prices[i] - prices[i - 1]);
  return sum / (prices.length - 1);
}
function efficiency(prices) {
  if (prices.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < prices.length; i += 1) path += Math.abs(prices[i] - prices[i - 1]);
  return path ? Math.abs(prices.at(-1) - prices[0]) / path : 0;
}
function turnRate(prices) {
  const signs = [];
  for (let i = 1; i < prices.length; i += 1) {
    const d = prices[i] - prices[i - 1];
    if (d !== 0) signs.push(Math.sign(d));
  }
  if (signs.length < 2) return 0;
  let turns = 0;
  for (let i = 1; i < signs.length; i += 1) if (signs[i] !== signs[i - 1]) turns += 1;
  return turns / (signs.length - 1);
}
function linearSlope(prices) {
  const n = prices.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(prices);
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    num += dx * (prices[i] - yMean);
    den += dx * dx;
  }
  return den ? num / den : 0;
}
function pivots(prices, radius = 2) {
  const highs = [], lows = [];
  for (let i = radius; i < prices.length - radius; i += 1) {
    const left = prices.slice(i - radius, i);
    const right = prices.slice(i + 1, i + radius + 1);
    const high = left.every(v => prices[i] >= v) && right.every(v => prices[i] >= v)
      && [...left, ...right].some(v => prices[i] > v);
    const low = left.every(v => prices[i] <= v) && right.every(v => prices[i] <= v)
      && [...left, ...right].some(v => prices[i] < v);
    if (high) highs.push({ i, quote: prices[i] });
    if (low) lows.push({ i, quote: prices[i] });
  }
  return { highs, lows };
}
function structureClass(prices, radius) {
  const p = pivots(prices, radius);
  const h = p.highs.slice(-2), l = p.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}
function windowMetrics(rows, radius = 3) {
  const prices = rows.map(t => t.quote);
  const step = avgStep(prices);
  const slope = linearSlope(prices);
  return {
    slopeNorm: step ? slope / step : 0,
    efficiency: efficiency(prices),
    turnRate: turnRate(prices),
    avgStep: step,
    net: prices.length ? prices.at(-1) - prices[0] : 0,
    structure: structureClass(prices, radius)
  };
}
function classifyTrend(m, kind) {
  const slopeThreshold = kind === 'LONG' ? 0.055 : 0.07;
  const effThreshold = kind === 'LONG' ? 0.10 : 0.11;
  const bullVotes = [m.slopeNorm >= slopeThreshold, m.efficiency >= effThreshold, m.net > 0, m.structure === 'BULL'].filter(Boolean).length;
  const bearVotes = [m.slopeNorm <= -slopeThreshold, m.efficiency >= effThreshold, m.net < 0, m.structure === 'BEAR'].filter(Boolean).length;
  if (bullVotes >= 3 && m.slopeNorm > 0) return 'BULL';
  if (bearVotes >= 3 && m.slopeNorm < 0) return 'BEAR';
  return 'NEUTRAL';
}
function classifyActive80(m) {
  if (Math.abs(m.slopeNorm) < 0.10 || m.efficiency < 0.085) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0 && (m.structure === 'BULL' || m.slopeNorm >= 0.16)) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0 && (m.structure === 'BEAR' || m.slopeNorm <= -0.16)) return 'BEAR';
  return 'NEUTRAL';
}
function chopDiagnostics(m80, m20) {
  const lowEfficiency = clamp((0.18 - m80.efficiency) / 0.18, 0, 1);
  const highTurns = clamp((m80.turnRate - 0.45) / 0.25, 0, 1);
  const weakSlope = clamp((0.08 - Math.abs(m80.slopeNorm)) / 0.08, 0, 1);
  const entryWhipsaw = clamp((m20.turnRate - 0.58) / 0.25, 0, 1);
  const score = (lowEfficiency + highTurns + weakSlope + entryWhipsaw) / 4;
  return { score, isChop: score >= 0.62 };
}
function volatilityState(m200, m80, m20) {
  const shortMedium = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const mediumLong = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (shortMedium < 0.45 || mediumLong < 0.55) return 'DEAD';
  if (shortMedium > 1.90 || m20.turnRate > 0.80) return 'CHAOTIC';
  return 'HEALTHY';
}
function timeframeMode(regime200, active80) {
  if (active80 === 'NEUTRAL') return 'NEUTRAL';
  return regime200 === active80 ? 'CONFIRMED' : 'TRANSITION';
}

function resetSessionState() {
  strategyState.session = 'NEUTRAL';
  strategyState.sessionMode = 'NEUTRAL';
  strategyState.phase = 'NEUTRAL';
  strategyState.candidate = 'NEUTRAL';
  strategyState.candidateMode = 'NEUTRAL';
  strategyState.candidateCount = 0;
  strategyState.invalidationCount = 0;
  strategyState.proofEpoch = 0;
  strategyState.proofSetupKey = '';
  strategyState.sessionTradeCount = 0;
  strategyState.lastSetupKey = '';
}
function updateSession(regime200, active80, chop, volatility, epoch) {
  const tradable = !chop && volatility === 'HEALTHY' ? active80 : 'NEUTRAL';
  const proposedMode = timeframeMode(regime200, tradable);

  if (strategyState.session === 'NEUTRAL') {
    if (epoch < strategyState.neutralUntilEpoch) return;
    if (tradable === 'NEUTRAL') {
      strategyState.candidate = 'NEUTRAL';
      strategyState.candidateCount = 0;
      return;
    }
    if (strategyState.candidate === tradable && strategyState.candidateMode === proposedMode) strategyState.candidateCount += 1;
    else {
      strategyState.candidate = tradable;
      strategyState.candidateMode = proposedMode;
      strategyState.candidateCount = 1;
    }
    const needed = proposedMode === 'CONFIRMED' ? CONFIRMED_SESSION_TICKS : TRANSITION_SESSION_TICKS;
    if (strategyState.candidateCount >= needed) {
      strategyState.session = tradable;
      strategyState.sessionMode = proposedMode;
      strategyState.phase = proposedMode === 'CONFIRMED' ? 'PRIME' : 'EARLY';
      strategyState.sessionId += 1;
      strategyState.sessionTradeCount = 0;
      strategyState.invalidationCount = 0;
      strategyState.proofEpoch = 0;
      strategyState.proofSetupKey = '';
      strategyState.lastSetupKey = '';
    }
    return;
  }

  if (tradable === strategyState.session) {
    strategyState.invalidationCount = 0;
    strategyState.sessionMode = regime200 === strategyState.session ? 'CONFIRMED' : 'TRANSITION';
    if (strategyState.phase === 'EARLY' && strategyState.sessionMode === 'CONFIRMED') strategyState.phase = 'PRIME';
    return;
  }

  strategyState.invalidationCount += tradable === 'NEUTRAL' ? 1 : 2;
  if (strategyState.invalidationCount >= INVALIDATION_TICKS) {
    resetSessionState();
    strategyState.neutralUntilEpoch = epoch + NEUTRAL_BUFFER_TICKS;
  }
}

function setupFor(rows20, session, relaxed = false) {
  const prices = rows20.map(t => t.quote);
  const p = pivots(prices, 2);
  const current = prices.at(-1), previous = prices.at(-2);
  const step = avgStep(prices) || 1;
  if (prices.length < ENTRY_WINDOW) return { ready: false, type: 'WAIT', reason: 'Need 20 ticks' };

  if (session === 'BULL') {
    const latestLow = p.lows.at(-1);
    if (!latestLow || latestLow.i < 4) return { ready: false, type: 'WAIT', reason: 'Need pullback low' };
    const lows = p.lows.slice(-2);
    const priorHigh = p.highs.filter(h => h.i < latestLow.i).at(-1);
    if (!priorHigh) return { ready: false, type: 'WAIT', reason: 'No prior high before pullback' };
    const isHL = relaxed
      ? latestLow.quote > Math.min(...prices.slice(0, latestLow.i))
      : lows.length >= 2 && latestLow.quote > lows[lows.length - 2].quote;
    if (!isHL) return { ready: false, type: 'WAIT', reason: relaxed ? 'Transition low is not higher' : 'Latest low is not a Higher Low' };
    const recovery = prices.slice(latestLow.i + 1, -1);
    if (recovery.length < 2) return { ready: false, type: 'WAIT', reason: 'Pullback still forming' };
    const resumeLevel = Math.max(...recovery);
    const depth = priorHigh.quote - latestLow.quote;
    const impulseRatio = Math.abs(current - previous) / step;
    const extensionRatio = Math.abs(current - latestLow.quote) / step;
    return {
      ready: current > resumeLevel && previous <= resumeLevel,
      type: relaxed ? 'PROOF_HL_BREAK' : 'HL_BREAK',
      reason: relaxed ? 'Early bullish proof break' : 'Prime Higher Low resumption',
      setupKey: `${strategyState.sessionId}:BULL:${relaxed ? 'PROOF' : 'HL'}:${rows20[latestLow.i]?.epoch}`,
      pullbackDepth: depth,
      pullbackRatio: depth / step,
      resumeLevel,
      impulseRatio,
      extensionRatio
    };
  }

  if (session === 'BEAR') {
    const latestHigh = p.highs.at(-1);
    if (!latestHigh || latestHigh.i < 4) return { ready: false, type: 'WAIT', reason: 'Need pullback high' };
    const highs = p.highs.slice(-2);
    const priorLow = p.lows.filter(l => l.i < latestHigh.i).at(-1);
    if (!priorLow) return { ready: false, type: 'WAIT', reason: 'No prior low before pullback' };
    const isLH = relaxed
      ? latestHigh.quote < Math.max(...prices.slice(0, latestHigh.i))
      : highs.length >= 2 && latestHigh.quote < highs[highs.length - 2].quote;
    if (!isLH) return { ready: false, type: 'WAIT', reason: relaxed ? 'Transition high is not lower' : 'Latest high is not a Lower High' };
    const recovery = prices.slice(latestHigh.i + 1, -1);
    if (recovery.length < 2) return { ready: false, type: 'WAIT', reason: 'Pullback still forming' };
    const resumeLevel = Math.min(...recovery);
    const depth = latestHigh.quote - priorLow.quote;
    const impulseRatio = Math.abs(current - previous) / step;
    const extensionRatio = Math.abs(current - latestHigh.quote) / step;
    return {
      ready: current < resumeLevel && previous >= resumeLevel,
      type: relaxed ? 'PROOF_LH_BREAK' : 'LH_BREAK',
      reason: relaxed ? 'Early bearish proof break' : 'Prime Lower High resumption',
      setupKey: `${strategyState.sessionId}:BEAR:${relaxed ? 'PROOF' : 'LH'}:${rows20[latestHigh.i]?.epoch}`,
      pullbackDepth: depth,
      pullbackRatio: depth / step,
      resumeLevel,
      impulseRatio,
      extensionRatio
    };
  }

  return { ready: false, type: 'WAIT', reason: 'No active session' };
}

function entryQuality(d, setup) {
  let score = 0;
  const reasons = [];
  const slope = Math.abs(d.m80.slopeNorm);
  if (d.sessionMode === 'CONFIRMED') { score += 12; reasons.push('macro aligned'); }
  else { score += 5; reasons.push('transition'); }

  if (d.m80.efficiency >= 0.16) score += 18;
  else if (d.m80.efficiency >= 0.11) score += 12;
  else score += 5;

  if (slope >= 0.22) score += 18;
  else if (slope >= 0.14) score += 13;
  else if (slope >= 0.10) score += 7;

  if (d.chopScore <= 0.20) score += 16;
  else if (d.chopScore <= 0.35) score += 11;
  else if (d.chopScore <= 0.50) score += 5;

  if (setup.impulseRatio >= 0.70) score += 18;
  else if (setup.impulseRatio >= 0.40) score += 11;
  else score += 3;

  if (setup.pullbackRatio >= 0.50 && setup.pullbackRatio <= 4.5) score += 12;
  else if (setup.pullbackRatio >= 0.25 && setup.pullbackRatio <= 6) score += 6;

  if (setup.extensionRatio > 7) { score -= 25; reasons.push('overextended'); }
  else if (setup.extensionRatio > 5.5) { score -= 12; reasons.push('late chase'); }

  if (strategyState.sessionTradeCount === 0) score += 4;
  if (strategyState.sessionTradeCount === 1) score += 10;
  if (strategyState.sessionTradeCount >= 2) score -= 30;

  return { score: clamp(Math.round(score), 0, 100), reasons };
}

function evaluateMaster(snapshot) {
  const rows = rawTicks(snapshot?.symbol || currentSymbol());
  if (rows.length < LONG_WINDOW) return { ready: false, reason: `Need ${LONG_WINDOW} ticks (${rows.length}/${LONG_WINDOW})`, rows, phase: 'WARMING' };

  const rows200 = rows.slice(-LONG_WINDOW);
  const rows80 = rows.slice(-MEDIUM_WINDOW);
  const rows20 = rows.slice(-ENTRY_WINDOW);
  const m200 = windowMetrics(rows200, 4);
  const m80 = windowMetrics(rows80, 3);
  const m20 = windowMetrics(rows20, 2);
  const regime200 = classifyTrend(m200, 'LONG');
  const active80 = classifyActive80(m80);
  const chopD = chopDiagnostics(m80, m20);
  const volatility = volatilityState(m200, m80, m20);
  const epoch = rows.at(-1).epoch;
  const quote = rows.at(-1).quote;
  const conflict = regime200 !== 'NEUTRAL' && active80 !== 'NEUTRAL' && regime200 !== active80;

  updateSession(regime200, active80, chopD.isChop, volatility, epoch);

  let proofSetup = { ready: false, type: 'WAIT' };
  if (strategyState.session !== 'NEUTRAL' && strategyState.phase === 'EARLY') {
    proofSetup = setupFor(rows20, strategyState.session, true);
    if (proofSetup.ready && proofSetup.setupKey !== strategyState.proofSetupKey) {
      strategyState.proofEpoch = epoch;
      strategyState.proofSetupKey = proofSetup.setupKey;
      strategyState.phase = 'PRIME_ARMED';
      recordProof(snapshot, { regime200, active80, chopScore: chopD.score, volatility, m200, m80, proofSetup });
    }
  }

  if (strategyState.phase === 'PRIME_ARMED' && epoch - strategyState.proofEpoch >= PRIME_DELAY_AFTER_PROOF) {
    strategyState.phase = 'PRIME';
  }
  if (strategyState.sessionTradeCount >= MAX_TRADES_PER_SESSION) strategyState.phase = 'LATE';
  if (strategyState.session !== 'NEUTRAL' && (m80.efficiency < 0.075 || Math.abs(m80.slopeNorm) < 0.085 || chopD.score > 0.55)) {
    if (strategyState.sessionTradeCount > 0) strategyState.phase = 'LATE';
  }

  const setup = strategyState.session !== 'NEUTRAL' ? setupFor(rows20, strategyState.session, false) : { ready: false, type: 'WAIT', reason: 'No active session' };
  const quality = setup.ready ? entryQuality({ sessionMode: strategyState.sessionMode, m80, chopScore: chopD.score }, setup) : { score: 0, reasons: [] };

  let reason = setup.reason || 'Waiting';
  if (chopD.isChop) reason = `CHOP veto ${(chopD.score * 100).toFixed(0)}%`;
  else if (volatility !== 'HEALTHY') reason = `Volatility ${volatility}`;
  else if (active80 === 'NEUTRAL') reason = '80-tick active trend neutral';
  else if (strategyState.session === 'NEUTRAL') reason = `${timeframeMode(regime200, active80)} ${active80} candidate ${strategyState.candidateCount}`;
  else if (strategyState.phase === 'EARLY') reason = 'EARLY: waiting for first proof pullback, no money yet';
  else if (strategyState.phase === 'PRIME_ARMED') reason = `Proof seen: waiting ${Math.max(0, PRIME_DELAY_AFTER_PROOF - (epoch - strategyState.proofEpoch))} ticks for PRIME`;
  else if (strategyState.phase === 'LATE') reason = 'LATE/EXHAUSTING: no new entries';
  else if (setup.ready && quality.score < MIN_QUALITY) reason = `Setup quality ${quality.score}/100 below ${MIN_QUALITY}`;
  else if (setup.setupKey && setup.setupKey === strategyState.lastSetupKey) reason = 'Pullback already traded';

  const ready = Boolean(
    strategyState.session !== 'NEUTRAL'
    && strategyState.phase === 'PRIME'
    && active80 === strategyState.session
    && !chopD.isChop
    && volatility === 'HEALTHY'
    && setup.ready
    && setup.setupKey !== strategyState.lastSetupKey
    && quality.score >= MIN_QUALITY
    && strategyState.sessionTradeCount < MAX_TRADES_PER_SESSION
  );

  return {
    ready, reason, rows, epoch, quote,
    regime200, active80, conflict,
    session: strategyState.session,
    sessionMode: strategyState.sessionMode,
    phase: strategyState.phase,
    sessionId: strategyState.sessionId,
    sessionTradeCount: strategyState.sessionTradeCount,
    chop: chopD.isChop,
    chopScore: chopD.score,
    volatility,
    m200, m80, m20,
    setup, quality,
    proofEpoch: strategyState.proofEpoch
  };
}

function recordProof(snapshot, d) {
  const p = d.proofSetup;
  const key = `proof:${currentSymbol()}:${snapshot?.epoch}:${p.setupKey}`;
  if (signalLedger.some(r => r.signalKey === key)) return;
  signalLedger.unshift({
    id: `proof-${Date.now()}`,
    cohort: 'v6.2-phase-aware',
    signalKey: key,
    observedAt: Date.now(),
    symbol: currentSymbol(),
    epoch: Number(snapshot?.epoch),
    quote: Number(snapshot?.quote),
    session: strategyState.session,
    sessionMode: strategyState.sessionMode,
    phase: 'EARLY_PROOF',
    direction: strategyState.session === 'BULL' ? 'CALL' : 'PUT',
    entryType: p.type,
    slope200: d.m200.slopeNorm,
    slope80: d.m80.slopeNorm,
    efficiency80: d.m80.efficiency,
    chopScore: d.chopScore,
    volatility: d.volatility,
    pullbackRatio: p.pullbackRatio,
    impulseRatio: p.impulseRatio,
    status: 'PROOF ONLY'
  });
  saveLedger();
}
function buildSignal(snapshot, d) {
  if (!d.ready) return null;
  const direction = d.session === 'BULL' ? 'CALL' : 'PUT';
  const offset = Number(snapshot?.executionOffset ?? entryOffsetEstimate());
  return {
    symbol: snapshot?.symbol || currentSymbol(),
    epoch: Number(snapshot?.epoch ?? d.epoch),
    quote: Number(snapshot?.quote ?? d.quote),
    direction,
    session: d.session,
    sessionMode: d.sessionMode,
    phase: d.phase,
    sessionId: d.sessionId,
    entryType: d.setup.type,
    setupKey: d.setup.setupKey,
    quality: d.quality.score,
    pullbackRatio: d.setup.pullbackRatio,
    impulseRatio: d.setup.impulseRatio,
    extensionRatio: d.setup.extensionRatio,
    regime200: d.regime200,
    active80: d.active80,
    slope200: d.m200.slopeNorm,
    efficiency200: d.m200.efficiency,
    slope80: d.m80.slopeNorm,
    efficiency80: d.m80.efficiency,
    chopScore: d.chopScore,
    volatility: d.volatility,
    executionOffset: offset
  };
}
function signalKey(s) { return `${s.symbol}:${s.epoch}:${s.setupKey}`; }
function ensureLedgerRow(s) {
  const key = signalKey(s);
  let row = signalLedger.find(r => r.signalKey === key);
  if (row) return row;
  row = {
    id: `mt62-${s.epoch}-${Date.now()}`,
    cohort: 'v6.2-phase-aware',
    signalKey: key,
    observedAt: Date.now(),
    symbol: s.symbol,
    epoch: s.epoch,
    quote: s.quote,
    session: s.session,
    sessionMode: s.sessionMode,
    phase: s.phase,
    sessionId: s.sessionId,
    direction: s.direction,
    entryType: s.entryType,
    quality: s.quality,
    pullbackRatio: s.pullbackRatio,
    impulseRatio: s.impulseRatio,
    extensionRatio: s.extensionRatio,
    regime200: s.regime200,
    active80: s.active80,
    slope200: s.slope200,
    efficiency200: s.efficiency200,
    slope80: s.slope80,
    efficiency80: s.efficiency80,
    chopScore: s.chopScore,
    volatility: s.volatility,
    expectedOffset: s.executionOffset,
    expectedWindow: `T+${s.executionOffset}→T+${s.executionOffset + FIXED_HORIZON}`,
    status: 'QUALIFIED'
  };
  signalLedger.unshift(row);
  saveLedger();
  return row;
}
function updateLedger(id, patch) {
  const row = signalLedger.find(r => r.id === id);
  if (!row) return;
  Object.assign(row, patch, { updatedAt: Date.now() });
  saveLedger();
}
function boughtCount() { return signalLedger.filter(r => Number.isFinite(Number(r.contractId))).length; }
function settledRows() { return signalLedger.filter(r => r.status === 'WON' || r.status === 'LOST'); }
function cohortStats() {
  const rows = settledRows();
  const wins = rows.filter(r => r.status === 'WON').length;
  const losses = rows.filter(r => r.status === 'LOST').length;
  const pnl = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
  const bull = rows.filter(r => r.session === 'BULL');
  const bear = rows.filter(r => r.session === 'BEAR');
  return {
    wins, losses, pnl,
    bullWins: bull.filter(r => r.status === 'WON').length,
    bullLosses: bull.filter(r => r.status === 'LOST').length,
    bearWins: bear.filter(r => r.status === 'WON').length,
    bearLosses: bear.filter(r => r.status === 'LOST').length
  };
}

function showTraderError(message) { $('traderError').textContent = message; $('traderError').classList.remove('hidden'); }
function clearTraderError() { $('traderError').textContent = ''; $('traderError').classList.add('hidden'); }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `API ${response.status}`);
  return json;
}
function readTraderConfig() {
  const next = {
    ...engine.config,
    symbol: currentSymbol(),
    stake: Number($('ptStake').value),
    takeProfit: Number($('ptTakeProfit').value),
    stopLoss: Number($('ptStopLoss').value),
    maxTrades: Number($('ptMaxTrades').value),
    duration: FIXED_HORIZON,
    durationUnit: 't',
    executionMethod: 'direct',
    oneOpenContract: true,
    maxSignalToSendMs: 500,
    currency: selectedAccount?.currency || 'USD',
    reconnect: true,
    maxReconnectAttempts: 8
  };
  if (!(next.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!engine.snapshot().running) engine.setConfig(next);
  return next;
}
function getAuthContext() {
  const appId = $('ptAppId').value.trim();
  const token = $('ptToken').value.trim();
  const accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  if (String(selectedAccount.account_type).toLowerCase() === 'real') throw new Error('Master Trader v6.2 is Demo-only.');
  return { appId, token, accountId };
}
async function freshWsUrl() {
  const data = await api('otp', lastOtpContext || getAuthContext());
  if (!data.url) throw new Error('OTP response did not include a WebSocket URL.');
  return data.url;
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
  renderAccountGate();
}
function renderAccountGate() {
  selectedAccount = accounts.find(a => a.account_id === $('ptAccount').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('ptRealGate').classList.toggle('hidden', !real);
  $('ptAccountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
  $('ptAccountPill').classList.toggle('real', real);
  $('ptConnect').disabled = !selectedAccount || real;
}

function maybeTrade(snapshot) {
  lastAnalysis = snapshot;
  const d = evaluateMaster(snapshot);
  lastDiagnostics = d;
  renderMasterState(d);
  drawMasterCanvas();
  renderLedger();
  const signal = buildSignal(snapshot, d);
  if (!signal) return;

  const row = ensureLedgerRow(signal);
  const state = engine.snapshot();
  if (signal.epoch <= lastTradeSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) return updateLedger(row.id, { status: 'SKIP STALE' });
  if (state.safeBlocked) return updateLedger(row.id, { status: 'SKIP SAFE PAUSE' });
  if (!state.running) return updateLedger(row.id, { status: state.connected ? 'OBSERVED' : 'SKIP DISCONNECTED' });
  if (boughtCount() >= Number($('ptMaxTrades').value || 100)) {
    updateLedger(row.id, { status: 'SKIP COHORT COMPLETE' });
    engine.pause();
    return;
  }
  const cooldownTicks = Number($('ptCooldown').value || 10);
  if (signal.epoch < cooldownUntilEpoch) return updateLedger(row.id, { status: 'SKIP COOLDOWN' });
  if (state.pendingTrade || state.openContracts > 0) return updateLedger(row.id, { status: 'SKIP OPEN' });

  try {
    readTraderConfig();
    lastTradeSignalEpoch = signal.epoch;
    cooldownUntilEpoch = signal.epoch + cooldownTicks;
    const now = perfNow();
    updateLedger(row.id, { status: 'ORDER SENT', sessionTradeNumber: strategyState.sessionTradeCount + 1 });
    engine.execute({
      direction: signal.direction,
      structure: 'master-v6.2-prime-entry',
      epoch: signal.epoch,
      quote: signal.quote,
      detectedPerf: now,
      detectedWallMs: Date.now(),
      patternMeta: { ...signal, ledgerId: row.id, expectedWindow: row.expectedWindow, sessionTradeNumber: strategyState.sessionTradeCount + 1 }
    });
    engine.log('success', `MASTER v6.2 PRIME ${signal.session} ${signal.direction} · quality ${signal.quality}/100 · ${signal.entryType} · 3t.`);
  } catch (error) {
    updateLedger(row.id, { status: 'ERROR', error: error.message });
    showTraderError(error.message);
    engine.pause();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function renderMasterState(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d?.active80 || '—');
  set('mtSession', d?.session ? `${d.session}${d.phase && d.phase !== 'NEUTRAL' ? ' · ' + d.phase : ''}` : 'NEUTRAL');
  set('mtEntry20', d?.setup?.type || 'WAIT');
  set('mtChop', d ? `${d.chop ? 'VETO' : 'CLEAR'} · ${(Number(d.chopScore || 0) * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');

  if (!d || !d.ready) {
    const q = d?.quality?.score ? ` · quality ${d.quality.score}/100` : '';
    $('ptSignal').innerHTML = `<b>WAIT · ${escapeHtml(d?.phase || 'NEUTRAL')}</b><span>${escapeHtml(d?.reason || 'Waiting for phase-aware entry.')}${q}</span>`;
  } else {
    const direction = d.session === 'BULL' ? 'CALL' : 'PUT';
    $('ptSignal').innerHTML = `<b class="${direction === 'CALL' ? 'positive' : 'negative'}">PRIME ${d.session} · ${direction} · ${d.quality.score}/100</b><span>${escapeHtml(d.setup.reason)} · impulse ${Number(d.setup.impulseRatio || 0).toFixed(2)}x · pullback ${Number(d.setup.pullbackRatio || 0).toFixed(2)}x</span>`;
  }
}
function renderLedger() {
  const s = cohortStats();
  $('ptQualified').textContent = String(signalLedger.filter(r => r.status !== 'PROOF ONLY').length);
  $('ptSkipped').textContent = String(signalLedger.filter(r => String(r.status || '').startsWith('SKIP')).length);
  $('ptBought').textContent = String(boughtCount());
  $('ptEntryOffset').textContent = `T+${entryOffsetEstimate()}`;
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = `${s.bullWins} / ${s.bullLosses}`;
  $('ptBearWL').textContent = `${s.bearWins} / ${s.bearLosses}`;

  $('ptLedgerRows').innerHTML = signalLedger.length ? signalLedger.slice(0, 100).map(r => {
    const time = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const window = r.actualWindow ? `${r.expectedWindow} → ${r.actualWindow}` : (r.expectedWindow || '—');
    return `<tr><td>${time}</td><td>${escapeHtml(`${r.session || '—'} · ${r.phase || r.sessionMode || '—'}`)}</td><td>${escapeHtml(r.direction || '—')}</td><td>${escapeHtml(`${r.entryType || '—'}${Number.isFinite(Number(r.quality)) ? ' · Q'+r.quality : ''}`)}</td><td>${Number.isFinite(Number(r.slope200)) ? Number(r.slope200).toFixed(3) : '—'}</td><td>${Number.isFinite(Number(r.slope80)) ? Number(r.slope80).toFixed(3) : '—'}</td><td>${Number.isFinite(Number(r.chopScore)) ? (Number(r.chopScore)*100).toFixed(0)+'%' : '—'}</td><td>${escapeHtml(r.volatility || '—')}</td><td>${escapeHtml(window)}</td><td>${escapeHtml(r.latencyClass || '—')}</td><td>${escapeHtml(r.status || '—')}</td><td>${r.contractId ? '#'+r.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.2 phase-aware setups yet.</td></tr>';
}
function exportLedgerCsv() {
  const headers = ['cohort','observed_at','symbol','epoch','quote','session','session_mode','phase','session_id','session_trade_number','direction','entry_type','quality','pullback_ratio','impulse_ratio','extension_ratio','regime_200','active_80','slope_200','efficiency_200','slope_80','efficiency_80','chop_score','volatility','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot'];
  const rows = signalLedger.map(r => [r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.session,r.sessionMode,r.phase,r.sessionId,r.sessionTradeNumber??'',r.direction,r.entryType,r.quality??'',r.pullbackRatio??'',r.impulseRatio??'',r.extensionRatio??'',r.regime200,r.active80,r.slope200,r.efficiency200,r.slope80,r.efficiency80,r.chopScore,r.volatility,r.expectedWindow,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'']);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `master-v6.2-phase-aware-${new Date().toISOString().replaceAll(':','-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function canvasScale(ctx, canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, rect.width || canvas.width), height = Math.max(180, rect.height || canvas.height);
  if (canvas.width !== Math.round(width*dpr) || canvas.height !== Math.round(height*dpr)) {
    canvas.width = Math.round(width*dpr); canvas.height = Math.round(height*dpr);
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return { width, height };
}
function drawMasterCanvas() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const rows = rawTicks().slice(-220);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvasScale(ctx, canvas);
  ctx.clearRect(0,0,width,height);
  const d = lastDiagnostics;
  const phase = d?.phase || 'NEUTRAL';
  const session = d?.session || 'NEUTRAL';
  ctx.fillStyle = phase === 'PRIME' ? (session === 'BULL' ? 'rgba(61,191,126,.075)' : session === 'BEAR' ? 'rgba(235,87,87,.075)' : 'rgba(146,153,168,.025)')
    : phase === 'EARLY' || phase === 'PRIME_ARMED' ? 'rgba(240,190,70,.045)'
    : phase === 'LATE' ? 'rgba(170,120,190,.045)' : 'rgba(146,153,168,.025)';
  ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='rgba(146,153,168,.10)';ctx.lineWidth=1;
  for(let x=0;x<=width;x+=width/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}
  for(let y=0;y<=height;y+=height/5){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}
  if(rows.length<2)return;
  const prices=rows.map(t=>t.quote), min=Math.min(...prices), max=Math.max(...prices), span=max-min||1;
  const xForEpoch=e=>12+(e-rows[0].epoch)/Math.max(1,rows.at(-1).epoch-rows[0].epoch)*(width-24);
  const yForPrice=p=>height-18-(p-min)/span*(height-36);
  ctx.strokeStyle='rgba(215,220,229,.72)';ctx.lineWidth=1.6;ctx.beginPath();
  rows.forEach((t,i)=>{const x=12+i/(rows.length-1)*(width-24),y=yForPrice(t.quote);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});ctx.stroke();
  ctx.font='12px system-ui,sans-serif';ctx.fillStyle='rgba(245,247,250,.78)';
  ctx.fillText(`200 ${d?.regime200||'—'}   80 ${d?.active80||'—'}   ${session} ${phase}${d?.quality?.score ? '   Q '+d.quality.score : ''}`,16,22);

  const recent20=rows.slice(-ENTRY_WINDOW), pp=pivots(recent20.map(t=>t.quote),2);
  const label=(arr,type)=>{let prev;for(const p of arr.slice(-3)){const text=prev===undefined?type:type==='H'?(p.quote>prev?'HH':'LH'):(p.quote>prev?'HL':'LL');prev=p.quote;const t=recent20[p.i];if(!t)continue;ctx.font='11px system-ui,sans-serif';ctx.fillStyle='rgba(245,247,250,.88)';ctx.fillText(text,xForEpoch(t.epoch)+4,yForPrice(t.quote)+(type==='H'?-7:14));}};
  label(pp.highs,'H');label(pp.lows,'L');

  const visibleStart=rows[0].epoch, visibleEnd=rows.at(-1).epoch;
  for(const r of signalLedger.filter(r=>r.status==='PROOF ONLY' && Number(r.epoch)>=visibleStart && Number(r.epoch)<=visibleEnd)){
    const x=xForEpoch(Number(r.epoch)),y=yForPrice(Number(r.quote));ctx.strokeStyle='#e6c35c';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x,y-6);ctx.lineTo(x+6,y);ctx.lineTo(x,y+6);ctx.lineTo(x-6,y);ctx.closePath();ctx.stroke();
  }
  for(const r of signalLedger.filter(r=>!Number.isFinite(Number(r.contractId)) && ['SKIP COOLDOWN','SKIP OPEN','OBSERVED','QUALIFIED'].includes(String(r.status)) && Number(r.epoch)>=visibleStart && Number(r.epoch)<=visibleEnd)){
    const x=xForEpoch(Number(r.epoch)),y=yForPrice(Number(r.quote));ctx.strokeStyle=r.direction==='CALL'?'rgba(103,217,154,.65)':'rgba(255,116,116,.65)';ctx.strokeRect(x-3.5,y-3.5,7,7);
  }
  for(const r of signalLedger.filter(r=>Number.isFinite(Number(r.contractId)) && Number(r.entryTickTime??r.epoch)>=visibleStart && Number(r.entryTickTime??r.epoch)<=visibleEnd)){
    const entryEpoch=Number(r.entryTickTime??r.epoch), entryPrice=Number(r.entrySpot??r.quote);if(!Number.isFinite(entryPrice))continue;
    const x=xForEpoch(entryEpoch),y=yForPrice(entryPrice),call=r.direction==='CALL';ctx.fillStyle=call?'#67d99a':'#ff7474';ctx.beginPath();if(call){ctx.moveTo(x,y-9);ctx.lineTo(x-6,y+5);ctx.lineTo(x+6,y+5);}else{ctx.moveTo(x,y+9);ctx.lineTo(x-6,y-5);ctx.lineTo(x+6,y-5);}ctx.closePath();ctx.fill();
    const exEpoch=Number(r.exitTickTime),exPrice=Number(r.exitSpot);if(Number.isFinite(exEpoch)&&Number.isFinite(exPrice)&&exEpoch>=visibleStart&&exEpoch<=visibleEnd){const ex=xForEpoch(exEpoch),ey=yForPrice(exPrice);ctx.strokeStyle=r.status==='WON'?'#67d99a':'#ff7474';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ex,ey);ctx.stroke();ctx.beginPath();ctx.arc(ex,ey,4,0,Math.PI*2);ctx.stroke();}
  }
  $('masterCanvasCaption').textContent=`${session} · ${phase} · yellow diamond=proof, triangle=trade, square=qualified/blocked · ${rows.length} ticks`;
}

const baseOnBuy = engine.onBuy.bind(engine);
engine.onBuy = function onBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : undefined;
  baseOnBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade || !meta) return;
  trade.patternMeta = meta; trade.ledgerId = meta.ledgerId; trade.expectedWindow = meta.expectedWindow;
  contractToLedger.set(contractId, meta.ledgerId);
  strategyState.lastSetupKey = meta.setupKey;
  strategyState.sessionTradeCount += 1;
  if (strategyState.sessionTradeCount >= MAX_TRADES_PER_SESSION) strategyState.phase = 'LATE';
  updateLedger(meta.ledgerId, { status:'BOUGHT', contractId, sessionTradeNumber:strategyState.sessionTradeCount, buyAckMs:trade.sendToAckMs });
  this.emit();
};
const baseOnContract = engine.onContract.bind(engine);
engine.onContract = function onContract(contract) {
  const contractId = Number(contract?.contract_id);
  baseOnContract(contract);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade?.patternMeta || !(contract?.is_sold || contract?.is_expired)) return;
  const offset = actualEntryOffset(trade);
  if (!trade.offsetRecorded && Number.isFinite(offset)) { trade.offsetRecorded = true; recordEntryOffset(offset); }
  trade.actualWindow = Number.isFinite(offset) ? `T+${offset}→T+${offset+FIXED_HORIZON}` : 'unknown';
  trade.latencyClass = latencyClass(offset);
  const ledgerId = trade.ledgerId || contractToLedger.get(contractId);
  updateLedger(ledgerId, { status:String(trade.status||'sold').toUpperCase(), profit:trade.profit, actualEntryOffset:offset, actualWindow:trade.actualWindow, latencyClass:trade.latencyClass, entrySpot:trade.entrySpot, exitSpot:trade.exitSpot, entryTickTime:trade.entryTickTime, exitTickTime:trade.exitTickTime });
  drawMasterCanvas();
  this.emit();
};

$('ptLoadAccounts').onclick = async () => {
  clearTraderError();
  try {
    const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim();
    if(!appId||!token)throw new Error('App ID and trade token are required.');
    $('ptLoadAccounts').disabled=true;
    const data=await api('accounts',{appId,token});accounts=data.accounts||[];localStorage.setItem('sani.deriv.appId',appId);sessionStorage.setItem('sani.deriv.token',token);renderAccounts();
  } catch(error){showTraderError(error.message);} finally{$('ptLoadAccounts').disabled=false;}
};
$('ptAccount').onchange=()=>{localStorage.setItem('sani.deriv.accountId',$('ptAccount').value);lastOtpContext=null;renderAccountGate();};
$('ptConnect').onclick=async()=>{clearTraderError();try{readTraderConfig();lastOtpContext=getAuthContext();$('ptConnect').disabled=true;await engine.connect(freshWsUrl);}catch(error){showTraderError(error.message);}finally{renderAccountGate();}};
$('ptDisconnect').onclick=()=>{engine.disconnect();lastOtpContext=null;};
$('ptStart').onclick=()=>{clearTraderError();try{getAuthContext();readTraderConfig();if(boughtCount()>=Number($('ptMaxTrades').value||100))throw new Error('v6.2 cohort cap reached.');engine.start();engine.log('info','Master v6.2 armed: EARLY proof → PRIME quality entry → LATE no-chase.');}catch(error){showTraderError(error.message);}};
$('ptPause').onclick=()=>engine.pause();$('ptStop').onclick=()=>engine.stop();
$('ptReset').onclick=()=>{try{engine.resetSession();lastTradeSignalEpoch=0;cooldownUntilEpoch=0;}catch(error){showTraderError(error.message);}};
$('ptClearLedger').onclick=()=>{if(!confirm('Clear the fresh v6.2 phase-aware cohort?'))return;signalLedger=[];localStorage.removeItem(LEDGER_KEY);resetSessionState();renderLedger();drawMasterCanvas();};
$('ptResetCalibration').onclick=()=>{if(!confirm('Reset execution calibration?'))return;localStorage.removeItem(OFFSET_KEY);renderLedger();};
$('ptExportLedger').onclick=exportLedgerCsv;
for(const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) $(id).addEventListener('change',()=>{try{if(!engine.snapshot().running)readTraderConfig();}catch(error){showTraderError(error.message);}});
window.addEventListener('sani-observatory-analysis',e=>maybeTrade(e.detail));window.addEventListener('resize',drawMasterCanvas);

engine.subscribe(state=>{
  $('ptStatus').textContent=state.safeBlocked?'SAFE PAUSE':state.status==='reconnecting'?'RECONNECTING':state.connected?(state.running?'TRADING':'CONNECTED'):'DISCONNECTED';
  $('ptDot').classList.toggle('ok',state.connected&&!state.safeBlocked);$('ptDot').classList.toggle('danger',Boolean(state.safeBlocked));
  $('ptPnl').textContent=`${Number(state.sessionPnL||0)>=0?'+':''}$${Number(state.sessionPnL||0).toFixed(2)}`;$('ptPnl').className=Number(state.sessionPnL||0)>=0?'positive':'negative';
  $('ptWL').textContent=`${state.wins||0} / ${state.losses||0}`;$('ptOpen').textContent=Number(state.openContracts||0)+(state.pendingTrade?1:0);
  $('ptStart').disabled=!state.connected||state.running||state.safeBlocked||!state.portfolioChecked;$('ptPause').disabled=!state.running;$('ptStop').disabled=!state.connected;$('ptReset').disabled=state.running||Number(state.openContracts||0)>0;
  $('ptTradeRows').innerHTML=state.trades.length?state.trades.map(t=>{const m=t.patternMeta||{},expected=t.expectedWindow||m.expectedWindow||'—',actual=t.actualWindow||'—';return `<tr><td>#${t.contractId}</td><td>${escapeHtml(`${m.session||'—'} · ${m.phase||'—'}`)}</td><td>${t.direction}</td><td>${escapeHtml(`${m.entryType||'—'} · Q${m.quality??'—'}`)}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${expected}</td><td>${actual}</td><td>${t.latencyClass||'—'}</td><td class="${(t.profit??0)>=0?'positive':'negative'}">${t.profit===undefined?'—':`${t.profit>=0?'+':''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs===undefined?'—':Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`;}).join(''):'<tr><td colspan="12" class="empty">No v6.2 trades yet.</td></tr>';
  if(state.logs?.[0])$('ptLogs').innerHTML=state.logs.slice(0,70).map(l=>`<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(l.message==='Engine armed. Waiting for fresh BOS.'?'Master v6.2 execution engine armed.':l.message)}</span></div>`).join('');
  renderLedger();drawMasterCanvas();
});

window.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.2'));
  const masterTitle=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Master Trader v6'));
  if(masterTitle)masterTitle.textContent='Master Trader v6.2 · Phase-Aware Entry';
  const ruleTitle=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Frozen v6 trade rules'));
  if(ruleTitle)ruleTitle.textContent='Frozen v6.2 trade rules';
  const start=$('ptStart');if(start)start.textContent='Start Master Trader v6.2';
  if($('ptCooldown'))$('ptCooldown').value='10';
  $('ptAppId').value=localStorage.getItem('sani.deriv.appId')||'';$('ptToken').value=sessionStorage.getItem('sani.deriv.token')||'';
  renderLedger();drawMasterCanvas();
  if($('ptAppId').value&&$('ptToken').value)$('ptLoadAccounts').click();
  const snap=window.SaniObservatory?.getSnapshot?.();if(snap){lastAnalysis=snap;lastDiagnostics=evaluateMaster(snap);renderMasterState(lastDiagnostics);drawMasterCanvas();}
});
