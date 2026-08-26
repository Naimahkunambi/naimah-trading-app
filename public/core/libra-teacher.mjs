import { SaniEngine } from './engine.mjs';
import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.teacher.v2';
const PAYOUT=.92;
const BREAK_EVEN=1/(1+PAYOUT);
const baseExecute=SaniEngine.prototype.execute;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{
  version:2,taughtAt:Date.now(),observations:0,setupPackets:0,completePackets:0,
  allowed:bucket(),blocked:bucket(),paid:bucket(),paidByRegime:{},
  rules:{
    MOUNTAIN_SIDE:{status:'MASTERED',source:'TAUGHT',description:'UP mountain permits CALL only; DOWN mountain permits PUT only until structural reversal is confirmed.'},
    REVERSAL_DISCIPLINE:{status:'MASTERED',source:'TAUGHT',description:'UP does not flip until important HL breaks and LH + LL confirm. Mirror for DOWN.'},
    CHOP_DISCIPLINE:{status:'MASTERED',source:'TAUGHT',description:'No clear directional distance means no paid trade.'},
    DIRECT_MOUNTAIN:{status:'MASTERED',source:'TAUGHT',description:'Direct mountain is entered early with momentum confirmation and never chased late.'}
  },
  lastDecision:null,lastLesson:'Base mountain laws are installed. Classroom evidence can qualify Demo work, but only paid Demo evidence can certify me.',lastAt:0
}}
function mergeBucket(base,raw){return{...base,...(raw||{}),recent:Array.isArray(raw?.recent)?raw.recent.slice(-240):[]}}
function load(){
  try{
    const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||localStorage.getItem('sani.libra.teacher.v1')||'null');
    if(!raw||typeof raw!=='object')return fresh();
    const f=fresh();
    return{...f,...raw,version:2,rules:{...f.rules,...(raw.rules||{})},allowed:mergeBucket(f.allowed,raw.allowed),blocked:mergeBucket(f.blocked,raw.blocked),paid:mergeBucket(f.paid,raw.paid),paidByRegime:raw.paidByRegime&&typeof raw.paidByRegime==='object'?raw.paidByRegime:{}};
  }catch{return fresh()}
}
const state=load();
let latest={mission:{},signals:[],ticks:[],accountType:'NONE'};
let mountain=analyzeMountain([]);
const captured=new Map(),settled=new Set();
let installed=false;

function save(){
  state.allowed.recent=(state.allowed.recent||[]).slice(-240);state.blocked.recent=(state.blocked.recent||[]).slice(-240);state.paid.recent=(state.paid.recent||[]).slice(-240);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}
}
function packetComplete(signal){
  const i=signal?.saniIntent||{};
  const checks=[signal?.sourceApproved,validDirection(signal?.sourceDirection),Boolean(i.familyId||signal?.pattern?.foundationFamily),Number.isFinite(Number(i.edge??signal?.pattern?.foundationEdge)),Boolean(i.structureTag||signal?.structure?.tag)];
  return checks.filter(Boolean).length/checks.length;
}
function recordBucket(target,won,pnl,row){
  target.trades+=1;target.pnl=Number((Number(target.pnl||0)+Number(pnl||0)).toFixed(2));if(won)target.wins+=1;else target.losses+=1;
  target.recent.push({...row,won,pnl,at:Date.now()});target.recent=target.recent.slice(-240);
}
function summary(target){const n=Number(target?.trades||0),wins=Number(target?.wins||0),pnl=Number(target?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0,avg:n?pnl/n:0}}
function recentSummary(rows=[],n=30){const take=(rows||[]).slice(-n),trades=take.length,wins=take.filter(r=>r.won).length,pnl=take.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades,wins,losses:trades-wins,pnl:Number(pnl.toFixed(2)),winRate:trades?wins/trades*100:0}}
function wilsonLower(wins,n,z=1.28){if(!n)return 0;const p=wins/n,z2=z*z,den=1+z2/n;return((p+z2/(2*n))-z*Math.sqrt((p*(1-p)+z2/(4*n))/n))/den}

