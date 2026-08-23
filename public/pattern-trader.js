import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.3';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const MAX_LEDGER = 5000;
const FIXED_HORIZON = 3;
const LONG_WINDOW = 200;
const MEDIUM_WINDOW = 80;
const WAVE_WINDOW = 80;
const SESSION_CONFIRM_TICKS = 2;
const INVALIDATION_TICKS = 3;
const MIN_WAVE_STEPS = 3.5;
const MAX_TOUCH_AGE = 8;
const MIN_QUALITY = 60;

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
  candidate: 'NEUTRAL',
  candidateCount: 0,
  invalidationCount: 0,
  sessionId: 0
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
engine.onTick = function waveTraderTick(tick) {
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
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mean(v) { return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function avgStep(prices) {
  if (prices.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < prices.length; i++) s += Math.abs(prices[i] - prices[i - 1]);
  return s / (prices.length - 1);
}
function efficiency(prices) {
  if (prices.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < prices.length; i++) path += Math.abs(prices[i] - prices[i - 1]);
  return path ? Math.abs(prices.at(-1) - prices[0]) / path : 0;
}
function turnRate(prices) {
  const signs = [];
  for (let i = 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d) signs.push(Math.sign(d));
  }
  if (signs.length < 2) return 0;
  let turns = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) turns++;
  return turns / (signs.length - 1);
}
function linearSlope(prices) {
  const n = prices.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(prices);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xm;
    num += dx * (prices[i] - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}
function pivots(prices, radius = 2) {
  const highs = [], lows = [];
  for (let i = radius; i < prices.length - radius; i++) {
    const left = prices.slice(i - radius, i), right = prices.slice(i + 1, i + radius + 1);
    const high = left.every(v => prices[i] >= v) && right.every(v => prices[i] >= v) && [...left, ...right].some(v => prices[i] > v);
    const low = left.every(v => prices[i] <= v) && right.every(v => prices[i] <= v) && [...left, ...right].some(v => prices[i] < v);
    if (high) highs.push({ i, quote: prices[i] });
    if (low) lows.push({ i, quote: prices[i] });
  }
  return { highs, lows };
}
function structureClass(prices, radius = 3) {
  const p = pivots(prices, radius), h = p.highs.slice(-2), l = p.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}
function metrics(rows, radius = 3) {
  const prices = rows.map(t => t.quote), step = avgStep(prices), slope = linearSlope(prices);
  return {
    slopeNorm: step ? slope / step : 0,
    efficiency: efficiency(prices),
    turnRate: turnRate(prices),
    avgStep: step,
    net: prices.length ? prices.at(-1) - prices[0] : 0,
    structure: structureClass(prices, radius)
  };
}
function classify200(m) {
  const bull = [m.slopeNorm >= .055, m.efficiency >= .10, m.net > 0, m.structure === 'BULL'].filter(Boolean).length;
  const bear = [m.slopeNorm <= -.055, m.efficiency >= .10, m.net < 0, m.structure === 'BEAR'].filter(Boolean).length;
  if (bull >= 3 && m.slopeNorm > 0) return 'BULL';
  if (bear >= 3 && m.slopeNorm < 0) return 'BEAR';
  return 'NEUTRAL';
}
function classify80(m) {
  if (Math.abs(m.slopeNorm) < .085 || m.efficiency < .075) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0 && (m.structure === 'BULL' || m.slopeNorm >= .145)) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0 && (m.structure === 'BEAR' || m.slopeNorm <= -.145)) return 'BEAR';
  return 'NEUTRAL';
}
function chopDiagnostics(m80, m20) {
  const lowEff = clamp((.17 - m80.efficiency) / .17, 0, 1);
  const turns = clamp((m80.turnRate - .47) / .25, 0, 1);
  const weakSlope = clamp((.07 - Math.abs(m80.slopeNorm)) / .07, 0, 1);
  const microWhip = clamp((m20.turnRate - .62) / .22, 0, 1);
  const score = (lowEff + turns + weakSlope + microWhip) / 4;
  return { score, isChop: score >= .66 };
}
function volatilityState(m200, m80, m20) {
  const shortMedium = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const mediumLong = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (shortMedium < .42 || mediumLong < .52) return 'DEAD';
  if (shortMedium > 2.05 || m20.turnRate > .84) return 'CHAOTIC';
  return 'HEALTHY';
}

function updateSession(active80, chop, volatility) {
  const tradable = !chop && volatility === 'HEALTHY' ? active80 : 'NEUTRAL';
  if (strategyState.session === 'NEUTRAL') {
    if (tradable === 'NEUTRAL') {
      strategyState.candidate = 'NEUTRAL';
      strategyState.candidateCount = 0;
      return;
    }
    if (strategyState.candidate === tradable) strategyState.candidateCount++;
    else { strategyState.candidate = tradable; strategyState.candidateCount = 1; }
    if (strategyState.candidateCount >= SESSION_CONFIRM_TICKS) {
      strategyState.session = tradable;
      strategyState.sessionId++;
      strategyState.invalidationCount = 0;
    }
    return;
  }
  if (tradable === strategyState.session) {
    strategyState.invalidationCount = 0;
    return;
  }
  strategyState.invalidationCount += tradable === 'NEUTRAL' ? 1 : 2;
  if (strategyState.invalidationCount >= INVALIDATION_TICKS) {
    strategyState.session = 'NEUTRAL';
    strategyState.candidate = 'NEUTRAL';
    strategyState.candidateCount = 0;
    strategyState.invalidationCount = 0;
  }
}

