import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v1';
const PAYOUT=.92;
const PREARM_CONFIRM=3;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{version:1,offsetTicks:1,preArmConfirm:PREARM_CONFIRM,passes:bucket(),rejects:bucket(),lastDecision:null,lastLesson:'Forward timing is armed. Decide on T for the executable T+1 → T+2 contract, not after the move has already confirmed.',paidAckMs:[],paidSlips:[]}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');const f=fresh();return raw&&typeof raw==='object'?{...f,...raw,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-240):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-240):[]}}:f}catch{return fresh()}}
const state=load();
let latest={ticks:[],signals:[],mission:{}},mountain=analyzeMountain([]),installed=false;
const captured=new Map(),settled=new Set();

function save(){state.passes.recent=(state.passes.recent||[]).slice(-240);state.rejects.recent=(state.rejects.recent||[]).slice(-240);state.paidAckMs=(state.paidAckMs||[]).slice(-60);state.paidSlips=(state.paidSlips||[]).slice(-60);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}}
function summary(b){const n=Number(b?.trades||0),wins=Number(b?.wins||0),pnl=Number(b?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0}}
function recent(rows=[],n=20){const a=(rows||[]).slice(-n),wins=a.filter(r=>r.won).length,pnl=a.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades:a.length,wins,losses:a.length-wins,pnl:Number(pnl.toFixed(2)),winRate:a.length?wins/a.length*100:0}}
function record(b,won,pnl,row){b.trades++;b.pnl=Number((Number(b.pnl||0)+Number(pnl||0)).toFixed(2));won?b.wins++:b.losses++;b.recent.push({...row,won,pnl,at:Date.now()});b.recent=b.recent.slice(-240)}
function median(values=[]){const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function prearmHealthy(){const r=recent(state.passes.recent,20);return !(r.trades>=20&&(r.winRate<45||r.pnl<=-5))}

function evaluateForward(signal,m=mountain){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  if(!signal?.sourceApproved||!validDirection(direction))return{allowed:false,action:'SANI QUIET',direction:'NONE',reason:'No qualified SANI setup to pre-arm.',mountain:m,forwardOffset:1};
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return{allowed:false,action:'WAIT',direction,reason:`Forward timing refuses ${m?.direction||'NO'} mountain.`,mountain:m,forwardOffset:1};
  if(m.allowedDirection!==direction)return{allowed:false,action:'BLOCK',direction,reason:`Wrong side before execution. ${m.direction} mountain allows ${m.allowedDirection}; SANI ${direction} is blocked.`,mountain:m,forwardOffset:1};
  if(!prearmHealthy())return{allowed:false,action:'FORWARD RETRAIN',direction,reason:'The last 20 pre-arm classroom entries degraded. Forward timing is temporarily disabled until more shadow evidence repairs it.',mountain:m,forwardOffset:1};

  // SANI already models the executable window one tick ahead: T+1 entry, T+2 exit.
  // Libra therefore acts while the pullback is STARTING to turn, not after full confirmation.
  if(m.entryMode==='WAIT_PULLBACK_END'&&Number(m.confirmation||0)>=PREARM_CONFIRM){
    return{allowed:true,action:'PRE-ARM PASS',direction,reason:`ONE-TICK LEAD: ${m.direction} mountain is intact and pullback turn has ${m.confirmation}/6 confirmations. SANI predicts T+1→T+2, so send now instead of waiting for PULLBACK_END.`,mountain:{...m,entryMode:'PRE_PULLBACK_END'},forwardOffset:1,preArm:true};
  }

  // In a DRIVE, fully confirmed PULLBACK_END has repeatedly been arriving after the impulse.
  if(m.entryMode==='PULLBACK_END'&&regime.startsWith('DRIVE')){
    return{allowed:false,action:'LATE DRIVE',direction,reason:`${regime}: PULLBACK_END is confirmed, but for a 1-tick contract confirmation is late. I needed PRE_PULLBACK_END one tick earlier.`,mountain:m,forwardOffset:1};
  }

  if(['PULLBACK_END','EARLY_MOMENTUM'].includes(m.entryMode))return null;
  return{allowed:false,action:'WAIT',direction,reason:`No one-tick lead yet: ${m.entryMode}, confirmation ${Number(m.confirmation||0)}/6.`,mountain:m,forwardOffset:1};
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;
  installed=true;
  const base=window.LIBRA_TEACHER.decisionFor.bind(window.LIBRA_TEACHER);
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);
    const forward=evaluateForward(signal,mountain);
    if(forward){state.lastDecision={...forward,signalId:signal?.signalId,at:Date.now()};save();window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));return forward}
    const normal=base(signal);
    const result={...normal,forwardOffset:1,reason:`ONE-TICK TARGET: ${normal?.reason||''}`};
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
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision:decision||{allowed:false,action:'DEFER CONFIRMED',reason:'Normal confirmed Teacher gate.',mountain:m},mountain:m});
    }
    // Worker's shadow is the executable simulation: executionOffset=1, duration=1.
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;
      const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1,target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,moment:lesson.decision?.mountain?.entryMode||lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset});
      const p=summary(state.passes);state.lastLesson=`FORWARD CLASSROOM: executable T+1→T+2 pre-arm set is ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}.`;settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{const d=event.detail||{};if(Number.isFinite(Number(d.buyAckMs)))state.paidAckMs.push(Number(d.buyAckMs));if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save()});

function snapshot(){return{version:'Forward Timing v1',offsetTicks:1,preArmConfirm:PREARM_CONFIRM,healthy:prearmHealthy(),passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,20),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[])),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
