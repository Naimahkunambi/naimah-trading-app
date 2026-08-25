import { SaniEngine } from './engine.mjs';

const STORAGE_KEY = 'sani.libra.sniper.v1';
const PAYOUT = 0.92;
const BREAK_EVEN = 1 / (1 + PAYOUT);
const clamp = (value,min,max)=>Math.max(min,Math.min(max,Number(value)||0));
const validDirection = value => ['CALL','PUT'].includes(value);
const dirSign = direction => direction === 'CALL' ? 1 : direction === 'PUT' ? -1 : 0;
const money = value => `${Number(value||0)>=0?'+':'-'}$${Math.abs(Number(value||0)).toFixed(2)}`;
const finite = value => Number.isFinite(Number(value));

function load(){
  try{
    const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');
    if(raw&&typeof raw==='object')return {
      version:3,
      threshold:Number(raw.threshold)||82,
      learned:Number(raw.learned)||0,
      wins:Number(raw.wins)||0,
      losses:Number(raw.losses)||0,
      states:raw.states&&typeof raw.states==='object'?raw.states:{},
      families:raw.families&&typeof raw.families==='object'?raw.families:{},
      buckets:raw.buckets&&typeof raw.buckets==='object'?raw.buckets:{},
      recent:Array.isArray(raw.recent)?raw.recent.slice(-600):[],
      lastLesson:raw.lastLesson||'I am learning which exact SANI entry moments deserve money.',
      lastAssessment:raw.lastAssessment||null,
      lastAt:Number(raw.lastAt)||0
    };
  }catch{}
  return {version:3,threshold:82,learned:0,wins:0,losses:0,states:{},families:{},buckets:{},recent:[],lastLesson:'I am learning which exact SANI entry moments deserve money.',lastAssessment:null,lastAt:0};
}

const state=load();
const seen=new Set();
let latest={mission:{},signals:[],brain:{},prediction:{}};
let patched=false;
let preArmed={epoch:0,quote:0,regime:'BOOTING',features:[],signature:'BOOTING',computedAt:0};

function save(){
  const trim=(obj,limit)=>Object.fromEntries(Object.entries(obj).sort((a,b)=>Number(b[1]?.lastAt||0)-Number(a[1]?.lastAt||0)).slice(0,limit));
  state.states=trim(state.states,1800);
  state.families=trim(state.families,400);
  state.recent=state.recent.slice(-600);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}
}

function armFromSnapshot(detail={}){
  const p=detail.prediction||{};
  if(!finite(p.epoch)||!Array.isArray(p.features))return;
  if(Number(p.epoch)<Number(preArmed.epoch||0))return;
  preArmed={
    epoch:Number(p.epoch),quote:Number(p.quote),regime:String(p.regime||'UNKNOWN'),
    features:p.features.map(Number),signature:String(p.signature||p.regime||'UNKNOWN'),
    direction:String(p.direction||'NONE'),probabilityUp:Number(p.probabilityUp||.5),
    confidence:Number(p.confidence||0),bestHorizon:Number(p.bestHorizon||1),computedAt:performance?.now?.()??Date.now()
  };
}

function featuresOf(signal){
  const source=Array.isArray(signal?.libra?.preArmedFeatures)?signal.libra.preArmedFeatures:signal?.libra?.features;
  const f=Array.isArray(source)?source.map(Number):[];
  return {
    slope3:f[0]||0,slope5:f[1]||0,slope8:f[2]||0,slope13:f[3]||0,slope21:f[4]||0,slope34:f[5]||0,
    acceleration:f[6]||0,curvature:f[7]||0,efficiency8:clamp(f[8]||0,0,1),efficiency21:clamp(f[9]||0,0,1),
    pressure8:f[10]||0,pressure21:f[11]||0,volatility:f[12]||0,reversal:clamp(f[13]||0,0,1)
  };
}

function familyOf(signal){
  return String(signal?.saniIntent?.familyId||signal?.pattern?.foundationFamily||signal?.pattern?.familyId||signal?.structure?.tag||'UNKNOWN');
}
function fingerprint(signal,direction){
  const intent=signal?.saniIntent||{};
  const structure=`${intent.structureTag||signal?.structure?.tag||'MIXED'}:${intent.phase||signal?.structure?.phase||'MID'}`;
  return `${signal?.libra?.preArmedSignature||signal?.libra?.signature||signal?.libra?.regime||'UNKNOWN'}|${familyOf(signal)}|${structure}|${direction}`;
}
function familyKey(signal,direction){return `${familyOf(signal)}|${direction}`}

