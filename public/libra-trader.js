import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';
import { TrendBudget } from './core/trend-budget.mjs';
import { LibraBrain, LIBRA_VERSION } from './core/libra-brain.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const SIGNAL_KEY = 'sani.libra.signals.v1';
const BRAIN_KEY = 'sani.libra.brain.v1';
const FIXED_DURATION = 1;
const MAX_CONCURRENT = 2;

let worker;
let workerAnalysis = null;
let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let signals = loadArray(SIGNAL_KEY);
let localTicks = loadTicks();
let lastTickKey = localTicks.length ? `${localTicks.at(-1).epoch}:${localTicks.at(-1).quote}` : '';
let pendingForecast = null;
let lastArbitration = null;
let mission = freshMission();
const contractMeta = new Map();
const brain = new LibraBrain(loadJson(BRAIN_KEY));
const trendBudget = new TrendBudget({ shortSeconds:8, primarySeconds:21, confirmSeconds:55, flipVotes:2, flipWindowSeconds:3 });
let trendSnapshot = trendBudget.hydrate(localTicks) || null;

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol:'1HZ25V',
  stake:1,
  duration:FIXED_DURATION,
  durationUnit:'t',
  executionMethod:'direct',
  oneOpenContract:false,
  takeProfit:0,
  stopLoss:0,
  maxTrades:5000,
  maxConsecutiveLosses:0,
  cooldownTicks:0,
  maxSignalToSendMs:250,
  reconnect:true,
  maxReconnectAttempts:8
});

function freshMission() {
  return {
    status:'IDLE', startedAt:0, deadlineAt:0, basePnl:0, baseTrades:0,
    targetProfit:30, hardStop:15, maxTrades:200, durationMinutes:30, goal:650,
    reason:'Connect, let Libra read the tape, then start the mission.'
  };
}

function loadArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function saveSignals() {
  signals = signals.slice(0, 6000);
  try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(signals)); } catch {}
}
function persistBrain() {
  try { localStorage.setItem(BRAIN_KEY, JSON.stringify(brain.exportState())); } catch {}
}
function currentSymbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function tickKey(symbol = currentSymbol()) { return `sani.observatory.ticks.${symbol}`; }
function loadTicks() {
  try {
    const value = JSON.parse(localStorage.getItem(tickKey()) || '[]');
    return Array.isArray(value)
      ? value.map(row => ({epoch:+row.epoch, quote:+row.quote})).filter(row => Number.isFinite(row.epoch) && Number.isFinite(row.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000)
      : [];
  } catch { return []; }
}
function upsertSignal(id, patch = {}) {
  let row = signals.find(item => item.signalId === id);
  if (!row) { row = { signalId:id, createdAt:Date.now(), actualTrades:[] }; signals.unshift(row); }
  Object.assign(row, patch, { updatedAt:Date.now() });
  row.actualTrades ||= [];
  saveSignals();
  return row;
}
function batchSize() { return Math.max(1, Math.min(2, Math.round(Number($('ptCooldown')?.value || 1)))); }
function exposure() {
  let pending = 0;
  for (const request of engine.pending.values()) if (['buy-direct','proposal','buy-proposal'].includes(request?.kind)) pending += 1;
  return engine.open.size + pending;
}
function totalSettled() { return engine.trades.filter(trade => ['won','lost'].includes(String(trade.status || '').toLowerCase())).length; }
function missionRunPnl() { return Number(engine.snapshot().sessionPnL || 0) - Number(mission.basePnl || 0); }
function missionRunTrades() { return Math.max(0, totalSettled() - Number(mission.baseTrades || 0)); }
function missionPlanFromForm() {
  return {
    durationMinutes:Math.max(1, Math.min(720, Number($('libraDuration')?.value || 30))),
    targetProfit:Math.max(0, Number($('ptTakeProfit')?.value || 30)),
    hardStop:Math.max(0.35, Number($('ptStopLoss')?.value || 15)),
    maxTrades:Math.max(1, Math.min(5000, Math.round(Number($('ptMaxTrades')?.value || 200)))),
    goal:Math.max(0, Number($('libraGoal')?.value || 650))
  };
}
function checkMission(now = Date.now()) {
  const runPnl = missionRunPnl();
  const runTrades = missionRunTrades();
  if (mission.status !== 'ACTIVE') return {stop:true, runPnl, runTrades, status:mission.status};
  if (runPnl <= -Math.abs(mission.hardStop)) {
    mission.status='HARD STOP'; mission.reason=`Hard stop reached at ${runPnl.toFixed(2)}. I am done paying for bad states.`;
  } else if (mission.targetProfit > 0 && runPnl >= mission.targetProfit) {
    mission.status='TARGET'; mission.reason=`Mission target reached at +$${runPnl.toFixed(2)}. I am locking the win.`;
  } else if (runTrades >= mission.maxTrades) {
    mission.status='CAP'; mission.reason=`The ${mission.maxTrades}-contract cap is complete.`;
  } else if (now >= mission.deadlineAt) {
    mission.status='TIME'; mission.reason=`The mission clock ended at ${runPnl >= 0 ? '+' : ''}$${runPnl.toFixed(2)}.`;
  }
  if (mission.status !== 'ACTIVE' && engine.running) engine.pause();
  return {stop:mission.status !== 'ACTIVE', runPnl, runTrades, status:mission.status};
}

function makeSnapshot() {
  const engineState = engine.snapshot();
  const prediction = brain.predict(localTicks);
  const brainState = brain.snapshot();
  const gate = checkMission();
  return {
    version:LIBRA_VERSION,
    ticks:localTicks,
    signals:[...signals].sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)),
    engine:engineState,
    analysis:workerAnalysis,
    trend:trendSnapshot,
    prediction,
    brain:brainState,
    arbitration:lastArbitration,
    mission:{...mission, runPnl:gate.runPnl, runTrades:gate.runTrades, remainingMs:mission.deadlineAt ? Math.max(0, mission.deadlineAt-Date.now()) : 0},
    accountType:selectedAccount ? String(selectedAccount.account_type || 'DEMO').toUpperCase() : 'NONE'
  };
}
function publish() {
  const detail = makeSnapshot();
  window.dispatchEvent(new CustomEvent('libra-state', {detail}));
  return detail;
}

