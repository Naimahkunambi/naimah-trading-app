import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const REGIME_HISTORY_KEY = 'sani.masterTrader.regimeHistory.v6';
const MAX_LEDGER = 5000;
const MAX_REGIME_HISTORY = 1200;

const FIXED_HORIZON = 3;
const LONG_WINDOW = 200;
const MEDIUM_WINDOW = 80;
const ENTRY_WINDOW = 20;
const SESSION_CONFIRM_TICKS = 5;
const INVALIDATION_TICKS = 5;
const NEUTRAL_BUFFER_TICKS = 5;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastAnalysis = null;
let lastDiagnostics = null;
let lastTradeSignalEpoch = 0;
let cooldownUntilEpoch = 0;
let signalLedger = loadArray(LEDGER_KEY);
let regimeHistory = loadArray(REGIME_HISTORY_KEY);
const contractToLedger = new Map();

const strategyState = {
  session: 'NEUTRAL',
  candidate: 'NEUTRAL',
  candidateCount: 0,
  invalidationCount: 0,
  neutralUntilEpoch: 0,
  sessionId: 0,
  sessionTradeCount: 0,
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

// Pattern Trader keeps its own execution socket, but BOS signals are disabled here.
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
function saveRegimeHistory() {
  regimeHistory = regimeHistory.slice(-MAX_REGIME_HISTORY);
  try { localStorage.setItem(REGIME_HISTORY_KEY, JSON.stringify(regimeHistory)); } catch {}
}
function rawTicks(symbol = currentSymbol()) {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol}`) || '[]');
    return Array.isArray(rows)
      ? rows
          .map(t => ({ epoch: Number(t.epoch), quote: Number(t.quote) }))
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
  renderLedger();
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
function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}
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
  const h = p.highs.slice(-2);
  const l = p.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  const hh = h[1].quote > h[0].quote;
  const hl = l[1].quote > l[0].quote;
  const lh = h[1].quote < h[0].quote;
  const ll = l[1].quote < l[0].quote;
  if (hh && hl) return 'BULL';
  if (lh && ll) return 'BEAR';
  return 'MIXED';
}
function windowMetrics(rows, radius = 3) {
  const prices = rows.map(t => t.quote);
  const step = avgStep(prices);
  const slope = linearSlope(prices);
  return {
    n: prices.length,
    slope,
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

  const bullVotes = [
    m.slopeNorm >= slopeThreshold,
    m.efficiency >= effThreshold,
    m.net > 0,
    m.structure === 'BULL'
  ].filter(Boolean).length;
  const bearVotes = [
    m.slopeNorm <= -slopeThreshold,
    m.efficiency >= effThreshold,
    m.net < 0,
    m.structure === 'BEAR'
  ].filter(Boolean).length;

  if (bullVotes >= 3 && m.slopeNorm > 0) return 'BULL';
  if (bearVotes >= 3 && m.slopeNorm < 0) return 'BEAR';
  return 'NEUTRAL';
}
function chopDiagnostics(longM, mediumM, entryM) {
  const lowEfficiency = clamp((0.18 - mediumM.efficiency) / 0.18, 0, 1);
  const highTurns = clamp((mediumM.turnRate - 0.45) / 0.25, 0, 1);
  const weakSlope = clamp((0.08 - Math.abs(mediumM.slopeNorm)) / 0.08, 0, 1);
  const entryWhipsaw = clamp((entryM.turnRate - 0.58) / 0.25, 0, 1);
  const score = (lowEfficiency + highTurns + weakSlope + entryWhipsaw) / 4;
  const disagreement = Math.sign(longM.slopeNorm) && Math.sign(mediumM.slopeNorm)
    && Math.sign(longM.slopeNorm) !== Math.sign(mediumM.slopeNorm);
  return { score, isChop: score >= 0.62 || (disagreement && mediumM.efficiency < 0.16) };
}
function volatilityState(longM, mediumM, entryM) {
  const shortMedium = mediumM.avgStep ? entryM.avgStep / mediumM.avgStep : 1;
  const mediumLong = longM.avgStep ? mediumM.avgStep / longM.avgStep : 1;
  if (shortMedium < 0.45 || mediumLong < 0.55) return { state: 'DEAD', shortMedium, mediumLong };
  if (shortMedium > 1.90 || entryM.turnRate > 0.80) return { state: 'CHAOTIC', shortMedium, mediumLong };
  return { state: 'HEALTHY', shortMedium, mediumLong };
}
function entrySetup(rows20, session, atr20, sessionId) {
  const prices = rows20.map(t => t.quote);
  const p = pivots(prices, 2);
  const current = prices.at(-1);
  const previous = prices.at(-2);
  if (prices.length < ENTRY_WINDOW || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return { ready: false, type: 'WAIT', reason: 'Need 20 ticks' };
  }

  if (session === 'BULL') {
    const lows = p.lows.slice(-2);
    if (lows.length < 2) return { ready: false, type: 'WAIT', reason: 'No confirmed Higher Low yet' };
    const latestLow = lows[1], previousLow = lows[0];
    const priorHigh = p.highs.filter(h => h.i < latestLow.i).at(-1);
    if (!priorHigh) return { ready: false, type: 'WAIT', reason: 'Pullback has no prior swing high' };
    if (!(latestLow.quote > previousLow.quote)) return { ready: false, type: 'WAIT', reason: 'Latest low is not a Higher Low' };
    const depth = priorHigh.quote - latestLow.quote;
    if (!(depth >= atr20 * 0.35 && depth <= atr20 * 5.0)) {
      return { ready: false, type: 'WAIT', reason: 'Pullback depth outside healthy range', pullbackDepth: depth };
    }
    const recovery = prices.slice(latestLow.i + 1, -1);
    if (recovery.length < 2) return { ready: false, type: 'WAIT', reason: 'Pullback has not started recovering' };
    const resumeLevel = Math.max(...recovery);
    const ready = current > resumeLevel && previous <= resumeLevel;
    const pivotEpoch = rows20[latestLow.i]?.epoch;
    return {
      ready,
      type: 'HL_BREAK',
      reason: ready ? 'Higher Low + bullish resumption break' : 'Waiting for bullish resumption break',
      pullbackDepth: depth,
      resumeLevel,
      setupKey: `${sessionId}:BULL:${pivotEpoch}`
    };
  }

  if (session === 'BEAR') {
    const highs = p.highs.slice(-2);
    if (highs.length < 2) return { ready: false, type: 'WAIT', reason: 'No confirmed Lower High yet' };
    const latestHigh = highs[1], previousHigh = highs[0];
    const priorLow = p.lows.filter(l => l.i < latestHigh.i).at(-1);
    if (!priorLow) return { ready: false, type: 'WAIT', reason: 'Pullback has no prior swing low' };
    if (!(latestHigh.quote < previousHigh.quote)) return { ready: false, type: 'WAIT', reason: 'Latest high is not a Lower High' };
    const depth = latestHigh.quote - priorLow.quote;
    if (!(depth >= atr20 * 0.35 && depth <= atr20 * 5.0)) {
      return { ready: false, type: 'WAIT', reason: 'Pullback depth outside healthy range', pullbackDepth: depth };
    }
    const recovery = prices.slice(latestHigh.i + 1, -1);
    if (recovery.length < 2) return { ready: false, type: 'WAIT', reason: 'Pullback has not started rolling over' };
    const resumeLevel = Math.min(...recovery);
    const ready = current < resumeLevel && previous >= resumeLevel;
    const pivotEpoch = rows20[latestHigh.i]?.epoch;
    return {
      ready,
      type: 'LH_BREAK',
      reason: ready ? 'Lower High + bearish resumption break' : 'Waiting for bearish resumption break',
      pullbackDepth: depth,
      resumeLevel,
      setupKey: `${sessionId}:BEAR:${pivotEpoch}`
    };
  }

  return { ready: false, type: 'WAIT', reason: 'No active directional session' };
}
function updateSession(longRegime, mediumTrend, chop, volatility, epoch) {
  const aligned = longRegime !== 'NEUTRAL' && longRegime === mediumTrend
    && !chop && volatility === 'HEALTHY' ? longRegime : 'NEUTRAL';

  if (strategyState.session === 'NEUTRAL') {
    if (epoch < strategyState.neutralUntilEpoch) {
      strategyState.candidate = 'NEUTRAL';
      strategyState.candidateCount = 0;
      return;
    }
    if (aligned !== 'NEUTRAL') {
      if (strategyState.candidate === aligned) strategyState.candidateCount += 1;
      else {
        strategyState.candidate = aligned;
        strategyState.candidateCount = 1;
      }
      if (strategyState.candidateCount >= SESSION_CONFIRM_TICKS) {
        strategyState.session = aligned;
        strategyState.sessionId += 1;
        strategyState.sessionTradeCount = 0;
        strategyState.invalidationCount = 0;
        strategyState.lastSetupKey = '';
      }
    } else {
      strategyState.candidate = 'NEUTRAL';
      strategyState.candidateCount = 0;
    }
    return;
  }

  const active = strategyState.session;
  const opposite = active === 'BULL' ? 'BEAR' : 'BULL';
  const hardInvalid = longRegime === opposite || mediumTrend === opposite;
  const pressureWeak = aligned !== active;
  if (hardInvalid) strategyState.invalidationCount += 2;
  else if (pressureWeak) strategyState.invalidationCount += 1;
  else strategyState.invalidationCount = 0;

  if (strategyState.invalidationCount >= INVALIDATION_TICKS) {
    strategyState.session = 'NEUTRAL';
    strategyState.candidate = 'NEUTRAL';
    strategyState.candidateCount = 0;
    strategyState.invalidationCount = 0;
    strategyState.neutralUntilEpoch = epoch + NEUTRAL_BUFFER_TICKS;
    strategyState.lastSetupKey = '';
  }
}
function recordRegime(epoch, quote, diagnostics) {
  const last = regimeHistory.at(-1);
  if (last?.epoch === epoch) return;
  regimeHistory.push({
    epoch,
    quote,
    session: diagnostics.session,
    regime200: diagnostics.regime200,
    trend80: diagnostics.trend80,
    chop: diagnostics.chop,
    volatility: diagnostics.volatility
  });
  saveRegimeHistory();
}

function evaluateMaster(snapshot) {
  const rows = rawTicks(snapshot?.symbol || currentSymbol());
  if (rows.length < LONG_WINDOW) {
    return {
      ready: false,
      reason: `Need ${LONG_WINDOW} archived ticks (${rows.length}/${LONG_WINDOW})`,
      rows,
      regime200: 'WARMING',
      trend80: 'WARMING',
      session: strategyState.session,
      chop: true,
      chopScore: 1,
      volatility: 'UNKNOWN',
      setup: { ready: false, type: 'WAIT', reason: 'Warming up' }
    };
  }

  const longRows = rows.slice(-LONG_WINDOW);
  const mediumRows = rows.slice(-MEDIUM_WINDOW);
  const entryRows = rows.slice(-ENTRY_WINDOW);
  const longM = windowMetrics(longRows, 4);
  const mediumM = windowMetrics(mediumRows, 3);
  const entryM = windowMetrics(entryRows, 2);
  const regime200 = classifyTrend(longM, 'LONG');
  const trend80 = classifyTrend(mediumM, 'MEDIUM');
  const chopD = chopDiagnostics(longM, mediumM, entryM);
  const volD = volatilityState(longM, mediumM, entryM);
  const epoch = rows.at(-1).epoch;

  updateSession(regime200, trend80, chopD.isChop, volD.state, epoch);
  const setup = entrySetup(entryRows, strategyState.session, entryM.avgStep || mediumM.avgStep || 1, strategyState.sessionId);

  let reason = setup.reason;
  if (regime200 === 'NEUTRAL') reason = '200-tick regime is neutral';
  else if (trend80 !== regime200) reason = '80-tick trend does not confirm 200-tick regime';
  else if (chopD.isChop) reason = 'CHOP veto is active';
  else if (volD.state !== 'HEALTHY') reason = `Volatility is ${volD.state}`;
  else if (strategyState.session === 'NEUTRAL') reason = 'Waiting for directional session confirmation';
  else if (setup.setupKey && setup.setupKey === strategyState.lastSetupKey) reason = 'This pullback setup was already traded';

  const ready = Boolean(
    strategyState.session !== 'NEUTRAL'
    && strategyState.session === regime200
    && strategyState.session === trend80
    && !chopD.isChop
    && volD.state === 'HEALTHY'
    && setup.ready
    && setup.setupKey !== strategyState.lastSetupKey
  );

  const diagnostics = {
    ready,
    reason,
    rows,
    epoch,
    quote: rows.at(-1).quote,
    regime200,
    trend80,
    session: strategyState.session,
    sessionId: strategyState.sessionId,
    sessionTradeCount: strategyState.sessionTradeCount,
    candidate: strategyState.candidate,
    candidateCount: strategyState.candidateCount,
    invalidationCount: strategyState.invalidationCount,
    chop: chopD.isChop,
    chopScore: chopD.score,
    volatility: volD.state,
    shortMediumVolRatio: volD.shortMedium,
    mediumLongVolRatio: volD.mediumLong,
    longM,
    mediumM,
    entryM,
    setup
  };
  recordRegime(epoch, rows.at(-1).quote, diagnostics);
  return diagnostics;
}
function buildSignal(snapshot, diagnostics) {
  if (!diagnostics?.ready) return null;
  const direction = diagnostics.session === 'BULL' ? 'CALL' : 'PUT';
  const executionOffset = Number(snapshot?.executionOffset ?? entryOffsetEstimate());
  return {
    symbol: snapshot?.symbol || currentSymbol(),
    epoch: Number(snapshot?.epoch ?? diagnostics.epoch),
    quote: Number(snapshot?.quote ?? diagnostics.quote),
    direction,
    regime200: diagnostics.regime200,
    trend80: diagnostics.trend80,
    session: diagnostics.session,
    sessionId: diagnostics.sessionId,
    entryType: diagnostics.setup.type,
    setupKey: diagnostics.setup.setupKey,
    pullbackDepth: diagnostics.setup.pullbackDepth,
    resumeLevel: diagnostics.setup.resumeLevel,
    chopScore: diagnostics.chopScore,
    volatility: diagnostics.volatility,
    slope200: diagnostics.longM.slopeNorm,
    efficiency200: diagnostics.longM.efficiency,
    slope80: diagnostics.mediumM.slopeNorm,
    efficiency80: diagnostics.mediumM.efficiency,
    turn80: diagnostics.mediumM.turnRate,
    patternMatches: snapshot?.matchCount,
    patternSimilarity: snapshot?.avgSimilarity,
    executionOffset
  };
}

function signalKey(signal) { return `${signal.symbol}:${signal.epoch}:${signal.setupKey}`; }
function ensureLedgerRow(signal) {
  const key = signalKey(signal);
  let row = signalLedger.find(r => r.signalKey === key);
  if (row) return row;
  row = {
    id: `mt6-${signal.epoch}-${Date.now()}`,
    cohort: 'v6-master-regime-pullback',
    signalKey: key,
    observedAt: Date.now(),
    symbol: signal.symbol,
    epoch: signal.epoch,
    quote: signal.quote,
    direction: signal.direction,
    regime200: signal.regime200,
    trend80: signal.trend80,
    session: signal.session,
    sessionId: signal.sessionId,
    entryType: signal.entryType,
    setupKey: signal.setupKey,
    pullbackDepth: signal.pullbackDepth,
    resumeLevel: signal.resumeLevel,
    chopScore: signal.chopScore,
    volatility: signal.volatility,
    slope200: signal.slope200,
    efficiency200: signal.efficiency200,
    slope80: signal.slope80,
    efficiency80: signal.efficiency80,
    turn80: signal.turn80,
    patternMatches: signal.patternMatches,
    patternSimilarity: signal.patternSimilarity,
    expectedOffset: signal.executionOffset,
    expectedWindow: `T+${signal.executionOffset}→T+${signal.executionOffset + FIXED_HORIZON}`,
    status: 'QUALIFIED'
  };
  signalLedger.unshift(row);
  saveLedger();
  renderLedger();
  return row;
}
function updateLedger(id, patch) {
  const row = signalLedger.find(r => r.id === id);
  if (!row) return;
  Object.assign(row, patch, { updatedAt: Date.now() });
  saveLedger();
  renderLedger();
}

function boughtCount() {
  return signalLedger.filter(r => Number.isFinite(Number(r.contractId))).length;
}
function settledRows() {
  return signalLedger.filter(r => r.status === 'WON' || r.status === 'LOST');
}
function cohortStats() {
  const rows = settledRows();
  const wins = rows.filter(r => r.status === 'WON').length;
  const losses = rows.filter(r => r.status === 'LOST').length;
  const pnl = rows.reduce((s, r) => s + Number(r.profit || 0), 0);
  const bull = rows.filter(r => r.session === 'BULL');
  const bear = rows.filter(r => r.session === 'BEAR');
  return {
    wins,
    losses,
    pnl,
    bullWins: bull.filter(r => r.status === 'WON').length,
    bullLosses: bull.filter(r => r.status === 'LOST').length,
    bearWins: bear.filter(r => r.status === 'WON').length,
    bearLosses: bear.filter(r => r.status === 'LOST').length
  };
}

function readStrategyControls() {
  return {
    cooldownTicks: Number($('ptCooldown').value || 20)
  };
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
    oneOpenContract: true,
    executionMethod: 'direct',
    durationUnit: 't',
    maxSignalToSendMs: 500,
    currency: selectedAccount?.currency || 'USD',
    reconnect: true,
    maxReconnectAttempts: 8
  };
  if (!(next.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!Number.isInteger(next.maxTrades) || next.maxTrades < 1) throw new Error('Max trades must be at least 1.');
  if (!engine.snapshot().running) engine.setConfig(next);
  return next;
}

function showTraderError(message) {
  $('traderError').textContent = message;
  $('traderError').classList.remove('hidden');
}
function clearTraderError() {
  $('traderError').textContent = '';
  $('traderError').classList.add('hidden');
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
function getAuthContext() {
  const appId = $('ptAppId').value.trim();
  const token = $('ptToken').value.trim();
  const accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  const real = String(selectedAccount.account_type).toLowerCase() === 'real';
  if (real) throw new Error('Master Trader v6 is Demo-only. Select a DEMO account.');
  return { appId, token, accountId };
}
async function freshWsUrl() {
  const ctx = lastOtpContext || getAuthContext();
  const data = await api('otp', ctx);
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
  const diagnostics = evaluateMaster(snapshot);
  lastDiagnostics = diagnostics;
  renderMasterState(diagnostics);
  drawMasterCanvas();

  const signal = buildSignal(snapshot, diagnostics);
  if (!signal) return;

  const row = ensureLedgerRow(signal);
  const state = engine.snapshot();
  if (signal.epoch <= lastTradeSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) return updateLedger(row.id, { status: 'SKIP STALE' });
  if (state.safeBlocked) return updateLedger(row.id, { status: 'SKIP SAFE PAUSE' });
  if (!state.running) {
    const disconnected = !state.connected || state.status === 'reconnecting' || state.status === 'error';
    return updateLedger(row.id, { status: disconnected ? 'SKIP DISCONNECTED' : 'OBSERVED' });
  }
  if (boughtCount() >= Number($('ptMaxTrades').value || 100)) {
    updateLedger(row.id, { status: 'SKIP COHORT COMPLETE' });
    engine.pause();
    engine.log('info', 'v6 persistent cohort cap reached. Trader paused.');
    return;
  }
  if (signal.epoch < cooldownUntilEpoch) return updateLedger(row.id, { status: 'SKIP COOLDOWN' });
  if (state.pendingTrade || state.openContracts > 0) return updateLedger(row.id, { status: 'SKIP OPEN' });

  try {
    readTraderConfig();
    engine.config.duration = FIXED_HORIZON;
    const tradeDirection = signal.direction;
    const controls = readStrategyControls();
    lastTradeSignalEpoch = signal.epoch;
    cooldownUntilEpoch = signal.epoch + controls.cooldownTicks;
    const now = perfNow();

    updateLedger(row.id, {
      tradeDirection,
      sessionTradeNumber: strategyState.sessionTradeCount + 1,
      status: 'ORDER SENT'
    });

    engine.execute({
      direction: tradeDirection,
      structure: 'master-v6-regime-pullback-resumption',
      epoch: signal.epoch,
      quote: signal.quote,
      detectedPerf: now,
      detectedWallMs: Date.now(),
      patternMeta: {
        ...signal,
        tradeDirection,
        horizon: FIXED_HORIZON,
        ledgerId: row.id,
        expectedWindow: row.expectedWindow,
        sessionTradeNumber: strategyState.sessionTradeCount + 1
      }
    });
    engine.log(
      'success',
      `MASTER v6 ${signal.session} ${tradeDirection} · ${signal.entryType} · fixed 3t · 200 slope ${signal.slope200.toFixed(3)} · 80 slope ${signal.slope80.toFixed(3)} · chop ${(signal.chopScore * 100).toFixed(0)}%.`
    );
  } catch (error) {
    updateLedger(row.id, { status: 'ERROR', error: error.message });
    showTraderError(error.message);
    engine.pause();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}
function renderMasterState(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d?.trend80 || '—');
  set('mtSession', d?.session || 'NEUTRAL');
  set('mtChop', d ? `${d.chop ? 'VETO' : 'CLEAR'} · ${(Number(d.chopScore || 0) * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');
  set('mtEntry20', d?.setup?.type === 'WAIT' ? 'WAIT' : d?.setup?.type || 'WAIT');

  if (!d || !d.ready) {
    $('ptSignal').innerHTML = `<b>WAIT</b><span>${escapeHtml(d?.reason || 'Waiting for 200/80/20 master structure.')}</span>`;
  } else {
    const direction = d.session === 'BULL' ? 'CALL' : 'PUT';
    $('ptSignal').innerHTML = `<b class="${direction === 'CALL' ? 'positive' : 'negative'}">${d.session} SESSION · ${direction} READY</b><span>${escapeHtml(d.setup.reason)} · chop ${(d.chopScore * 100).toFixed(0)}% · volatility ${d.volatility}</span>`;
  }
}
function renderCohortStats() {
  const s = cohortStats();
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = `${s.bullWins} / ${s.bullLosses}`;
  $('ptBearWL').textContent = `${s.bearWins} / ${s.bearLosses}`;
}
function renderLedger() {
  const qualified = signalLedger.length;
  const bought = boughtCount();
  const skipped = signalLedger.filter(r => String(r.status || '').startsWith('SKIP')).length;
  $('ptQualified').textContent = String(qualified);
  $('ptBought').textContent = String(bought);
  $('ptSkipped').textContent = String(skipped);
  $('ptEntryOffset').textContent = `T+${entryOffsetEstimate()}`;
  renderCohortStats();

  $('ptLedgerRows').innerHTML = signalLedger.length ? signalLedger.slice(0, 100).map(r => {
    const time = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const window = r.actualWindow ? `${r.expectedWindow} → ${r.actualWindow}` : r.expectedWindow;
    return `<tr>
      <td>${time}</td>
      <td>${escapeHtml(r.session || '—')}</td>
      <td>${escapeHtml(r.direction || r.tradeDirection || '—')}</td>
      <td>${escapeHtml(r.entryType || '—')}</td>
      <td>${Number.isFinite(Number(r.slope200)) ? Number(r.slope200).toFixed(3) : '—'}</td>
      <td>${Number.isFinite(Number(r.slope80)) ? Number(r.slope80).toFixed(3) : '—'}</td>
      <td>${Number.isFinite(Number(r.chopScore)) ? (Number(r.chopScore) * 100).toFixed(0) + '%' : '—'}</td>
      <td>${escapeHtml(r.volatility || '—')}</td>
      <td>${escapeHtml(window || '—')}</td>
      <td>${escapeHtml(r.latencyClass || '—')}</td>
      <td>${escapeHtml(r.status || '—')}</td>
      <td>${r.contractId ? '#' + r.contractId : '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6 master setups recorded yet.</td></tr>';
}
function exportLedgerCsv() {
  const headers = [
    'cohort','observed_at','symbol','epoch','quote','session','session_id','session_trade_number','direction',
    'entry_type','pullback_depth','resume_level','regime_200','trend_80','slope_200_norm','efficiency_200',
    'slope_80_norm','efficiency_80','turn_80','chop_score','volatility','pattern_matches_context',
    'pattern_similarity_context','expected_entry_offset','expected_window','status','contract_id','profit',
    'actual_entry_offset','actual_window','latency_class','entry_spot','exit_spot','entry_tick_time','exit_tick_time'
  ];
  const rows = signalLedger.map(r => [
    r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.session,r.sessionId,
    r.sessionTradeNumber ?? '',r.direction,r.entryType,r.pullbackDepth ?? '',r.resumeLevel ?? '',
    r.regime200,r.trend80,r.slope200,r.efficiency200,r.slope80,r.efficiency80,r.turn80,r.chopScore,
    r.volatility,r.patternMatches ?? '',r.patternSimilarity ?? '',r.expectedOffset,r.expectedWindow,r.status,
    r.contractId ?? '',r.profit ?? '',r.actualEntryOffset ?? '',r.actualWindow ?? '',r.latencyClass ?? '',
    r.entrySpot ?? '',r.exitSpot ?? '',r.entryTickTime ?? '',r.exitTickTime ?? ''
  ]);
  const csv = [headers, ...rows]
    .map(row => row.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `master-v6-regime-pullback-${new Date().toISOString().replaceAll(':','-')}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
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
function drawMasterCanvas() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const rows = rawTicks().slice(-220);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvasScale(ctx, canvas);
  ctx.clearRect(0, 0, width, height);

  const session = lastDiagnostics?.session || 'NEUTRAL';
  ctx.fillStyle = session === 'BULL'
    ? 'rgba(61, 191, 126, .06)'
    : session === 'BEAR'
      ? 'rgba(235, 87, 87, .06)'
      : 'rgba(146, 153, 168, .025)';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 8) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 5) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  if (rows.length < 2) return;

  const prices = rows.map(t => t.quote);
  const min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const xForEpoch = epoch => {
    const first = rows[0].epoch, last = rows.at(-1).epoch;
    return 12 + (epoch - first) / Math.max(1, last - first) * (width - 24);
  };
  const yForPrice = price => height - 18 - (price - min) / span * (height - 36);

  ctx.strokeStyle = 'rgba(215,220,229,.72)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  rows.forEach((t, i) => {
    const x = 12 + i / (rows.length - 1) * (width - 24);
    const y = yForPrice(t.quote);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Label recent 20-tick swing structure.
  const recent20 = rows.slice(-ENTRY_WINDOW);
  const pp = pivots(recent20.map(t => t.quote), 2);
  const labelPivot = (arr, type) => {
    let previous;
    for (const p of arr.slice(-3)) {
      const label = previous === undefined
        ? type
        : type === 'H'
          ? (p.quote > previous ? 'HH' : 'LH')
          : (p.quote > previous ? 'HL' : 'LL');
      previous = p.quote;
      const tick = recent20[p.i];
      if (!tick) continue;
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(245,247,250,.85)';
      ctx.fillText(label, xForEpoch(tick.epoch) + 4, yForPrice(tick.quote) + (type === 'H' ? -7 : 14));
    }
  };
  labelPivot(pp.highs, 'H');
  labelPivot(pp.lows, 'L');

  const visibleStart = rows[0].epoch;
  const visibleEnd = rows.at(-1).epoch;
  const trades = signalLedger.filter(r => {
    const e = Number(r.entryTickTime ?? r.epoch);
    return Number.isFinite(e) && e >= visibleStart && e <= visibleEnd && Number.isFinite(Number(r.contractId));
  });

  for (const r of trades) {
    const entryEpoch = Number(r.entryTickTime ?? r.epoch);
    const entryPrice = Number(r.entrySpot ?? r.quote);
    if (!Number.isFinite(entryPrice)) continue;
    const x = xForEpoch(entryEpoch), y = yForPrice(entryPrice);
    const call = (r.direction || r.tradeDirection) === 'CALL';
    ctx.fillStyle = call ? '#67d99a' : '#ff7474';
    ctx.beginPath();
    if (call) {
      ctx.moveTo(x, y - 9); ctx.lineTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5);
    } else {
      ctx.moveTo(x, y + 9); ctx.lineTo(x - 6, y - 5); ctx.lineTo(x + 6, y - 5);
    }
    ctx.closePath(); ctx.fill();

    const exitEpoch = Number(r.exitTickTime);
    const exitPrice = Number(r.exitSpot);
    if (Number.isFinite(exitEpoch) && Number.isFinite(exitPrice) && exitEpoch >= visibleStart && exitEpoch <= visibleEnd) {
      const ex = xForEpoch(exitEpoch), ey = yForPrice(exitPrice);
      ctx.strokeStyle = r.status === 'WON' ? '#67d99a' : '#ff7474';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.stroke();
    }
  }

  $('masterCanvasCaption').textContent = `${session} session · 200/80/20 · ${rows.length} visible ticks`;
}

const baseOnBuy = engine.onBuy.bind(engine);
engine.onBuy = function masterOnBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : undefined;
  baseOnBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade || !meta) return;

  trade.patternMeta = meta;
  trade.ledgerId = meta.ledgerId;
  trade.expectedWindow = meta.expectedWindow;
  contractToLedger.set(contractId, meta.ledgerId);

  strategyState.lastSetupKey = meta.setupKey;
  strategyState.sessionTradeCount += 1;

  updateLedger(meta.ledgerId, {
    status: 'BOUGHT',
    direction: meta.direction,
    tradeDirection: meta.tradeDirection,
    sessionTradeNumber: strategyState.sessionTradeCount,
    contractId,
    buyAckMs: trade.sendToAckMs,
    serverStartDelayMs: trade.serverStartDelayMs
  });
  this.emit();
};

