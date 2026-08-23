import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.4';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const MAX_LEDGER = 5000;
const FIXED_HORIZON = 3;
const LONG_WINDOW = 200;
const AUTH_WINDOW = 80;
const FAST_WINDOW = 20;
const WAVE_WINDOW = 64;
const MIN_WAVE_STEPS = 3.2;
const MAX_RETRACE = 0.786;
const MIN_QUALITY = 58;
const SESSION_CONFIRM = 2;
const SESSION_INVALIDATE = 3;
const GOLDEN_LOW = 0.382;
const GOLDEN_HIGH = 0.618;
const SHALLOW_LOW = 0.236;
const TOUCH_MAX_AGE = 7;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastAnalysis = null;
let lastDiagnostics = null;
let lastTradeSignalEpoch = 0;
let cooldownUntilEpoch = 0;
let signalLedger = loadArray(LEDGER_KEY);
const contractToLedger = new Map();

const state = {
  session: 'NEUTRAL',
  candidate: 'NEUTRAL',
  candidateCount: 0,
  invalidationCount: 0,
  sessionId: 0,
  contractSupport: null
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
  maxSignalToSendMs: 350,
  reconnect: true,
  maxReconnectAttempts: 8
};

const engine = new SaniEngine(config);
engine.onTick = function masterWaveTick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  this.emit();
};