function classroomStatus(){
  const all=summary(state.allowed),recent=recentSummary(state.allowed.recent,30),lower=wilsonLower(all.wins,all.trades);
  if(all.trades>=80&&lower>BREAK_EVEN&&all.pnl>0)return'MASTERED_CLASSROOM';
  if(all.trades>=30&&all.winRate>=(BREAK_EVEN*100+3)&&all.pnl>0)return'QUALIFIED';
  if(all.trades>=12&&all.pnl>0)return'APPRENTICE';
  if(recent.trades>=20&&recent.winRate<45)return'DEGRADED';
  return'SCHOOL';
}
function paidStatus(){
  const all=summary(state.paid),recent=recentSummary(state.paid.recent,30),lower=wilsonLower(all.wins,all.trades);
  if(all.trades>=80&&all.pnl>0&&lower>BREAK_EVEN)return'CERTIFIED';
  if(all.trades>=30&&all.pnl>0&&all.winRate>=BREAK_EVEN*100+2)return'PAID_QUALIFIED';
  if(all.trades>=12)return'DEMO_PROBATION';
  if(recent.trades>=20&&(recent.winRate<45||recent.pnl<=-5))return'DEGRADED';
  return'NO_PAID_EXAM';
}
function teacherStage(){
  const paid=paidStatus(),classroom=classroomStatus(),context=competencyLedger().SANI_CONTEXT.status;
  if(paid==='CERTIFIED')return'CERTIFIED';
  if(paid==='PAID_QUALIFIED')return'PAID QUALIFIED';
  if(paid==='DEMO_PROBATION')return'DEMO PROBATION';
  if(paid==='DEGRADED')return'RETRAIN';
  if(['QUALIFIED','MASTERED_CLASSROOM'].includes(classroom)&&context!=='SCHOOL')return'QUALIFIED FOR DEMO';
  if(context!=='SCHOOL')return'APPRENTICE';
  return'SCHOOL';
}
function competencyLedger(){
  const allowed=summary(state.allowed),blocked=summary(state.blocked),paid=summary(state.paid),paidRecent=recentSummary(state.paid.recent,30),packetRate=state.setupPackets?state.completePackets/state.setupPackets*100:0;
  return{
    SANI_CONTEXT:{status:state.setupPackets>=25&&packetRate>=90?'MASTERED':state.setupPackets>=10?'APPRENTICE':'SCHOOL',tested:state.setupPackets,score:packetRate,description:'Can I read why SANI proposed the setup, not only CALL/PUT?'},
    MOUNTAIN_DIRECTION:{status:'MASTERED',tested:state.observations,score:100,description:state.rules.MOUNTAIN_SIDE.description},
    REVERSAL_DISCIPLINE:{status:'MASTERED',tested:state.observations,score:100,description:state.rules.REVERSAL_DISCIPLINE.description},
    PULLBACK_END_TIMING:{status:classroomStatus(),tested:allowed.trades,score:allowed.winRate,description:'Shadow classroom result for the entries I taught SANI to take.'},
    WRONG_SIDE_FILTER:{status:'MASTERED',tested:blocked.trades,score:blocked.trades?100-blocked.winRate:100,description:'SANI cannot trade against a locked mountain.'},
    PAID_DEMO_EXAM:{status:paidStatus(),tested:paid.trades,score:paid.winRate,description:'Only actual unique Demo entries can certify the teacher.'},
    EXECUTION:{status:paid.trades>=12?'PROBATION':'WARMING',tested:paid.trades,score:paidRecent.winRate,description:'Shadow marks do not equal paid marks. Actual Deriv entries are the exam.'},
    RETENTION:{status:'MASTERED',tested:state.observations,score:100,description:'Taught rules and empirical lessons persist across missions and reloads.'}
  }
}
function workReady(){const ledger=competencyLedger();return state.observations>=25&&ledger.SANI_CONTEXT.status!=='SCHOOL'}
function unhealthy(){const recent=recentSummary(state.paid.recent,30);return recent.trades>=20&&(recent.winRate<45||recent.pnl<=-5)}