const baseOnContract = engine.onContract.bind(engine);
engine.onContract = function masterOnContract(contract) {
  const contractId = Number(contract?.contract_id);
  baseOnContract(contract);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade?.patternMeta) return;
  if (!(contract?.is_sold || contract?.is_expired)) return;

  const offset = actualEntryOffset(trade);
  if (!trade.patternOffsetRecorded && Number.isFinite(offset)) {
    trade.patternOffsetRecorded = true;
    recordEntryOffset(offset);
  }
  trade.actualEntryOffset = offset;
  trade.latencyClass = latencyClass(offset);
  trade.actualWindow = Number.isFinite(offset) ? `T+${offset}→T+${offset + FIXED_HORIZON}` : 'unknown';

  const ledgerId = trade.ledgerId || contractToLedger.get(contractId) || trade.patternMeta.ledgerId;
  updateLedger(ledgerId, {
    status: String(trade.status || 'sold').toUpperCase(),
    contractId,
    profit: trade.profit,
    actualEntryOffset: offset,
    actualWindow: trade.actualWindow,
    latencyClass: trade.latencyClass,
    entrySpot: trade.entrySpot,
    exitSpot: trade.exitSpot,
    entryTickTime: trade.entryTickTime,
    exitTickTime: trade.exitTickTime
  });
  drawMasterCanvas();
  this.emit();
};