function loadArray(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}
function saveLedger() {
  signalLedger = signalLedger.slice(0, MAX_LEDGER);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(signalLedger)); } catch {}
}
function currentSymbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function rawTicks(symbol = currentSymbol()) {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol}`) || '[]');
    return Array.isArray(rows)
      ? rows.map(t => ({ epoch:Number(t.epoch), quote:Number(t.quote) }))
        .filter(t => Number.isFinite(t.epoch) && Number.isFinite(t.quote))
        .sort((a,b) => a.epoch-b.epoch)
      : [];
  } catch { return []; }
}
function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}
function mean(v){return v.length?v.reduce((s,x)=>s+x,0)/v.length:0;}
function avgStep(prices){if(prices.length<2)return 0;let s=0;for(let i=1;i<prices.length;i++)s+=Math.abs(prices[i]-prices[i-1]);return s/(prices.length-1);}
function efficiency(prices){if(prices.length<2)return 0;let p=0;for(let i=1;i<prices.length;i++)p+=Math.abs(prices[i]-prices[i-1]);return p?Math.abs(prices.at(-1)-prices[0])/p:0;}
function turnRate(prices){const signs=[];for(let i=1;i<prices.length;i++){const d=prices[i]-prices[i-1];if(d)signs.push(Math.sign(d));}if(signs.length<2)return 0;let t=0;for(let i=1;i<signs.length;i++)if(signs[i]!==signs[i-1])t++;return t/(signs.length-1);}
function slope(prices){const n=prices.length;if(n<2)return 0;const xm=(n-1)/2,ym=mean(prices);let num=0,den=0;for(let i=0;i<n;i++){const dx=i-xm;num+=dx*(prices[i]-ym);den+=dx*dx;}return den?num/den:0;}
function pivots(prices,radius=2){const highs=[],lows=[];for(let i=radius;i<prices.length-radius;i++){const l=prices.slice(i-radius,i),r=prices.slice(i+1,i+radius+1);const hi=l.every(v=>prices[i]>=v)&&r.every(v=>prices[i]>=v)&&[...l,...r].some(v=>prices[i]>v);const lo=l.every(v=>prices[i]<=v)&&r.every(v=>prices[i]<=v)&&[...l,...r].some(v=>prices[i]<v);if(hi)highs.push({i,quote:prices[i]});if(lo)lows.push({i,quote:prices[i]});}return{highs,lows};}
function structure(prices,radius=3){const p=pivots(prices,radius),h=p.highs.slice(-2),l=p.lows.slice(-2);if(h.length<2||l.length<2)return'MIXED';if(h[1].quote>h[0].quote&&l[1].quote>l[0].quote)return'BULL';if(h[1].quote<h[0].quote&&l[1].quote<l[0].quote)return'BEAR';return'MIXED';}
function metrics(rows,radius=3){const prices=rows.map(t=>t.quote),step=avgStep(prices),s=slope(prices);return{slopeNorm:step?s/step:0,efficiency:efficiency(prices),turnRate:turnRate(prices),avgStep:step,net:prices.at(-1)-prices[0],structure:structure(prices,radius)};}
function classify200(m){const bull=[m.slopeNorm>=.055,m.efficiency>=.10,m.net>0,m.structure==='BULL'].filter(Boolean).length,bear=[m.slopeNorm<=-.055,m.efficiency>=.10,m.net<0,m.structure==='BEAR'].filter(Boolean).length;if(bull>=3&&m.slopeNorm>0)return'BULL';if(bear>=3&&m.slopeNorm<0)return'BEAR';return'NEUTRAL';}
function classify80(m){if(Math.abs(m.slopeNorm)<.078||m.efficiency<.065)return'NEUTRAL';if(m.slopeNorm>0&&m.net>0&&(m.structure==='BULL'||m.slopeNorm>=.13))return'BULL';if(m.slopeNorm<0&&m.net<0&&(m.structure==='BEAR'||m.slopeNorm<=-.13))return'BEAR';return'NEUTRAL';}
function fastBias(m){if(Math.abs(m.slopeNorm)<.07||m.efficiency<.08)return'NEUTRAL';return m.slopeNorm>0&&m.net>0?'BULL':m.slopeNorm<0&&m.net<0?'BEAR':'NEUTRAL';}
function chopDiag(m80,m20){const a=clamp((.16-m80.efficiency)/.16,0,1),b=clamp((m80.turnRate-.49)/.25,0,1),c=clamp((.065-Math.abs(m80.slopeNorm))/.065,0,1),d=clamp((m20.turnRate-.66)/.2,0,1);const score=(a+b+c+d)/4;return{score,isChop:score>=.68};}
function volatility(m200,m80,m20){const sm=m80.avgStep?m20.avgStep/m80.avgStep:1,ml=m200.avgStep?m80.avgStep/m200.avgStep:1;if(sm<.40||ml<.50)return'DEAD';if(sm>2.15||m20.turnRate>.87)return'CHAOTIC';return'HEALTHY';}

function updateSession(active80, fast, chop, vol) {
  const authority = !chop && vol === 'HEALTHY' ? active80 : 'NEUTRAL';
  if (state.session === 'NEUTRAL') {
    const candidate = authority !== 'NEUTRAL' ? authority : fast;
    if (candidate === 'NEUTRAL') { state.candidate='NEUTRAL'; state.candidateCount=0; return; }
    if (state.candidate === candidate) state.candidateCount += 1;
    else { state.candidate=candidate; state.candidateCount=1; }
    if (state.candidateCount >= SESSION_CONFIRM) {
      state.session=candidate; state.sessionId += 1; state.invalidationCount=0;
    }
    return;
  }
  if (authority === state.session || (authority === 'NEUTRAL' && fast === state.session)) {
    state.invalidationCount=0;
    return;
  }
  state.invalidationCount += authority !== 'NEUTRAL' && authority !== state.session ? 2 : 1;
  if (state.invalidationCount >= SESSION_INVALIDATE) {
    const replacement = authority !== 'NEUTRAL' ? authority : fast;
    state.session = replacement !== state.session ? replacement : 'NEUTRAL';
    state.sessionId += 1;
    state.candidate='NEUTRAL'; state.candidateCount=0; state.invalidationCount=0;
  }
}

function latestSignificantStart(rows,direction) {
  const prices=rows.map(t=>t.quote),step=avgStep(prices)||1,p=pivots(prices,2);
  if(direction==='BULL') {
    const lows=[...p.lows].reverse();
    for(const lo of lows){
      const future=prices.slice(lo.i+1);if(future.length<3)continue;
      const hi=Math.max(...future),hiRel=future.indexOf(hi),hiI=lo.i+1+hiRel;
      if(hi-lo.quote>=step*MIN_WAVE_STEPS&&hiI-lo.i>=3)return{start:lo,end:{i:hiI,quote:hi},step};
    }
  } else {
    const highs=[...p.highs].reverse();
    for(const hi of highs){
      const future=prices.slice(hi.i+1);if(future.length<3)continue;
      const lo=Math.min(...future),loRel=future.indexOf(lo),loI=hi.i+1+loRel;
      if(hi.quote-lo>=step*MIN_WAVE_STEPS&&loI-hi.i>=3)return{start:hi,end:{i:loI,quote:lo},step};
    }
  }
  return null;
}

function rollingWave(rows,direction) {
  const base=latestSignificantStart(rows,direction);if(!base)return null;
  const prices=rows.map(t=>t.quote),{start,end,step}=base;
  const range=direction==='BULL'?end.quote-start.quote:start.quote-end.quote;
  if(!(range>0))return null;
  const after=prices.slice(end.i+1);
  const current=prices.at(-1);
  const maxRetrace=after.length
    ? direction==='BULL'?(end.quote-Math.min(...after))/range:(Math.max(...after)-end.quote)/range
    : 0;
  const currentRetrace=direction==='BULL'?(end.quote-current)/range:(current-end.quote)/range;
  const retraces=after.map(v=>direction==='BULL'?(end.quote-v)/range:(v-end.quote)/range);
  return{direction,start,end,step,range,maxRetrace,currentRetrace,retraces};
}
function fibPrice(w,r){return w.direction==='BULL'?w.end.quote-w.range*r:w.end.quote+w.range*r;}
function waveKey(w,rows){return w?`${w.direction}:${rows[w.start.i]?.epoch}:${rows[w.end.i]?.epoch}`:'';}
function alreadyTraded(key){return signalLedger.some(r=>r.waveKey===key&&Number.isFinite(Number(r.contractId)));}
function fibTouch(w,strong) {
  if(!w?.retraces?.length)return{touched:false,zone:'NONE',age:Infinity,touchRatio:0};
  let idx=-1,zone='NONE',ratio=0;
  for(let i=0;i<w.retraces.length;i++){
    const r=w.retraces[i];
    if(r>=GOLDEN_LOW&&r<=GOLDEN_HIGH){idx=i;zone='GOLDEN';ratio=r;}
    else if(strong&&r>=SHALLOW_LOW&&r<GOLDEN_LOW&&idx<0){idx=i;zone='SHALLOW';ratio=r;}
  }
  return{touched:idx>=0,zone,age:idx>=0?w.retraces.length-1-idx:Infinity,touchRatio:ratio};
}
function microResume(rows,direction,step){const p=rows.map(t=>t.quote),n=p.length;if(n<5)return{ok:false,strength:0,break:false};const cur=p[n-1],p1=p[n-2],p2=p[n-3],p3=p[n-4];const strength=Math.abs(cur-p1)/(step||1);if(direction==='BULL'){const br=cur>Math.max(p1,p2,p3);return{ok:cur>p1&&cur>p2&&br&&cur-p1>=step*.15,strength,break:br};}const br=cur<Math.min(p1,p2,p3);return{ok:cur<p1&&cur<p2&&br&&p1-cur>=step*.15,strength,break:br};}
function phaseOf(w,touch,resume){if(!w)return'SEARCHING';if(w.maxRetrace>MAX_RETRACE)return'INVALIDATED';if(w.currentRetrace<0)return'EXTENDING';if(!touch.touched)return w.maxRetrace<SHALLOW_LOW?'IMPULSE':'RETRACE';if(touch.age>TOUCH_MAX_AGE)return'REANCHOR';if(resume.ok)return'SNIPER';return'POCKET';}
function quality(d){let q=0;if(d.touch.zone==='GOLDEN')q+=30;else if(d.touch.zone==='SHALLOW')q+=20;if(d.m80.efficiency>=.18)q+=17;else if(d.m80.efficiency>=.11)q+=11;else q+=6;const s=Math.abs(d.m80.slopeNorm);if(s>=.20)q+=15;else if(s>=.12)q+=10;else q+=5;if(d.resume.strength>=.60)q+=16;else if(d.resume.strength>=.3)q+=11;else q+=5;if(d.chopScore<=.2)q+=10;else if(d.chopScore<=.38)q+=6;if(d.regime200===d.session)q+=5;if(d.fast===d.session)q+=7;if(d.wave.currentRetrace>=.12&&d.wave.currentRetrace<=.62)q+=7;if(d.touch.age>5)q-=8;if(d.wave.maxRetrace>.70)q-=18;return clamp(Math.round(q),0,100);}

function evaluate(snapshot){
  const all=rawTicks(snapshot?.symbol||currentSymbol());
  if(all.length<LONG_WINDOW)return{ready:false,reason:`Need ${LONG_WINDOW} ticks (${all.length}/${LONG_WINDOW})`,phase:'WARMING',rows:all};
  const rows200=all.slice(-LONG_WINDOW),rows80=all.slice(-AUTH_WINDOW),rows20=all.slice(-FAST_WINDOW),waveRows=all.slice(-WAVE_WINDOW);
  const m200=metrics(rows200,4),m80=metrics(rows80,3),m20=metrics(rows20,2),regime200=classify200(m200),active80=classify80(m80),fast=fastBias(m20),chop=chopDiag(m80,m20),vol=volatility(m200,m80,m20);
  updateSession(active80,fast,chop.isChop,vol);
  const session=state.session;
  let wave=session==='BULL'||session==='BEAR'?rollingWave(waveRows,session):null;
  const strong=m80.efficiency>=.16&&Math.abs(m80.slopeNorm)>=.14;
  let touch=fibTouch(wave,strong),resume=microResume(rows20,session,wave?.step||m20.avgStep||1),phase=phaseOf(wave,touch,resume),key=waveKey(wave,waveRows);

  // A stale/invalid wave must not imprison the engine. Re-evaluate the most recent live wave
  // from a tighter window so a new impulse can become tradable immediately.
  if(wave&&(phase==='INVALIDATED'||phase==='REANCHOR')){
    const tight=all.slice(-42),next=rollingWave(tight,session);
    if(next){wave=next;touch=fibTouch(wave,strong);resume=microResume(rows20,session,wave.step||m20.avgStep||1);phase=phaseOf(wave,touch,resume);key=waveKey(wave,tight);waveRows=tight;}
  }

  const duplicate=alreadyTraded(key);
  const q=wave?quality({touch,m80,resume,chopScore:chop.score,regime200,session,fast,wave}):0;
  const trendPermission=session!=='NEUTRAL'&&(active80===session||(active80==='NEUTRAL'&&fast===session));
  const ready=Boolean(trendPermission&&!chop.isChop&&vol==='HEALTHY'&&wave&&wave.maxRetrace<=MAX_RETRACE&&touch.touched&&touch.age<=TOUCH_MAX_AGE&&wave.currentRetrace>=.06&&wave.currentRetrace<=.66&&resume.ok&&q>=MIN_QUALITY&&!duplicate);
  let reason='Scanning live waves';
  if(chop.isChop)reason=`CHOP veto ${(chop.score*100).toFixed(0)}%`;
  else if(vol!=='HEALTHY')reason=`Volatility ${vol}`;
  else if(session==='NEUTRAL')reason=`No active session · 80 ${active80} · fast ${fast}`;
  else if(active80==='NEUTRAL'&&fast!==session)reason=`80 neutral and 20-tick pressure no longer supports ${session}`;
  else if(!wave)reason='Building a fresh impulse anchor';
  else if(wave.maxRetrace>MAX_RETRACE)reason=`Old wave invalidated ${(wave.maxRetrace*100).toFixed(0)}% · rolling anchor forward`;
  else if(wave.currentRetrace<0)reason='Impulse still extending · waiting for first pullback';
  else if(!touch.touched)reason=`Retrace ${(wave.maxRetrace*100).toFixed(1)}% · waiting for ${strong?'23.6':'38.2'}–61.8 pocket`;
  else if(touch.age>TOUCH_MAX_AGE)reason='Pocket stale · re-anchoring to latest wave';
  else if(!resume.ok)reason=`${touch.zone} pocket touched · waiting only for 3-tick micro break`;
  else if(q<MIN_QUALITY)reason=`Micro break seen but quality ${q}/100 < ${MIN_QUALITY}`;
  else if(duplicate)reason='Wave already traded · waiting for next impulse/pullback cycle';
  else if(ready)reason=`${touch.zone} pocket + micro break · FIRE`;
  return{ready,reason,rows:all,waveRows,epoch:all.at(-1).epoch,quote:all.at(-1).quote,regime200,active80,fast,session,phase,chop:chop.isChop,chopScore:chop.score,volatility:vol,m200,m80,m20,wave,touch,resume,waveKey:key,quality:q,strong,trendPermission};
}

function entryOffsets(){return loadArray(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50);}
function entryOffsetEstimate(){const a=entryOffsets().map(v=>Math.max(1,Math.min(10,Math.round(v)))).sort((x,y)=>x-y);if(!a.length)return 1;const m=Math.floor(a.length/2);return a.length%2?a[m]:Math.round((a[m-1]+a[m])/2);}
function recordEntryOffset(v){v=Number(v);if(!Number.isFinite(v))return;const a=entryOffsets();a.push(Math.max(1,Math.min(10,Math.round(v))));try{localStorage.setItem(OFFSET_KEY,JSON.stringify(a.slice(-50)));}catch{}}
function actualEntryOffset(t){const s=Number(t?.signalEpoch),e=Number(t?.entryTickTime);if(Number.isFinite(s)&&Number.isFinite(e))return Math.max(1,Math.round(e-s));const st=Number(t?.startTime);if(Number.isFinite(s)&&Number.isFinite(st))return Math.max(1,Math.round(st-s)+1);}
function latencyClass(o){o=Number(o);if(!Number.isFinite(o))return'UNKNOWN';if(o<=1)return'CLEAN';if(o===2)return'LATE +1';return'LATE +2+';}
function buildSignal(snapshot,d){if(!d.ready)return null;const offset=Number(snapshot?.executionOffset??entryOffsetEstimate());return{symbol:snapshot?.symbol||currentSymbol(),epoch:Number(snapshot?.epoch??d.epoch),quote:Number(snapshot?.quote??d.quote),direction:d.session==='BULL'?'CALL':'PUT',session:d.session,phase:d.phase,waveKey:d.waveKey,fibZone:d.touch.zone,fibTouch:d.touch.touchRatio,fibMaxRetrace:d.wave.maxRetrace,fibEntryRetrace:d.wave.currentRetrace,quality:d.quality,regime200:d.regime200,active80:d.active80,fast:d.fast,slope200:d.m200.slopeNorm,slope80:d.m80.slopeNorm,efficiency80:d.m80.efficiency,chopScore:d.chopScore,volatility:d.volatility,waveStart:d.wave.start.quote,waveEnd:d.wave.end.quote,waveStartEpoch:d.waveRows[d.wave.start.i]?.epoch,waveEndEpoch:d.waveRows[d.wave.end.i]?.epoch,executionOffset:offset};}
function signalKey(s){return`${s.symbol}:${s.epoch}:${s.waveKey}`;}
function ensureLedgerRow(s){const k=signalKey(s);let r=signalLedger.find(x=>x.signalKey===k);if(r)return r;r={id:`mt64-${s.epoch}-${Date.now()}`,cohort:'v6.4-rolling-wave-sniper',signalKey:k,observedAt:Date.now(),...s,expectedOffset:s.executionOffset,expectedWindow:`T+${s.executionOffset}→T+${s.executionOffset+FIXED_HORIZON}`,status:'QUALIFIED'};signalLedger.unshift(r);saveLedger();return r;}
function updateLedger(id,patch){const r=signalLedger.find(x=>x.id===id);if(!r)return;Object.assign(r,patch,{updatedAt:Date.now()});saveLedger();}
function boughtCount(){return signalLedger.filter(r=>Number.isFinite(Number(r.contractId))).length;}
function settledRows(){return signalLedger.filter(r=>r.status==='WON'||r.status==='LOST');}
function stats(){const a=settledRows(),wins=a.filter(r=>r.status==='WON').length,losses=a.filter(r=>r.status==='LOST').length,pnl=a.reduce((s,r)=>s+Number(r.profit||0),0),bull=a.filter(r=>r.session==='BULL'),bear=a.filter(r=>r.session==='BEAR');return{wins,losses,pnl,bullW:bull.filter(r=>r.status==='WON').length,bullL:bull.filter(r=>r.status==='LOST').length,bearW:bear.filter(r=>r.status==='WON').length,bearL:bear.filter(r=>r.status==='LOST').length};}

function showTraderError(m){$('traderError').textContent=m;$('traderError').classList.remove('hidden');}
function clearTraderError(){$('traderError').textContent='';$('traderError').classList.add('hidden');}
async function api(path,body){const r=await fetch(`/api/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'}),j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||`API ${r.status}`);return j;}
function readTraderConfig(){const next={...engine.config,symbol:currentSymbol(),stake:Number($('ptStake').value),takeProfit:Number($('ptTakeProfit').value),stopLoss:Number($('ptStopLoss').value),maxTrades:Number($('ptMaxTrades').value),duration:FIXED_HORIZON,durationUnit:'t',executionMethod:'direct',oneOpenContract:true,maxSignalToSendMs:350,currency:selectedAccount?.currency||'USD',reconnect:true,maxReconnectAttempts:8};if(!(next.stake>0))throw new Error('Stake must be greater than 0.');if(!engine.snapshot().running)engine.setConfig(next);return next;}
function getAuthContext(){const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim(),accountId=$('ptAccount').value;selectedAccount=accounts.find(a=>a.account_id===accountId)||null;if(!appId||!token)throw new Error('App ID and trade token are required.');if(!selectedAccount)throw new Error('Load and select a Deriv Options account.');if(String(selectedAccount.account_type).toLowerCase()==='real')throw new Error('Master Trader v6.4 is Demo-only.');return{appId,token,accountId};}
async function freshWsUrl(){const d=await api('otp',lastOtpContext||getAuthContext());if(!d.url)throw new Error('OTP response did not include a WebSocket URL.');return d.url;}
function renderAccounts(){const s=$('ptAccount');s.innerHTML=accounts.length?'':'<option value="">No accounts found</option>';for(const a of accounts){const o=document.createElement('option');o.value=a.account_id;o.textContent=`${String(a.account_type).toUpperCase()} · ${a.account_id} · ${a.currency} ${a.balance}`;s.appendChild(o);}const saved=localStorage.getItem('sani.deriv.accountId');if(saved&&accounts.some(a=>a.account_id===saved))s.value=saved;if(!s.value||String(accounts.find(a=>a.account_id===s.value)?.account_type).toLowerCase()==='real'){const demo=accounts.find(a=>String(a.account_type).toLowerCase()!=='real');if(demo)s.value=demo.account_id;}selectedAccount=accounts.find(a=>a.account_id===s.value)||null;renderAccountGate();}
function renderAccountGate(){selectedAccount=accounts.find(a=>a.account_id===$('ptAccount').value)||null;const real=String(selectedAccount?.account_type||'').toLowerCase()==='real';$('ptRealGate').classList.toggle('hidden',!real);$('ptAccountPill').textContent=selectedAccount?String(selectedAccount.account_type).toUpperCase():'NO ACCOUNT';$('ptConnect').disabled=!selectedAccount||real;}