function saniContext(signal,direction){
  const intent=signal?.saniIntent||{};
  const pattern=signal?.pattern||{};
  const sniper=signal?.sniper||{};
  const structure=signal?.structure||{};
  const expected=direction==='CALL'?'UP':'DOWN';
  const patternDirection=String(intent.patternDirection||pattern?.baseline?.direction||pattern?.direction||'EVEN');
  const edge=Number(intent.edge??pattern?.foundationEdge??pattern?.baseline?.edge??pattern?.edge??50);
  const avgSimilarity=Number(intent.avgSimilarity??pattern?.avgSimilarity??84);
  const matches=Number(intent.matchCount??pattern?.matchCount??0);
  const topAgree=Number(intent.top10Agree??pattern?.top10Agree??0);
  const topTotal=Number(intent.top10Total??pattern?.top10Total??10);
  const sameTag=Number(intent.sameTagCount??pattern?.sameTagCount??0);
  const samePhase=Number(intent.samePhaseCount??pattern?.samePhaseCount??0);
  const repeatCount=Number(intent.repeatCount??sniper?.repeatCount??1);
  const saniScore=Number(intent.sniperScore??sniper?.score??0);
  const familyRate=Number(intent.familyRate??sniper?.familyMemory?.rate??.5);
  const familyN=Number(intent.familySamples??sniper?.familyMemory?.total??0);
  const addressRate=Number(intent.addressRate??sniper?.addressMemory?.rate??.5);
  const addressN=Number(intent.addressSamples??sniper?.addressMemory?.total??0);
  const phase=String(intent.phase||structure?.phase||'MID');
  const tag=String(intent.structureTag||structure?.tag||'MIXED');
  const aligned=patternDirection===expected;
  const historicalAgreement=topTotal>0?topAgree/topTotal:.5;
  return {intent,patternDirection,edge,avgSimilarity,matches,topAgree,topTotal,sameTag,samePhase,repeatCount,saniScore,familyRate,familyN,addressRate,addressN,phase,tag,aligned,historicalAgreement};
}