function learnPreviousTick(epoch, quote) {
  if (!pendingForecast || Number(epoch) <= Number(pendingForecast.epoch)) return;
  const actualUp = quote > pendingForecast.quote ? true : quote < pendingForecast.quote ? false : null;
  if (actualUp == null) {
    brain.learn({actualUp:null});
  } else {
    brain.learn({
      features:pendingForecast.features,
      signature:pendingForecast.signature,
      predictedUp:pendingForecast.probabilityUp,
      actualUp,
      regime:pendingForecast.regime,
      confidence:pendingForecast.confidence
    });
  }
  persistBrain();
}

function postTick(tick) {
  const epoch = Number(tick?.epoch), quote = Number(tick?.quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const key = `${epoch}:${quote}`;
  if (key === lastTickKey) return;
  learnPreviousTick(epoch, quote);
  lastTickKey = key;
  localTicks.push({epoch, quote});
  if (localTicks.length > 10000) localTicks.splice(0, localTicks.length - 10000);
  trendSnapshot = {...trendBudget.ingest({epoch,quote}, workerAnalysis?.pattern?.direction || 'NONE'), epoch};
  const forecast = brain.predict(localTicks);
  pendingForecast = forecast.ready ? {
    epoch, quote, features:[...(forecast.features || [])], signature:forecast.signature,
    probabilityUp:forecast.probabilityUp, regime:forecast.regime, confidence:forecast.confidence
  } : null;
  worker?.postMessage({type:'TICK', tick:{epoch,quote}});
  publish();
}

function initWorker() {
  worker?.terminate?.();
  worker = new Worker('/pattern-trader-v73-worker.js', {type:'module'});
  worker.onmessage = event => {
    const message = event.data || {};
    if (message.type === 'ANALYSIS') workerAnalysis = message.analysis;
    else if (message.type === 'DECISION') handleDecision(message.decision);
    else if (message.type === 'SHADOW_RESULT') {
      const row = upsertSignal(message.signalId);
      row.shadow = message.shadow;
      row.variantOutcomes = message.variantOutcomes || row.variantOutcomes;
      row.addressKey = message.addressKey || row.addressKey;
      saveSignals();
    }
    publish();
  };
  worker.onerror = event => {
    workerAnalysis = {state:'WORKER_ERROR', reason:event.message || 'Worker error'};
    showError(event.message || 'Worker error');
    publish();
  };
  worker.postMessage({type:'INIT', ticks:localTicks, executionOffset:1, memoryRows:[]});
}

function sourceFromDecision(decision) {
  const baseline = decision?.pattern?.baseline || {};
  const approved = Boolean(decision?.controlApproved);
  const tradeDirection = baseline.direction === 'UP' ? 'CALL' : baseline.direction === 'DOWN' ? 'PUT' : decision?.tradeDirection;
  return {
    approved,
    tradeDirection:['CALL','PUT'].includes(tradeDirection) ? tradeDirection : 'NONE',
    signalEpoch:decision?.signalEpoch,
    signalQuote:decision?.signalQuote,
    familyId:baseline.familyId || decision?.pattern?.familyId,
    edge:baseline.edge ?? decision?.pattern?.edge,
    why:approved ? 'Original v8 baseline qualified.' : 'Original v8 baseline is quiet.'
  };
}

function handleDecision(decision) {
  if (!decision?.signalId) return;
  const source = sourceFromDecision(decision);
  const gate = checkMission();
  let arbitration = brain.decide({
    ticks:localTicks,
    sourceDecision:source,
    openContracts:exposure(),
    runPnl:gate.runPnl
  });
  if (gate.stop) arbitration = {...arbitration, action:'MISSION LOCK', approved:false, tradeDirection:'NONE', reason:mission.reason};
  lastArbitration = {...arbitration, at:Date.now(), signalId:decision.signalId};

  const row = upsertSignal(decision.signalId, {
    approved:Boolean(arbitration.approved),
    sourceApproved:source.approved,
    sourceDirection:source.tradeDirection,
    tradeDirection:arbitration.tradeDirection,
    signalEpoch:decision.signalEpoch,
    signalQuote:decision.signalQuote,
    duration:FIXED_DURATION,
    structure:decision.structure,
    pattern:{...decision.pattern, foundationFamily:source.familyId, foundationEdge:source.edge},
    sniper:decision.sniper,
    campaign:decision.campaign,
    decisionMs:decision.decisionMs,
    libra:{
      action:arbitration.action,
      reason:arbitration.reason,
      regime:arbitration.regime,
      direction:arbitration.direction,
      confidence:arbitration.confidence,
      probabilityUp:arbitration.probabilityUp,
      bestHorizon:arbitration.bestHorizon,
      horizons:arbitration.horizons,
      signature:arbitration.signature,
      features:arbitration.features,
      modelGeneration:arbitration.modelGeneration,
      updates:arbitration.updates,
      retainedStates:arbitration.retainedStates,
      lastLearnMs:arbitration.lastLearnMs
    },
    why:`${arbitration.reason} Foundation: ${source.why}`
  });

  if (!arbitration.approved || !['CALL','PUT'].includes(arbitration.tradeDirection)) {
    row.executionState = `LIBRA_${String(arbitration.action).replaceAll(' ','_')}`;
    saveSignals(); publish(); return;
  }
  const state = engine.snapshot();
  if (!state.running) { row.executionState = state.connected ? 'OBSERVED' : 'DISCONNECTED'; saveSignals(); publish(); return; }
  if (state.safeBlocked) { row.executionState='SAFE_BLOCK'; saveSignals(); publish(); return; }
  if (exposure() >= MAX_CONCURRENT) { row.executionState='EXPOSURE_FULL'; saveSignals(); publish(); return; }
  if (missionRunTrades() >= mission.maxTrades) { row.executionState='MISSION_CAP'; checkMission(); saveSignals(); publish(); return; }

  try {
    traderConfig();
    const room = Math.max(0, MAX_CONCURRENT - exposure());
    const wanted = Math.min(batchSize(), room, Math.max(0, mission.maxTrades - missionRunTrades()));
    const sent = [];
    for (let slot = 1; slot <= wanted; slot += 1) {
      const didSend = engine.execute({
        direction:arbitration.tradeDirection,
        structure:`libra-${String(arbitration.action).toLowerCase().replaceAll(' ','-')}-${source.familyId || decision.structure?.tag || 'state'}`,
        epoch:decision.signalEpoch,
        quote:decision.signalQuote,
        detectedPerf:perfNow(),
        detectedWallMs:Date.now(),
        patternMeta:{
          signalId:decision.signalId,
          slot,
          action:arbitration.action,
          sourceDirection:source.tradeDirection,
          libraDirection:arbitration.tradeDirection,
          regime:arbitration.regime,
          confidence:arbitration.confidence
        }
      });
      if (didSend) sent.push(slot);
    }
    row.requestedBatch = sent.length;
    row.executionState = sent.length ? `ORDER_SENT_X${sent.length}` : 'NOT_SENT';
    if (sent.length) engine.log('success', `LIBRA ${arbitration.action} · ${arbitration.tradeDirection} x${sent.length} · ${arbitration.regime} · ${arbitration.confidence.toFixed(0)}%.`);
  } catch (error) {
    row.executionState='ERROR'; row.error=error.message; showError(error.message);
  }
  saveSignals(); publish();
}

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onLibraBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? {...pending.signal.patternMeta} : null;
  baseBuy(message);
  const contractId = Number(message?.buy?.contract_id);
  const trade = this.trades.find(item => Number(item.contractId) === contractId);
  if (!trade || !meta?.signalId) return;
  trade.signalId = meta.signalId;
  trade.patternMeta = meta;
  contractMeta.set(contractId, meta);
  const row = upsertSignal(meta.signalId);
  if (!row.actualTrades.some(item => Number(item.contractId) === contractId)) {
    row.actualTrades.push({contractId, slot:meta.slot, outcome:'OPEN', buyAckMs:trade.sendToAckMs});
  }
  saveSignals(); publish();
};