function findBullWave(rows) {
  const prices = rows.map(t => t.quote), step = avgStep(prices) || 1, p = pivots(prices, 2);
  for (let hi = p.highs.length - 1; hi >= 0; hi--) {
    const end = p.highs[hi];
    const start = p.lows.filter(x => x.i < end.i).at(-1);
    if (!start) continue;
    const range = end.quote - start.quote;
    if (range < step * MIN_WAVE_STEPS || end.i - start.i < 4) continue;
    const after = prices.slice(end.i + 1);
    if (!after.length) continue;
    const deepest = Math.min(...after);
    const maxRetrace = clamp((end.quote - deepest) / range, 0, 2);
    const currentRetrace = clamp((end.quote - prices.at(-1)) / range, -1, 2);
    const retraces = after.map(v => (end.quote - v) / range);
    const strongTrend = false;
    return { direction:'BULL', start, end, range, step, maxRetrace, currentRetrace, retraces, afterStartIndex:end.i+1 };
  }
  return null;
}
function findBearWave(rows) {
  const prices = rows.map(t => t.quote), step = avgStep(prices) || 1, p = pivots(prices, 2);
  for (let lo = p.lows.length - 1; lo >= 0; lo--) {
    const end = p.lows[lo];
    const start = p.highs.filter(x => x.i < end.i).at(-1);
    if (!start) continue;
    const range = start.quote - end.quote;
    if (range < step * MIN_WAVE_STEPS || end.i - start.i < 4) continue;
    const after = prices.slice(end.i + 1);
    if (!after.length) continue;
    const highest = Math.max(...after);
    const maxRetrace = clamp((highest - end.quote) / range, 0, 2);
    const currentRetrace = clamp((prices.at(-1) - end.quote) / range, -1, 2);
    const retraces = after.map(v => (v - end.quote) / range);
    return { direction:'BEAR', start, end, range, step, maxRetrace, currentRetrace, retraces, afterStartIndex:end.i+1 };
  }
  return null;
}
function fibPrice(wave, ratio) {
  if (!wave) return undefined;
  return wave.direction === 'BULL'
    ? wave.end.quote - wave.range * ratio
    : wave.end.quote + wave.range * ratio;
}
function waveKey(wave, rows) {
  if (!wave) return '';
  return `${wave.direction}:${rows[wave.start.i]?.epoch}:${rows[wave.end.i]?.epoch}`;
}
function waveAlreadyTraded(key) {
  return signalLedger.some(r => r.waveKey === key && Number.isFinite(Number(r.contractId)));
}
function zoneTouch(wave, strongTrend) {
  if (!wave?.retraces?.length) return { touched:false, zone:'NONE', age:Infinity, touchRatio:0 };
  let touchIndex = -1, zone = 'NONE', ratio = 0;
  for (let i = 0; i < wave.retraces.length; i++) {
    const r = wave.retraces[i];
    if (r >= .382 && r <= .618) { touchIndex = i; zone = 'GOLDEN'; ratio = r; }
    else if (strongTrend && r >= .236 && r < .382 && touchIndex < 0) { touchIndex = i; zone = 'SHALLOW'; ratio = r; }
  }
  return { touched: touchIndex >= 0, zone, age: touchIndex >= 0 ? wave.retraces.length - 1 - touchIndex : Infinity, touchRatio: ratio };
}
function microResumption(rows, direction, step) {
  const p = rows.map(t => t.quote), n = p.length;
  if (n < 5) return { ok:false, impulse:0 };
  const current = p[n-1], prev = p[n-2], prev2 = p[n-3];
  const impulse = Math.abs(current - prev) / (step || 1);
  if (direction === 'BULL') {
    const ok = current > prev && current > prev2 && current - prev >= step * .18;
    return { ok, impulse };
  }
  const ok = current < prev && current < prev2 && prev - current >= step * .18;
  return { ok, impulse };
}
function classifyWavePhase(wave, touch, resumption) {
  if (!wave) return 'SEARCHING';
  if (wave.maxRetrace > .786) return 'DAMAGED';
  if (!touch.touched) return wave.maxRetrace < .236 ? 'IMPULSE' : 'RETRACE';
  if (touch.age > MAX_TOUCH_AGE || wave.currentRetrace < .08) return 'MISSED';
  if (resumption.ok) return 'SNIPER';
  return 'POCKET';
}
function entryQuality({ wave, touch, resumption, m80, m200, regime200, session, chopScore }) {
  let score = 0;
  if (touch.zone === 'GOLDEN') score += 28;
  else if (touch.zone === 'SHALLOW') score += 18;
  if (m80.efficiency >= .18) score += 18;
  else if (m80.efficiency >= .12) score += 13;
  else score += 7;
  const slope = Math.abs(m80.slopeNorm);
  if (slope >= .22) score += 16;
  else if (slope >= .14) score += 12;
  else score += 6;
  if (resumption.impulse >= .60) score += 18;
  else if (resumption.impulse >= .30) score += 12;
  else score += 6;
  if (chopScore <= .20) score += 12;
  else if (chopScore <= .35) score += 8;
  else score += 3;
  if (regime200 === session) score += 6;
  if (wave.currentRetrace >= .15 && wave.currentRetrace <= .62) score += 8;
  if (wave.currentRetrace < .10) score -= 20;
  if (wave.maxRetrace > .70) score -= 25;
  if (touch.age > 5) score -= 10;
  return clamp(Math.round(score), 0, 100);
}

