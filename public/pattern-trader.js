import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastAnalysis = null;
let lastTradeSignalEpoch = 0;
let cooldownUntilEpoch = 0;

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
  maxSignalToSendMs: 500
};

const engine = new SaniEngine(config);

// Pattern Trader uses SaniEngine only for authenticated connection, safety checks,
// order lifecycle, and settlement. It deliberately disables BOS signal generation.
engine.onTick = function patternTraderTick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  this.emit();
};

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
    currency: selectedAccount?.currency || 'USD'
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
  const eligible = (snapshot.horizons || [])
    .filter(h => h.decided >= t.minMatches && h.strength >= t.minBias && (h.bias === 'UP' || h.bias === 'DOWN'))
    .sort((a, b) => b.strength - a.strength || b.decided - a.decided || a.horizon - b.horizon);
  if (!eligible.length) return null;
  const best = eligible[0];
  return {
    direction: best.bias === 'UP' ? 'CALL' : 'PUT',
    horizon: best.horizon,
    strength: best.strength,
    matchCount: snapshot.matchCount,
    avgSimilarity: snapshot.avgSimilarity,
    epoch: snapshot.epoch,
    quote: snapshot.quote
  };
}

function maybeTrade(snapshot) {
  lastAnalysis = snapshot;
  renderPatternSignal(snapshot);
  if (!engine.snapshot().running) return;
  const signal = chooseSignal(snapshot);
  if (!signal) return;
  if (signal.epoch <= lastTradeSignalEpoch || signal.epoch < cooldownUntilEpoch) return;
  if (engine.snapshot().pendingTrade || engine.snapshot().openContracts > 0) return;

  try {
    const next = readTraderConfig();
    engine.config.duration = signal.horizon;
    const t = thresholds();
    lastTradeSignalEpoch = signal.epoch;
    cooldownUntilEpoch = signal.epoch + t.cooldownTicks;
    const now = perfNow();
    engine.execute({
      direction: signal.direction,
      structure: 'pattern-observatory',
      epoch: signal.epoch,
      quote: signal.quote,
      detectedPerf: now,
      detectedWallMs: Date.now(),
      patternMeta: { ...signal },
      config: next
    });
    addTraderLog('success', `${signal.direction} +${signal.horizon}t · ${signal.strength.toFixed(1)}% bias · ${signal.matchCount} matches · ${signal.avgSimilarity.toFixed(1)}% similarity`);
  } catch (error) {
    showTraderError(error.message);
    engine.pause();
  }
}

function renderPatternSignal(snapshot) {
  const signal = chooseSignal(snapshot);
  if (!signal) {
    $('ptSignal').innerHTML = '<b>WAIT</b><span>No horizon meets the current trade thresholds.</span>';
    return;
  }
  $('ptSignal').innerHTML = `<b class="${signal.direction === 'CALL' ? 'positive' : 'negative'}">${signal.direction} · +${signal.horizon} ticks</b><span>${signal.strength.toFixed(1)}% historical bias · ${signal.matchCount} matches · ${signal.avgSimilarity.toFixed(1)}% avg similarity</span>`;
}

function addTraderLog(level, message) {
  const row = document.createElement('div');
  row.className = `log ${level}`;
  row.innerHTML = `<time>${new Date().toLocaleTimeString()}</time><span>${message}</span>`;
  $('ptLogs').prepend(row);
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
    if (lastAnalysis) maybeTrade(lastAnalysis);
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

for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptMinMatches','ptMinSimilarity','ptMinBias','ptCooldown']) {
  $(id).addEventListener('change', () => {
    try { if (!engine.snapshot().running) readTraderConfig(); } catch (error) { showTraderError(error.message); }
    if (lastAnalysis) renderPatternSignal(lastAnalysis);
  });
}

window.addEventListener('sani-observatory-analysis', event => maybeTrade(event.detail));

engine.subscribe(state => {
  $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.connected ? (state.running ? 'TRADING' : 'CONNECTED') : 'DISCONNECTED';
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

  $('ptTradeRows').innerHTML = state.trades.length ? state.trades.map(t => `
    <tr><td>#${t.contractId}</td><td>${t.direction}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot ?? '—'} → ${t.exitSpot ?? '—'}</td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">No Pattern Trader trades yet.</td></tr>';

  if (state.logs?.[0]) {
    $('ptLogs').innerHTML = state.logs.slice(0, 40).map(l => `<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${l.message}</span></div>`).join('');
  }
});

window.addEventListener('DOMContentLoaded', () => {
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snap = window.SaniObservatory?.getSnapshot?.();
  if (snap) maybeTrade(snap);
});
