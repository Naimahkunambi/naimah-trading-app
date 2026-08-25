import { SaniEngine } from './engine.mjs';
import { analyzeMountain, mountainAllows } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.sniper.v2';
const PAYOUT=.92;
const BREAK_EVEN=1/(1+PAYOUT);
const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const validDirection=v=>['CALL','PUT'].includes(v);
const dirSign=d=>d==='CALL'?1:d==='PUT'?-1:0;
const finite=v=>Number.isFinite(Number(v));
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;

function emptyState(){return{version:4,threshold:82,learned:0,wins:0,losses:0,states:{},families:{},buckets:{},recent:[],lastLesson:'I am learning SANI setups inside the correct mountain.',lastAssessment:null,lastAt:0}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null');return raw&&typeof raw==='object'?{...emptyState(),...raw,version:4,recent:Array.isArray(raw.recent)?raw.recent.slice(-800):[]}:emptyState()}catch{return emptyState()}}
const state=load();
const seen=new Set();
const pendingAssessment=new Map();
let latest={mission:{},signals:[],ticks:[],brain:{},prediction:{}};
let patched=false;
let preArmed={epoch:0,quote:0,regime:'BOOTING',features:[],signature:'BOOTING',computedAt:0};
let mountain=analyzeMountain([]);

function save(){
  const trim=(obj,limit)=>Object.fromEntries(Object.entries(obj).sort((a,b)=>Number(b[1]?.lastAt||0)-Number(a[1]?.lastAt||0)).slice(0,limit));
  state.states=trim(state.states,2200);state.families=trim(state.families,500);state.recent=state.recent.slice(-800);
  try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}
}
function arm(detail={}){
  latest=detail||latest;
  const p=latest.prediction||{};
  if(finite(p.epoch)&&Array.isArray(p.features)&&Number(p.epoch)>=Number(preArmed.epoch||0))preArmed={epoch:Number(p.epoch),quote:Number(p.quote),regime:String(p.regime||'UNKNOWN'),features:p.features.map(Number),signature:String(p.signature||p.regime||'UNKNOWN'),direction:String(p.direction||'NONE'),probabilityUp:Number(p.probabilityUp||.5),confidence:Number(p.confidence||0),bestHorizon:Number(p.bestHorizon||1),computedAt:performance?.now?.()??Date.now()};
  mountain=analyzeMountain(latest.ticks||[]);
}
function featuresOf(signal){
  const source=Array.isArray(signal?.libra?.preArmedFeatures)?signal.libra.preArmedFeatures:Array.isArray(signal?.libra?.features)?signal.libra.features:preArmed.features;
  const f=Array.isArray(source)?source.map(Number):[];
  return{slope3:f[0]||0,slope5:f[1]||0,slope8:f[2]||0,slope13:f[3]||0,slope21:f[4]||0,slope34:f[5]||0,acceleration:f[6]||0,curvature:f[7]||0,efficiency8:clamp(f[8]||0,0,1),efficiency21:clamp(f[9]||0,0,1),pressure8:f[10]||0,pressure21:f[11]||0,volatility:f[12]||0,reversal:clamp(f[13]||0,0,1)}
}
function familyOf(signal){return String(signal?.saniIntent?.familyId||signal?.pattern?.foundationFamily||signal?.pattern?.familyId||signal?.structure?.tag||'UNKNOWN')}
function mountainKey(m){return `${m?.direction||'NONE'}:${m?.entryMode||'NO_TRADE'}:${m?.important?.label||'—'}`}
function fingerprint(signal,direction,m=mountain){const intent=signal?.saniIntent||{},structure=`${intent.structureTag||signal?.structure?.tag||'MIXED'}:${intent.phase||signal?.structure?.phase||'MID'}`;return`${mountainKey(m)}|${signal?.libra?.preArmedSignature||signal?.libra?.signature||signal?.libra?.regime||'UNKNOWN'}|${familyOf(signal)}|${structure}|${direction}`}
function familyKey(signal,direction,m=mountain){return`${m?.direction||'NONE'}|${familyOf(signal)}|${direction}`}