function teacherDecision(signal,m=mountain){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE',sourceApproved=Boolean(signal?.sourceApproved??true);
  if(!sourceApproved||!validDirection(direction))return{allowed:false,action:'SANI QUIET',direction:'NONE',reason:'SANI did not supply a valid setup.'};
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return{allowed:false,action:'WAIT',direction,reason:`No locked directional mountain (${m?.direction||'NONE'}).`};
  if(m.allowedDirection!==direction)return{allowed:false,action:'BLOCK',direction,reason:`Wrong side of the mountain. ${m.direction} is locked, so SANI ${direction} is forbidden.`};
  if(!['PULLBACK_END','EARLY_MOMENTUM'].includes(m.entryMode))return{allowed:false,action:'WAIT',direction,reason:`Correct ${m.direction} side, but ${m.entryMode}. SANI waits for the taught entry moment.`};
  let sniper=null;try{sniper=window.LIBRA_SNIPER?.assessSignal?.(signal,direction)||null}catch{}
  if(sniper&&['LATE','TRASH'].includes(sniper.entryClass))return{allowed:false,action:'WAIT',direction,reason:`Mountain moment is valid, but retained timing memory grades this ${sniper.entryClass} (${sniper.score}).`,sniper};
  return{allowed:true,action:'TAUGHT PASS',direction,reason:`SANI setup is on the ${m.direction} mountain and the moment is ${m.entryMode}.${sniper?` Timing grade ${sniper.entryClass} ${sniper.score}.`:''}`,sniper};
}
function captureSignals(){
  for(const signal of latest.signals||[]){
    if(!signal?.signalId||captured.has(signal.signalId)||settled.has(signal.signalId)||!signal.sourceApproved||!validDirection(signal.sourceDirection))continue;
    const m=structuredClone(mountain),decision=teacherDecision({...signal,direction:signal.sourceDirection},m),completeness=packetComplete(signal);
    state.observations+=1;state.setupPackets+=1;if(completeness>=.8)state.completePackets+=1;
    captured.set(signal.signalId,{signalId:signal.signalId,signalAt:Number(signal.createdAt||Date.now()),signalEpoch:Number(signal.signalEpoch||0),signalQuote:Number(signal.signalQuote||0),regime:signal.libra?.regime||'UNKNOWN',direction:signal.sourceDirection,mountain:m,decision,completeness});
  }
}
function learnSettled(){
  for(const signal of latest.signals||[]){
    if(!signal?.shadowSettled||!signal.signalId||settled.has(signal.signalId)||!signal.sourceApproved||!validDirection(signal.sourceDirection))continue;
    const lesson=captured.get(signal.signalId)||{signalId:signal.signalId,signalAt:Number(signal.createdAt||Date.now()),signalEpoch:Number(signal.signalEpoch||0),signalQuote:Number(signal.signalQuote||0),regime:signal.libra?.regime||'UNKNOWN',direction:signal.sourceDirection,mountain:structuredClone(mountain),decision:teacherDecision({...signal,direction:signal.sourceDirection},mountain),completeness:packetComplete(signal)};
    const result=signal.shadowResult?.sani;if(!result||!['WON','LOST'].includes(result.outcome)){settled.add(signal.signalId);continue}
    const won=result.outcome==='WON',pnl=Number(result.profit??(won?PAYOUT:-1));
    const row={signalId:signal.signalId,signalAt:lesson.signalAt,signalEpoch:lesson.signalEpoch,signalQuote:lesson.signalQuote,regime:lesson.regime,direction:lesson.direction,mountainDirection:lesson.mountain?.direction||'NONE',entryMode:lesson.mountain?.entryMode||'NO_TRADE',reason:lesson.decision.reason};
    if(lesson.decision.allowed)recordBucket(state.allowed,won,pnl,row);else recordBucket(state.blocked,won,pnl,row);
    const a=summary(state.allowed),b=summary(state.blocked),status=classroomStatus();
    state.lastLesson=lesson.decision.allowed?`CLASSROOM: I taught SANI to TAKE ${lesson.direction} in ${lesson.mountain?.direction} ${lesson.mountain?.entryMode}. It ${won?'WON':'LOST'}. Shadow taught-entry skill is ${status}: ${a.trades} cases, ${a.winRate.toFixed(1)}%, ${money(a.pnl)}.`:`CLASSROOM: I taught SANI to ${lesson.decision.action} ${lesson.direction}. The skipped setup ${won?'would have won':'would have lost'}. Rejected set: ${b.trades} cases, ${b.winRate.toFixed(1)}%, ${money(b.pnl)}.`;
    state.lastAt=Date.now();settled.add(signal.signalId);captured.delete(signal.signalId);save();
  }
}

