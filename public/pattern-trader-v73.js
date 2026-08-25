import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';
import { V73UI } from './pattern-trader-v73-ui.js';
import { TrendBudget, applyMilkingPolicy } from './core/trend-budget.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const IS_MILKING_ZONE = document.body?.dataset?.lab === 'milking-zone';
const VERSION = IS_MILKING_ZONE ? 'Milking Zone v1' : 'v8.1';
const SIGNAL_KEY = IS_MILKING_ZONE ? 'sani.milkingZone.signals.v1' : 'sani.sniperCampaign.signals.v8.1';
const LEGACY_KEYS = ['sani.sniper.setups.v7.3','sani.masterTrader.signalLedger.v7.2','sani.masterTrader.signalLedger.v7.1'];
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const FIXED_DURATION = 1;
const DEFAULT_BATCH = 2;
const DEMO_MAX_CONCURRENT = 6;
const REAL_MAX_CONCURRENT = 2;

let worker;
let workerAnalysis = null;
let signals = loadArray(SIGNAL_KEY);
let legacySignals = loadLegacy();
let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let localTicks = loadTicks();
let lastTickKey = localTicks.length ? `${localTicks.at(-1).epoch}:${localTicks.at(-1).quote}` : '';
const contractMeta = new Map();
const trendBudget = IS_MILKING_ZONE ? new TrendBudget() : null;
let trendSnapshot = trendBudget?.hydrate(localTicks) || null;

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: FIXED_DURATION,
  durationUnit: 't',
  executionMethod: 'direct',
  oneOpenContract: false,
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 60,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  maxSignalToSendMs: 250,
  reconnect: true,
  maxReconnectAttempts: 8
});

function loadArray(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function saveSignals() {
  signals = signals.slice(0, 5000);
  try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(signals)); } catch {}
}
function currentSymbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function tickKey(symbol = currentSymbol()) { return `sani.observatory.ticks.${symbol}`; }
function loadTicks() {
  try {
    const v = JSON.parse(localStorage.getItem(tickKey()) || '[]');
    return Array.isArray(v) ? v.map(x => ({ epoch:+x.epoch, quote:+x.quote })).filter(x => Number.isFinite(x.epoch) && Number.isFinite(x.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000) : [];
  } catch { return []; }
}
function loadLegacy() {
  const out = [];
  for (const key of LEGACY_KEYS) {
    for (const r of loadArray(key)) {
      const id = `legacy:${key}:${r.id || r.signalEpoch || r.createdAt || Math.random()}`;
      out.push({
        legacy:true, signalId:id, createdAt:r.createdAt || r.observedAt || Date.now(),
        approved:Boolean(r.decision?.approved ?? r.agreement),
        tradeDirection:r.tradeDirection || r.direction || r.structureDirection,
        signalEpoch:r.signalEpoch, signalQuote:r.signalQuote,
        structure:r.structure || { tag:r.pivotType || r.timingClass || 'OLD', pivotType:r.pivotType, pivotQuote:r.pivotQuote, pivotEpoch:r.pivotEpoch },
        pattern:r.pattern || (Number.isFinite(+r.patternStrength) ? { edge:+r.patternStrength, familyId:'OLD' } : null),
        actualTrades:r.actualTrades || (r.actual?.contractId ? [r.actual] : r.contractId ? [{ contractId:r.contractId, outcome:r.status, profit:r.profit, entrySpot:r.entrySpot, exitSpot:r.exitSpot }] : []),
        shadow:r.shadow || (r.shadowOutcome ? { outcome:r.shadowOutcome, entry:r.shadowEntry, exit:r.shadowExit } : null),
        why:r.decision?.why || r.patternReason || r.lastReason || r.status || 'old cohort'
      });
    }
  }
  return out;
}
function allForUI() { return [...signals, ...legacySignals].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); }
function isRealAccount() { return String(selectedAccount?.account_type || '').toLowerCase() === 'real'; }
function maxConcurrent() { return isRealAccount() ? REAL_MAX_CONCURRENT : DEMO_MAX_CONCURRENT; }
function render() { V73UI.render({ analysis:workerAnalysis, signals:allForUI(), ticks:localTicks, engine:engine.snapshot(), batchSize:batchSize(), maxConcurrent:maxConcurrent(), accountType:isRealAccount()?'REAL':'DEMO', trend:trendSnapshot, lab:IS_MILKING_ZONE?'MILKING_ZONE':'SNIPER' }); }

