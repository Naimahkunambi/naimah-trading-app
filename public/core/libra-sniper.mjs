import { SaniEngine } from './engine.mjs';

const STORAGE_KEY = 'sani.libra.sniper.v1';
const PAYOUT = 0.92;
const BREAK_EVEN = 1 / (1 + PAYOUT);
const clamp = (value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
const validDirection = value => ['CALL','PUT'].includes(value);
const dirSign = direction => direction === 'CALL' ? 1 : direction === 'PUT' ? -1 : 0;
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;

function load(){
  try{
    const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
    if(raw&&typeof raw==='object')return {
      version:2,
      threshold:Number(raw.threshold)||82,
      learned:Number(raw.learned)||0,
      wins:Number(raw.wins)||0,
      losses:Number(raw.losses)||0,
      states:raw.states&&typeof raw.states==='object'?raw.states:{},
      families:raw.families&&typeof raw.families==='object'?raw.families:{},
      buckets:raw.buckets&&typeof raw.buckets==='object'?raw.buckets:{},
      recent:Array.isArray(raw.recent)?raw.recent.slice(-240):[],
      lastLesson:raw.lastLesson||'I am learning which exact entry moments deserve money.',
      lastAssessment:raw.lastAssessment||null,
      lastAt:Number(raw.lastAt)||0
    };
  }catch{}
  return {version:2,threshold:82,learned:0,wins:0,losses:0,states:{},families:{},buckets:{},recent:[],lastLesson:'I am learning which exact entry moments deserve money.',lastAssessment:null,lastAt:0};
}

const state=load();
const seen=new Set();
let latest={mission:{},signals:[],brain:{},prediction:{}};
let patched=false;

function save(){
  const trim=(obj,limit)=>Object.fromEntries(Object.entries(obj).sort((a,b)=>Number(b[1]?.lastAt||0)-Number(a[1]?.lastAt||0)).slice(0,limit));
  state.states=trim(state.states,1800);
  state.families=trim(state.families,300);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}
}

function featuresOf(signal){
  const f=Array.isArray(signal?.libra?.features)?signal.libra.features.map(Number):[];
  return {
    slope3:f[0]||0,slope5:f[1]||0,slope8:f[2]||0,slope13:f[3]||0,slope21:f[4]||0,slope34:f[5]||0,
    acceleration:f[6]||0,curvature:f[7]||0,efficiency8:clamp(f[8]||0,0,1),efficiency21:clamp(f[9]||0,0,1),
    pressure8:f[10]||0,pressure21:f[11]||0,volatility:f[12]||0,reversal:clamp(f[13]||0,0,1)
  };
}

function familyOf(signal){
  return String(signal?.pattern?.foundationFamily||signal?.pattern?.familyId||signal?.structure?.tag||'UNKNOWN');
}
function fingerprint(signal,direction){
  return `${signal?.libra?.signature||signal?.libra?.regime||'UNKNOWN'}|${familyOf(signal)}|${direction}`;
}
function familyKey(signal,direction){return `${familyOf(signal)}|${direction}`}

function technicalScore(signal,direction){
  if(!validDirection(direction))return 0;
  const d=dirSign(direction),f=featuresOf(signal),regime=String(signal?.libra?.regime||'UNKNOWN');
  const slope=d*(.24*f.slope3+.23*f.slope5+.19*f.slope8+.14*f.slope13+.12*f.slope21+.08*f.slope34);
  const pressure=d*(.58*f.pressure8+.42*f.pressure21);
  const impulse=d*(.62*f.acceleration+.38*f.curvature);
  const long=d*(.55*f.slope21+.45*f.slope34);
  const short=d*(.58*f.slope3+.42*f.slope5);
  const efficiency=.42*f.efficiency8+.58*f.efficiency21;
  const volatilitySweet=1-Math.min(1,Math.abs(f.volatility-.10)/1.25);
  const freshTurn=short>0&&impulse>0&&Math.abs(long)<.22 ? 1 : 0;
  const established=short>0&&long>0 ? 1 : 0;
  const late=long>.12&&short>0&&impulse<-.05 ? 1 : 0;
  const fighting=short<-.05 ? 1 : 0;
  const exhausted=(regime==='UP EXHAUSTION'&&direction==='CALL')||(regime==='DOWN EXHAUSTION'&&direction==='PUT');
  const transitionFit=(regime==='TRANSITION UP'&&direction==='CALL')||(regime==='TRANSITION DOWN'&&direction==='PUT');
  const driveFit=(regime==='DRIVE UP'&&direction==='CALL')||(regime==='DRIVE DOWN'&&direction==='PUT');
  const chop=regime==='CHOP';

  let score=50;
  score+=21*clamp(slope,-1,1);
  score+=12*clamp(pressure,-1,1);
  score+=11*clamp(impulse,-1,1);
  score+=8*((efficiency-.5)*2);
  score+=4*((volatilitySweet-.5)*2);
  if(freshTurn)score+=8;
  if(established)score+=4;
  if(transitionFit)score+=8;
  if(driveFit)score+=5;
  if(late)score-=15;
  if(fighting)score-=16;
  if(exhausted)score-=18;
  if(chop)score-=14;
  if(f.reversal>.35&&long>0)score-=8*f.reversal;
  return clamp(score,0,100);
}