function maybeTrade(snapshot){lastAnalysis=snapshot;const d=evaluate(snapshot);lastDiagnostics=d;renderMasterState(d);drawMasterCanvas();renderLedger();const s=buildSignal(snapshot,d);if(!s)return;const row=ensureLedgerRow(s),e=engine.snapshot();if(s.epoch<=lastTradeSignalEpoch)return;if(Date.now()-Number(snapshot.at||0)>2500)return updateLedger(row.id,{status:'SKIP STALE'});if(e.safeBlocked)return updateLedger(row.id,{status:'SKIP SAFE PAUSE'});if(!e.running)return updateLedger(row.id,{status:e.connected?'OBSERVED':'SKIP DISCONNECTED'});if(boughtCount()>=Number($('ptMaxTrades').value||100)){updateLedger(row.id,{status:'SKIP COHORT COMPLETE'});engine.pause();return;}const cooldown=Number($('ptCooldown').value||3);if(s.epoch<cooldownUntilEpoch)return updateLedger(row.id,{status:'SKIP COOLDOWN'});if(e.pendingTrade||e.openContracts>0)return updateLedger(row.id,{status:'SKIP OPEN'});try{readTraderConfig();lastTradeSignalEpoch=s.epoch;cooldownUntilEpoch=s.epoch+cooldown;const now=perfNow();updateLedger(row.id,{status:'ORDER SENT'});engine.execute({direction:s.direction,structure:'master-v6.4-rolling-wave-sniper',epoch:s.epoch,quote:s.quote,detectedPerf:now,detectedWallMs:Date.now(),patternMeta:{...s,ledgerId:row.id,expectedWindow:row.expectedWindow}});engine.log('success',`MASTER v6.4 FIRE ${s.session} ${s.direction} · ${s.fibZone} · retrace ${(s.fibEntryRetrace*100).toFixed(1)}% · Q${s.quality}.`);}catch(err){updateLedger(row.id,{status:'ERROR',error:err.message});showTraderError(err.message);engine.pause();}}

