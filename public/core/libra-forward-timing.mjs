import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v3';
const PAYOUT=.92;
const PREARM_CONFIRM=3;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{version:3,offsetTicks:1,preArmConfirm:PREARM_CONFIRM,passes:bucket(),rejects:bucket(),lastDecision:null,lastLesson:'Forward timing v3: one paid PRE-ARM shot per mountain leg. No spraying repeated SANI setups into the same move.',paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0,lastPaidOpportunityKey:'',lastPaidOpportunityAt:0,oneShotBlocks:0}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||localStorage.getItem('sani.libra.forward-timing.v2')||localStorage.getItem('sani.libra.forward-timing.v1')||'null');const f=fresh();return raw&&typeof raw==='object'?{...f,...raw,version:3,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-240):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-240):[]}}:f}catch{return fresh()}}
const state=load();
let latest={ticks:[],signals:[],mission:{}},mountain=analyzeMountain([]),installed=false;
const captured=new Map(),settled=new Set();

function save(){state.passes.recent=(state.passes.recent||[]).slice(-240);state.rejects.recent=(state.rejects.recent||[]).slice(-240);state.paidAckMs=(state.paidAckMs||[]).slice(-60);state.paidSlips=(state.paidSlips||[]).slice(-60);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}}
function summary(b){const n=Number(b?.trades||0),wins=Number(b?.wins||0),pnl=Number(b?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0}}
function recent(rows=[],n=20){const a=(rows||[]).slice(-n),wins=a.filter(r=>r.won).length,pnl=a.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades:a.length,wins,losses:a.length-wins,pnl:Number(pnl.toFixed(2)),winRate:a.length?wins/a.length*100:0}}
function record(b,won,pnl,row){b.trades++;b.pnl=Number((Number(b.pnl||0)+Number(pnl||0)).toFixed(2));won?b.wins++:b.losses++;b.recent.push({...row,won,pnl,at:Date.now()});b.recent=b.recent.slice(-240)}
function median(values=[]){const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function prearmHealthy(){const r=recent(state.passes.recent,20);return !(r.trades>=20&&(r.winRate<45||r.pnl<=-5))}
function latencyHeld(){return Date.now()<Number(state.latencyHoldUntil||0)}
function opportunityKey(m,direction){const leg=Number(m?.extreme?.epoch||m?.start?.epoch||0),important=Number(m?.important?.epoch||0);return validDirection(direction)&&['UP','DOWN'].includes(m?.direction)&&leg?`${direction}|${m.direction}|${leg}|${important}`:''}

function evaluateForward(signal,m=mountain){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  if(!signal?.sourceApproved||!validDirection(direction))return{allowed:false,action:'SANI QUIET',direction:'NONE',reason:'No qualified SANI setup to pre-arm.',mountain:m,forwardOffset:1};
  if(latencyHeld())return{allowed:false,action:'LATENCY HOLD',direction,reason:`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. Pause ${Math.max(0,Math.ceil((state.latencyHoldUntil-Date.now())/1000))}s before risking another 1-tick entry.`,mountain:m,forwardOffset:1};
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return{allowed:false,action:'WAIT',direction,reason:`Forward timing refuses ${m?.direction||'NO'} mountain.`,mountain:m,forwardOffset:1};
  if(m.allowedDirection!==direction)return{allowed:false,action:'BLOCK',direction,reason:`Wrong side before execution. ${m.direction} mountain allows ${m.allowedDirection}; SANI ${direction} is blocked.`,mountain:m,forwardOffset:1};
  if(!prearmHealthy())return{allowed:false,action:'FORWARD RETRAIN',direction,reason:'Recent executable-window pre-arm evidence degraded. Paid timing pauses while shadow evidence rebuilds.',mountain:m,forwardOffset:1};

  if(m.entryMode==='WAIT_PULLBACK_END'&&Number(m.confirmation||0)>=PREARM_CONFIRM){
    return{allowed:true,action:'PRE-ARM PASS',direction,reason:`ONE-TICK LEAD: ${m.direction} mountain intact, pullback turn ${m.confirmation}/6. SANI predicts T+1→T+2, so send before full confirmation.`,mountain:{...m,entryMode:'PRE_PULLBACK_END'},forwardOffset:1,preArm:true,opportunityKey:opportunityKey(m,direction)};
  }

  if(m.entryMode==='PULLBACK_END')return{allowed:false,action:regime.startsWith('DRIVE')?'LATE DRIVE':'CONFIRMED TOO LATE',direction,reason:`${regime}: the pullback is already fully confirmed. For the 1-tick paid contract this is shadow-only; paid entry needed PRE_PULLBACK_END one tick earlier.`,mountain:m,forwardOffset:1};
  if(m.entryMode==='EARLY_MOMENTUM')return{allowed:false,action:'EARLY MOMENTUM SHADOW',direction,reason:'Direct-mountain early momentum remains shadow-only until its actual Demo timing has enough evidence.',mountain:m,forwardOffset:1};
  return{allowed:false,action:'WAIT',direction,reason:`No one-tick lead yet: ${m.entryMode}, confirmation ${Number(m.confirmation||0)}/6.`,mountain:m,forwardOffset:1};
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;
  installed=true;
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);
    let result=evaluateForward(signal,mountain);
    if(result.allowed&&result.preArm){
      const key=result.opportunityKey||opportunityKey(mountain,result.direction);
      if(key&&key===state.lastPaidOpportunityKey){
        state.oneShotBlocks=Number(state.oneShotBlocks||0)+1;
        result={allowed:false,action:'LEG ALREADY USED',direction:result.direction,reason:'One paid shot was already used on this mountain leg. Wait for a NEW HH/LL leg before SANI can fire again.',mountain:result.mountain,forwardOffset:1,preArm:true,opportunityKey:key};
      }else if(key){
        state.lastPaidOpportunityKey=key;state.lastPaidOpportunityAt=Date.now();result={...result,opportunityKey:key,reason:`${result.reason} ONE-SHOT LOCK: this mountain leg is now consumed until a new structural extreme forms.`};
      }
    }
    state.lastDecision={...result,signalId:signal?.signalId,at:Date.now()};save();window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));return result;
  };
  return true;
}

