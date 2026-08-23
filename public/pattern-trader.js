import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const LEDGER_KEY = 'sani.patternTrader.signalLedger.v2';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const MAX_LEDGER = 2000;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastAnalysis = null;
let lastTradeSignalEpoch = 0;
let cooldownUntilEpoch = 0;
let signalLedger = loadArray(LEDGER_KEY);
const contractToLedger = new Map();

const config = {
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: 1,
  durationUnit: 't',
  executionMethod: 'direct',
  oneOpenContract: true,
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 30,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  maxSignalToSendMs: 500,
  reconnect: true,
  maxReconnectAttempts: 8
};

const engine = new SaniEngine(config);

engine.onTick = function patternTraderTick(tick) {
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
  signalLedger = signalLedger.slice(0, MAX_LEDGER);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(signalLedger)); } catch {}
}
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
  if (Number.isFinite(signalEpoch) && Number.isFinite(entryTick)) {
    return Math.max(1, Math.round(entryTick - signalEpoch));
  }
  const startTime = Number(trade?.startTime);
  if (Number.isFinite(signalEpoch) && Number.isFinite(startTime)) {
    return Math.max(1, Math.round(startTime - signalEpoch) + 1);
  }
  return undefined;
}
function latencyClass(offset) {
  offset = Number(offset);
  if (!Number.isFinite(offset)) return 'UNKNOWN';
  if (offset <= 1) return 'CLEAN';
  if (offset === 2) return 'LATE +1';
  return 'LATE +2+';
}
function signalKey(signal) {
  return `${signal.symbol || '1HZ25V'}:${signal.epoch}`;
}
function ensureLedgerRow(signal) {
  const key = signalKey(signal);
  let row = signalLedger.find(r => r.signalKey === key);
  if (row) return row;
  row = {
    id: `pt-${signal.epoch}-${Date.now()}`,
    signalKey: key,
    observedAt: Date.now(),
    symbol: signal.symbol || '1HZ25V',
    epoch: signal.epoch,
    quote: signal.quote,
    direction: signal.direction,
    horizon: signal.horizon,
    strength: signal.strength,
    rawStrength: signal.rawStrength,
    matchCount: signal.matchCount,
    avgSimilarity: signal.avgSimilarity,
    expectedOffset: signal.executionOffset,
    expectedWindow: `T+${signal.executionOffset}→T+${signal.executionOffset + signal.horizon}`,
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

function readTraderConfig() {
  const next = {
    ...engine.config,
    symbol: $('obsSymbol').value.trim() || '1HZ25V',
    stake: Number($('ptStake').value),
    takeProfit: Number($('ptTakeProfit').value),
    stopLoss: Number($('ptStopLoss').value),
    maxTrades: Number($('ptMaxTrades').value),
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

function getAuthContext() {
  const appId = $('ptAppId').value.trim();
  const token = $('ptToken').value.trim();
  const accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  const real = String(selectedAccount.account_type).toLowerCase() === 'real';
  if (real && $('ptRealPhrase').value !== 'REAL') throw new Error('Type REAL to unlock the real-money account.');
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
  selectedAccount = accounts.find(a => a.account_id === select.value) || null;
  renderAccountGate();
}

function renderAccountGate() {
  selectedAccount = accounts.find(a => a.account_id === $('ptAccount').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('ptRealGate').classList.toggle('hidden', !real);
  $('ptAccountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
  $('ptAccountPill').classList.toggle('real', real);
  $('ptConnect').disabled = !selectedAccount || (real && $('ptRealPhrase').value !== 'REAL');
}

function thresholds() {
  return {
    minMatches: Number($('ptMinMatches').value || 40),
    minSimilarity: Number($('ptMinSimilarity').value || 88),
    minBias: Number($('ptMinBias').value || 55),
    cooldownTicks: Number($('ptCooldown').value || 20)
  };
}

function chooseSignal(snapshot) {
  if (!snapshot || !Number.isFinite(snapshot.epoch) || !Number.isFinite(snapshot.quote)) return null;
  const t = thresholds();
  if (snapshot.matchCount < t.minMatches || snapshot.avgSimilarity < t.minSimilarity) return null;
  const scored = Array.isArray(snapshot.executionHorizons) && snapshot.executionHorizons.length
    ? snapshot.executionHorizons
    : snapshot.horizons || [];
  const eligible = scored
    .filter(h => h.decided >= t.minMatches && h.strength >= t.minBias && (h.bias === 'UP' || h.bias === 'DOWN'))
    .sort((a, b) => b.strength - a.strength || b.decided - a.decided || a.horizon - b.horizon);
  if (!eligible.length) return null;
  const best = eligible[0];
  const raw = (snapshot.horizons || []).find(h => h.horizon === best.horizon);
  const executionOffset = Number(best.startOffset ?? snapshot.executionOffset ?? entryOffsetEstimate());
  return {
    symbol: snapshot.symbol,
    direction: best.bias === 'UP' ? 'CALL' : 'PUT',
    horizon: best.horizon,
    strength: best.strength,
    rawStrength: raw?.strength,
    matchCount: snapshot.matchCount,
    avgSimilarity: snapshot.avgSimilarity,
    executionOffset,
    epoch: snapshot.epoch,
    quote: snapshot.quote
  };
}

function maybeTrade(snapshot) {
  lastAnalysis = snapshot;
  const signal = chooseSignal(snapshot);
  renderPatternSignal(snapshot, signal);
  if (!signal) return;

  const row = ensureLedgerRow(signal);
  const state = engine.snapshot();
  if (signal.epoch <= lastTradeSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) {
    updateLedger(row.id, { status: 'SKIP STALE' });
    return;
  }
  if (state.safeBlocked) {
    updateLedger(row.id, { status: 'SKIP SAFE PAUSE' });
    return;
  }
  if (!state.running) {
    const disconnected = !state.connected || state.status === 'reconnecting' || state.status === 'error';
    updateLedger(row.id, { status: disconnected ? 'SKIP DISCONNECTED' : 'OBSERVED' });
    return;
  }
  if (signal.epoch < cooldownUntilEpoch) {
    updateLedger(row.id, { status: 'SKIP COOLDOWN' });
    return;
  }
  if (state.pendingTrade || state.openContracts > 0) {
    updateLedger(row.id, { status: 'SKIP OPEN' });
    return;
  }

  try {
    readTraderConfig();
    engine.config.duration = signal.horizon;
    const t = thresholds();
    lastTradeSignalEpoch = signal.epoch;
    cooldownUntilEpoch = signal.epoch + t.cooldownTicks;
    const now = perfNow();
    updateLedger(row.id, { status: 'ORDER SENT' });
    engine.execute({
      direction: signal.direction,
      structure: 'pattern-observatory-v2',
      epoch: signal.epoch,
      quote: signal.quote,
      detectedPerf: now,
      detectedWallMs: Date.now(),
      patternMeta: { ...signal, ledgerId: row.id, expectedWindow: row.expectedWindow }
    });
    engine.log('success', `PATTERN ${signal.direction} ${row.expectedWindow} · ${signal.strength.toFixed(1)}% execution-aware bias · ${signal.matchCount} matches · ${signal.avgSimilarity.toFixed(1)}% similarity.`);
  } catch (error) {
    updateLedger(row.id, { status: 'ERROR', error: error.message });
    showTraderError(error.message);
    engine.pause();
  }
}

function renderPatternSignal(snapshot, existingSignal) {
  const signal = existingSignal || chooseSignal(snapshot);
  if (!signal) {
    $('ptSignal').innerHTML = '<b>WAIT</b><span>No execution-aware horizon meets the current trade thresholds.</span>';
    return;
  }
  const raw = Number.isFinite(signal.rawStrength) ? ` · raw ${signal.rawStrength.toFixed(1)}%` : '';
  $('ptSignal').innerHTML = `<b class="${signal.direction === 'CALL' ? 'positive' : 'negative'}">${signal.direction} · ${`T+${signal.executionOffset}→T+${signal.executionOffset + signal.horizon}`}</b><span>${signal.strength.toFixed(1)}% execution-aware bias${raw} · ${signal.matchCount} matches · ${signal.avgSimilarity.toFixed(1)}% avg similarity</span>`;
}

const baseOnBuy = engine.onBuy.bind(engine);
engine.onBuy = function patternOnBuy(message) {
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
  updateLedger(meta.ledgerId, {
    status: 'BOUGHT',
    contractId,
    buyAckMs: trade.sendToAckMs,
    serverStartDelayMs: trade.serverStartDelayMs
  });
  this.emit();
};

const baseOnContract = engine.onContract.bind(engine);
engine.onContract = function patternOnContract(contract) {
  const contractId = Number(contract?.contract_id);
  baseOnContract(contract);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade) return;
  const meta = trade.patternMeta;
  if (!meta) return;

  const settled = Boolean(contract?.is_sold || contract?.is_expired);
  if (!settled) return;
  const offset = actualEntryOffset(trade);
  if (!trade.patternOffsetRecorded && Number.isFinite(offset)) {
    trade.patternOffsetRecorded = true;
    recordEntryOffset(offset);
  }
  trade.actualEntryOffset = offset;
  trade.latencyClass = latencyClass(offset);
  trade.actualWindow = Number.isFinite(offset) ? `T+${offset}→T+${offset + Number(trade.duration || meta.horizon)}` : 'unknown';

  const ledgerId = trade.ledgerId || contractToLedger.get(contractId) || meta.ledgerId;
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
  this.emit();
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function renderLedger() {
  const qualified = signalLedger.length;
  const bought = signalLedger.filter(r => Number.isFinite(Number(r.contractId))).length;
  const skipped = signalLedger.filter(r => String(r.status || '').startsWith('SKIP')).length;
  $('ptQualified').textContent = String(qualified);
  $('ptBought').textContent = String(bought);
  $('ptSkipped').textContent = String(skipped);
  $('ptEntryOffset').textContent = `T+${entryOffsetEstimate()}`;
  $('ptLedgerRows').innerHTML = signalLedger.length ? signalLedger.slice(0, 50).map(r => {
    const time = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const signal = `${r.direction} ${r.horizon}t`;
    const bias = Number.isFinite(Number(r.strength)) ? `${Number(r.strength).toFixed(1)}%` : '—';
    const sim = Number.isFinite(Number(r.avgSimilarity)) ? `${Number(r.avgSimilarity).toFixed(1)}%` : '—';
    const window = r.actualWindow ? `${r.expectedWindow} → ${r.actualWindow}` : r.expectedWindow;
    return `<tr><td>${time}</td><td>${escapeHtml(signal)}</td><td>${bias}</td><td>${r.matchCount ?? '—'}</td><td>${sim}</td><td>${escapeHtml(window)}</td><td>${escapeHtml(r.latencyClass || '—')}</td><td>${escapeHtml(r.status || '—')}</td><td>${r.contractId ? '#' + r.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">No qualified pattern signals recorded yet.</td></tr>';
}
function exportLedgerCsv() {
  const headers = ['observed_at','symbol','epoch','quote','direction','duration_ticks','execution_aware_bias_pct','raw_bias_pct','matches','avg_similarity_pct','expected_entry_offset','expected_window','status','contract_id','profit','actual_entry_offset','actual_window','latency_class','entry_spot','exit_spot'];
  const rows = signalLedger.map(r => [
    new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.direction,r.horizon,r.strength,r.rawStrength ?? '',r.matchCount,r.avgSimilarity,r.expectedOffset,r.expectedWindow,r.status,r.contractId ?? '',r.profit ?? '',r.actualEntryOffset ?? '',r.actualWindow ?? '',r.latencyClass ?? '',r.entrySpot ?? '',r.exitSpot ?? ''
  ]);
  const csv = [headers, ...rows].map(row => row.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `pattern-signal-ledger-${new Date().toISOString().replaceAll(':','-')}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

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
  } catch (error) {
    showTraderError(error.message);
  } finally {
    $('ptLoadAccounts').disabled = false;
  }
};

$('ptAccount').onchange = () => {
  localStorage.setItem('sani.deriv.accountId', $('ptAccount').value);
  $('ptRealPhrase').value = '';
  lastOtpContext = null;
  renderAccountGate();
};
$('ptRealPhrase').oninput = renderAccountGate;

$('ptConnect').onclick = async () => {
  clearTraderError();
  try {
    readTraderConfig();
    lastOtpContext = getAuthContext();
    $('ptConnect').disabled = true;
    await engine.connect(freshWsUrl);
  } catch (error) {
    showTraderError(error.message);
  } finally {
    renderAccountGate();
  }
};
$('ptDisconnect').onclick = () => {
  engine.disconnect();
  lastOtpContext = null;
};
$('ptStart').onclick = () => {
  clearTraderError();
  try {
    getAuthContext();
    readTraderConfig();
    engine.start();
    if (lastAnalysis) renderPatternSignal(lastAnalysis);
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
  if (!confirm('Clear the persistent Pattern Trader qualified-signal ledger?')) return;
  signalLedger = [];
  localStorage.removeItem(LEDGER_KEY);
  renderLedger();
};
$('ptResetCalibration').onclick = () => {
  if (!confirm('Reset measured execution entry-offset calibration back to default T+1?')) return;
  localStorage.removeItem(OFFSET_KEY);
  window.dispatchEvent(new CustomEvent('sani-pattern-offset-updated'));
  renderLedger();
};
$('ptExportLedger').onclick = exportLedgerCsv;

for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptMinMatches','ptMinSimilarity','ptMinBias','ptCooldown']) {
  $(id).addEventListener('change', () => {
    try { if (!engine.snapshot().running) readTraderConfig(); } catch (error) { showTraderError(error.message); }
    if (lastAnalysis) renderPatternSignal(lastAnalysis);
  });
}

window.addEventListener('sani-observatory-analysis', event => maybeTrade(event.detail));

engine.subscribe(state => {
  $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.status === 'reconnecting' ? 'RECONNECTING' : state.connected ? (state.running ? 'TRADING' : 'CONNECTED') : 'DISCONNECTED';
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
    const expected = t.expectedWindow || t.patternMeta?.expectedWindow || '—';
    const actual = t.actualWindow || '—';
    const latency = t.latencyClass || latencyClass(actualEntryOffset(t));
    return `<tr><td>#${t.contractId}</td><td>${t.direction}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${escapeHtml(expected)}</td><td>${escapeHtml(actual)}</td><td>${escapeHtml(latency)}</td><td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot ?? '—'} → ${t.exitSpot ?? '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">No Pattern Trader trades yet.</td></tr>';

  if (state.logs?.[0]) {
    $('ptLogs').innerHTML = state.logs.slice(0, 50).map(l => `<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(l.message)}</span></div>`).join('');
  }
  renderLedger();
});

window.addEventListener('DOMContentLoaded', () => {
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snap = window.SaniObservatory?.getSnapshot?.();
  if (snap) {
    lastAnalysis = snap;
    renderPatternSignal(snap);
  }
});