function saniContext(signal,direction){
  const intent=signal?.saniIntent||{},pattern=signal?.pattern||{},sniper=signal?.sniper||{},structure=signal?.structure||{},expected=direction==='CALL'?'UP':'DOWN';
  const patternDirection=String(intent.patternDirection||pattern?.baseline?.direction||pattern?.direction||'EVEN'),edge=Number(intent.edge??pattern?.foundationEdge??pattern?.baseline?.edge??pattern?.edge??50),avgSimilarity=Number(intent.avgSimilarity??pattern?.avgSimilarity??84),topAgree=Number(intent.top10Agree??pattern?.top10Agree??0),topTotal=Number(intent.top10Total??pattern?.top10Total??10),sameTag=Number(intent.sameTagCount??pattern?.sameTagCount??0),samePhase=Number(intent.samePhaseCount??pattern?.samePhaseCount??0),repeatCount=Number(intent.repeatCount??sniper?.repeatCount??1),saniScore=Number(intent.sniperScore??sniper?.score??0),familyRate=Number(intent.familyRate??sniper?.familyMemory?.rate??.5),familyN=Number(intent.familySamples??sniper?.familyMemory?.total??0),addressRate=Number(intent.addressRate??sniper?.addressMemory?.rate??.5),addressN=Number(intent.addressSamples??sniper?.addressMemory?.total??0),phase=String(intent.phase||structure?.phase||'MID');
  return{patternDirection,edge,avgSimilarity,topAgree,topTotal,sameTag,samePhase,repeatCount,saniScore,familyRate,familyN,addressRate,addressN,phase,aligned:patternDirection===expected,historicalAgreement:topTotal>0?topAgree/topTotal:.5}
}
function rowStats(row){const n=Number(row?.attempts||0),wins=Number(row?.wins||0),pnl=Number(row?.pnl||0);return{n,wins,pnl,winRate:n?wins/n:0,avg:n?pnl/n:0,repeatLosses:Number(row?.repeatLosses||0)}}
function memoryAdjustment(signal,direction,m){
  const exact=rowStats(state.states[fingerprint(signal,direction,m)]),family=rowStats(state.families[familyKey(signal,direction,m)]);let adjust=0;
  if(exact.n){const smoothed=(exact.wins+2)/(exact.n+4);adjust+=clamp((smoothed-BREAK_EVEN)*52,-15,15)*clamp(exact.n/8,.25,1);adjust-=Math.min(20,exact.repeatLosses*5)}
  if(family.n>=4){const smoothed=(family.wins+3)/(family.n+6);adjust+=clamp((smoothed-BREAK_EVEN)*28,-9,9)*clamp(family.n/20,.25,1)}
  return{adjust,exact,family}
}
function classify(score,threshold=state.threshold){if(score>=threshold)return'SNIPER';if(score>=threshold-10)return'GOOD';if(score>=threshold-22)return'LATE';return'TRASH'}