function rowStats(row){
  const n=Number(row?.attempts||0),wins=Number(row?.wins||0),pnl=Number(row?.pnl||0);
  return {n,wins,pnl,winRate:n?wins/n:0,avg:n?pnl/n:0,repeatLosses:Number(row?.repeatLosses||0)};
}

function memoryAdjustment(signal,direction){
  const exact=rowStats(state.states[fingerprint(signal,direction)]);
  const family=rowStats(state.families[familyKey(signal,direction)]);
  let adjust=0;
  if(exact.n){
    const smoothed=(exact.wins+2)/(exact.n+4);
    adjust+=clamp((smoothed-BREAK_EVEN)*52,-15,15)*clamp(exact.n/8,.25,1);
    adjust-=Math.min(16,exact.repeatLosses*4);
  }
  if(family.n>=4){
    const smoothed=(family.wins+3)/(family.n+6);
    adjust+=clamp((smoothed-BREAK_EVEN)*28,-9,9)*clamp(family.n/20,.25,1);
  }
  return {adjust,exact,family};
}

function classify(score,threshold=state.threshold){
  if(score>=threshold)return'SNIPER';
  if(score>=threshold-10)return'GOOD';
  if(score>=threshold-22)return'LATE';
  return'TRASH';
}

function assess(signal,direction){
  const raw=technicalScore(signal,direction);
  const memory=memoryAdjustment(signal,direction);
  const score=clamp(raw+memory.adjust,0,100);
  const entryClass=classify(score);
  const reason=[];
  if(memory.exact.n)reason.push(`${memory.exact.n} exact twins ${Math.round(memory.exact.winRate*100)}%`);
  if(memory.exact.repeatLosses>=2)reason.push(`${memory.exact.repeatLosses} repeated losses`);
  if(memory.family.n>=6)reason.push(`${memory.family.n} family cases ${Math.round(memory.family.winRate*100)}%`);
  if(!reason.length)reason.push('new fingerprint');
  return {score:Number(score.toFixed(1)),rawScore:Number(raw.toFixed(1)),entryClass,threshold:state.threshold,direction,reason:reason.join(' · '),fingerprint:fingerprint(signal,direction),family:familyOf(signal)};
}

function updateRow(container,key,won,pnl){
  const row=container[key]||{attempts:0,wins:0,losses:0,pnl:0,repeatLosses:0,lastAt:0};
  row.attempts+=1;
  row.pnl+=pnl;
  if(won){row.wins+=1;row.repeatLosses=0}else{row.losses+=1;row.repeatLosses+=1}
  row.lastAt=Date.now();
  container[key]=row;
  return row;
}

function bucketKey(score){return String(Math.max(0,Math.min(100,Math.floor(score/5)*5)))}
function recalcThreshold(){
  if(state.learned<40)return;
  let chosen=null;
  for(let threshold=60;threshold<=95;threshold+=5){
    let attempts=0,wins=0,pnl=0;
    for(const [bucket,row] of Object.entries(state.buckets)){
      if(Number(bucket)<threshold)continue;
      attempts+=Number(row.attempts||0);wins+=Number(row.wins||0);pnl+=Number(row.pnl||0);
    }
    if(attempts<18)continue;
    const winRate=wins/attempts,avg=pnl/attempts;
    if(winRate>=BREAK_EVEN+.025&&avg>=.025){chosen=threshold;break}
  }
  if(chosen!=null)state.threshold=clamp(chosen,60,95);
  else if(state.learned>=80)state.threshold=clamp(state.threshold+1,70,95);
}

function learnEntry(signal,direction,result,role){
  if(!validDirection(direction)||!result||!['WON','LOST'].includes(result.outcome))return;
  const assessment=assess(signal,direction);
  const won=result.outcome==='WON',pnl=Number(result.profit??(won?PAYOUT:-1));
  const exact=updateRow(state.states,assessment.fingerprint,won,pnl);
  updateRow(state.families,familyKey(signal,direction),won,pnl);
  const bucket=state.buckets[bucketKey(assessment.rawScore)]||{attempts:0,wins:0,losses:0,pnl:0,lastAt:0};
  bucket.attempts+=1;bucket.pnl+=pnl;if(won)bucket.wins+=1;else bucket.losses+=1;bucket.lastAt=Date.now();state.buckets[bucketKey(assessment.rawScore)]=bucket;
  state.learned+=1;if(won)state.wins+=1;else state.losses+=1;
  state.recent.push({at:Date.now(),score:assessment.score,rawScore:assessment.rawScore,entryClass:assessment.entryClass,won,pnl,role,direction,regime:signal?.libra?.regime||'UNKNOWN',family:assessment.family});
  state.recent=state.recent.slice(-240);
  const repeat=Number(exact.repeatLosses||0);
  state.lastLesson=won
    ? `${role} ${direction} scored ${assessment.score} ${assessment.entryClass} and WON. I strengthened this exact entry fingerprint.`
    : `${role} ${direction} scored ${assessment.score} ${assessment.entryClass} and LOST.${repeat>=2?` Same fingerprint has now failed ${repeat} times in a row, so I am suppressing it harder.`:''}`;
  state.lastAt=Date.now();
  recalcThreshold();save();
}