function evaluate(snapshot) {
  const all = rawTicks(snapshot?.symbol || currentSymbol());
  if (all.length < LONG_WINDOW) return { ready:false, reason:`Need ${LONG_WINDOW} ticks (${all.length}/${LONG_WINDOW})`, phase:'WARMING', rows:all };
  const rows200 = all.slice(-LONG_WINDOW), rows80 = all.slice(-MEDIUM_WINDOW), rows20 = all.slice(-20), waveRows = all.slice(-WAVE_WINDOW);
  const m200 = metrics(rows200, 4), m80 = metrics(rows80, 3), m20 = metrics(rows20, 2);
  const regime200 = classify200(m200), active80 = classify80(m80);
  const chopD = chopDiagnostics(m80, m20), volatility = volatilityState(m200, m80, m20);
  updateSession(active80, chopD.isChop, volatility);
  const session = strategyState.session;
  const wave = session === 'BULL' ? findBullWave(waveRows) : session === 'BEAR' ? findBearWave(waveRows) : null;
  const strongTrend = m80.efficiency >= .17 && Math.abs(m80.slopeNorm) >= .16;
  const touch = zoneTouch(wave, strongTrend);
  const resumption = microResumption(rows20, session, wave?.step || m20.avgStep || 1);
  const phase = classifyWavePhase(wave, touch, resumption);
  const key = waveKey(wave, waveRows);
  const quality = wave ? entryQuality({ wave, touch, resumption, m80, m200, regime200, session, chopScore:chopD.score }) : 0;
  const duplicate = key ? waveAlreadyTraded(key) : false;
  const ready = Boolean(
    session !== 'NEUTRAL' && active80 === session && !chopD.isChop && volatility === 'HEALTHY'
    && wave && touch.touched && touch.age <= MAX_TOUCH_AGE && wave.maxRetrace <= .786
    && wave.currentRetrace >= .08 && wave.currentRetrace <= .65
    && resumption.ok && quality >= MIN_QUALITY && !duplicate
  );
  let reason = 'Scanning for active wave';
  if (chopD.isChop) reason = `CHOP veto ${(chopD.score*100).toFixed(0)}%`;
  else if (volatility !== 'HEALTHY') reason = `Volatility ${volatility}`;
  else if (active80 === 'NEUTRAL') reason = '80-tick trend neutral';
  else if (session === 'NEUTRAL') reason = `${active80} candidate ${strategyState.candidateCount}/${SESSION_CONFIRM_TICKS}`;
  else if (!wave) reason = 'No completed impulse anchor yet';
  else if (wave.maxRetrace > .786) reason = `Wave damaged: retrace ${(wave.maxRetrace*100).toFixed(0)}% > 78.6%`;
  else if (!touch.touched) reason = `Waiting for Fib pocket · retrace ${(wave.maxRetrace*100).toFixed(0)}%`;
  else if (touch.age > MAX_TOUCH_AGE) reason = 'Fib pocket was touched, but the entry window is stale';
  else if (!resumption.ok) reason = `${touch.zone} pocket touched · waiting for micro resumption`;
  else if (quality < MIN_QUALITY) reason = `Sniper quality ${quality}/100 below ${MIN_QUALITY}`;
  else if (duplicate) reason = 'This wave has already been traded';
  else if (ready) reason = `${touch.zone} Fib pocket + micro resumption`;
  return {
    ready, reason, rows:all, waveRows, epoch:all.at(-1).epoch, quote:all.at(-1).quote,
    regime200, active80, session, phase, chop:chopD.isChop, chopScore:chopD.score,
    volatility, m200, m80, m20, wave, touch, resumption, waveKey:key, quality, strongTrend
  };
}