function executionOffsetEstimate() {
  try {
    const rows = JSON.parse(localStorage.getItem(OFFSET_KEY) || '[]').map(Number).filter(Number.isFinite).slice(-30).sort((a,b)=>a-b);
    if (!rows.length) return 1;
    const m = Math.floor(rows.length / 2);
    return rows.length % 2 ? rows[m] : Math.round((rows[m-1] + rows[m]) / 2);
  } catch { return 1; }
}
function recordOffset(v) {
  if (!Number.isFinite(+v)) return;
  const a = loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite);
  a.push(Math.max(1, Math.min(10, Math.round(+v))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(a.slice(-50))); } catch {}
  worker?.postMessage({ type:'CONFIG', executionOffset:executionOffsetEstimate() });
}
function batchSize() {
  const raw = Number($('ptCooldown')?.value || DEFAULT_BATCH);
  return Math.max(1, Math.min(2, Math.round(raw || DEFAULT_BATCH)));
}
function workerMemoryRows() {
  return signals.filter(row => ['WON','LOST'].includes(row.shadow?.outcome) && row.pattern?.familyId).map(row => ({
    familyId:row.pattern.familyId,
    structureTag:row.structure?.tag,
    phase:row.structure?.phase,
    addressKey:row.addressKey,
    outcome:row.shadow.outcome
  }));
}
function totalBought() { return signals.reduce((s, r) => s + (r.actualTrades || []).filter(t => t.contractId).length, 0); }
function pendingBuys() {
  let n = 0;
  for (const p of engine.pending.values()) if (['buy-direct','proposal','buy-proposal'].includes(p?.kind)) n += 1;
  return n;
}
function exposure() { return engine.open.size + pendingBuys(); }
function upsertSignal(id, patch = {}) {
  let row = signals.find(x => x.signalId === id);
  if (!row) { row = { signalId:id, createdAt:Date.now(), actualTrades:[] }; signals.unshift(row); }
  Object.assign(row, patch, { updatedAt:Date.now() });
  row.actualTrades ||= [];
  saveSignals();
  return row;
}
function actualOffset(trade) {
  const signal = +trade?.signalEpoch, entry = +trade?.entryTickTime, start = +trade?.startTime;
  if (Number.isFinite(signal) && Number.isFinite(entry)) return Math.max(1, Math.round(entry - signal));
  if (Number.isFinite(signal) && Number.isFinite(start)) return Math.max(1, Math.round(start - signal) + 1);
}
function latency(offset) { return !Number.isFinite(+offset) ? 'UNKNOWN' : +offset <= 1 ? 'CLEAN' : +offset === 2 ? 'LATE +1' : 'LATE +2+'; }

function postTick(tick) {
  const epoch = +tick?.epoch, quote = +tick?.quote;
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const key = `${epoch}:${quote}`;
  if (key === lastTickKey) return;
  lastTickKey = key;
  localTicks.push({ epoch, quote });
  if (localTicks.length > 10000) localTicks.splice(0, localTicks.length - 10000);
  if (trendBudget) trendSnapshot = trendBudget.ingest({ epoch, quote }, workerAnalysis?.pattern?.direction || 'NONE');
  worker?.postMessage({ type:'TICK', tick:{epoch,quote} });
  render();
}