function recordPaid(payload={}){
  if(!payload.signalId||!['WON','LOST'].includes(payload.outcome))return snapshot();
  if((state.paid.recent||[]).some(r=>r.signalId===payload.signalId))return snapshot();
  const won=payload.outcome==='WON',pnl=Number(payload.profit||0),row={signalId:payload.signalId,signalAt:Number(payload.signalAt||Date.now()),signalEpoch:Number(payload.signalEpoch||0),signalQuote:Number(payload.signalQuote||0),entryEpoch:Number(payload.entryEpoch||0),entrySpot:Number(payload.entrySpot||0),exitEpoch:Number(payload.exitEpoch||0),exitSpot:Number(payload.exitSpot||0),buyAckMs:Number(payload.buyAckMs||0),signalToEntryTicks:Number(payload.signalToEntryTicks||0),regime:payload.regime||'UNKNOWN',direction:payload.direction||'NONE',mountainDirection:payload.mountainDirection||'NONE',entryMode:payload.entryMode||'NO_TRADE'};
  recordBucket(state.paid,won,pnl,row);
  const regime=String(row.regime||'UNKNOWN');state.paidByRegime[regime] ||= bucket();recordBucket(state.paidByRegime[regime],won,pnl,row);
  const p=summary(state.paid),status=paidStatus();
  state.lastLesson=`PAID EXAM: SANI ${row.direction} ${won?'WON':'LOST'} ${money(pnl)}. Actual Demo exam is ${status}: ${p.trades} unique entries, ${p.winRate.toFixed(1)}%, ${money(p.pnl)}. Shadow marks do not certify me.`;state.lastAt=Date.now();save();
  window.dispatchEvent(new CustomEvent('libra-teacher-paid',{detail:{...row,won,pnl,status,summary:p}}));
  return snapshot();
}
function missionSnapshot(startedAt=0){
  const summarizeRows=rows=>{const trades=rows.length,wins=rows.filter(r=>r.won).length,pnl=rows.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades,wins,losses:trades-wins,pnl:Number(pnl.toFixed(2)),winRate:trades?wins/trades*100:0}};
  const allowedRows=(state.allowed.recent||[]).filter(r=>Number(r.signalAt||0)>=Number(startedAt||0)),blockedRows=(state.blocked.recent||[]).filter(r=>Number(r.signalAt||0)>=Number(startedAt||0)),paidRows=(state.paid.recent||[]).filter(r=>Number(r.signalAt||0)>=Number(startedAt||0));
  return{stage:teacherStage(),workReady:workReady(),unhealthy:unhealthy(),allowed:summarizeRows(allowedRows),blocked:summarizeRows(blockedRows),paid:summarizeRows(paidRows),ledger:competencyLedger(),lastLesson:state.lastLesson};
}
function snapshot(){const byRegime={};for(const[k,v]of Object.entries(state.paidByRegime||{}))byRegime[k]=summary(v);return{version:'Libra Teacher v2 · Paid Exam',stage:teacherStage(),workReady:workReady(),unhealthy:unhealthy(),observations:state.observations,allowed:summary(state.allowed),blocked:summary(state.blocked),paid:summary(state.paid),paidByRegime:byRegime,ledger:competencyLedger(),lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain:structuredClone(mountain)}}

function findSignal(id){const cached=(latest.signals||[]).find(r=>r.signalId===id);if(cached)return cached;try{const live=window.LIBRA?.getSignals?.();return Array.isArray(live)?live.find(r=>r.signalId===id)||null:null}catch{return null}}
export function installTeacherExecution(){
  if(installed)return;installed=true;
  SaniEngine.prototype.execute=function(signal){
    const mission=latest.mission||{},signalId=signal?.patternMeta?.signalId;if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return baseExecute.call(this,signal);
    const row=findSignal(signalId),direction=signal?.direction||row?.sourceDirection||signal?.patternMeta?.sourceDirection;if(!row||!row.sourceApproved||direction!==row.sourceDirection)return false;
    const decision=teacherDecision({...row,direction},mountain);state.lastDecision={...decision,signalId,at:Date.now(),mountain:structuredClone(mountain)};save();window.dispatchEvent(new CustomEvent('libra-teacher-decision',{detail:state.lastDecision}));if(!decision.allowed)return false;return baseExecute.call(this,signal);
  };
}
function injectUi(){
  const stats=document.querySelector('.libraBrainStats');
  if(stats&&!document.getElementById('libraTeacherStage'))stats.insertAdjacentHTML('beforeend',`<div><small>LIBRA DEGREE</small><strong id="libraTeacherStage">SCHOOL</strong></div><div><small>SANI EDUCATION</small><strong id="libraSaniEducation">BASE RULES LOADED</strong></div><div><small>CLASSROOM KPI</small><strong id="libraTaughtKpi">LEARNING</strong></div><div><small>PAID DEMO EXAM</small><strong id="libraPaidExam">NO PAID EXAM</strong></div><div><small>LAST TAUGHT RULE</small><strong id="libraTaughtRule">—</strong></div>`);
  const s=snapshot(),set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};
  set('libraTeacherStage',s.stage);set('libraSaniEducation','MOUNTAIN LAW · REVERSAL · CHOP · EARLY ENTRY');set('libraTaughtKpi',s.allowed.trades?`${s.allowed.trades}T · ${s.allowed.winRate.toFixed(1)}% · ${money(s.allowed.pnl)}`:'LEARNING');set('libraPaidExam',s.paid.trades?`${s.paid.trades}T · ${s.paid.winRate.toFixed(1)}% · ${money(s.paid.pnl)}`:'NO PAID EXAM');set('libraTaughtRule',s.lastDecision?`${s.lastDecision.action} ${s.lastDecision.direction}`:'BASE RULES ACTIVE');
}
window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);captureSignals();learnSettled();injectUi();window.dispatchEvent(new CustomEvent('libra-teacher-state',{detail:snapshot()}))});
window.addEventListener('libra-teacher-decision',injectUi);window.addEventListener('libra-teacher-paid',injectUi);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',injectUi,{once:true});else injectUi();setInterval(injectUi,1000);

window.LIBRA_TEACHER={snapshot,missionSnapshot,decisionFor:(signal)=>teacherDecision(signal,mountain),recordPaid,workReady,reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