const baseContract = engine.onContract.bind(engine);
engine.onContract = function onLibraContract(contract) {
  const id = Number(contract?.contract_id);
  const meta = contractMeta.get(id) || this.trades.find(item => Number(item.contractId) === id)?.patternMeta;
  baseContract(contract);
  if (!meta?.signalId || !(contract?.is_sold || contract?.is_expired)) return;
  const trade = this.trades.find(item => Number(item.contractId) === id);
  if (!trade) return;
  const row = upsertSignal(meta.signalId);
  const item = row.actualTrades.find(entry => Number(entry.contractId) === id) || {contractId:id, slot:meta.slot};
  Object.assign(item, {
    outcome:trade.status === 'won' ? 'WON' : trade.status === 'lost' ? 'LOST' : String(trade.status || 'SOLD').toUpperCase(),
    profit:trade.profit,
    entrySpot:trade.entrySpot,
    exitSpot:trade.exitSpot,
    entryEpoch:trade.entryTickTime,
    exitEpoch:trade.exitTickTime,
    buyAckMs:trade.sendToAckMs
  });
  if (!row.actualTrades.some(entry => Number(entry.contractId) === id)) row.actualTrades.push(item);
  const entrySpot = Number(item.entrySpot), exitSpot = Number(item.exitSpot);
  if (row.libra?.features && Number.isFinite(entrySpot) && Number.isFinite(exitSpot) && entrySpot !== exitSpot) {
    brain.learn({
      features:row.libra.features,
      signature:row.libra.signature || 'PAID_UNKNOWN',
      predictedUp:Number(row.libra.probabilityUp ?? 0.5),
      actualUp:exitSpot > entrySpot,
      regime:row.libra.regime || 'PAID',
      confidence:Number(row.libra.confidence || 0)
    });
    persistBrain();
    row.libra.paidLesson = brain.snapshot().lastLesson;
  }
  saveSignals();
  checkMission();
  publish();
};