function study(){
  for(const row of latest.signals||[]){
    if(!row?.signalId||!row.sourceApproved||!validDirection(row.sourceDirection))continue;
    if(!captured.has(row.signalId)&&!settled.has(row.signalId)){
      const m=analyzeMountain((latest.ticks||[]).filter(t=>Number(t.epoch)<=Number(row.signalEpoch||Infinity)));
      const decision=evaluateForward({...row,direction:row.sourceDirection},m);
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision,mountain:m});
    }
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;
      const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1,target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,moment:lesson.decision?.mountain?.entryMode||lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset,opportunityKey:lesson.decision?.opportunityKey||opportunityKey(lesson.mountain,lesson.direction)});
      const p=summary(state.passes);state.lastLesson=`FORWARD CLASSROOM: executable T+1→T+2 PRE-ARM set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}. Paid execution is capped at one shot per mountain leg.`;settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{
  const d=event.detail||{},ack=Number(d.buyAckMs);
  if(Number.isFinite(ack)){state.lastAckMs=ack;state.paidAckMs.push(ack);if(ack>LATENCY_OUTLIER_MS)state.latencyHoldUntil=Date.now()+LATENCY_HOLD_MS}
  if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save();
});

function snapshot(){return{version:'Forward Timing v3',offsetTicks:1,preArmConfirm:PREARM_CONFIRM,healthy:prearmHealthy(),latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,20),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastPaidOpportunityKey:state.lastPaidOpportunityKey,lastPaidOpportunityAt:state.lastPaidOpportunityAt,oneShotBlocks:state.oneShotBlocks,lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[])),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