function processSettled(detail){
  latest=detail||latest;
  for(const signal of latest.signals||[]){
    if(!signal?.shadowSettled||!signal.signalId||seen.has(signal.signalId))continue;
    const saniResult=signal.shadowResult?.sani;
    if(signal.sourceApproved&&validDirection(signal.sourceDirection)&&saniResult)learnEntry(signal,signal.sourceDirection,saniResult,'SANI');
    const libraDirection=signal.shadowLibra?.direction;
    const libraResult=signal.shadowResult?.libra;
    if(validDirection(libraDirection)&&libraResult&&(!signal.sourceApproved||libraDirection!==signal.sourceDirection))learnEntry(signal,libraDirection,libraResult,'LIBRA');
    seen.add(signal.signalId);
  }
}

function snapshot(){
  const total=state.wins+state.losses;
  const sniper=state.recent.filter(row=>row.entryClass==='SNIPER');
  const sniperWins=sniper.filter(row=>row.won).length;
  const sniperPnl=sniper.reduce((sum,row)=>sum+Number(row.pnl||0),0);
  return {
    version:'Libra Sniper v1',threshold:state.threshold,learned:state.learned,states:Object.keys(state.states).length,
    winRate:total?state.wins/total*100:0,sniperTrades:sniper.length,sniperWinRate:sniper.length?sniperWins/sniper.length*100:0,
    sniperPnl,lastLesson:state.lastLesson,lastAssessment:state.lastAssessment,breakEven:BREAK_EVEN*100
  };
}

function findSignal(id){return (latest.signals||[]).find(row=>row.signalId===id)||null}
function guardExecute(original,ctx,signal){
  const mission=latest.mission||{};
  const signalId=signal?.patternMeta?.signalId;
  if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return original.call(ctx,signal);
  const row=findSignal(signalId);
  const direction=signal?.direction||signal?.patternMeta?.libraDirection||row?.tradeDirection||row?.sourceDirection;
  if(!row||!validDirection(direction))return original.call(ctx,signal);
  const assessment=assess(row,direction);
  state.lastAssessment={...assessment,signalId,at:Date.now()};save();
  window.dispatchEvent(new CustomEvent('libra-sniper-assessment',{detail:{...assessment,signalId}}));
  if(assessment.entryClass!=='SNIPER'){
    window.dispatchEvent(new CustomEvent('libra-sniper-block',{detail:{...assessment,signalId}}));
    return false;
  }
  return original.call(ctx,signal);
}

function patchExecution(){
  if(patched)return;
  const original=SaniEngine.prototype.execute;
  if(typeof original!=='function')return;
  SaniEngine.prototype.execute=function(signal){return guardExecute(original,this,signal)};
  patched=true;
}

function injectUi(){
  const stats=document.querySelector('.libraBrainStats');
  if(stats&&!document.getElementById('libraSniperThreshold')){
    stats.insertAdjacentHTML('beforeend',`
      <div><small>ENTRY GATE</small><strong id="libraEntryGate">SNIPER ONLY</strong></div>
      <div><small>SNIPER THRESHOLD</small><strong id="libraSniperThreshold">82</strong></div>
      <div><small>ENTRY MEMORY</small><strong id="libraEntryMemory">0</strong></div>
      <div><small>SNIPER WIN RATE</small><strong id="libraSniperRate">0.0%</strong></div>
      <div><small>LAST ENTRY READ</small><strong id="libraLastEntryRead">—</strong></div>`);
  }
  const s=snapshot();
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
  set('libraSniperThreshold',`${s.threshold}/100`);
  set('libraEntryMemory',`${s.learned} lessons · ${s.states} states`);
  set('libraSniperRate',s.sniperTrades?`${s.sniperWinRate.toFixed(1)}% · ${money(s.sniperPnl)}`:'LEARNING');
  const a=s.lastAssessment;set('libraLastEntryRead',a?`${a.score} ${a.entryClass} ${a.direction}`:'—');
}

window.addEventListener('libra-state',event=>{processSettled(event.detail||{});injectUi()});
window.addEventListener('libra-sniper-assessment',injectUi);
patchExecution();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{injectUi();patchExecution()},{once:true});else{injectUi();patchExecution()}
setInterval(injectUi,1000);

window.LIBRA_SNIPER={snapshot,assessSignal:(signal,direction)=>assess(signal,direction),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