function entryOffsets() {
  return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50);
}
function entryOffsetEstimate() {
  const rows = entryOffsets().map(v => Math.max(1, Math.min(10, Math.round(v)))).sort((a,b)=>a-b);
  if (!rows.length) return 1;
  const m = Math.floor(rows.length/2);
  return rows.length%2 ? rows[m] : Math.round((rows[m-1]+rows[m])/2);
}
function recordEntryOffset(v) {
  v = Number(v); if (!Number.isFinite(v)) return;
  const rows = entryOffsets(); rows.push(Math.max(1, Math.min(10, Math.round(v))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(rows.slice(-50))); } catch {}
}
function actualEntryOffset(trade) {
  const signalEpoch=Number(trade?.signalEpoch), entryTick=Number(trade?.entryTickTime);
  if(Number.isFinite(signalEpoch)&&Number.isFinite(entryTick))return Math.max(1,Math.round(entryTick-signalEpoch));
  const start=Number(trade?.startTime);
  if(Number.isFinite(signalEpoch)&&Number.isFinite(start))return Math.max(1,Math.round(start-signalEpoch)+1);
}
function latencyClass(o) {
  o=Number(o); if(!Number.isFinite(o))return 'UNKNOWN'; if(o<=1)return 'CLEAN'; if(o===2)return 'LATE +1'; return 'LATE +2+';
}
function buildSignal(snapshot,d) {
  if(!d.ready)return null;
  const offset=Number(snapshot?.executionOffset??entryOffsetEstimate());
  return {
    symbol:snapshot?.symbol||currentSymbol(), epoch:Number(snapshot?.epoch??d.epoch), quote:Number(snapshot?.quote??d.quote),
    direction:d.session==='BULL'?'CALL':'PUT', session:d.session, phase:d.phase, waveKey:d.waveKey,
    fibZone:d.touch.zone, fibTouch:d.touch.touchRatio, fibMaxRetrace:d.wave.maxRetrace, fibEntryRetrace:d.wave.currentRetrace,
    quality:d.quality, regime200:d.regime200, active80:d.active80, slope200:d.m200.slopeNorm, slope80:d.m80.slopeNorm,
    efficiency80:d.m80.efficiency, chopScore:d.chopScore, volatility:d.volatility,
    waveStart:d.wave.start.quote, waveEnd:d.wave.end.quote,
    waveStartEpoch:d.waveRows[d.wave.start.i]?.epoch, waveEndEpoch:d.waveRows[d.wave.end.i]?.epoch,
    executionOffset:offset
  };
}
function signalKey(s){return `${s.symbol}:${s.epoch}:${s.waveKey}`;}
function ensureLedgerRow(s){
  const key=signalKey(s); let row=signalLedger.find(r=>r.signalKey===key); if(row)return row;
  row={id:`mt63-${s.epoch}-${Date.now()}`,cohort:'v6.3-wave-rider',signalKey:key,observedAt:Date.now(),...s,
    expectedOffset:s.executionOffset,expectedWindow:`T+${s.executionOffset}→T+${s.executionOffset+FIXED_HORIZON}`,status:'QUALIFIED'};
  signalLedger.unshift(row);saveLedger();return row;
}
function updateLedger(id,patch){const r=signalLedger.find(x=>x.id===id);if(!r)return;Object.assign(r,patch,{updatedAt:Date.now()});saveLedger();}
function boughtCount(){return signalLedger.filter(r=>Number.isFinite(Number(r.contractId))).length;}
function settledRows(){return signalLedger.filter(r=>r.status==='WON'||r.status==='LOST');}
function stats(){
  const rows=settledRows(),wins=rows.filter(r=>r.status==='WON').length,losses=rows.filter(r=>r.status==='LOST').length,pnl=rows.reduce((s,r)=>s+Number(r.profit||0),0);
  const bull=rows.filter(r=>r.session==='BULL'),bear=rows.filter(r=>r.session==='BEAR');
  return {wins,losses,pnl,bullW:bull.filter(r=>r.status==='WON').length,bullL:bull.filter(r=>r.status==='LOST').length,bearW:bear.filter(r=>r.status==='WON').length,bearL:bear.filter(r=>r.status==='LOST').length};
}

