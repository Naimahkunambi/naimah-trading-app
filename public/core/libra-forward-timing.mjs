import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v5';
const PAYOUT=.92;
const PREARM_CONFIRM=2;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{
  version:5,offsetTicks:1,preArmConfirm:PREARM_CONFIRM,
  passes:bucket(),rejects:bucket(),
  lastDecision:null,
  lastLesson:'Forward timing v5: SANI setup + locked mountain side + early pullback turn. Broad regime labels and arbitrary scores no longer veto a structurally valid pre-arm.',
  paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0,
  lastPaidOpportunityKey:'',lastPaidOpportunityAt:0,oneShotBlocks:0
}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'),f=fresh();return raw&&typeof raw==='object'?{...f,...raw,version:5,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-240):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-240):[]}}:f}catch{return fresh()}}
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

// A structural leg is keyed by the important HL/LH that produced the current campaign leg.
// Do NOT key on every micro extreme, otherwise SANI gets another paid bullet every time price wiggles.
function opportunityKey(m,direction){
  if(!validDirection(direction)||!['UP','DOWN'].includes(m?.direction))return'';
  const structuralEpoch=Number(m?.important?.epoch||m?.start?.epoch||0);
  return structuralEpoch?`${direction}|${m.direction}|${structuralEpoch}`:'';
}

function regressionLast(rows,period){
  const slice=(rows||[]).slice(-Math.max(2,period));if(slice.length<2)return Number(slice.at(-1)?.quote||0);
  const n=slice.length,xm=(n-1)/2,ym=slice.reduce((s,r)=>s+Number(r.quote),0)/n;let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-xm)*(Number(slice[i].quote)-ym);den+=(i-xm)**2}
  const slope=den?num/den:0,intercept=ym-slope*xm;return intercept+slope*(n-1);
}
function crossAt(rows,end){const r=(rows||[]).slice(0,end+1);if(r.length<22)return null;const now=regressionLast(r,5)-regressionLast(r,21),prevRows=r.slice(0,-1),prev=regressionLast(prevRows,5)-regressionLast(prevRows,21);if(prev<=0&&now>0)return'CALL';if(prev>=0&&now<0)return'PUT';return null}
function crossoverRead(rows=[],mountainDirection='NONE'){
  const clean=(rows||[]).slice(-40);let direction='NONE',age=99;
  for(let back=0;back<4;back++){const end=clean.length-1-back;if(end<21)break;const d=crossAt(clean,end);if(d){direction=d;age=back;break}}
  const wanted=mountainDirection==='UP'?'CALL':mountainDirection==='DOWN'?'PUT':'NONE';
  return{direction,age,fresh:direction!=='NONE'&&age<=3,aligned:direction!=='NONE'&&direction===wanted,counter:direction!=='NONE'&&wanted!=='NONE'&&direction!==wanted};
}
function diagnostic(signal,m,cross){
  const i=signal?.saniIntent||{},p=signal?.pattern||{};
  return{
    family:i.familyId||p.foundationFamily||p.familyId||'UNKNOWN',
    edge:Number(i.edge??p.foundationEdge??p.edge??0),
    similarity:Number(i.avgSimilarity??p.avgSimilarity??0),
    topAgree:Number(i.top10Agree??p.top10Agree??0),
    topTotal:Number(i.top10Total??p.top10Total??0),
    confirmation:Number(m?.confirmation||0),cross
  };
}
function rejected(action,direction,reason,m,extra={}){return{allowed:false,action,direction,reason,mountain:m,forwardOffset:1,...extra}}

