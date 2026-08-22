import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const stored = (() => { try { return JSON.parse(localStorage.getItem('sani.config') || '{}'); } catch { return {}; } })();
let config = { ...DEFAULT_CONFIG, ...stored };
let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let remotePoll = null;
let remoteState = null;
let lastRenderedState = null;

const engine = new SaniEngine(config);

const fields = [
  'stake','duration','takeProfit','stopLoss','maxTrades','symbol','executionMethod','durationUnit',
  'maxConsecutiveLosses','cooldownTicks','maxSignalToSendMs'
];
for (const id of fields) $(id).value = config[id];
for (const id of ['bullEnabled','bearEnabled','oneOpenContract']) $(id).checked = Boolean(config[id]);
$('appId').value = localStorage.getItem('sani.deriv.appId') || '';
$('token').value = sessionStorage.getItem('sani.deriv.token') || '';
$('runnerMode').value = localStorage.getItem('sani.runnerMode') || 'browser';
$('workerUrl').value = localStorage.getItem('sani.workerUrl') || '';
$('workerKey').value = sessionStorage.getItem('sani.workerKey') || '';

const runnerMode = () => $('runnerMode').value;

function readConfig() {
  const next = { ...config };
  for (const id of ['stake','duration','takeProfit','stopLoss','maxTrades','maxConsecutiveLosses','cooldownTicks','maxSignalToSendMs']) {
    next[id] = Number($(id).value);
  }
  for (const id of ['symbol','executionMethod','durationUnit']) next[id] = $(id).value.trim();
  for (const id of ['bullEnabled','bearEnabled','oneOpenContract']) next[id] = $(id).checked;
  next.shadowHorizons = [1, 2, 3];
  if (selectedAccount?.currency && runnerMode() === 'browser') next.currency = selectedAccount.currency;

  if (!(next.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!Number.isInteger(next.duration) || next.duration < 1) throw new Error('Duration must be a whole number of at least 1.');
  if (!Number.isInteger(next.maxTrades) || next.maxTrades < 1) throw new Error('Max trades must be at least 1.');
  if (!next.symbol) throw new Error('Symbol is required.');
  if (!next.bullEnabled && !next.bearEnabled) throw new Error('Enable at least Bull or Bear execution.');

  config = next;
  localStorage.setItem('sani.config', JSON.stringify(next));
  if (runnerMode() === 'browser' && !engine.snapshot().running) engine.setConfig(next);
  return next;
}

for (const id of [...fields, 'bullEnabled','bearEnabled','oneOpenContract']) {
  $(id).addEventListener('change', () => { try { readConfig(); } catch (e) { showError(e.message); } });
}

async function api(path, body) {
  // Production uses same-origin functions. Local dev can fall back to Deriv REST.
  try {
    const response = await fetch(`/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
    if (response.ok || response.status !== 404) {
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || 'API error');
      return json;
    }
  } catch (error) {
    if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') throw error;
  }

  if (path === 'accounts') {
    const response = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      headers: { 'Deriv-App-ID': String(body.appId), Authorization: `Bearer ${body.token}` },
      cache: 'no-store'
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json?.errors?.[0]?.message || 'Could not load accounts');
    return { accounts: Array.isArray(json.data) ? json.data : [json.data].filter(Boolean) };
  }

  const response = await fetch(
    `https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(body.accountId)}/otp`,
    {
      method: 'POST',
      headers: { 'Deriv-App-ID': String(body.appId), Authorization: `Bearer ${body.token}` },
      cache: 'no-store'
    }
  );
  const json = await response.json();
  if (!response.ok) throw new Error(json?.errors?.[0]?.message || 'Could not create OTP');
  return { url: json?.data?.url };
}

function getAuthContext() {
  const appId = $('appId').value.trim();
  const token = $('token').value.trim();
  const accountId = $('accountSelect').value;
  selectedAccount = accounts.find(x => x.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!accountId || !selectedAccount) throw new Error('Select a Deriv Options account first.');
  if (String(selectedAccount.account_type).toLowerCase() === 'real' && $('realPhrase').value !== 'REAL') {
    throw new Error('Type REAL to unlock the real-money account.');
  }
  return { appId, token, accountId };
}

async function freshWsUrl() {
  const ctx = lastOtpContext || getAuthContext();
  const data = await api('otp', ctx);
  if (!data.url) throw new Error('OTP response did not include a WebSocket URL.');
  return data.url;
}

async function workerFetch(path, { method = 'GET', body } = {}) {
  const base = $('workerUrl').value.trim().replace(/\/$/, '');
  const key = $('workerKey').value;
  if (!base) throw new Error('Worker URL is required.');
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(key ? { 'x-worker-key': key } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `Worker HTTP ${response.status}`);
  return json;
}

function startRemotePolling() {
  stopRemotePolling();
  remotePoll = setInterval(async () => {
    try {
      remoteState = await workerFetch('/status');
      if (runnerMode() === 'worker') render(remoteState);
    } catch (error) {
      if (runnerMode() === 'worker') {
        render({ ...(remoteState || emptyState()), connected: false, status: 'worker-offline', lastError: error.message });
      }
    }
  }, 1000);
}
function stopRemotePolling() {
  if (remotePoll) clearInterval(remotePoll);
  remotePoll = null;
}
function emptyState() {
  return {
    status:'idle',connected:false,running:false,safeBlocked:false,portfolioChecked:false,balance:undefined,
    lastTick:undefined,bosCount:0,sessionPnL:0,wins:0,losses:0,openContracts:0,pendingTrade:false,trades:[],
    shadow:[1,2,3].map(h=>({horizon:h,wins:0,losses:0,pending:0})),logs:[],config
  };
}

$('runnerMode').onchange = () => {
  localStorage.setItem('sani.runnerMode', runnerMode());
  clearError();
  const worker = runnerMode() === 'worker';
  $('browserAuthPanel').classList.toggle('hidden', worker);
  $('workerPanel').classList.toggle('hidden', !worker);
  if (worker) {
    engine.pause();
    render(remoteState || emptyState());
  } else {
    stopRemotePolling();
    render(engine.snapshot());
    renderAccountGate();
  }
};

$('loadAccountsBtn').onclick = async () => {
  clearError();
  const appId = $('appId').value.trim();
  const token = $('token').value.trim();
  if (!appId || !token) return showError('App ID and trade token are required.');
  try {
    $('loadAccountsBtn').disabled = true;
    const data = await api('accounts', { appId, token });
    accounts = data.accounts || [];
    localStorage.setItem('sani.deriv.appId', appId);
    sessionStorage.setItem('sani.deriv.token', token);
    renderAccounts();
  } catch (e) {
    showError(e.message);
  } finally {
    $('loadAccountsBtn').disabled = false;
  }
};

$('accountSelect').onchange = () => {
  localStorage.setItem('sani.deriv.accountId', $('accountSelect').value);
  $('realPhrase').value = '';
  selectedAccount = accounts.find(x => x.account_id === $('accountSelect').value) || null;
  lastOtpContext = null;
  renderAccountGate();
  try { readConfig(); } catch {}
};
$('realPhrase').oninput = renderAccountGate;

$('connectBtn').onclick = async () => {
  clearError();
  try {
    readConfig();
    lastOtpContext = getAuthContext();
    $('connectBtn').disabled = true;
    // Provider mode means reconnects request a FRESH one-time WebSocket URL.
    await engine.connect(freshWsUrl);
  } catch (e) {
    showError(e.message);
  } finally {
    renderAccountGate();
  }
};
$('disconnectBtn').onclick = () => {
  engine.disconnect();
  lastOtpContext = null;
};

$('workerConnectBtn').onclick = async () => {
  clearError();
  try {
    localStorage.setItem('sani.workerUrl', $('workerUrl').value.trim());
    sessionStorage.setItem('sani.workerKey', $('workerKey').value);
    remoteState = await workerFetch('/connect', { method: 'POST' });
    render(remoteState);
    startRemotePolling();
  } catch (e) { showError(e.message); }
};
$('workerDisconnectBtn').onclick = () => {
  stopRemotePolling();
  remoteState = null;
  render(emptyState());
};

$('startBtn').onclick = async () => {
  try {
    clearError();
    const cfg = readConfig();
    if (runnerMode() === 'browser') {
      getAuthContext();
      engine.start();
    } else {
      remoteState = await workerFetch('/start', { method: 'POST', body: cfg });
      render(remoteState);
      startRemotePolling();
    }
  } catch (e) { showError(e.message); }
};
$('pauseBtn').onclick = async () => {
  try {
    if (runnerMode() === 'browser') engine.pause();
    else { remoteState = await workerFetch('/pause', { method: 'POST' }); render(remoteState); }
  } catch (e) { showError(e.message); }
};
$('stopBtn').onclick = async () => {
  try {
    if (runnerMode() === 'browser') engine.stop();
    else { remoteState = await workerFetch('/stop', { method: 'POST' }); render(remoteState); }
  } catch (e) { showError(e.message); }
};
$('resetBtn').onclick = async () => {
  try {
    if (runnerMode() === 'browser') engine.resetSession();
    else { remoteState = await workerFetch('/reset', { method: 'POST' }); render(remoteState); }
  } catch (e) { showError(e.message); }
};
$('exportBtn').onclick = () => {
  const csv = runnerMode() === 'browser' ? engine.exportCsv() : snapshotCsv(lastRenderedState || remoteState || emptyState());
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sani-trades-${new Date().toISOString().replaceAll(':','-')}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
};

function snapshotCsv(state) {
  const h = ['contract_id','direction','status','stake','duration','duration_unit','execution_method','buy_price','profit','signal_epoch','signal_quote','signal_to_send_ms','send_to_ack_ms','signal_to_ack_ms','server_purchase_delay_ms','server_start_delay_ms','purchase_time','start_time','entry_spot','exit_spot'];
  const rows = (state?.trades || []).map(t => [t.contractId,t.direction,t.status,t.stake,t.duration,t.durationUnit,t.executionMethod,t.buyPrice,t.profit??'',t.signalEpoch,t.signalQuote,t.signalToSendMs??'',t.sendToAckMs??'',t.signalToAckMs??'',t.serverPurchaseDelayMs??'',t.serverStartDelayMs??'',t.purchaseTime??'',t.startTime??'',t.entrySpot??'',t.exitSpot??'']);
  return [h, ...rows].map(row => row.map(v => `"${String(v).replaceAll('"','""')}"`).join(',')).join('\n');
}

function renderAccounts() {
  const select = $('accountSelect');
  select.innerHTML = accounts.length ? '' : '<option value="">No accounts found</option>';
  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.account_id;
    option.textContent = `${String(account.account_type).toUpperCase()} · ${account.account_id} · ${account.currency} ${account.balance}`;
    select.appendChild(option);
  }
  const saved = localStorage.getItem('sani.deriv.accountId');
  if (saved && accounts.some(a => a.account_id === saved)) select.value = saved;
  selectedAccount = accounts.find(x => x.account_id === select.value) || null;
  renderAccountGate();
}

function renderAccountGate() {
  selectedAccount = accounts.find(x => x.account_id === $('accountSelect').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('realGate').classList.toggle('hidden', !real);
  if (runnerMode() === 'browser') {
    $('accountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
    $('accountPill').classList.toggle('real', real);
  }
  $('connectBtn').disabled = !selectedAccount || (real && $('realPhrase').value !== 'REAL');
}

function showError(message) {
  $('authError').textContent = message;
  $('authError').classList.remove('hidden');
}
function clearError() { $('authError').classList.add('hidden'); }

engine.subscribe(state => { if (runnerMode() === 'browser') render(state); });
function render(state = emptyState()) {
  lastRenderedState = state;
  const workerMeta = state.worker || {};
  $('dot').classList.toggle('ok', state.connected && !state.safeBlocked);
  $('dot').classList.toggle('danger', Boolean(state.safeBlocked));
  $('connectionLabel').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.connected ? (runnerMode() === 'worker' ? 'Worker + Deriv connected' : 'Deriv connected') : 'Disconnected';
  if (runnerMode() === 'worker') {
    const type = workerMeta.accountType ? String(workerMeta.accountType).toUpperCase() : 'WORKER';
    $('accountPill').textContent = type;
    $('accountPill').classList.toggle('real', type === 'REAL');
  }
  $('statusLabel').textContent = state.status || 'idle';
  $('sessionPnl').textContent = `${Number(state.sessionPnL || 0) >= 0 ? '+' : ''}$${Number(state.sessionPnL || 0).toFixed(2)}`;
  $('sessionPnl').className = Number(state.sessionPnL || 0) >= 0 ? 'positive' : 'negative';
  $('wl').textContent = `${state.wins || 0} / ${state.losses || 0}`;
  $('bosCount').textContent = state.bosCount || 0;
  $('openCount').textContent = Number(state.openContracts || 0) + (state.pendingTrade ? 1 : 0);
  $('lastTick').textContent = state.lastTick ? Number(state.lastTick.quote).toFixed(2) : '—';
  $('startBtn').disabled = !state.connected || state.running || state.safeBlocked || !state.portfolioChecked;
  $('pauseBtn').disabled = !state.running;
  $('stopBtn').disabled = !state.connected;
  $('resetBtn').disabled = state.running || Number(state.openContracts || 0) > 0;

  const shadow = state.shadow || [];
  $('timingGrid').innerHTML = shadow.map(x => {
    const n = Number(x.wins || 0) + Number(x.losses || 0);
    const wr = n ? Number(x.wins || 0) / n * 100 : 0;
    return `<div class="timingBox"><span>T+${x.horizon}</span><strong>${n ? wr.toFixed(1)+'%' : '—'}</strong><small>${x.wins || 0}W ${x.losses || 0}L${x.pending ? ` · ${x.pending} pending` : ''}</small></div>`;
  }).join('');

  $('tradeRows').innerHTML = state.trades?.length ? state.trades.map(t => `
    <tr>
      <td>#${t.contractId}</td>
      <td>${escapeHtml(t.direction)}</td>
      <td><span class="result ${t.status}">${escapeHtml(t.status)}</span></td>
      <td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td>
      <td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0)+'ms'}</td>
      <td>${t.serverStartDelayMs === undefined ? '—' : t.serverStartDelayMs+'ms'}</td>
      <td>${t.entrySpot ?? '—'} → ${t.exitSpot ?? '—'}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">No trades yet.</td></tr>';

  $('logs').innerHTML = state.logs?.length ? state.logs.map(l => `
    <div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(l.message)}</span></div>`
  ).join('') : `<div class="empty">${state.lastError ? escapeHtml(state.lastError) : 'Engine messages will appear here.'}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

// Initial visibility.
$('runnerMode').onchange();
if ($('appId').value && $('token').value && runnerMode() === 'browser') $('loadAccountsBtn').click();
