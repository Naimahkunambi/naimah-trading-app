import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v6';
const PAYOUT=.92;
const MIN_SANI_EDGE=57;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{
  version:6,minSaniEdge:MIN_SANI_EDGE,passes:bucket(),rejects:bucket(),lastDecision:null,
  lastLesson:'Forward timing v6: SANI supplies the setup, the locked mountain supplies direction. The old pullback-confirmation gate is retired because the audit showed it selected the losing windows.',
  paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0
}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'),f=fresh();return raw&&typeof raw==='object'?{...f,...raw,version:6,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-240):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-240):[]}}:f}catch{return fresh()}}
const state=load();
let latest={ticks:[],signals:[],mission:{}},mountain=analyzeMountain([]),installed=false;
const captured=new Map(),settled=new Set();

function save(){state.passes.recent=(state.passes.recent||[]).slice(-240);state.rejects.recent=(state.rejects.recent||[]).slice(-240);state.paidAckMs=(state.paidAckMs||[]).slice(-60);state.paidSlips=(state.paidSlips||[]).slice(-60);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}}
function summary(b){const n=Number(b?.trades||0),wins=Number(b?.wins||0),pnl=Number(b?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0}}
function recent(rows=[],n=20){const a=(rows||[]).slice(-n),wins=a.filter(r=>r.won).length,pnl=a.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades:a.length,wins,losses:a.length-wins,pnl:Number(pnl.toFixed(2)),winRate:a.length?wins/a.length*100:0}}
function record(b,won,pnl,row){b.trades++;b.pnl=Number((Number(b.pnl||0)+Number(pnl||0)).toFixed(2));won?b.wins++:b.losses++;b.recent.push({...row,won,pnl,at:Date.now()});b.recent=b.recent.slice(-240)}
function median(values=[]){const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function latencyHeld(){return Date.now()<Number(state.latencyHoldUntil||0)}

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
function saniEdge(signal){const i=signal?.saniIntent||{},p=signal?.pattern||{};return Number(i.edge??p.foundationEdge??p.edge??0)}
function rejected(action,direction,reason,m,extra={}){return{allowed:false,action,direction,reason,mountain:m,forwardOffset:1,...extra}}

// The audit on the live Demo run showed the old timing classifier doing the opposite
// of its job: the PRE_PULLBACK_END set lost 4/4 in execution-offset shadow while
// mountain-aligned SANI during WORK won 16/26 (61.5%). v6 therefore stops pretending
// that a 2/6 or 3/6 confirmation count is a superior sniper trigger.
// Direction is hierarchical: SANI setup -> locked mountain agreement -> execution guards.
function evaluateForward(signal,m=mountain,rows=latest.ticks||[]){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  const edge=saniEdge(signal),cross=crossoverRead(rows,m?.direction);
  const diagnostic={edge,regime,cross,moment:m?.entryMode||'NO_TRADE',confirmation:Number(m?.confirmation||0)};
  const sniper={score:null,entryClass:'MOUNTAIN_ALIGNED_SANI'};

  if(!signal?.sourceApproved||!validDirection(direction))return rejected('SANI QUIET','NONE','No qualified SANI setup.',m,{cross,diagnostic,sniper,regime});
  if(latencyHeld())return rejected('LATENCY HOLD',direction,`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. One-tick execution pauses while latency is unstable.`,m,{cross,diagnostic,sniper,regime});
  if(edge<MIN_SANI_EDGE)return rejected('SANI EDGE WAIT',direction,`SANI edge ${edge.toFixed(1)} is below the v6 execution floor ${MIN_SANI_EDGE}.`,m,{cross,diagnostic,sniper,regime});
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return rejected('NO MOUNTAIN',direction,`No locked directional mountain (${m?.direction||'NONE'}).`,m,{cross,diagnostic,sniper,regime});
  if(m.allowedDirection!==direction)return rejected('BLOCK',direction,`Wrong side of the mountain. ${m.direction} allows ${m.allowedDirection}; SANI ${direction} is blocked until important structure reverses.`,m,{cross,diagnostic,sniper,regime});

  const crossText=cross.aligned&&cross.fresh
    ?` Fresh ${cross.direction} crossover agrees.`
    :cross.counter&&cross.fresh
      ?` Fresh ${cross.direction} crossover marks a micro shift/pullback, but it does not overrule the locked ${m.direction} mountain.`
      :' No fresh crossover.';
  return{
    allowed:true,action:'MOUNTAIN PASS',direction,
    reason:`SANI edge ${edge.toFixed(1)} + locked ${m.direction} mountain agree.${crossText} ${m.entryMode} is context, not a paid veto.`,
    mountain:m,forwardOffset:1,cross,diagnostic,sniper,regime
  };
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;
  installed=true;
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);
    const result=evaluateForward(signal,mountain,latest.ticks||[]);
    state.lastDecision={...result,signalId:signal?.signalId,at:Date.now()};save();
    window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));return result;
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
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,mountainDirection:lesson.mountain?.direction||'NONE',moment:lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',edge:lesson.decision?.diagnostic?.edge,cross:lesson.decision?.cross?.direction,entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset});
      const p=summary(state.passes);state.lastLesson=`FORWARD CLASSROOM v6: mountain-aligned SANI set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}.`;
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

function snapshot(){const cross=crossoverRead(latest.ticks||[],mountain?.direction);return{version:'Forward Timing v6 · Mountain-Aligned SANI',minSaniEdge:MIN_SANI_EDGE,latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,20),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain,cross}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[]),latest.ticks||[]),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