engine.onTick = function onLibraTick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  postTick(tick);
  this.emit();
};
engine.subscribe(() => publish());

function traderConfig() {
  const plan = missionPlanFromForm();
  const config = {
    ...engine.config,
    symbol:currentSymbol(),
    stake:Number($('ptStake')?.value || 1),
    takeProfit:0,
    stopLoss:0,
    maxTrades:5000,
    duration:FIXED_DURATION,
    durationUnit:'t',
    cooldownTicks:0,
    executionMethod:'direct',
    oneOpenContract:false,
    maxSignalToSendMs:250,
    currency:selectedAccount?.currency || 'USD',
    maxConsecutiveLosses:0,
    reconnect:true,
    maxReconnectAttempts:8
  };
  if (!(config.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (String(selectedAccount?.account_type || '').toLowerCase() === 'real') throw new Error('Libra v1 is Demo-only while her adaptive policy is being validated.');
  if (!engine.snapshot().running) engine.setConfig(config);
  return {...config, ...plan};
}
function auth() {
  const appId=$('ptAppId')?.value?.trim(), token=$('ptToken')?.value?.trim(), accountId=$('ptAccount')?.value;
  selectedAccount = accounts.find(account => account.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Demo account.');
  if (String(selectedAccount.account_type || '').toLowerCase() === 'real') throw new Error('Choose a Demo account for Libra v1.');
  return {appId, token, accountId};
}
async function api(path, body) {
  const response=await fetch(`/api/${path}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(data.error || `API ${response.status}`);
  return data;
}
async function freshWs() { const data=await api('otp', lastOtpContext || auth()); if(!data.url) throw new Error('OTP response missing WebSocket URL.'); return data.url; }
function showError(message) { if(!$('traderError')) return; $('traderError').textContent=message; $('traderError').classList.remove('hidden'); }
function clearError() { if(!$('traderError')) return; $('traderError').textContent=''; $('traderError').classList.add('hidden'); }
function renderAccounts() {
  const select=$('ptAccount');
  if(!select) return;
  select.innerHTML = accounts.length ? '' : '<option value="">No accounts found</option>';
  for(const account of accounts) {
    const option=document.createElement('option');
    option.value=account.account_id;
    option.textContent=`${String(account.account_type).toUpperCase()} · ${account.account_id} · ${account.currency} ${account.balance}`;
    select.appendChild(option);
  }
  const saved=localStorage.getItem('sani.deriv.accountId');
  if(saved && accounts.some(account=>account.account_id===saved && String(account.account_type).toLowerCase()!=='real')) select.value=saved;
  const demo=accounts.find(account=>String(account.account_type).toLowerCase()!=='real');
  if(demo && (!select.value || String(accounts.find(account=>account.account_id===select.value)?.account_type).toLowerCase()==='real')) select.value=demo.account_id;
  selectedAccount=accounts.find(account=>account.account_id===select.value)||null;
  publish();
}

function bindControls() {
  $('ptLoadAccounts')?.addEventListener('click', async () => {
    clearError();
    try {
      const appId=$('ptAppId').value.trim(), token=$('ptToken').value.trim();
      if(!appId||!token) throw new Error('App ID and trade token are required.');
      $('ptLoadAccounts').disabled=true;
      const data=await api('accounts',{appId,token}); accounts=data.accounts||[];
      localStorage.setItem('sani.deriv.appId',appId); sessionStorage.setItem('sani.deriv.token',token); renderAccounts();
    } catch(error) { showError(error.message); }
    finally { $('ptLoadAccounts').disabled=false; }
  });
  $('ptAccount')?.addEventListener('change',()=>{localStorage.setItem('sani.deriv.accountId',$('ptAccount').value);lastOtpContext=null;selectedAccount=accounts.find(account=>account.account_id===$('ptAccount').value)||null;publish();});
  $('ptConnect')?.addEventListener('click',async()=>{clearError();try{traderConfig();lastOtpContext=auth();$('ptConnect').disabled=true;await engine.connect(freshWs);}catch(error){showError(error.message);}finally{$('ptConnect').disabled=false;publish();}});
  $('ptDisconnect')?.addEventListener('click',()=>{mission.status='IDLE';mission.reason='Trader disconnected.';engine.disconnect();lastOtpContext=null;publish();});
  $('ptStart')?.addEventListener('click',()=>{
    clearError();
    try {
      auth(); const plan=traderConfig(); engine.start();
      mission={
        ...freshMission(), ...plan,
        status:'ACTIVE', startedAt:Date.now(), deadlineAt:Date.now()+plan.durationMinutes*60000,
        basePnl:Number(engine.snapshot().sessionPnL||0), baseTrades:totalSettled(),
        reason:'I am live. I will let SMFN through when it is right, block it when it is weak, and lead when my edge is cleaner.'
      };
      engine.log('success','LIBRA armed. Original v8 remains the foundation; Libra now arbitrates every fresh decision and learns from every settled tick transition.');
      publish();
    } catch(error) { showError(error.message); }
  });
  $('ptPause')?.addEventListener('click',()=>{mission.status='PAUSED';mission.reason='Mission paused.';engine.pause();publish();});
  $('ptStop')?.addEventListener('click',()=>{mission.status='STOPPED';mission.reason='Mission stopped.';engine.stop();publish();});
  $('ptReset')?.addEventListener('click',()=>{try{engine.resetSession();mission=freshMission();signals=[];localStorage.removeItem(SIGNAL_KEY);publish();}catch(error){showError(error.message);}});
  $('libraClearResults')?.addEventListener('click',()=>{if(confirm('Clear Libra trade results? Her learned brain will be retained.')){signals=[];localStorage.removeItem(SIGNAL_KEY);publish();}});
  $('libraResetBrain')?.addEventListener('click',()=>{if(confirm('Erase Libra learned memory and start her brain from zero?')){brain.importState({weights:Array(14).fill(0),bias:0,updates:0,mistakes:0,correct:0,skippedFlats:0,generation:1,stateMemory:{},recent:[],lastLesson:'Memory reset. I am learning from zero.',lastLearnMs:0,lastUpdateAt:0});persistBrain();pendingForecast=null;publish();}});
}

window.addEventListener('sani-observatory-analysis', event => {
  const tick=event.detail;
  if(Number(tick?.archiveCount||0)>localTicks.length+10 && typeof window.SaniObservatory?.getTicks==='function') {
    const feed=window.SaniObservatory.getTicks().filter(row=>Number.isFinite(+row.epoch)&&Number.isFinite(+row.quote)).sort((a,b)=>a.epoch-b.epoch).slice(-10000);
    if(feed.length){localTicks=feed;lastTickKey=`${feed.at(-1).epoch}:${feed.at(-1).quote}`;trendSnapshot=trendBudget.hydrate(localTicks)||trendSnapshot;worker?.postMessage({type:'INIT',ticks:localTicks,executionOffset:1,memoryRows:[]});const f=brain.predict(localTicks);pendingForecast=f.ready?{epoch:f.epoch,quote:f.quote,features:[...(f.features||[])],signature:f.signature,probabilityUp:f.probabilityUp,regime:f.regime,confidence:f.confidence}:null;publish();return;}
  }
  if(tick?.epoch!==undefined&&tick?.quote!==undefined) postTick(tick);
});

function boot() {
  if($('ptAppId')) $('ptAppId').value=localStorage.getItem('sani.deriv.appId')||'';
  if($('ptToken')) $('ptToken').value=sessionStorage.getItem('sani.deriv.token')||'';
  bindControls();
  initWorker();
  const forecast=brain.predict(localTicks);
  pendingForecast=forecast.ready?{epoch:forecast.epoch,quote:forecast.quote,features:[...(forecast.features||[])],signature:forecast.signature,probabilityUp:forecast.probabilityUp,regime:forecast.regime,confidence:forecast.confidence}:null;
  publish();
  if($('ptAppId')?.value&&$('ptToken')?.value) $('ptLoadAccounts')?.click();
}

window.LIBRA = {
  version:LIBRA_VERSION,
  getSnapshot:()=>makeSnapshot(),
  getBrain:()=>brain.exportState(),
  getSignals:()=>signals.map(row=>structuredClone(row)),
  predict:()=>brain.predict(localTicks)
};

setInterval(()=>publish(),500);
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