function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function renderMasterState(d){const set=(id,v)=>{if($(id))$(id).textContent=v;};set('mtRegime200',d?.regime200||'—');set('mtTrend80',d?`${d.active80}${d.active80==='NEUTRAL'&&d.fast!=='NEUTRAL'?' · fast '+d.fast:''}`:'—');set('mtSession',d?.session&&d.session!=='NEUTRAL'?`${d.session} · ${d.phase}`:'NEUTRAL');set('mtEntry20',d?.ready?'FIRE':d?.touch?.touched?`${d.touch.zone} · WAIT`:'WAIT');set('mtChop',d?`${d.chop?'VETO':'CLEAR'} · ${(Number(d.chopScore||0)*100).toFixed(0)}%`:'—');set('mtVolatility',d?.volatility||'—');if(!d||!d.ready){const fib=d?.wave?` · live retrace ${(d.wave.currentRetrace*100).toFixed(1)}%`:'';$('ptSignal').innerHTML=`<b>WAIT · ${escapeHtml(d?.phase||'SEARCHING')}</b><span>${escapeHtml(d?.reason||'Scanning')}${fib}</span>`;}else{$('ptSignal').innerHTML=`<b class="${d.session==='BULL'?'positive':'negative'}">FIRE ${d.session} · ${d.session==='BULL'?'CALL':'PUT'} · Q${d.quality}</b><span>${d.touch.zone} pocket · ${(d.wave.currentRetrace*100).toFixed(1)}% retrace · 3-tick micro break confirmed</span>`;}}
function renderLedger(){const s=stats();$('ptQualified').textContent=String(signalLedger.length);$('ptSkipped').textContent=String(signalLedger.filter(r=>String(r.status||'').startsWith('SKIP')).length);$('ptBought').textContent=String(boughtCount());$('ptEntryOffset').textContent=`T+${entryOffsetEstimate()}`;$('ptCohortN').textContent=String(s.wins+s.losses);$('ptCohortWL').textContent=`${s.wins} / ${s.losses}`;$('ptCohortPnl').textContent=`${s.pnl>=0?'+':''}$${s.pnl.toFixed(2)}`;$('ptBullWL').textContent=`${s.bullW} / ${s.bullL}`;$('ptBearWL').textContent=`${s.bearW} / ${s.bearL}`;$('ptLedgerRows').innerHTML=signalLedger.length?signalLedger.slice(0,100).map(r=>{const time=new Date(r.observedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}),w=r.actualWindow?`${r.expectedWindow} → ${r.actualWindow}`:r.expectedWindow;return`<tr><td>${time}</td><td>${escapeHtml(`${r.session||'—'} · ${r.phase||'—'}`)}</td><td>${r.direction||'—'}</td><td>${escapeHtml(`${r.fibZone||'—'} · Q${r.quality??'—'} · ${(Number(r.fibEntryRetrace||0)*100).toFixed(0)}%`)}</td><td>${Number.isFinite(Number(r.slope200))?Number(r.slope200).toFixed(3):'—'}</td><td>${Number.isFinite(Number(r.slope80))?Number(r.slope80).toFixed(3):'—'}</td><td>${Number.isFinite(Number(r.chopScore))?(Number(r.chopScore)*100).toFixed(0)+'%':'—'}</td><td>${r.volatility||'—'}</td><td>${w||'—'}</td><td>${r.latencyClass||'—'}</td><td>${r.status||'—'}</td><td>${r.contractId?'#'+r.contractId:'—'}</td></tr>`;}).join(''):'<tr><td colspan="12" class="empty">No v6.4 setups yet.</td></tr>';}
function exportLedgerCsv(){const h=['cohort','observed_at','symbol','epoch','quote','session','phase','direction','wave_key','fib_zone','fib_touch','fib_max_retrace','fib_entry_retrace','quality','regime_200','active_80','fast','slope_200','slope_80','efficiency_80','chop_score','volatility','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot'],rows=signalLedger.map(r=>[r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.session,r.phase,r.direction,r.waveKey,r.fibZone,r.fibTouch,r.fibMaxRetrace,r.fibEntryRetrace,r.quality,r.regime200,r.active80,r.fast,r.slope200,r.slope80,r.efficiency80,r.chopScore,r.volatility,r.expectedWindow,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'']),csv=[h,...rows].map(row=>row.map(v=>`"${String(v??'').replaceAll('"','""')}"`).join(',')).join('\n'),blob=new Blob([csv],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`master-v6.4-rolling-wave-${new Date().toISOString().replaceAll(':','-')}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),500);}

function canvasScale(ctx,canvas){const dpr=Math.max(1,window.devicePixelRatio||1),rect=canvas.getBoundingClientRect(),width=Math.max(300,rect.width||canvas.width),height=Math.max(180,rect.height||canvas.height);if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);}ctx.setTransform(dpr,0,0,dpr,0,0);return{width,height};}
function drawMasterCanvas(){const canvas=$('masterCanvas');if(!canvas)return;const rows=rawTicks().slice(-220),ctx=canvas.getContext('2d'),{width,height}=canvasScale(ctx,canvas);ctx.clearRect(0,0,width,height);const d=lastDiagnostics,session=d?.session||'NEUTRAL';ctx.fillStyle=session==='BULL'?'rgba(61,191,126,.055)':session==='BEAR'?'rgba(235,87,87,.055)':'rgba(146,153,168,.025)';ctx.fillRect(0,0,width,height);ctx.strokeStyle='rgba(146,153,168,.10)';ctx.lineWidth=1;for(let x=0;x<=width;x+=width/8){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,height);ctx.stroke();}for(let y=0;y<=height;y+=height/5){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(width,y);ctx.stroke();}if(rows.length<2)return;const prices=rows.map(t=>t.quote),min=Math.min(...prices),max=Math.max(...prices),span=max-min||1,xFor=e=>12+(e-rows[0].epoch)/Math.max(1,rows.at(-1).epoch-rows[0].epoch)*(width-24),yFor=p=>height-18-(p-min)/span*(height-36);ctx.strokeStyle='rgba(215,220,229,.72)';ctx.lineWidth=1.5;ctx.beginPath();rows.forEach((t,i)=>{const x=12+i/(rows.length-1)*(width-24),y=yFor(t.quote);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.stroke();ctx.font='12px system-ui,sans-serif';ctx.fillStyle='rgba(245,247,250,.85)';ctx.fillText(`200 ${d?.regime200||'—'}   80 ${d?.active80||'—'}   FAST ${d?.fast||'—'}   ${session}   ${d?.phase||'—'}${d?.quality?'   Q'+d.quality:''}`,16,22);
if(d?.wave&&d?.waveRows){const se=d.waveRows[d.wave.start.i]?.epoch,ee=d.waveRows[d.wave.end.i]?.epoch;if(Number.isFinite(se)&&Number.isFinite(ee)){const sx=xFor(se),ex=xFor(ee),sy=yFor(d.wave.start.quote),ey=yFor(d.wave.end.quote);ctx.strokeStyle='rgba(230,195,92,.85)';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke();ctx.fillStyle='#e6c35c';for(const [x,y] of [[sx,sy],[ex,ey]]){ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();}const y382=yFor(fibPrice(d.wave,.382)),y618=yFor(fibPrice(d.wave,.618));ctx.fillStyle='rgba(230,195,92,.08)';ctx.fillRect(ex,Math.min(y382,y618),Math.max(0,width-12-ex),Math.abs(y618-y382));for(const [r,label]of[[.236,'23.6'],[.382,'38.2'],[.5,'50'],[.618,'61.8'],[.786,'78.6']]){const y=yFor(fibPrice(d.wave,r));ctx.strokeStyle=(r===.382||r===.618)?'rgba(230,195,92,.75)':'rgba(230,195,92,.3)';ctx.lineWidth=(r===.382||r===.618)?1.2:.8;ctx.beginPath();ctx.moveTo(ex,y);ctx.lineTo(width-12,y);ctx.stroke();ctx.fillStyle='rgba(230,195,92,.9)';ctx.font='10px system-ui,sans-serif';ctx.fillText(label+'%',width-45,y-3);}const cy=yFor(d.quote);ctx.fillStyle=d.ready?'#67d99a':'rgba(245,247,250,.9)';ctx.beginPath();ctx.arc(width-16,cy,4,0,Math.PI*2);ctx.fill();}}
const recent=rows.slice(-20),pp=pivots(recent.map(t=>t.quote),2),label=(arr,type)=>{let prev;for(const p of arr.slice(-3)){const text=prev===undefined?type:type==='H'?(p.quote>prev?'HH':'LH'):(p.quote>prev?'HL':'LL');prev=p.quote;const t=recent[p.i];if(!t)continue;ctx.fillStyle='rgba(245,247,250,.88)';ctx.font='11px system-ui,sans-serif';ctx.fillText(text,xFor(t.epoch)+4,yFor(t.quote)+(type==='H'?-7:14));}};label(pp.highs,'H');label(pp.lows,'L');const vs=rows[0].epoch,ve=rows.at(-1).epoch;for(const r of signalLedger.filter(r=>!Number.isFinite(Number(r.contractId))&&Number(r.epoch)>=vs&&Number(r.epoch)<=ve)){const x=xFor(Number(r.epoch)),y=yFor(Number(r.quote));ctx.strokeStyle=r.direction==='CALL'?'rgba(103,217,154,.65)':'rgba(255,116,116,.65)';ctx.strokeRect(x-3.5,y-3.5,7,7);}for(const r of signalLedger.filter(r=>Number.isFinite(Number(r.contractId))&&Number(r.entryTickTime??r.epoch)>=vs&&Number(r.entryTickTime??r.epoch)<=ve)){const ep=Number(r.entryTickTime??r.epoch),price=Number(r.entrySpot??r.quote);if(!Number.isFinite(price))continue;const x=xFor(ep),y=yFor(price),call=r.direction==='CALL';ctx.fillStyle=call?'#67d99a':'#ff7474';ctx.beginPath();if(call){ctx.moveTo(x,y-9);ctx.lineTo(x-6,y+5);ctx.lineTo(x+6,y+5);}else{ctx.moveTo(x,y+9);ctx.lineTo(x-6,y-5);ctx.lineTo(x+6,y-5);}ctx.closePath();ctx.fill();const ee=Number(r.exitTickTime),xp=Number(r.exitSpot);if(Number.isFinite(ee)&&Number.isFinite(xp)&&ee>=vs&&ee<=ve){const ex=xFor(ee),ey=yFor(xp);ctx.strokeStyle=r.status==='WON'?'#67d99a':'#ff7474';ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ex,ey);ctx.stroke();ctx.beginPath();ctx.arc(ex,ey,4,0,Math.PI*2);ctx.stroke();}}$('masterCanvasCaption').textContent=`${session} · ${d?.phase||'SEARCHING'} · gold band=38.2–61.8 pocket · FAST=${d?.fast||'—'} · triangle=trade · ${rows.length} ticks`;}

const baseOnBuy=engine.onBuy.bind(engine);engine.onBuy=function(message){const p=this.pending.get(Number(message.req_id)),meta=p?.signal?.patternMeta?{...p.signal.patternMeta}:undefined;baseOnBuy(message);const id=Number(message?.buy?.contract_id),trade=this.trades.find(t=>Number(t.contractId)===id);if(!trade||!meta)return;trade.patternMeta=meta;trade.ledgerId=meta.ledgerId;trade.expectedWindow=meta.expectedWindow;contractToLedger.set(id,meta.ledgerId);updateLedger(meta.ledgerId,{status:'BOUGHT',contractId:id,buyAckMs:trade.sendToAckMs});this.emit();};const baseOnContract=engine.onContract.bind(engine);engine.onContract=function(contract){const id=Number(contract?.contract_id);baseOnContract(contract);const trade=this.trades.find(t=>Number(t.contractId)===id);if(!trade?.patternMeta||!(contract?.is_sold||contract?.is_expired))return;const off=actualEntryOffset(trade);if(!trade.offsetRecorded&&Number.isFinite(off)){trade.offsetRecorded=true;recordEntryOffset(off);}trade.actualWindow=Number.isFinite(off)?`T+${off}→T+${off+FIXED_HORIZON}`:'unknown';trade.latencyClass=latencyClass(off);const lid=trade.ledgerId||contractToLedger.get(id);updateLedger(lid,{status:String(trade.status||'sold').toUpperCase(),profit:trade.profit,actualEntryOffset:off,actualWindow:trade.actualWindow,latencyClass:trade.latencyClass,entrySpot:trade.entrySpot,exitSpot:trade.exitSpot,entryTickTime:trade.entryTickTime,exitTickTime:trade.exitTickTime});drawMasterCanvas();this.emit();};

$('ptLoadAccounts').onclick=async()=>{clearTraderError();try{const appId=$('ptAppId').value.trim(),token=$('ptToken').value.trim();if(!appId||!token)throw new Error('App ID and trade token are required.');$('ptLoadAccounts').disabled=true;const d=await api('accounts',{appId,token});accounts=d.accounts||[];localStorage.setItem('sani.deriv.appId',appId);sessionStorage.setItem('sani.deriv.token',token);renderAccounts();}catch(e){showTraderError(e.message);}finally{$('ptLoadAccounts').disabled=false;}};$('ptAccount').onchange=()=>{localStorage.setItem('sani.deriv.accountId',$('ptAccount').value);lastOtpContext=null;renderAccountGate();};$('ptConnect').onclick=async()=>{clearTraderError();try{readTraderConfig();lastOtpContext=getAuthContext();$('ptConnect').disabled=true;await engine.connect(freshWsUrl);}catch(e){showTraderError(e.message);}finally{renderAccountGate();}};$('ptDisconnect').onclick=()=>{engine.disconnect();lastOtpContext=null;};$('ptStart').onclick=()=>{clearTraderError();try{getAuthContext();readTraderConfig();if(boughtCount()>=Number($('ptMaxTrades').value||100))throw new Error('v6.4 cohort cap reached.');engine.start();engine.log('info','Master v6.4 armed: rolling live impulse → Fib pocket → 3-tick micro break. 80 neutral may retain a session only when fast pressure agrees.');}catch(e){showTraderError(e.message);}};$('ptPause').onclick=()=>engine.pause();$('ptStop').onclick=()=>engine.stop();$('ptReset').onclick=()=>{try{engine.resetSession();lastTradeSignalEpoch=0;cooldownUntilEpoch=0;}catch(e){showTraderError(e.message);}};$('ptClearLedger').onclick=()=>{if(!confirm('Clear fresh v6.4 cohort?'))return;signalLedger=[];localStorage.removeItem(LEDGER_KEY);state.session='NEUTRAL';state.candidate='NEUTRAL';state.candidateCount=0;state.invalidationCount=0;renderLedger();drawMasterCanvas();};$('ptResetCalibration').onclick=()=>{if(!confirm('Reset execution calibration?'))return;localStorage.removeItem(OFFSET_KEY);renderLedger();};$('ptExportLedger').onclick=exportLedgerCsv;for(const id of['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown'])$(id).addEventListener('change',()=>{try{if(!engine.snapshot().running)readTraderConfig();}catch(e){showTraderError(e.message);}});window.addEventListener('sani-observatory-analysis',e=>maybeTrade(e.detail));window.addEventListener('resize',drawMasterCanvas);

engine.subscribe(s=>{$('ptStatus').textContent=s.safeBlocked?'SAFE PAUSE':s.status==='reconnecting'?'RECONNECTING':s.connected?(s.running?'TRADING':'CONNECTED'):'DISCONNECTED';$('ptDot').classList.toggle('ok',s.connected&&!s.safeBlocked);$('ptDot').classList.toggle('danger',Boolean(s.safeBlocked));$('ptPnl').textContent=`${Number(s.sessionPnL||0)>=0?'+':''}$${Number(s.sessionPnL||0).toFixed(2)}`;$('ptPnl').className=Number(s.sessionPnL||0)>=0?'positive':'negative';$('ptWL').textContent=`${s.wins||0} / ${s.losses||0}`;$('ptOpen').textContent=Number(s.openContracts||0)+(s.pendingTrade?1:0);$('ptStart').disabled=!s.connected||s.running||s.safeBlocked||!s.portfolioChecked;$('ptPause').disabled=!s.running;$('ptStop').disabled=!s.connected;$('ptReset').disabled=s.running||Number(s.openContracts||0)>0;$('ptTradeRows').innerHTML=s.trades.length?s.trades.map(t=>{const m=t.patternMeta||{},expected=t.expectedWindow||m.expectedWindow||'—',actual=t.actualWindow||'—';return`<tr><td>#${t.contractId}</td><td>${escapeHtml(`${m.session||'—'} · ${m.phase||'WAVE'}`)}</td><td>${t.direction}</td><td>${escapeHtml(`${m.fibZone||'—'} · ${(Number(m.fibEntryRetrace||0)*100).toFixed(0)}% · Q${m.quality??'—'}`)}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${expected}</td><td>${actual}</td><td>${t.latencyClass||'—'}</td><td class="${(t.profit??0)>=0?'positive':'negative'}">${t.profit===undefined?'—':`${t.profit>=0?'+':''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs===undefined?'—':Number(t.sendToAckMs).toFixed(0)+'ms'}</td><td>${t.entrySpot??'—'} → ${t.exitSpot??'—'}</td></tr>`;}).join(''):'<tr><td colspan="12" class="empty">No v6.4 rolling-wave trades yet.</td></tr>';if(s.logs?.[0])$('ptLogs').innerHTML=s.logs.slice(0,70).map(l=>`<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${escapeHtml(l.message==='Engine armed. Waiting for fresh BOS.'?'Master v6.4 execution engine armed.':l.message)}</span></div>`).join('');renderLedger();drawMasterCanvas();});

window.addEventListener('DOMContentLoaded',()=>{document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.4'));const mt=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Master Trader v6'));if(mt)mt.textContent='Master Trader v6.4 · Rolling Wave Sniper';const rt=[...document.querySelectorAll('.sectionTitle span')].find(el=>el.textContent.includes('Frozen v6'));if(rt)rt.textContent='Frozen v6.4 rolling-wave rules';if($('ptStart'))$('ptStart').textContent='Start Master Trader v6.4';if($('ptCooldown'))$('ptCooldown').value='3';$('ptAppId').value=localStorage.getItem('sani.deriv.appId')||'';$('ptToken').value=sessionStorage.getItem('sani.deriv.token')||'';renderLedger();drawMasterCanvas();if($('ptAppId').value&&$('ptToken').value)$('ptLoadAccounts').click();const snap=window.SaniObservatory?.getSnapshot?.();if(snap){lastAnalysis=snap;lastDiagnostics=evaluate(snap);renderMasterState(lastDiagnostics);drawMasterCanvas();}});