function technicalScore(signal,direction){
  if(!validDirection(direction))return {score:0,parts:{}};
  const d=dirSign(direction),f=featuresOf(signal),regime=String(signal?.libra?.preArmedRegime||signal?.libra?.regime||'UNKNOWN');
  const s=saniContext(signal,direction);
  const slope=d*(.24*f.slope3+.23*f.slope5+.19*f.slope8+.14*f.slope13+.12*f.slope21+.08*f.slope34);
  const pressure=d*(.58*f.pressure8+.42*f.pressure21);
  const impulse=d*(.62*f.acceleration+.38*f.curvature);
  const long=d*(.55*f.slope21+.45*f.slope34);
  const short=d*(.58*f.slope3+.42*f.slope5);
  const efficiency=.42*f.efficiency8+.58*f.efficiency21;
  const volatilitySweet=1-Math.min(1,Math.abs(f.volatility-.10)/1.25);
  const freshTurn=short>0&&impulse>0&&Math.abs(long)<.22;
  const established=short>0&&long>0;
  const late=long>.12&&short>0&&impulse<-.05;
  const fighting=short<-.05;
  const exhausted=(regime==='UP EXHAUSTION'&&direction==='CALL')||(regime==='DOWN EXHAUSTION'&&direction==='PUT');
  const transitionFit=(regime==='TRANSITION UP'&&direction==='CALL')||(regime==='TRANSITION DOWN'&&direction==='PUT');
  const driveFit=(regime==='DRIVE UP'&&direction==='CALL')||(regime==='DRIVE DOWN'&&direction==='PUT');
  const chop=regime==='CHOP';
  const locationFresh=(direction==='CALL'&&['LOW_ZONE','NEAR_LOW'].includes(s.phase))||(direction==='PUT'&&['HIGH_ZONE','NEAR_HIGH'].includes(s.phase));
  const locationLate=(direction==='CALL'&&['HIGH_ZONE','NEAR_HIGH'].includes(s.phase))||(direction==='PUT'&&['LOW_ZONE','NEAR_LOW'].includes(s.phase));

  const physics=21*clamp(slope,-1,1)+12*clamp(pressure,-1,1)+11*clamp(impulse,-1,1)+8*((efficiency-.5)*2)+4*((volatilitySweet-.5)*2);
  let timing=0;
  if(freshTurn)timing+=8;
  if(established)timing+=4;
  if(transitionFit)timing+=8;
  if(driveFit)timing+=5;
  if(locationFresh&&impulse>=0)timing+=5;
  if(late)timing-=15;
  if(fighting)timing-=16;
  if(exhausted)timing-=18;
  if(chop)timing-=14;
  if(locationLate&&impulse<.02)timing-=6;
  if(f.reversal>.35&&long>0)timing-=8*f.reversal;

  let setup=0;
  if(s.aligned)setup+=clamp((s.edge-50)/50,-1,1)*10;
  else setup-=10;
  setup+=clamp((s.avgSimilarity-82)/18,-1,1)*4;
  setup+=clamp((s.historicalAgreement-.5)*2,-1,1)*7;
  setup+=Math.min(3,s.sameTag*.15)+Math.min(2,s.samePhase*.10);
  if(s.repeatCount>=2)setup+=Math.min(4,1.5+s.repeatCount*.6);
  if(s.familyN>=6)setup+=clamp((s.familyRate-BREAK_EVEN)*24,-5,5);
  if(s.addressN>=5)setup+=clamp((s.addressRate-BREAK_EVEN)*20,-4,4);
  setup+=clamp(s.saniScore/20,-1,1)*3;

  const score=clamp(50+physics+timing+setup,0,100);
  return {score,parts:{physics:Number(physics.toFixed(2)),timing:Number(timing.toFixed(2)),setup:Number(setup.toFixed(2)),slope,pressure,impulse,efficiency,regime,phase:s.phase,aligned:s.aligned,edge:s.edge,avgSimilarity:s.avgSimilarity,historicalAgreement:s.historicalAgreement,repeatCount:s.repeatCount}};
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
    adjust-=Math.min(20,exact.repeatLosses*5);
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
  const started=performance?.now?.()??Date.now();
  const technical=technicalScore(signal,direction);
  const memory=memoryAdjustment(signal,direction);
  const score=clamp(technical.score+memory.adjust,0,100);
  const entryClass=classify(score);
  const reason=[];
  const parts=technical.parts||{};
  reason.push(`setup ${parts.setup>=0?'+':''}${Number(parts.setup||0).toFixed(1)}`);
  reason.push(`timing ${parts.timing>=0?'+':''}${Number(parts.timing||0).toFixed(1)}`);
  if(memory.exact.n)reason.push(`${memory.exact.n} exact twins ${Math.round(memory.exact.winRate*100)}%`);
  if(memory.exact.repeatLosses>=2)reason.push(`${memory.exact.repeatLosses} repeated losses`);
  if(memory.family.n>=6)reason.push(`${memory.family.n} family cases ${Math.round(memory.family.winRate*100)}%`);
  const judgeMs=Math.max(0,(performance?.now?.()??Date.now())-started);
  return {score:Number(score.toFixed(1)),rawScore:Number(technical.score.toFixed(1)),entryClass,threshold:state.threshold,direction,reason:reason.join(' · '),fingerprint:fingerprint(signal,direction),family:familyOf(signal),parts,judgeMs};
}

function updateRow(container,key,won,pnl){
  const row=container[key]||{attempts:0,wins:0,losses:0,pnl:0,repeatLosses:0,lastAt:0};
  row.attempts+=1;row.pnl+=pnl;
  if(won){row.wins+=1;row.repeatLosses=0}else{row.losses+=1;row.repeatLosses+=1}
  row.lastAt=Date.now();container[key]=row;return row;
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
  state.recent.push({at:Date.now(),signalAt:Number(signal?.createdAt||Date.now()),score:assessment.score,rawScore:assessment.rawScore,entryClass:assessment.entryClass,won,pnl,role,direction,regime:signal?.libra?.preArmedRegime||signal?.libra?.regime||'UNKNOWN',family:assessment.family,parts:assessment.parts});
  state.recent=state.recent.slice(-600);
  const repeat=Number(exact.repeatLosses||0);
  state.lastLesson=won
    ? `${role} ${direction} scored ${assessment.score} ${assessment.entryClass} and WON. I strengthened this exact setup+moment fingerprint.`
    : `${role} ${direction} scored ${assessment.score} ${assessment.entryClass} and LOST.${repeat>=2?` This exact setup+moment has now failed ${repeat} times in a row, so I am suppressing it harder.`:''}`;
  state.lastAt=Date.now();recalcThreshold();save();
}