function assess(signal,direction,m=mountain){
  const started=performance?.now?.()??Date.now();
  if(!validDirection(direction))return{score:0,rawScore:0,entryClass:'TRASH',direction:'NONE',threshold:state.threshold,reason:'No valid SANI direction.',mountain:m,judgeMs:0};
  const mountainGate=mountainAllows(m,direction);
  const f=featuresOf(signal),s=saniContext(signal,direction),d=dirSign(direction);
  const slope=d*(.24*f.slope3+.23*f.slope5+.19*f.slope8+.14*f.slope13+.12*f.slope21+.08*f.slope34),pressure=d*(.58*f.pressure8+.42*f.pressure21),impulse=d*(.62*f.acceleration+.38*f.curvature),eff=.42*f.efficiency8+.58*f.efficiency21;
  let setup=0;setup+=s.aligned?clamp((s.edge-50)/50,-1,1)*10:-10;setup+=clamp((s.avgSimilarity-82)/18,-1,1)*4;setup+=clamp((s.historicalAgreement-.5)*2,-1,1)*7;setup+=Math.min(3,s.sameTag*.15)+Math.min(2,s.samePhase*.10);if(s.repeatCount>=2)setup+=Math.min(4,1.5+s.repeatCount*.6);if(s.familyN>=6)setup+=clamp((s.familyRate-BREAK_EVEN)*24,-5,5);if(s.addressN>=5)setup+=clamp((s.addressRate-BREAK_EVEN)*20,-4,4);setup+=clamp(s.saniScore/20,-1,1)*3;
  const physics=18*clamp(slope,-1,1)+10*clamp(pressure,-1,1)+10*clamp(impulse,-1,1)+6*((eff-.5)*2);
  let mountainScore=0;
  if(m?.direction==='CHOP'||m?.allowedDirection==='NONE')mountainScore=-55;
  else if(direction!==m?.allowedDirection)mountainScore=-65;
  else if(m?.entryMode==='PULLBACK_END')mountainScore=28+Math.min(8,Number(m.confirmation||0));
  else if(m?.entryMode==='EARLY_MOMENTUM')mountainScore=24+Math.min(6,Number(m.confirmation||0));
  else if(m?.entryMode==='WAIT_PULLBACK_END')mountainScore=-18;
  else if(m?.entryMode==='EXHAUSTION')mountainScore=-28;
  else mountainScore=-22;
  const memory=memoryAdjustment(signal,direction,m),rawScore=clamp(42+setup+physics+mountainScore,0,100),score=clamp(rawScore+memory.adjust,0,100);
  let entryClass=classify(score);
  if(!mountainGate.allowed)entryClass=(direction!==m?.allowedDirection||m?.direction==='CHOP')?'TRASH':score>=state.threshold-22?'LATE':'TRASH';
  const reason=[`mountain ${m?.direction||'NONE'} ${m?.entryMode||'NO_TRADE'}`,mountainGate.reason,`setup ${setup>=0?'+':''}${setup.toFixed(1)}`,`physics ${physics>=0?'+':''}${physics.toFixed(1)}`];if(memory.exact.n)reason.push(`${memory.exact.n} exact twins ${Math.round(memory.exact.winRate*100)}%`);if(memory.exact.repeatLosses>=2)reason.push(`${memory.exact.repeatLosses} repeated losses`);
  return{score:Number(score.toFixed(1)),rawScore:Number(rawScore.toFixed(1)),entryClass,threshold:state.threshold,direction,reason:reason.join(' · '),fingerprint:fingerprint(signal,direction,m),family:familyOf(signal),mountain:structuredClone(m),parts:{setup,physics,mountainScore,slope,pressure,impulse,efficiency:eff},judgeMs:Math.max(0,(performance?.now?.()??Date.now())-started)}
}
function updateRow(container,key,won,pnl){const row=container[key]||{attempts:0,wins:0,losses:0,pnl:0,repeatLosses:0,lastAt:0};row.attempts++;row.pnl+=pnl;if(won){row.wins++;row.repeatLosses=0}else{row.losses++;row.repeatLosses++}row.lastAt=Date.now();container[key]=row;return row}
function bucketKey(score){return String(Math.max(0,Math.min(100,Math.floor(score/5)*5)))}
function recalcThreshold(){if(state.learned<50)return;let chosen=null;for(let threshold=65;threshold<=95;threshold+=5){let attempts=0,wins=0,pnl=0;for(const[b,row]of Object.entries(state.buckets)){if(Number(b)<threshold)continue;attempts+=Number(row.attempts||0);wins+=Number(row.wins||0);pnl+=Number(row.pnl||0)}if(attempts<20)continue;const wr=wins/attempts,avg=pnl/attempts;if(wr>=BREAK_EVEN+.025&&avg>=.025){chosen=threshold;break}}if(chosen!=null)state.threshold=clamp(chosen,65,95);else if(state.learned>=100)state.threshold=clamp(state.threshold+1,75,95)}
function learnEntry(signal,direction,result,role,assessment){
  if(!validDirection(direction)||!result||!['WON','LOST'].includes(result.outcome)||!assessment)return;
  const won=result.outcome==='WON',pnl=Number(result.profit??(won?PAYOUT:-1)),exact=updateRow(state.states,assessment.fingerprint,won,pnl);updateRow(state.families,familyKey(signal,direction,assessment.mountain),won,pnl);
  const bucket=state.buckets[bucketKey(assessment.rawScore)]||{attempts:0,wins:0,losses:0,pnl:0,lastAt:0};bucket.attempts++;bucket.pnl+=pnl;if(won)bucket.wins++;else bucket.losses++;bucket.lastAt=Date.now();state.buckets[bucketKey(assessment.rawScore)]=bucket;
  state.learned++;if(won)state.wins++;else state.losses++;
  state.recent.push({at:Date.now(),signalAt:Number(signal?.createdAt||Date.now()),signalId:signal?.signalId,score:assessment.score,rawScore:assessment.rawScore,entryClass:assessment.entryClass,won,pnl,role,direction,mountainDirection:assessment.mountain?.direction||'NONE',entryMode:assessment.mountain?.entryMode||'NO_TRADE',family:assessment.family,parts:assessment.parts});
  const repeat=Number(exact.repeatLosses||0);state.lastLesson=won?`${role} ${direction} ${assessment.entryClass} WON inside ${assessment.mountain?.direction} ${assessment.mountain?.entryMode}. I strengthen this setup+mountain+moment.`:`${role} ${direction} ${assessment.entryClass} LOST inside ${assessment.mountain?.direction} ${assessment.mountain?.entryMode}.${repeat>=2?` Same fingerprint has failed ${repeat} times, so I suppress it harder.`:''}`;state.lastAt=Date.now();recalcThreshold();save()
}
function queueAssessments(){for(const signal of latest.signals||[]){if(!signal?.signalId||pendingAssessment.has(signal.signalId)||seen.has(signal.signalId)||!signal.sourceApproved||!validDirection(signal.sourceDirection))continue;pendingAssessment.set(signal.signalId,assess(signal,signal.sourceDirection,mountain))}}
function processSettled(){
  for(const signal of latest.signals||[]){if(!signal?.shadowSettled||!signal.signalId||seen.has(signal.signalId))continue;const saniResult=signal.shadowResult?.sani,assessment=pendingAssessment.get(signal.signalId)||assess(signal,signal.sourceDirection,mountain);if(signal.sourceApproved&&validDirection(signal.sourceDirection)&&saniResult)learnEntry(signal,signal.sourceDirection,saniResult,'SANI',assessment);pendingAssessment.delete(signal.signalId);seen.add(signal.signalId)}
}
function summarize(rows=[]){const trades=rows.length,wins=rows.filter(r=>r.won).length,pnl=rows.reduce((a,r)=>a+Number(r.pnl||0),0);return{trades,wins,losses:trades-wins,pnl:Number(pnl.toFixed(2)),winRate:trades?wins/trades*100:0,avg:trades?pnl/trades:0}}
function missionSnapshot(startedAt=0){const rows=state.recent.filter(r=>r.role==='SANI'&&r.signalAt>=Number(startedAt||0)),sniper=summarize(rows.filter(r=>r.entryClass==='SNIPER')),goodPlus=summarize(rows.filter(r=>['SNIPER','GOOD'].includes(r.entryClass))),rejected=summarize(rows.filter(r=>['LATE','TRASH'].includes(r.entryClass)));return{startedAt:Number(startedAt||0),all:summarize(rows),sniper,goodPlus,rejected,threshold:state.threshold,breakEven:BREAK_EVEN*100,mountain:structuredClone(mountain)}}
function snapshot(){const sniper=summarize(state.recent.filter(r=>r.role==='SANI'&&r.entryClass==='SNIPER'));return{version:'Libra Sniper v3 · Mountain Guardian',threshold:state.threshold,learned:state.learned,states:Object.keys(state.states).length,sniperTrades:sniper.trades,sniperWinRate:sniper.winRate,sniperPnl:sniper.pnl,lastLesson:state.lastLesson,lastAssessment:state.lastAssessment,breakEven:BREAK_EVEN*100,preArmed:{...preArmed},mountain:structuredClone(mountain)}}
function findSignal(id){return(latest.signals||[]).find(r=>r.signalId===id)||null}
function guardExecute(original,ctx,signal){
  const mission=latest.mission||{},signalId=signal?.patternMeta?.signalId;if(!signalId||mission.status!=='ACTIVE'||mission.phase==='LEARN')return original.call(ctx,signal);
  const row=findSignal(signalId),direction=signal?.direction||row?.sourceDirection;if(!row||!validDirection(direction)||!row.sourceApproved||direction!==row.sourceDirection)return false;
  const assessment=pendingAssessment.get(signalId)||assess(row,direction,mountain);state.lastAssessment={...assessment,signalId,at:Date.now()};save();window.dispatchEvent(new CustomEvent('libra-sniper-assessment',{detail:{...assessment,signalId}}));
  if(assessment.entryClass!=='SNIPER'){window.dispatchEvent(new CustomEvent('libra-sniper-block',{detail:{...assessment,signalId}}));return false}
  return original.call(ctx,signal)
}
function patchExecution(){if(patched)return;const original=SaniEngine.prototype.execute;if(typeof original!=='function')return;SaniEngine.prototype.execute=function(signal){return guardExecute(original,this,signal)};patched=true}
function injectUi(){
  const stats=document.querySelector('.libraBrainStats');if(stats&&!document.getElementById('libraMountainDirection'))stats.insertAdjacentHTML('beforeend',`<div><small>MOUNTAIN</small><strong id="libraMountainDirection">WAIT</strong></div><div><small>MOUNTAIN MOMENT</small><strong id="libraMountainMoment">NO TRADE</strong></div><div><small>ENTRY JOB</small><strong id="libraEntryGate">SANI SETUP → LIBRA MOMENT</strong></div><div><small>SNIPER THRESHOLD</small><strong id="libraSniperThreshold">82</strong></div><div><small>ENTRY MEMORY</small><strong id="libraEntryMemory">0</strong></div><div><small>SNIPER WIN RATE</small><strong id="libraSniperRate">LEARNING</strong></div><div><small>LAST ENTRY READ</small><strong id="libraLastEntryRead">—</strong></div><div><small>JUDGMENT SPEED</small><strong id="libraJudgeMs">PRE-ARMED</strong></div>`);
  const s=snapshot(),set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v};set('libraMountainDirection',`${s.mountain?.direction||'NONE'} → ${s.mountain?.allowedDirection||'NONE'}`);set('libraMountainMoment',s.mountain?.entryMode||'NO_TRADE');set('libraSniperThreshold',`${s.threshold}/100`);set('libraEntryMemory',`${s.learned} lessons · ${s.states} states`);set('libraSniperRate',s.sniperTrades?`${s.sniperWinRate.toFixed(1)}% · ${money(s.sniperPnl)}`:'LEARNING');const a=s.lastAssessment;set('libraLastEntryRead',a?`${a.score} ${a.entryClass} ${a.direction}`:'—');set('libraJudgeMs',a&&finite(a.judgeMs)?`${Number(a.judgeMs).toFixed(3)} ms`:'PRE-ARMED')
}
window.addEventListener('libra-state',event=>{arm(event.detail||{});queueAssessments();processSettled();injectUi();window.dispatchEvent(new CustomEvent('libra-mountain-state',{detail:structuredClone(mountain)}))});
window.addEventListener('libra-sniper-assessment',injectUi);
patchExecution();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{injectUi();patchExecution()},{once:true});else{injectUi();patchExecution()}
setInterval(injectUi,1000);
window.LIBRA_SNIPER={snapshot,missionSnapshot,assessSignal:(signal,direction)=>assess(signal,direction,mountain),preArmed:()=>({...preArmed}),mountain:()=>structuredClone(mountain),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