$('ptLoadAccounts').onclick = async () => {
  clearTraderError();
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
  } catch (error) { showTraderError(error.message); }
  finally { $('ptLoadAccounts').disabled = false; }
};
$('ptAccount').onchange = () => {
  localStorage.setItem('sani.deriv.accountId', $('ptAccount').value);
  lastOtpContext = null;
  renderAccountGate();
};
$('ptConnect').onclick = async () => {
  clearTraderError();
  try {
    readTraderConfig();
    lastOtpContext = getAuthContext();
    $('ptConnect').disabled = true;
    await engine.connect(freshWsUrl);
  } catch (error) { showTraderError(error.message); }
  finally { renderAccountGate(); }
};
$('ptDisconnect').onclick = () => { engine.disconnect(); lastOtpContext = null; };
$('ptStart').onclick = () => {
  clearTraderError();
  try {
    getAuthContext();
    readTraderConfig();
    if (boughtCount() >= Number($('ptMaxTrades').value || 100)) {
      throw new Error('v6 persistent cohort cap is already reached. Export/clear v6 only if you intentionally want a new cohort.');
    }
    engine.start();
    engine.log('info', 'Master Trader v6 armed: 200 regime → 80 confirmation → chop/volatility veto → 20 pullback/resumption → fixed 3 ticks.');
    if (lastAnalysis) {
      lastDiagnostics = evaluateMaster(lastAnalysis);
      renderMasterState(lastDiagnostics);
      drawMasterCanvas();
    }
  } catch (error) { showTraderError(error.message); }
};
$('ptPause').onclick = () => engine.pause();
$('ptStop').onclick = () => engine.stop();
$('ptReset').onclick = () => {
  try {
    engine.resetSession();
    lastTradeSignalEpoch = 0;
    cooldownUntilEpoch = 0;
  } catch (error) { showTraderError(error.message); }
};
$('ptClearLedger').onclick = () => {
  if (!confirm('Clear the fresh v6 master cohort and regime visual history? Older v5 data is not affected.')) return;
  signalLedger = [];
  regimeHistory = [];
  localStorage.removeItem(LEDGER_KEY);
  localStorage.removeItem(REGIME_HISTORY_KEY);
  strategyState.session = 'NEUTRAL';
  strategyState.candidate = 'NEUTRAL';
  strategyState.candidateCount = 0;
  strategyState.invalidationCount = 0;
  strategyState.neutralUntilEpoch = 0;
  strategyState.sessionTradeCount = 0;
  strategyState.lastSetupKey = '';
  renderLedger();
  drawMasterCanvas();
};
$('ptResetCalibration').onclick = () => {
  if (!confirm('Reset measured execution entry-offset calibration back to default T+1?')) return;
  localStorage.removeItem(OFFSET_KEY);
  window.dispatchEvent(new CustomEvent('sani-pattern-offset-updated'));
  renderLedger();
};
$('ptExportLedger').onclick = exportLedgerCsv;