function processSettled(detail){
  latest=detail||latest;armFromSnapshot(latest);
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

function summarizeRows(rows=[]){
  const trades=rows.length,wins=rows.filter(row=>row.won).length,pnl=rows.reduce((sum,row)=>sum+Number(row.pnl||0),0);
  return {trades,wins,losses:trades-wins,pnl:Number(pnl.toFixed(2)),winRate:trades?wins/trades*100:0,avg:trades?pnl/trades:0};
}
function missionSnapshot(startedAt=0){
  const rows=state.recent.filter(row=>row.role==='SANI'&&row.signalAt>=Number(startedAt||0));
  const sniper=summarizeRows(rows.filter(row=>row.entryClass==='SNIPER'));
  const goodPlus=summarizeRows(rows.filter(row=>['SNIPER','GOOD'].includes(row.entryClass)));
  const rejected=summarizeRows(rows.filter(row=>['LATE','TRASH'].includes(row.entryClass)));
  return {startedAt:Number(startedAt||0),all:summarizeRows(rows),sniper,goodPlus,rejected,threshold:state.threshold,breakEven:BREAK_EVEN*100};
}
function snapshot(){
  const total=state.wins+state.losses;
  const sniperRows=state.recent.filter(row=>row.role==='SANI'&&row.entryClass==='SNIPER');
  const sniper=summarizeRows(sniperRows);
  return {
    version:'Libra Sniper v2 · SANI setup / Libra moment',threshold:state.threshold,learned:state.learned,states:Object.keys(state.states).length,
    winRate:total?state.wins/total*100:0,sniperTrades:sniper.trades,sniperWinRate:sniper.winRate,sniperPnl:sniper.pnl,
    lastLesson:state.lastLesson,lastAssessment:state.lastAssessment,breakEven:BREAK_EVEN*100,preArmed:{...preArmed}
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

  // Paid Libra is now an entry specialist: SANI must supply the setup and direction.
  if(!row.sourceApproved||direction!==row.sourceDirection){
    const blocked={score:0,entryClass:'TRASH',direction,reason:'No matching SANI setup. Libra does not invent paid entries in sniper mode.',signalId,judgeMs:0};
    state.lastAssessment={...blocked,at:Date.now()};save();
    window.dispatchEvent(new CustomEvent('libra-sniper-block',{detail:blocked}));
    return false;
  }

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
      <div><small>ENTRY JOB</small><strong id="libraEntryGate">SANI SETUP → LIBRA MOMENT</strong></div>
      <div><small>SNIPER THRESHOLD</small><strong id="libraSniperThreshold">82</strong></div>
      <div><small>ENTRY MEMORY</small><strong id="libraEntryMemory">0</strong></div>
      <div><small>SNIPER WIN RATE</small><strong id="libraSniperRate">0.0%</strong></div>
      <div><small>LAST ENTRY READ</small><strong id="libraLastEntryRead">—</strong></div>
      <div><small>JUDGMENT SPEED</small><strong id="libraJudgeMs">—</strong></div>`);
  }
  const s=snapshot();
  const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
  set('libraSniperThreshold',`${s.threshold}/100`);
  set('libraEntryMemory',`${s.learned} lessons · ${s.states} states`);
  set('libraSniperRate',s.sniperTrades?`${s.sniperWinRate.toFixed(1)}% · ${money(s.sniperPnl)}`:'LEARNING');
  const a=s.lastAssessment;
  set('libraLastEntryRead',a?`${a.score} ${a.entryClass} ${a.direction}`:'—');
  set('libraJudgeMs',a&&finite(a.judgeMs)?`${Number(a.judgeMs).toFixed(3)} ms`:'PRE-ARMED');
}

window.addEventListener('libra-state',event=>{processSettled(event.detail||{});injectUi()});
window.addEventListener('libra-sniper-assessment',injectUi);
patchExecution();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{injectUi();patchExecution()},{once:true});else{injectUi();patchExecution()}
setInterval(injectUi,1000);

window.LIBRA_SNIPER={snapshot,missionSnapshot,assessSignal:(signal,direction)=>assess(signal,direction),preArmed:()=>({...preArmed}),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