function initWorker() {
  worker?.terminate?.();
  worker = new Worker('/pattern-trader-v73-worker.js', { type:'module' });
  worker.onmessage = e => {
    const msg = e.data || {};
    if (msg.type === 'ANALYSIS') workerAnalysis = msg.analysis;
    else if (msg.type === 'DECISION') handleDecision(msg.decision);
    else if (msg.type === 'SHADOW_RESULT') {
      const row = upsertSignal(msg.signalId);
      row.shadow = msg.shadow;
      row.variants = msg.variants || row.variants;
      row.variantOutcomes = msg.variantOutcomes || row.variantOutcomes;
      row.addressKey = msg.addressKey || row.addressKey;
      saveSignals();
    }
    render();
  };
  worker.onerror = e => {
    console.error('v8.1 worker', e);
    workerAnalysis = { state:'WORKER_ERROR', reason:e.message || 'Worker error' };
    render();
  };
  worker.postMessage({ type:'INIT', ticks:localTicks, executionOffset:executionOffsetEstimate(), memoryRows:workerMemoryRows() });
}

function handleDecision(d) {
  const milkingPolicy = IS_MILKING_ZONE ? applyMilkingPolicy(d, trendSnapshot) : null;
  const approved = IS_MILKING_ZONE ? Boolean(d.approved && milkingPolicy?.approved) : d.approved;
  const requestedBatch = IS_MILKING_ZONE ? Number(milkingPolicy?.batch || 0) : d.requestedBatch;
  const row = upsertSignal(d.signalId, {
    approved,
    sniperApproved:d.approved,
    controlApproved:d.controlApproved,
    state:d.state,
    tradeDirection:d.tradeDirection,
    predicted:d.predicted,
    signalEpoch:d.signalEpoch,
    signalQuote:d.signalQuote,
    duration:d.duration,
    executionOffset:d.executionOffset,
    structure:d.structure,
    pattern:d.pattern,
    sniper:d.sniper,
    variants:d.variants,
    context80:d.context80,
    context200:d.context200,
    campaign:d.campaign,
    requestedBatch,
    decisionMs:d.decisionMs,
    milking:IS_MILKING_ZONE ? { ...trendSnapshot, policy:milkingPolicy } : undefined,
    why:IS_MILKING_ZONE ? `${milkingPolicy?.reason || 'Trend Budget observing.'} · ${d.why}` : d.why
  });

  if (!approved) {
    if (IS_MILKING_ZONE && d.approved) row.executionState = `MILKING_${trendSnapshot?.state || 'OBSERVE'}_BLOCK`;
    saveSignals();
    return;
  }
  const s = engine.snapshot();
  if (!s.running) { row.executionState = s.connected ? 'OBSERVED' : 'DISCONNECTED'; saveSignals(); return; }
  if (s.safeBlocked) { row.executionState = 'SAFE_BLOCK'; saveSignals(); return; }
  if (Number(s.cooldownRemaining || 0) > 0) { row.executionState = `RISK_COOLDOWN_${s.cooldownRemaining}`; saveSignals(); return; }
  if (totalBought() >= Number($('ptMaxTrades')?.value || 60)) { row.executionState = 'CAP'; saveSignals(); engine.pause(); return; }

  const room = Math.max(0, maxConcurrent() - exposure());
  const wanted = Math.min(Number(requestedBatch || 1), batchSize(), room, Math.max(0, Number($('ptMaxTrades')?.value || 60) - totalBought()));
  if (wanted <= 0) { row.executionState = 'EXPOSURE_FULL'; saveSignals(); return; }

  try {
    traderConfig();
    const sent = [];
    for (let slot = 1; slot <= wanted; slot += 1) {
      const detectedPerf = perfNow();
      const didSend = engine.execute({
        direction:d.tradeDirection,
        structure:`v81-${d.pattern.familyId}-${d.structure.tag}`,
        epoch:d.signalEpoch,
        quote:d.signalQuote,
        detectedPerf,
        detectedWallMs:Date.now(),
        patternMeta:{ signalId:d.signalId, slot, slotRole:slot===1?'BASE':'EARNED', familyId:d.pattern.familyId, edge:d.pattern.edge, grade:d.sniper?.grade, structureTag:d.structure.tag }
      });
      if (didSend) sent.push(slot);
    }
    row.executionState = sent.length ? `ORDER_SENT_X${sent.length}` : 'NOT_SENT';
    row.requestedBatch = sent.length;
    saveSignals();
    if (sent.length) engine.log('success', `${VERSION} ${d.tradeDirection} x${sent.length} · ${trendSnapshot?.state || d.sniper?.event} · ${d.sniper?.grade} · ${d.pattern.familyId} · ${d.decisionMs.toFixed(1)}ms.`);
  } catch (err) {
    row.executionState = 'ERROR'; row.error = err.message; saveSignals(); showError(err.message);
  }
}