function showTraderError(message){$('traderError').textContent=message;$('traderError').classList.remove('hidden');}
function clearTraderError(){$('traderError').textContent='';$('traderError').classList.add('hidden');}
async function api(path,body){const r=await fetch(`/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`API ${r.status}`);return j;}
function readTraderConfig(){
  const next={...engine.config,symbol:currentSymbol(),stake:Number($('ptStake').value),takeProfit:Number($('ptTakeProfit').value),stopLoss:Number($('ptStopLoss').value),maxTrades:Number($('ptMaxTrades').value),duration:FIXED_HORIZON,durationUnit:'t',executionMethod:'direct',oneOpenContract:true,maxSignalToSendMs:500,currency:selectedAccount?.currency||'USD',reconnect:true,maxReconnectAttempts:8};
  if(!(next.stake>0))throw new Error('Stake must be greater than 0.');
  if(!engine.snapshot().running)engine.setConfig(next);return next;
}
function getAuthContext(){
  const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim(),accountId=$('ptAccount').value;
  selectedAccount=accounts.find(a=>a.account_id===accountId)||null;
  if(!appId||!token)throw new Error('App ID and trade token are required.');
  if(!selectedAccount)throw new Error('Load and select a Deriv Options account.');
  if(String(selectedAccount.account_type).toLowerCase()==='real')throw new Error('Master Trader v6.3 is Demo-only.');
  return {appId,token,accountId};
}
async function freshWsUrl(){const d=await api('otp',lastOtpContext||getAuthContext());if(!d.url)throw new Error('OTP response did not include a WebSocket URL.');return d.url;}
function renderAccounts(){
  const select=$('ptAccount');select.innerHTML=accounts.length?'':'<option value="">No accounts found</option>';
  for(const a of accounts){const o=document.createElement('option');o.value=a.account_id;o.textContent=`${String(a.account_type).toUpperCase()} · ${a.account_id} · ${a.currency} ${a.balance}`;select.appendChild(o);}
  const saved=localStorage.getItem('sani.deriv.accountId');if(saved&&accounts.some(a=>a.account_id===saved))select.value=saved;
  if(!select.value||String(accounts.find(a=>a.account_id===select.value)?.account_type).toLowerCase()==='real'){const demo=accounts.find(a=>String(a.account_type).toLowerCase()!=='real');if(demo)select.value=demo.account_id;}
  selectedAccount=accounts.find(a=>a.account_id===select.value)||null;renderAccountGate();
}
function renderAccountGate(){selectedAccount=accounts.find(a=>a.account_id===$('ptAccount').value)||null;const real=String(selectedAccount?.account_type||'').toLowerCase()==='real';$('ptRealGate').classList.toggle('hidden',!real);$('ptAccountPill').textContent=selectedAccount?String(selectedAccount.account_type).toUpperCase():'NO ACCOUNT';$('ptConnect').disabled=!selectedAccount||real;}

function maybeTrade(snapshot){
  lastAnalysis=snapshot;const d=evaluate(snapshot);lastDiagnostics=d;renderMasterState(d);drawMasterCanvas();renderLedger();const s=buildSignal(snapshot,d);if(!s)return;
  const row=ensureLedgerRow(s),state=engine.snapshot();if(s.epoch<=lastTradeSignalEpoch)return;
  if(Date.now()-Number(snapshot.at||0)>2500)return updateLedger(row.id,{status:'SKIP STALE'});
  if(state.safeBlocked)return updateLedger(row.id,{status:'SKIP SAFE PAUSE'});
  if(!state.running)return updateLedger(row.id,{status:state.connected?'OBSERVED':'SKIP DISCONNECTED'});
  if(boughtCount()>=Number($('ptMaxTrades').value||100)){updateLedger(row.id,{status:'SKIP COHORT COMPLETE'});engine.pause();return;}
  const cooldown=Number($('ptCooldown').value||5);if(s.epoch<cooldownUntilEpoch)return updateLedger(row.id,{status:'SKIP COOLDOWN'});
  if(state.pendingTrade||state.openContracts>0)return updateLedger(row.id,{status:'SKIP OPEN'});
  try{
    readTraderConfig();lastTradeSignalEpoch=s.epoch;cooldownUntilEpoch=s.epoch+cooldown;const now=perfNow();updateLedger(row.id,{status:'ORDER SENT'});
    engine.execute({direction:s.direction,structure:'master-v6.3-fib-wave-sniper',epoch:s.epoch,quote:s.quote,detectedPerf:now,detectedWallMs:Date.now(),patternMeta:{...s,ledgerId:row.id,expectedWindow:row.expectedWindow}});
    engine.log('success',`MASTER v6.3 SNIPER ${s.session} ${s.direction} · ${s.fibZone} Fib · entry ${(s.fibEntryRetrace*100).toFixed(1)}% · Q${s.quality} · 3t.`);
  }catch(e){updateLedger(row.id,{status:'ERROR',error:e.message});showTraderError(e.message);engine.pause();}
}

function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function renderMasterState(d){
  const set=(id,v)=>{if($(id))$(id).textContent=v;};
  set('mtRegime200',d?.regime200||'—');set('mtTrend80',d?.active80||'—');
  set('mtSession',d?.session&&d.session!=='NEUTRAL'?`${d.session} · ${d.phase}`:'NEUTRAL');
  set('mtEntry20',d?.ready?'SNIPER READY':d?.touch?.touched?`${d.touch.zone} · WAIT`:'WAIT');
  set('mtChop',d?`${d.chop?'VETO':'CLEAR'} · ${(Number(d.chopScore||0)*100).toFixed(0)}%`:'—');set('mtVolatility',d?.volatility||'—');
  if(!d||!d.ready){const fib=d?.wave?` · retrace ${(d.wave.currentRetrace*100).toFixed(1)}%`:'';$('ptSignal').innerHTML=`<b>WAIT · ${escapeHtml(d?.phase||'SEARCHING')}</b><span>${escapeHtml(d?.reason||'Scanning waves')}${fib}</span>`;}
  else $('ptSignal').innerHTML=`<b class="${d.session==='BULL'?'positive':'negative'}">SNIPER ${d.session} · ${d.session==='BULL'?'CALL':'PUT'} · Q${d.quality}</b><span>${d.touch.zone} Fib pocket · current retrace ${(d.wave.currentRetrace*100).toFixed(1)}% · micro resumption confirmed</span>`;
}
function renderLedger(){
  const s=stats();$('ptQualified').textContent=String(signalLedger.length);$('ptSkipped').textContent=String(signalLedger.filter(r=>String(r.status||'').startsWith('SKIP')).length);$('ptBought').textContent=String(boughtCount());$('ptEntryOffset').textContent=`T+${entryOffsetEstimate()}`;
  $('ptCohortN').textContent=String(s.wins+s.losses);$('ptCohortWL').textContent=`${s.wins} / ${s.losses}`;$('ptCohortPnl').textContent=`${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`;$('ptBullWL').textContent=`${s.bullW} / ${s.bullL}`;$('ptBearWL').textContent=`${s.bearW} / ${s.bearL}`;
  $('ptLedgerRows').innerHTML=signalLedger.length?signalLedger.slice(0,100).map(r=>{const time=new Date(r.observedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}),window=r.actualWindow?`${r.expectedWindow} → ${r.actualWindow}`:r.expectedWindow;return `<tr><td>${time}</td><td>${escapeHtml(`${r.session||'—'} · ${r.phase||'—'}`)}</td><td>${r.direction||'—'}</td><td>${escapeHtml(`${r.fibZone||'—'} · Q${r.quality??'—'} · ${(Number(r.fibEntryRetrace||0)*100).toFixed(0)}%`)}</td><td>${Number.isFinite(Number(r.slope200))?Number(r.slope200).toFixed(3):'—'}</td><td>${Number.isFinite(Number(r.slope80))?Number(r.slope80).toFixed(3):'—'}</td><td>${Number.isFinite(Number(r.chopScore))?(Number(r.chopScore)*100).toFixed(0)+'%':'—'}</td><td>${r.volatility||'—'}</td><td>${window||'—'}</td><td>${r.latencyClass||'—'}</td><td>${r.status||'—'}</td><td>${r.contractId?'#'+r.contractId:'—'}</td></tr>`;}).join(''):'<tr><td colspan="12" class="empty">No v6.3 wave sniper setups yet.</td></tr>';
}
function exportLedgerCsv(){
  const h=['cohort','observed_at','symbol','epoch','quote','session','phase','direction','wave_key','fib_zone','fib_touch','fib_max_retrace','fib_entry_retrace','quality','wave_start','wave_end','wave_start_epoch','wave_end_epoch','regime_200','active_80','slope_200','slope_80','efficiency_80','chop_score','volatility','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot'];
  const rows=signalLedger.map(r=>[r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.session,r.phase,r.direction,r.waveKey,r.fibZone,r.fibTouch,r.fibMaxRetrace,r.fibEntryRetrace,r.quality,r.waveStart,r.waveEnd,r.waveStartEpoch,r.waveEndEpoch,r.regime200,r.active80,r.slope200,r.slope80,r.efficiency80,r.chopScore,r.volatility,r.expectedWindow,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'']);
  const csv=[h,...rows].map(row=>row.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`master-v6.3-wave-sniper-${new Date().toISOString().replaceAll(':','-')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);
}

function canvasScale(ctx,canvas){const dpr=Math.max(1,window.devicePixelRatio||1),rect=canvas.getBoundingClientRect(),width=Math.max(300,rect.width||canvas.width),height=Math.max(180,rect.height||canvas.height);if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);return{width,height};}
function drawMasterCanvas(){
  const canvas=$('masterCanvas');if(!canvas)return;const rows=rawTicks().slice(-220),ctx=canvas.getContext('2d'),{width,height}=canvasScale(ctx,canvas);ctx.clearRect(0,0,width,height);const d=lastDiagnostics,session=d?.session||'NEUTRAL';ctx.fillStyle=session==='BULL'?'rgba(61,191,126,.055)':session==='BEAR'?'rgba(235,87,87,.055)':'rgba(146,153,168,.025)';ctx.fillRect(0,0,width,height);
  ctx.strokeStyle='rgba(146,153,168,.10)';ctx.lineWidth=1;for(let x=0;x<=width;x+=width/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}for(let y=0;y<=height;y+=height/5){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}if(rows.length<2)return;
  const prices=rows.map(t=>t.quote),min=Math.min(...prices),max=Math.max(...prices),span=max-min||1,xFor=e=>12+(e-rows[0].epoch)/Math.max(1,rows.at(-1).epoch-rows[0].epoch)*(width-24),yFor=p=>height-18-(p-min)/span*(height-36);
  ctx.strokeStyle='rgba(215,220,229,.72)';ctx.lineWidth=1.6;ctx.beginPath();rows.forEach((t,i)=>{const x=12+i/(rows.length-1)*(width-24),y=yFor(t.quote);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();
  ctx.font='12px system-ui,sans-serif';ctx.fillStyle='rgba(245,247,250,.82)';ctx.fillText(`200 ${d?.regime200||'—'}   80 ${d?.active80||'—'}   ${session}   WAVE ${d?.phase||'—'}${d?.quality?'   Q '+d.quality:''}`,16,22);
  if(d?.wave&&d?.waveRows){
    const startEpoch=d.waveRows[d.wave.start.i]?.epoch,endEpoch=d.waveRows[d.wave.end.i]?.epoch;
    if(Number.isFinite(startEpoch)&&Number.isFinite(endEpoch)){
      const sx=xFor(startEpoch),ex=xFor(endEpoch),sy=yFor(d.wave.start.quote),ey=yFor(d.wave.end.quote);ctx.strokeStyle='rgba(230,195,92,.75)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke();ctx.fillStyle='#e6c35c';ctx.beginPath();ctx.arc(sx,sy,4,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(ex,ey,4,0,Math.PI*2);ctx.fill();
      for(const [ratio,label] of [[.236,'23.6'],[.382,'38.2'],[.5,'50'],[.618,'61.8'],[.786,'78.6']]){const price=fibPrice(d.wave,ratio),y=yFor(price);ctx.strokeStyle=ratio===.382||ratio===.618?'rgba(230,195,92,.70)':'rgba(230,195,92,.28)';ctx.lineWidth=ratio===.382||ratio===.618?1.2:.8;ctx.beginPath();ctx.moveTo(ex,y);ctx.lineTo(width-12,y);ctx.stroke();ctx.fillStyle='rgba(230,195,92,.85)';ctx.font='10px system-ui,sans-serif';ctx.fillText(label+'%',width-44,y-3);}
    }
  }
  const recent20=rows.slice(-20),pp=pivots(recent20.map(t=>t.quote),2);const label=(arr,type)=>{let prev;for(const p of arr.slice(-3)){const text=prev===undefined?type:type==='H'?(p.quote>prev?'HH':'LH'):(p.quote>prev?'HL':'LL');prev=p.quote;const t=recent20[p.i];if(!t)continue;ctx.fillStyle='rgba(245,247,250,.88)';ctx.font='11px system-ui,sans-serif';ctx.fillText(text,xFor(t.epoch)+4,yFor(t.quote)+(type==='H'?-7:14));}};label(pp.highs,'H');label(pp.lows,'L');
  const visibleStart=rows[0].epoch,visibleEnd=rows.at(-1).epoch;for(const r of signalLedger.filter(r=>!Number.isFinite(Number(r.contractId))&&Number(r.epoch)>=visibleStart&&Number(r.epoch)<=visibleEnd)){const x=xFor(Number(r.epoch)),y=yFor(Number(r.quote));ctx.strokeStyle=r.direction==='CALL'?'rgba(103,217,154,.65)':'rgba(255,116,116,.65)';ctx.strokeRect(x-3.5,y-3.5,7,7);}
  for(const r of signalLedger.filter(r=>Number.isFinite(Number(r.contractId))&&Number(r.entryTickTime??r.epoch)>=visibleStart&&Number(r.entryTickTime??r.epoch)<=visibleEnd)){const ep=Number(r.entryTickTime??r.epoch),price=Number(r.entrySpot??r.quote);if(!Number.isFinite(price))continue;const x=xFor(ep),y=yFor(price),call=r.direction==='CALL';ctx.fillStyle=call?'#67d99a':'#ff7474';ctx.beginPath();if(call){ctx.moveTo(x,y-9);ctx.lineTo(x-6,y+5);ctx.lineTo(x+6,y+5);}else{ctx.moveTo(x,y+9);ctx.lineTo(x-6,y-5);ctx.lineTo(x+6,y-5);}ctx.closePath();ctx.fill();const ee=Number(r.exitTickTime),xp=Number(r.exitSpot);if(Number.isFinite(ee)&&Number.isFinite(xp)&&ee>=visibleStart&&ee<=visibleEnd){const ex=xFor(ee),ey=yFor(xp);ctx.strokeStyle=r.status==='WON'?'#67d99a':'#ff7474';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ex,ey);ctx.stroke();ctx.beginPath();ctx.arc(ex,ey,4,0,Math.PI*2);ctx.stroke();}}
  $('masterCanvasCaption').textContent=`${session} · ${d?.phase||'SEARCHING'} · Fib 23.6/38.2/50/61.8/78.6 · triangle=trade, square=qualified/blocked · ${rows.length} ticks`;
}

const baseOnBuy=engine.onBuy.bind(engine);
engine.onBuy=function(message){const pending=this.pending.get(Number(message.req_id)),meta=pending?.signal?.patternMeta?{...pending.signal.patternMeta}:undefined;baseOnBuy(message);const id=Number(message?.buy?.contract_id),trade=this.trades.find(t=>Number(t.contractId)===id);if(!trade||!meta)return;trade.patternMeta=meta;trade.ledgerId=meta.ledgerId;trade.expectedWindow=meta.expectedWindow;contractToLedger.set(id,meta.ledgerId);updateLedger(meta.ledgerId,{status:'BOUGHT',contractId:id,buyAckMs:trade.sendToAckMs});this.emit();};
const baseOnContract=engine.onContract.bind(engine);
engine.onContract=function(contract){const id=Number(contract?.contract_id);baseOnContract(contract);const trade=this.trades.find(t=>Number(t.contractId)===id);if(!trade?.patternMeta||!(contract?.is_sold||contract?.is_expired))return;const offset=actualEntryOffset(trade);if(!trade.offsetRecorded&&Number.isFinite(offset)){trade.offsetRecorded=true;recordEntryOffset(offset);}trade.actualWindow=Number.isFinite(offset)?`T+${offset}→T+${offset+FIXED_HORIZON}`:'unknown';trade.latencyClass=latencyClass(offset);const ledgerId=trade.ledgerId||contractToLedger.get(id);updateLedger(ledgerId,{status:String(trade.status||'sold').toUpperCase(),profit:trade.profit,actualEntryOffset:offset,actualWindow:trade.actualWindow,latencyClass:trade.latencyClass,entrySpot:trade.entrySpot,exitSpot:trade.exitSpot,entryTickTime:trade.entryTickTime,exitTickTime:trade.exitTickTime});drawMasterCanvas();this.emit();};

$('ptLoadAccounts').onclick=async()=>{clearTraderError();try{const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim();if(!appId||!token)throw new Error('App ID and trade token are required.');$('ptLoadAccounts').disabled=true;const d=await api('accounts',{appId,token});accounts=d.accounts||[];localStorage.setItem('sani.deriv.appId',appId);sessionStorage.setItem('sani.deriv.token',token);renderAccounts();}catch(e){showTraderError(e.message);}finally{$('ptLoadAccounts').disabled=false;}};
$('ptAccount').onchange=()=>{localStorage.setItem('sani.deriv.accountId',$('ptAccount').value);lastOtpContext=null;renderAccountGate();};
$('ptConnect').onclick=async()=>{clearTraderError();try{readTraderConfig();lastOtpContext=getAuthContext();$('ptConnect').disabled=true;await engine.connect(freshWsUrl);}catch(e){showTraderError(e.message);}finally{renderAccountGate();}};
$('ptDisconnect').onclick=()=>{engine.disconnect();lastOtpContext=null;};
$('ptStart').onclick=()=>{clearTraderError();try{getAuthContext();readTraderConfig();if(boughtCount()>=Number($('ptMaxTrades').value||100))throw new Error('v6.3 cohort cap reached.');engine.start();engine.log('info','Master v6.3 armed: 80 trend authority → impulse wave → Fibonacci retrace pocket → micro resumption → one sniper trade per wave.');}catch(e){showTraderError(e.message);}};
$('ptPause').onclick=()=>engine.pause();$('ptStop').onclick=()=>engine.stop();$('ptReset').onclick=()=>{try{engine.resetSession();lastTradeSignalEpoch=0;cooldownUntilEpoch=0;}catch(e){showTraderError(e.message);}};
$('ptClearLedger').onclick=()=>{if(!confirm('Clear the fresh v6.3 wave-rider cohort?'))return;signalLedger=[];localStorage.removeItem(LEDGER_KEY);strategyState.session='NEUTRAL';strategyState.candidate='NEUTRAL';strategyState.candidateCount=0;strategyState.invalidationCount=0;renderLedger();drawMasterCanvas();};
$('ptResetCalibration').onclick=()=>{if(!confirm('Reset execution calibration?'))return;localStorage.removeItem(OFFSET_KEY);renderLedger();};$('ptExportLedger').onclick=exportLedgerCsv;
for(const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown'])$(id).addEventListener('change',()=>{try{if(!engine.snapshot().running)readTraderConfig();}catch(e){showTraderError(e.message);}});
window.addEventListener('sani-observatory-analysis',e=>maybeTrade(e.detail));window.addEventListener('resize',drawMasterCanvas);

engine.subscribe(state=>{
  $('ptStatus').textContent=state.safeBlocked?'SAFE PAUSE':state.status==='reconnecting'?'RECONNECTING':state.connected?(state.running?'TRADING':'CONNECTED'):'DISCONNECTED';$('ptDot').classList.toggle('ok',state.connected&&!state.safeBlocked);$('ptDot').classList.toggle('danger',Boolean(state.safeBlocked));$('ptPnl').textContent=`${Number(state.sessionPnL||0)>=0?'+':''}$${Number(state.sessionPnL||0).toFixed(2)}`;$('ptPnl').className=Number(state.sessionPnL||0)>=0?'positive':'negative';$('ptWL').textContent=`${state.wins||0} / ${state.losses||0}`;$('ptOpen').textContent=Number(state.openContracts||0)+(state.pendingTrade?1:0);$('ptStart').disabled=!state.connected||state.running||state.safeBlocked||!state.portfolioChecked;$('ptPause').disabled=!state.running;$('ptStop').disabled=!state.connected;$('ptReset').disabled=state.running||Number(state.openContracts||0)>0;
  $('ptTradeRows').innerHTML=state.trades.length?state.trades.map(t=>{const m=t.patternMeta||{},expected=t.expectedWindow||m.expectedWindow||'—',actual=t.actualWindow||'—';return `<tr><td>#${t.contractId}</td><td>${escapeHtml(`${m.session||'—'} · ${m.phase||'WAVE'}`)}</td><td>${t.direction}</td><td>${escapeHtml(`${m.fibZone||'—'} · ${(Number(m.fibEntryRetrace||0)*100).toFixed(0)}% · Q${m.quality??'—'}`)}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${expected}</td><td>${actual}</td><td>${t.latencyClass||'—'}</td><td class="${(t.profit??0)>=0?'positive':'negative'}">${t.profit===undefined?'—':`${t.profit>=0?'+':''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs===undefined?'—':Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`;}).join(''):'<tr><td colspan="12" class="empty">No v6.3 wave sniper trades yet.</td></tr>';
  if(state.logs?.[0])$('ptLogs').innerHTML=state.logs.slice(0,70).map(l=>`<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(l.message==='Engine armed. Waiting for fresh BOS.'?'Master v6.3 wave execution engine armed.':l.message)}</span></div>`).join('');renderLedger();drawMasterCanvas();
});

window.addEventListener('DOMContentLoaded',()=>{
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.3'));
  const masterTitle=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Master Trader v6'));if(masterTitle)masterTitle.textContent='Master Trader v6.3 · Fibonacci Wave Rider';
  const ruleTitle=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Frozen v6'));if(ruleTitle)ruleTitle.textContent='Frozen v6.3 wave rules';
  const start=$('ptStart');if(start)start.textContent='Start Master Trader v6.3';if($('ptCooldown'))$('ptCooldown').value='5';
  const caption=document.querySelector('.observatoryCanvasCard p.muted:last-child');
  $('ptAppId').value=localStorage.getItem('sani.deriv.appId')||'';$('ptToken').value=sessionStorage.getItem('sani.deriv.token')||'';renderLedger();drawMasterCanvas();if($('ptAppId').value&&$('ptToken').value)$('ptLoadAccounts').click();const snap=window.SaniObservatory?.getSnapshot?.();if(snap){lastAnalysis=snap;lastDiagnostics=evaluate(snap);renderMasterState(lastDiagnostics);drawMasterCanvas();}
});