// v5 doctrine:
// SANI proposes. Mountain direction is law. Libra enters one tick early at the pullback turn.
// Broad Libra regimes are context only because the audit showed they were blocking many executable winners.
// The old 0-100 score is diagnostic-only and is NOT allowed to veto a structurally valid setup.
function evaluateForward(signal,m=mountain,rows=latest.ticks||[]){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  const cross=crossoverRead(rows,m?.direction),diag=diagnostic(signal,m,cross);
  const structuralClass=m?.entryMode==='WAIT_PULLBACK_END'&&Number(m?.confirmation||0)>=PREARM_CONFIRM?'STRUCTURAL_PREARM':m?.entryMode||'WAIT';
  const sniper={score:null,entryClass:structuralClass};

  if(!signal?.sourceApproved||!validDirection(direction))return rejected('SANI QUIET','NONE','SANI has no qualified setup to supervise.',m,{cross,diagnostic:diag,sniper,regime});
  if(latencyHeld())return rejected('LATENCY HOLD',direction,`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. One-tick entries pause while execution is unstable.`,m,{cross,diagnostic:diag,sniper,regime});
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return rejected('WAIT',direction,`No locked directional mountain (${m?.direction||'NONE'}).`,m,{cross,diagnostic:diag,sniper,regime});
  if(m.allowedDirection!==direction)return rejected('BLOCK',direction,`Wrong side. ${m.direction} mountain allows ${m.allowedDirection}; SANI ${direction} stays blocked until the important structure actually reverses.`,m,{cross,diagnostic:diag,sniper,regime});
  if(!prearmHealthy())return rejected('FORWARD RETRAIN',direction,'Recent v5 executable PRE-ARM evidence degraded. Paid timing pauses while the same structural rule rebuilds in shadow.',m,{cross,diagnostic:diag,sniper,regime});

  if(m.entryMode==='WAIT_PULLBACK_END'&&Number(m.confirmation||0)>=PREARM_CONFIRM){
    const crossText=cross.aligned&&cross.fresh
      ?` Fresh ${cross.direction} micro/structure cross supports the mountain.`
      :cross.counter&&cross.fresh
        ?` Fresh ${cross.direction} cross is treated as pullback noise because the important ${m.important?.label||'structure'} has not reversed the ${m.direction} mountain.`
        :' No fresh crossover is required; SANI + mountain structure carry the setup.';
    return{
      allowed:true,action:'PRE-ARM PASS',direction,
      reason:`ONE-TICK LEAD: ${m.direction} mountain intact, SANI agrees, pullback turn ${m.confirmation}/6.${crossText} Broad regime ${regime} is context only, not a veto.`,
      mountain:{...m,entryMode:'PRE_PULLBACK_END'},forwardOffset:1,preArm:true,
      opportunityKey:opportunityKey(m,direction),cross,diagnostic:diag,sniper,regime
    };
  }

  if(m.entryMode==='PULLBACK_END')return rejected('CONFIRMED TOO LATE',direction,`${m.direction} mountain is still valid, but the pullback is already fully confirmed. Keep it shadow because the paid one-tick shot belonged 1 tick earlier.`,m,{cross,diagnostic:diag,sniper,regime});
  if(m.entryMode==='EARLY_MOMENTUM')return rejected('EARLY MOMENTUM · SHADOW',direction,'Direct-mountain momentum remains shadow-only until its own paid Demo timing is independently proven.',m,{cross,diagnostic:diag,sniper,regime});
  if(m.entryMode==='EXHAUSTION')return rejected('EXHAUSTION · WAIT',direction,'Mountain direction remains locked, but there is no fresh pullback-turn entry. Wait for a new structural leg instead of chasing.',m,{cross,diagnostic:diag,sniper,regime});
  return rejected('WAIT',direction,`Correct ${m.direction} side, but no fresh early entry yet: ${m.entryMode}, confirmation ${Number(m.confirmation||0)}/6.`,m,{cross,diagnostic:diag,sniper,regime});
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;
  installed=true;
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);
    let result=evaluateForward(signal,mountain,latest.ticks||[]);
    if(result.allowed&&result.preArm){
      const key=result.opportunityKey||opportunityKey(mountain,result.direction);
      if(key&&key===state.lastPaidOpportunityKey){
        state.oneShotBlocks=Number(state.oneShotBlocks||0)+1;
        result=rejected('LEG ALREADY USED',result.direction,'This important HL/LH leg already used its one paid entry. Wait for a new important structural pullback before firing again.',result.mountain,{forwardOffset:1,preArm:true,opportunityKey:key,cross:result.cross,diagnostic:result.diagnostic,sniper:result.sniper,regime:result.regime});
      }else if(key){
        state.lastPaidOpportunityKey=key;state.lastPaidOpportunityAt=Date.now();
        result={...result,opportunityKey:key,reason:`${result.reason} ONE-SHOT LOCK: this important structural leg is now consumed.`};
      }
    }
    state.lastDecision={...result,signalId:signal?.signalId,at:Date.now()};save();
    window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));
    return result;
  };
  return true;
}

function study(){
  for(const row of latest.signals||[]){
    if(!row?.signalId||!row.sourceApproved||!validDirection(row.sourceDirection))continue;
    if(!captured.has(row.signalId)&&!settled.has(row.signalId)){
      const historicalTicks=(latest.ticks||[]).filter(t=>Number(t.epoch)<=Number(row.signalEpoch||Infinity));
      const m=analyzeMountain(historicalTicks),decision=evaluateForward({...row,direction:row.sourceDirection},m,historicalTicks);
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision,mountain:m});
    }
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;
      const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1,target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,mountainDirection:lesson.mountain?.direction||'NONE',moment:lesson.decision?.mountain?.entryMode||lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',confirmation:lesson.mountain?.confirmation,cross:lesson.decision?.cross?.direction,entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset,opportunityKey:lesson.decision?.opportunityKey||opportunityKey(lesson.mountain,lesson.direction)});
      const p=summary(state.passes);state.lastLesson=`FORWARD CLASSROOM v5: structurally eligible PRE-ARM set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}. Broad regime labels and old score thresholds are no longer deciding the paid gate.`;
      settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{
  const d=event.detail||{},ack=Number(d.buyAckMs);
  if(Number.isFinite(ack)){state.lastAckMs=ack;state.paidAckMs.push(ack);if(ack>LATENCY_OUTLIER_MS)state.latencyHoldUntil=Date.now()+LATENCY_HOLD_MS}
  if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save();
});

function snapshot(){const cross=crossoverRead(latest.ticks||[],mountain?.direction);return{version:'Forward Timing v5 · Structural Pre-Arm',offsetTicks:1,preArmConfirm:PREARM_CONFIRM,healthy:prearmHealthy(),latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,20),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastPaidOpportunityKey:state.lastPaidOpportunityKey,lastPaidOpportunityAt:state.lastPaidOpportunityAt,oneShotBlocks:state.oneShotBlocks,lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain,cross}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[]),latest.ticks||[]),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