engine.onTick = function v8Tick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  if (this.cooldownRemaining > 0) {
    this.cooldownRemaining -= 1;
    if (this.cooldownRemaining === 0) this.log('success', 'Risk cooldown complete. Sniper may fire on the next qualified repeat.');
  }
  postTick(tick);
  this.emit();
};

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onV8Buy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : null;
  baseBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(t => Number(t.contractId) === contractId);
  if (!trade || !meta?.signalId) return;
  trade.signalId = meta.signalId;
  trade.batchSlot = meta.slot;
  trade.slotRole = meta.slotRole;
  contractMeta.set(contractId, meta);
  const row = upsertSignal(meta.signalId);
  const existing = row.actualTrades.find(t => Number(t.contractId) === contractId);
  if (!existing) row.actualTrades.push({ contractId, slot:meta.slot, slotRole:meta.slotRole, outcome:'OPEN', buyAckMs:trade.sendToAckMs });
  saveSignals(); render();
};

const baseContract = engine.onContract.bind(engine);
engine.onContract = function onV8Contract(contract) {
  const id = Number(contract?.contract_id);
  const meta = contractMeta.get(id) || this.trades.find(t => Number(t.contractId) === id)?.patternMeta;
  baseContract(contract);
  if (!meta?.signalId || !(contract?.is_sold || contract?.is_expired)) return;
  const trade = this.trades.find(t => Number(t.contractId) === id);
  if (!trade) return;
  const offset = actualOffset(trade);
  if (Number.isFinite(offset)) recordOffset(offset);
  const row = upsertSignal(meta.signalId);
  const item = row.actualTrades.find(t => Number(t.contractId) === id) || { contractId:id, slot:meta.slot, slotRole:meta.slotRole };
  Object.assign(item, {
    outcome:trade.status === 'won' ? 'WON' : trade.status === 'lost' ? 'LOST' : String(trade.status || 'SOLD').toUpperCase(),
    profit:trade.profit,
    entrySpot:trade.entrySpot,
    exitSpot:trade.exitSpot,
    entryEpoch:trade.entryTickTime,
    exitEpoch:trade.exitTickTime,
    latency:latency(offset),
    window:Number.isFinite(offset) ? `T+${offset}→T+${offset + FIXED_DURATION}` : 'unknown',
    buyAckMs:trade.sendToAckMs
  });
  if (!row.actualTrades.some(t => Number(t.contractId) === id)) row.actualTrades.push(item);
  saveSignals(); render();
};

