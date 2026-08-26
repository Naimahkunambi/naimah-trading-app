import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v4';
const PAYOUT=.92;
const PREARM_CONFIRM=3;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{version:4,offsetTicks:1,preArmConfirm:PREARM_CONFIRM,passes:bucket(),rejects:bucket(),lastDecision:null,lastLesson:'Forward timing v4: paid = correct mountain + BUILD + PRE_PULLBACK_END + SNIPER quality + unused leg. Crossovers are transition evidence, never automatic trades.',paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0,lastPaidOpportunityKey:'',lastPaidOpportunityAt:0,oneShotBlocks:0}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||localStorage.getItem('sani.libra.forward-timing.v3')||localStorage.getItem('sani.libra.forward-timing.v2')||'null');const f=fresh();return raw&&typeof raw==='object'?{...f,...raw,version:4,passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-240):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-240):[]}}:f}catch{return fresh()}}
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
  return{direction,age,fresh:direction!=='NONE'&&age<=3,aligned:direction!== 'NONE'&&direction===wanted,counter:direction!=='NONE'&&wanted!=='NONE'&&direction!==wanted};
}
function quality(signal,m,cross){
  const i=signal?.saniIntent||{},p=signal?.pattern||{};
  const edge=Number(i.edge??p.foundationEdge??p.edge??0),sim=Number(i.avgSimilarity??p.avgSimilarity??0),topAgree=Number(i.top10Agree??p.top10Agree??0),topTotal=Math.max(1,Number(i.top10Total??p.top10Total??10)),saniSniper=Number(i.sniperScore??signal?.sniper?.score??0),familyRate=Number(i.familyRate||0),familySamples=Number(i.familySamples||0),addressRate=Number(i.addressRate||0),addressSamples=Number(i.addressSamples||0),confirmation=Number(m?.confirmation||0);
  let score=0;
  score+=clamp((edge-50)*1.5,0,27);
  score+=clamp((sim-80)*.8,0,16);
  score+=clamp(topAgree/topTotal*20,0,20);
  score+=clamp(confirmation*5,0,30);
  if(cross.aligned&&cross.fresh)score+=10;
  if(cross.counter&&cross.fresh)score-=12;
  if(familySamples>=6)score+=(familyRate-.5)*12;
  if(addressSamples>=5)score+=(addressRate-.5)*10;
  if(saniSniper>0)score=score*.78+saniSniper*.22;
  if(edge<56)score-=12;
  if(topAgree/topTotal<.6)score-=12;
  score=clamp(score,0,100);
  const grade=score>=76?'SNIPER':score>=66?'ACCEPTABLE':score>=52?'LATE':'TRASH';
  return{score:Number(score.toFixed(1)),grade,edge,sim,topAgree,topTotal,saniSniper,confirmation,cross};
}
function rejected(action,direction,reason,m,extra={}){return{allowed:false,action,direction,reason,mountain:m,forwardOffset:1,...extra}}

