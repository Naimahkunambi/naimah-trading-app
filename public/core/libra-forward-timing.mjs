import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v10';
const PAYOUT=.92;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{
  version:10,passes:bucket(),rejects:bucket(),lastDecision:null,
  lastLesson:'v10 trades BEFORE confirmation: SANI setup + locked mountain + WAIT_PULLBACK_END. PULLBACK_END is already late for the 1-tick paid hand.',
  paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0
}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'),f=fresh();return raw&&raw.version===10?{...f,...raw,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-300):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-300):[]}}:f}catch{return fresh()}}
const state=load();
let latest={ticks:[],signals:[],mission:{}},mountain=analyzeMountain([]),installed=false;
const captured=new Map(),settled=new Set();

function save(){state.passes.recent=(state.passes.recent||[]).slice(-300);state.rejects.recent=(state.rejects.recent||[]).slice(-300);state.paidAckMs=(state.paidAckMs||[]).slice(-80);state.paidSlips=(state.paidSlips||[]).slice(-80);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}}
function summary(b){const n=Number(b?.trades||0),wins=Number(b?.wins||0),pnl=Number(b?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0}}
function recent(rows=[],n=30){const a=(rows||[]).slice(-n),wins=a.filter(r=>r.won).length,pnl=a.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades:a.length,wins,losses:a.length-wins,pnl:Number(pnl.toFixed(2)),winRate:a.length?wins/a.length*100:0}}
function record(b,won,pnl,row){b.trades++;b.pnl=Number((Number(b.pnl||0)+Number(pnl||0)).toFixed(2));won?b.wins++:b.losses++;b.recent.push({...row,won,pnl,at:Date.now()});b.recent=b.recent.slice(-300)}
function median(values=[]){const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function latencyHeld(){return Date.now()<Number(state.latencyHoldUntil||0)}
function saniEdge(signal){const i=signal?.saniIntent||{},p=signal?.pattern||{};return Number(i.edge??p.foundationEdge??p.edge??0)}
function rejected(action,direction,reason,m,extra={}){return{allowed:false,action,direction,reason,mountain:m,forwardOffset:1,...extra}}

function evaluateForward(signal,m=mountain){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  const edge=saniEdge(signal),moment=m?.entryMode||'NO_TRADE';
  const diagnostic={edge,regime,moment,confirmation:Number(m?.confirmation||0)};
  const sniper={score:null,entryClass:moment==='WAIT_PULLBACK_END'?'AHEAD_OF_TURN':'NO_ENTRY'};

  if(!signal?.sourceApproved||!validDirection(direction))return rejected('SANI QUIET','NONE','No qualified SANI setup.',m,{diagnostic,sniper,regime});
  if(latencyHeld())return rejected('LATENCY HOLD',direction,`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. The 1-tick pipe is late, so do not send.`,m,{diagnostic,sniper,regime});
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return rejected('NO LOCKED MOUNTAIN',direction,`No locked campaign direction (${m?.direction||'NONE'}).`,m,{diagnostic,sniper,regime});
  if(m.allowedDirection!==direction)return rejected('WRONG MOUNTAIN SIDE',direction,`${m.direction} campaign allows ${m.allowedDirection}; SANI ${direction} is blocked until important structure actually reverses.`,m,{diagnostic,sniper,regime});

  // WAIT_PULLBACK_END is deliberately the paid state. It means the pullback exists but
  // the turn has NOT yet accumulated the four confirmations required for PULLBACK_END.
  // Across five independent Demo audits this aligned state produced 85W/62L (57.8%)
  // in the executable T+1→T+2 shadow, while aligned EXHAUSTION was below break-even.
  if(moment==='WAIT_PULLBACK_END'){
    return{
      allowed:true,action:'AHEAD OF TURN',direction,
      reason:`PREDICT, DO NOT CONFIRM: ${m.direction} mountain is locked and SANI already proposes ${direction} while the opposite move is still a pullback. Confirmation is only ${Number(m.confirmation||0)}/6. SEND before PULLBACK_END. SANI edge ${edge.toFixed(1)}% is diagnostic, not a veto.`,
      mountain:m,forwardOffset:1,diagnostic,sniper,regime
    };
  }

  if(moment==='PULLBACK_END')return rejected('CONFIRMED TOO LATE',direction,'The turn is already confirmed. For a 1-tick paid contract this is the state we were arriving late to. Keep it shadow.',m,{diagnostic,sniper,regime});
  if(moment==='EXHAUSTION')return rejected('EXHAUSTION · BLOCK',direction,'Mountain direction remains valid, but progression is flattening. Latest multi-run evidence puts aligned EXHAUSTION below break-even.',m,{diagnostic,sniper,regime});
  if(moment==='LATE_OR_WAIT')return rejected('LATE · BLOCK',direction,'Correct mountain side, but there is no fresh pullback. Do not enter mid-leg.',m,{diagnostic,sniper,regime});
  if(moment==='EARLY_MOMENTUM')return rejected('DIRECT MOMENTUM · SHADOW',direction,'Direct mountain with no proper pullback stays shadow until it has its own independent paid evidence.',m,{diagnostic,sniper,regime});
  return rejected('WAIT',direction,`No predictive pullback window: ${moment}.`,m,{diagnostic,sniper,regime});
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;installed=true;
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);const result=evaluateForward(signal,mountain);
    state.lastDecision={...result,signalId:signal?.signalId,at:Date.now()};save();window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));return result;
  };
  return true;
}

function study(){
  for(const row of latest.signals||[]){
    if(!row?.signalId||!row.sourceApproved||!validDirection(row.sourceDirection))continue;
    if(!captured.has(row.signalId)&&!settled.has(row.signalId)){
      const historicalTicks=(latest.ticks||[]).filter(t=>Number(t.epoch)<=Number(row.signalEpoch||Infinity));
      const m=analyzeMountain(historicalTicks),decision=evaluateForward({...row,direction:row.sourceDirection},m);
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision,mountain:m,edge:saniEdge(row)});
    }
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1,target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,mountainDirection:lesson.mountain?.direction||'NONE',moment:lesson.mountain?.entryMode||'NO_TRADE',confirmation:lesson.mountain?.confirmation,action:lesson.decision?.action||'WAIT',edge:lesson.edge,entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset});
      const p=summary(state.passes);state.lastLesson=`AHEAD-OF-TURN v10: eligible executable set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}.`;settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{const d=event.detail||{},ack=Number(d.buyAckMs);if(Number.isFinite(ack)){state.lastAckMs=ack;state.paidAckMs.push(ack);if(ack>LATENCY_OUTLIER_MS)state.latencyHoldUntil=Date.now()+LATENCY_HOLD_MS}if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save()});

function snapshot(){return{version:'Forward Timing v10 · Ahead Of Turn',latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,30),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[])),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