for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) {
  $(id).addEventListener('change', () => {
    try { if (!engine.snapshot().running) readTraderConfig(); }
    catch (error) { showTraderError(error.message); }
  });
}

window.addEventListener('sani-observatory-analysis', event => maybeTrade(event.detail));
window.addEventListener('resize', drawMasterCanvas);

engine.subscribe(state => {
  $('ptStatus').textContent = state.safeBlocked
    ? 'SAFE PAUSE'
    : state.status === 'reconnecting'
      ? 'RECONNECTING'
      : state.connected
        ? (state.running ? 'TRADING' : 'CONNECTED')
        : 'DISCONNECTED';
  $('ptDot').classList.toggle('ok', state.connected && !state.safeBlocked);
  $('ptDot').classList.toggle('danger', Boolean(state.safeBlocked));
  $('ptPnl').textContent = `${Number(state.sessionPnL || 0) >= 0 ? '+' : ''}$${Number(state.sessionPnL || 0).toFixed(2)}`;
  $('ptPnl').className = Number(state.sessionPnL || 0) >= 0 ? 'positive' : 'negative';
  $('ptWL').textContent = `${state.wins || 0} / ${state.losses || 0}`;
  $('ptOpen').textContent = Number(state.openContracts || 0) + (state.pendingTrade ? 1 : 0);
  $('ptStart').disabled = !state.connected || state.running || state.safeBlocked || !state.portfolioChecked;
  $('ptPause').disabled = !state.running;
  $('ptStop').disabled = !state.connected;
  $('ptReset').disabled = state.running || Number(state.openContracts || 0) > 0;

  $('ptTradeRows').innerHTML = state.trades.length ? state.trades.map(t => {
    const meta = t.patternMeta || {};
    const expected = t.expectedWindow || meta.expectedWindow || '—';
    const actual = t.actualWindow || '—';
    const latency = t.latencyClass || latencyClass(actualEntryOffset(t));
    return `<tr>
      <td>#${t.contractId}</td>
      <td>${escapeHtml(meta.session || '—')}</td>
      <td>${t.direction}</td>
      <td>${escapeHtml(meta.entryType || '—')}</td>
      <td><span class="result ${t.status}">${t.status}</span></td>
      <td>${t.duration}t</td>
      <td>${escapeHtml(expected)}</td>
      <td>${escapeHtml(actual)}</td>
      <td>${escapeHtml(latency)}</td>
      <td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td>
      <td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0)+'ms'}</td>
      <td>${t.entrySpot ?? '—'} → ${t.exitSpot ?? '—'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6 master trades yet.</td></tr>';

  if (state.logs?.[0]) $('ptLogs').innerHTML = state.logs.slice(0, 70).map(l => {
    const message = l.message === 'Engine armed. Waiting for fresh BOS.'
      ? 'Master Trader execution engine armed.'
      : l.message;
    return `<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(message)}</span></div>`;
  }).join('');

  renderLedger();
  drawMasterCanvas();
});

window.addEventListener('DOMContentLoaded', () => {
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger();
  drawMasterCanvas();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snap = window.SaniObservatory?.getSnapshot?.();
  if (snap) {
    lastAnalysis = snap;
    lastDiagnostics = evaluateMaster(snap);
    renderMasterState(lastDiagnostics);
    drawMasterCanvas();
  }
});