function evaluateForward(signal,m=mountain){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  const cross=crossoverRead(latest.ticks||[],m?.direction),q=quality(signal,m,cross),sniper={score:q.score,entryClass:q.grade};
  if(!signal?.sourceApproved||!validDirection(direction))return rejected('SANI QUIET','NONE','No qualified SANI setup to grade.',m,{cross,quality:q,sniper});
  if(latencyHeld())return rejected('LATENCY HOLD',direction,`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. I will not risk another 1-tick entry during unstable execution.`,m,{cross,quality:q,sniper});
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return rejected('WAIT',direction,`No locked directional mountain (${m?.direction||'NONE'}).`,m,{cross,quality:q,sniper});
  if(regime==='CHOP')return rejected('CHOP · NO TRADE',direction,'Broad regime is CHOP. Crossovers here are transition alerts only, never paid triggers.',m,{cross,quality:q,sniper});
  if(regime.startsWith('TRANSITION'))return rejected('TRANSITION · WAIT',direction,'Structure is transitioning. I will not pay while direction is being renegotiated.',m,{cross,quality:q,sniper});
  if(regime.includes('EXHAUSTION'))return rejected('EXHAUSTION · NO CHASE',direction,'Mountain may still point this way, but the move is exhausted. No paid chase.',m,{cross,quality:q,sniper});
  if(m.allowedDirection!==direction)return rejected('BLOCK',direction,`Wrong side. ${m.direction} mountain allows ${m.allowedDirection}; SANI ${direction} is forbidden until structural reversal.`,m,{cross,quality:q,sniper});
  if(!prearmHealthy())return rejected('FORWARD RETRAIN',direction,'Recent executable-window PRE-ARM evidence degraded. Paid timing stays off while shadow evidence rebuilds.',m,{cross,quality:q,sniper});
  if(regime.startsWith('DRIVE'))return rejected('DRIVE · SHADOW',direction,'Correct side, but DRIVE is already underway. I will study it, not chase it with a 1-tick paid contract.',m,{cross,quality:q,sniper});

  if(m.entryMode==='WAIT_PULLBACK_END'&&Number(m.confirmation||0)>=PREARM_CONFIRM){
    if(cross.counter&&cross.fresh)return rejected('CROSS AGAINST MOUNTAIN',direction,`Fresh ${cross.direction} micro/structure cross fights the locked ${m.direction} mountain. Treat it as pullback/fakeout until the fast line crosses back with the mountain.`,m,{cross,quality:q,sniper});
    if(q.grade!=='SNIPER')return rejected(`${q.grade} · SHADOW`,direction,`Correct side and early moment, but quality is ${q.grade} ${q.score}/100. Paid requires SNIPER ≥76. Cross ${cross.direction}${cross.fresh?` age ${cross.age}T`:' none/far'}.`,m,{cross,quality:q,sniper});
    const alignedText=cross.aligned&&cross.fresh?` Fresh ${cross.direction} crossover confirms the turn.`:' No fresh aligned crossover, so the pattern/structure score had to carry the entry.';
    return{allowed:true,action:'SNIPER · PRE-ARM',direction,reason:`ONE-TICK LEAD: ${m.direction} BUILD-side pullback turn ${m.confirmation}/6, quality ${q.score}/100.${alignedText} SANI predicts T+1→T+2, so send before full confirmation.`,mountain:{...m,entryMode:'PRE_PULLBACK_END'},forwardOffset:1,preArm:true,opportunityKey:opportunityKey(m,direction),cross,quality:q,sniper};
  }

  if(m.entryMode==='PULLBACK_END')return rejected('CONFIRMED TOO LATE',direction,`${regime}: full pullback confirmation is classroom-only. Paid entry needed PRE_PULLBACK_END one tick earlier.`,m,{cross,quality:q,sniper});
  if(m.entryMode==='EARLY_MOMENTUM')return rejected('EARLY MOMENTUM · SHADOW',direction,'Direct-mountain momentum remains shadow-only until its paid timing has independent evidence.',m,{cross,quality:q,sniper});
  return rejected('WAIT',direction,`No paid moment: ${m.entryMode}, confirmation ${Number(m.confirmation||0)}/6, quality ${q.grade} ${q.score}/100, crossover ${cross.direction}${cross.fresh?` ${cross.age}T ago`:''}.`,m,{cross,quality:q,sniper});
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
        result=rejected('LEG ALREADY USED',result.direction,'This mountain leg already spent its one paid bullet. Wait for a new structural HH/LL leg and a fresh pullback.',result.mountain,{forwardOffset:1,preArm:true,opportunityKey:key,cross:result.cross,quality:result.quality,sniper:result.sniper});
      }else if(key){
        state.lastPaidOpportunityKey=key;state.lastPaidOpportunityAt=Date.now();result={...result,opportunityKey:key,reason:`${result.reason} ONE-SHOT LOCK: this structural leg is now consumed.`};
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
      const historicalTicks=(latest.ticks||[]).filter(t=>Number(t.epoch)<=Number(row.signalEpoch||Infinity));
      const m=analyzeMountain(historicalTicks),decision=evaluateForward({...row,direction:row.sourceDirection},m);
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision,mountain:m});
    }
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;
      const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1,target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,moment:lesson.decision?.mountain?.entryMode||lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',quality:lesson.decision?.quality?.grade,score:lesson.decision?.quality?.score,cross:lesson.decision?.cross?.direction,entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset,opportunityKey:lesson.decision?.opportunityKey||opportunityKey(lesson.mountain,lesson.direction)});
      const p=summary(state.passes);state.lastLesson=`FORWARD CLASSROOM: paid-eligible SNIPER PRE-ARM set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}. Everything else stays shadow.`;settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{
  const d=event.detail||{},ack=Number(d.buyAckMs);
  if(Number.isFinite(ack)){state.lastAckMs=ack;state.paidAckMs.push(ack);if(ack>LATENCY_OUTLIER_MS)state.latencyHoldUntil=Date.now()+LATENCY_HOLD_MS}
  if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save();
});

function snapshot(){const cross=crossoverRead(latest.ticks||[],mountain?.direction);return{version:'Forward Timing v4 · Sniper Only',offsetTicks:1,preArmConfirm:PREARM_CONFIRM,healthy:prearmHealthy(),latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,20),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastPaidOpportunityKey:state.lastPaidOpportunityKey,lastPaidOpportunityAt:state.lastPaidOpportunityAt,oneShotBlocks:state.oneShotBlocks,lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain,cross}}
window.LIBRA_FORWARD_TIMING={snapshot,evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[])),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