function traderConfig() {
  const real = isRealAccount();
  const config = {
    ...engine.config,
    symbol:currentSymbol(),
    stake:+$('ptStake').value,
    takeProfit:+$('ptTakeProfit').value,
    stopLoss:+$('ptStopLoss').value,
    maxTrades:+$('ptMaxTrades').value,
    duration:FIXED_DURATION,
    durationUnit:'t',
    cooldownTicks:real ? 30 : 0,
    executionMethod:'direct',
    oneOpenContract:false,
    maxSignalToSendMs:250,
    currency:selectedAccount?.currency || 'USD',
    maxConsecutiveLosses:real ? 3 : 0,
    reconnect:true,
    maxReconnectAttempts:8
  };
  if (!(config.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (IS_MILKING_ZONE && real) throw new Error('Milking Zone v1 is Demo-only while Trend Budget is being validated.');
  if (real && !$('v81RealConfirm')?.checked) throw new Error('Confirm the guarded Real-money test before connecting or starting.');
  if (real && !(config.stopLoss > 0)) throw new Error('A stop loss greater than $0 is mandatory on a Real account.');
  if (real && config.stake > 5) throw new Error('v8.1 Real test stake is capped at $5 per contract.');
  if (real && config.maxTrades > 50) throw new Error('v8.1 Real test is capped at 50 contracts per cohort.');
  if (!engine.snapshot().running) engine.setConfig(config);
  return config;
}
function auth() {
  const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim(), accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  if (isRealAccount() && !$('v81RealConfirm')?.checked) throw new Error('Tick the Real-money confirmation first.');
  return { appId, token, accountId };
}
async function api(path, body) {
  const r = await fetch(`/api/${path}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), cache:'no-store' });
  const j = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(j.error || `API ${r.status}`);
  return j;
}
async function freshWs() { const d = await api('otp', lastOtpContext || auth()); if (!d.url) throw new Error('OTP response missing WebSocket URL.'); return d.url; }
function showError(m) { if (!$('traderError')) return; $('traderError').textContent = m; $('traderError').classList.remove('hidden'); }
function clearError() { if (!$('traderError')) return; $('traderError').textContent = ''; $('traderError').classList.add('hidden'); }
function renderAccounts() {
  const select = $('ptAccount');
  select.innerHTML = accounts.length ? '' : '<option value="">No accounts found</option>';
  for (const a of accounts) {
    const o = document.createElement('option'); o.value = a.account_id; o.textContent = `${String(a.account_type).toUpperCase()} · ${a.account_id} · ${a.currency} ${a.balance}`; select.appendChild(o);
  }
  const saved = localStorage.getItem('sani.deriv.accountId');
  if (saved && accounts.some(a => a.account_id === saved)) select.value = saved;
  if (!select.value || String(accounts.find(a => a.account_id === select.value)?.account_type).toLowerCase() === 'real') {
    const demo = accounts.find(a => String(a.account_type).toLowerCase() !== 'real'); if (demo) select.value = demo.account_id;
  }
  selectedAccount = accounts.find(a => a.account_id === select.value) || null;
  renderGate();
}
function renderGate() {
  selectedAccount = accounts.find(a => a.account_id === $('ptAccount').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('ptRealGate')?.classList.toggle('hidden', !real);
  if ($('v81RealMode')) $('v81RealMode').classList.toggle('hidden', !real);
  if ($('ptAccountPill')) $('ptAccountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
  if (real) {
    if ($('ptMaxTrades') && Number($('ptMaxTrades').value) > 50) $('ptMaxTrades').value = '30';
    if ($('ptStopLoss') && !(Number($('ptStopLoss').value) > 0)) $('ptStopLoss').value = '5';
  }
  if ($('ptConnect')) $('ptConnect').disabled = !selectedAccount || (real && !$('v81RealConfirm')?.checked);
  render();
}

function exportCsv() {
  const headers = ['signal_id','created_at','milking_approved','sniper_approved','control_approved','event','grade','score','repeat_count','batch','trade_direction','signal_epoch','signal_quote','trend_state','trend_direction','trend_health','trend_maturity','trend_exhaustion','trend_age_seconds','trend_remaining_low','trend_remaining_median','trend_remaining_high','trend_efficiency','trend_decelerating','structure_tag','phase','pattern_family','pattern_length','edge','matches','similarity','top10','family_memory','address_memory','campaign_direction','campaign_fires','variant_control','variant_repeat','variant_length','variant_memory','variant_hysteresis','variant_structure','variant_sniper','decision_ms','execution_state','actual_contracts','actual_wins','actual_losses','actual_profit','shadow','why'];
  const rows = signals.map(s => {
    const trades = s.actualTrades || [];
    return [s.signalId,new Date(s.createdAt||Date.now()).toISOString(),s.approved,s.sniperApproved,s.controlApproved,s.sniper?.event,s.sniper?.grade,s.sniper?.score,s.sniper?.repeatCount,s.requestedBatch,s.tradeDirection,s.signalEpoch,s.signalQuote,s.milking?.state,s.milking?.direction,s.milking?.health,s.milking?.maturity,s.milking?.exhaustion,s.milking?.ageSeconds,s.milking?.remaining?.low,s.milking?.remaining?.median,s.milking?.remaining?.high,s.milking?.efficiency,s.milking?.decelerating,s.structure?.tag,s.structure?.phase,s.pattern?.familyId,s.pattern?.length,s.pattern?.edge,s.pattern?.matchCount,s.pattern?.avgSimilarity,`${s.pattern?.top10Agree||0}/${s.pattern?.top10Total||0}`,`${s.sniper?.familyMemory?.wins||0}/${s.sniper?.familyMemory?.losses||0}`,`${s.sniper?.addressMemory?.wins||0}/${s.sniper?.addressMemory?.losses||0}`,s.campaign?.direction,s.campaign?.fires,s.variants?.control,s.variants?.repeat,s.variants?.length,s.variants?.memory,s.variants?.hysteresis,s.variants?.structure,s.variants?.sniper,s.decisionMs,s.executionState,trades.length,trades.filter(t=>t.outcome==='WON').length,trades.filter(t=>t.outcome==='LOST').length,trades.reduce((a,t)=>a+(+t.profit||0),0),s.shadow?.outcome,s.why];
  });
  const csv = [headers,...rows].map(r => r.map(v => `"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  const a = document.createElement('a'); a.href = url; a.download = `${IS_MILKING_ZONE?'sani-milking-zone':'sani-v8.1-sniper-campaign'}-${new Date().toISOString().replaceAll(':','-')}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),500);
}

function bindControls() {
  $('ptLoadAccounts').onclick = async () => {
    clearError();
    try {
      const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim();
      if (!appId || !token) throw new Error('App ID and trade token are required.');
      $('ptLoadAccounts').disabled = true;
      const d = await api('accounts', { appId, token }); accounts = d.accounts || [];
      localStorage.setItem('sani.deriv.appId', appId); sessionStorage.setItem('sani.deriv.token', token); renderAccounts();
    } catch (e) { showError(e.message); }
    finally { $('ptLoadAccounts').disabled = false; }
  };
  $('ptAccount').onchange = () => { localStorage.setItem('sani.deriv.accountId', $('ptAccount').value); lastOtpContext = null; renderGate(); };
  $('v81RealConfirm')?.addEventListener('change', renderGate);
  $('ptConnect').onclick = async () => { clearError(); try { traderConfig(); lastOtpContext = auth(); $('ptConnect').disabled = true; await engine.connect(freshWs); } catch(e) { showError(e.message); } finally { renderGate(); } };
  $('ptDisconnect').onclick = () => { engine.disconnect(); lastOtpContext = null; };
  $('ptStart').onclick = () => { clearError(); try { auth(); traderConfig(); engine.start(); engine.log('info',IS_MILKING_ZONE ? 'Milking Zone armed on Demo: Trend Budget chooses the side, sniper patterns choose the exact tick.' : `v8.1 armed on ${isRealAccount()?'REAL':'DEMO'}: only the full sniper lane can buy. Six comparison variants remain shadow-only.`); } catch(e) { showError(e.message); } };
  $('ptPause').onclick = () => engine.pause();
  $('ptStop').onclick = () => engine.stop();
  $('ptReset').onclick = () => { try { engine.resetSession(); worker?.postMessage({type:'RESET'}); if (trendBudget) trendSnapshot = trendBudget.hydrate(localTicks); render(); } catch(e) { showError(e.message); } };
  $('ptClearLedger').onclick = () => { if (confirm(IS_MILKING_ZONE ? 'Clear the Milking Zone cohort?' : 'Clear the fresh v8.1 sniper cohort?')) { signals=[]; localStorage.removeItem(SIGNAL_KEY); render(); } };
  $('ptResetCalibration').onclick = () => { if (confirm('Reset measured execution offset?')) { localStorage.removeItem(OFFSET_KEY); worker?.postMessage({type:'CONFIG',executionOffset:1}); render(); } };
  $('ptExportLedger').onclick = exportCsv;
  for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) $(id)?.addEventListener('change', () => { try { if (!engine.snapshot().running) traderConfig(); render(); } catch(e) { showError(e.message); } });
}

engine.subscribe(state => {
  if ($('ptStatus')) $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.status === 'reconnecting' ? 'RECONNECTING' : state.connected ? (state.running ? 'MILKING' : 'CONNECTED') : 'DISCONNECTED';
  if ($('ptPnl')) { $('ptPnl').textContent = `${Number(state.sessionPnL||0)>=0?'+':''}$${Number(state.sessionPnL||0).toFixed(2)}`; $('ptPnl').className = Number(state.sessionPnL||0)>=0?'positive':'negative'; }
  if ($('ptWL')) $('ptWL').textContent = `${state.wins||0} / ${state.losses||0}`;
  if ($('ptOpen')) $('ptOpen').textContent = String(Number(state.openContracts||0) + pendingBuys());
  if ($('ptStart')) $('ptStart').disabled = !state.connected || state.running || state.safeBlocked || !state.portfolioChecked;
  if ($('ptPause')) $('ptPause').disabled = !state.running;
  if ($('ptStop')) $('ptStop').disabled = !state.connected;
  if ($('ptReset')) $('ptReset').disabled = state.running || Number(state.openContracts||0)>0 || pendingBuys()>0;
  if ($('ptAccount')) $('ptAccount').disabled = state.connected;
  if ($('ptLoadAccounts')) $('ptLoadAccounts').disabled = state.connected;
  if ($('ptLogs')) $('ptLogs').innerHTML = state.logs?.length ? state.logs.slice(0,60).map(log => `<div class="log ${log.level}"><time>${new Date(log.at).toLocaleTimeString()}</time><span>${String(log.message||'')}</span></div>`).join('') : '<div class="empty">v8.1 messages appear here.</div>';
  render();
});

window.addEventListener('sani-observatory-analysis', event => {
  const t = event.detail;
  if (IS_MILKING_ZONE && Number(t?.archiveCount || 0) > localTicks.length + 10 && typeof window.SaniObservatory?.getTicks === 'function') {
    const feedTicks = window.SaniObservatory.getTicks().filter(row => Number.isFinite(+row.epoch) && Number.isFinite(+row.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000);
    if (feedTicks.length) {
      localTicks = feedTicks;
      lastTickKey = `${feedTicks.at(-1).epoch}:${feedTicks.at(-1).quote}`;
      trendSnapshot = trendBudget?.hydrate(localTicks) || trendSnapshot;
      worker?.postMessage({ type:'INIT', ticks:localTicks, executionOffset:executionOffsetEstimate(), memoryRows:workerMemoryRows() });
      render();
      return;
    }
  }
  if (t?.epoch !== undefined && t?.quote !== undefined) postTick(t);
});
window.addEventListener('resize', render);

function boot() {
  V73UI.install();
  if ($('ptCooldown')) $('ptCooldown').value = String(DEFAULT_BATCH);
  if ($('ptMaxTrades')) $('ptMaxTrades').value = '60';
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  bindControls();
  initWorker();
  render();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true});
else boot();
