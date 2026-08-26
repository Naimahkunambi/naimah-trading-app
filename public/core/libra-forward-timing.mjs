import { analyzeMountain } from './libra-mountain.mjs';

const STORAGE_KEY='sani.libra.forward-timing.v8';
const PAYOUT=.92;
const FORECAST_THRESHOLD=.60;
const LATENCY_OUTLIER_MS=1500;
const LATENCY_HOLD_MS=8000;
const LEARN_RATE=.004;
const validDirection=v=>['CALL','PUT'].includes(v);
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const sigmoid=z=>1/(1+Math.exp(-Math.max(-20,Math.min(20,z))));

// Seeded from earlier Demo executable-shadow sessions, then updated online from T+1→T+2 outcomes.
// These are not confirmation rules. They estimate whether a SANI direction is likely to still be correct
// when Deriv actually enters one tick later.
const PRIOR={
  intercept:.01989409,
  rows:[
    ['edge',59.829813,3.170477,-.074931],
    ['o_slope2',-.300634,1.175117,.010099],
    ['o_slope3',-.193670,.859424,-.019636],
    ['o_slope5',-.098376,.644250,-.042156],
    ['o_slope8',-.042960,.509605,-.001520],
    ['o_slope13',-.003398,.409256,-.090945],
    ['o_slope21',-.008331,.321249,.134760],
    ['o_accel3_8',-.150710,.756419,-.021286],
    ['o_accel5_13',-.094977,.551986,.018227],
    ['o_slope3_delta',-.088695,.826469,-.059869],
    ['o_curv',-.213928,1.673837,.034344],
    ['o_spread5_21',-.158884,1.897708,.111704],
    ['o_spread_vel',-.192949,.738878,.130882],
    ['o_spread_project',-.351833,2.176587,.141821],
    ['o_pos8',.393995,.397098,-.330224],
    ['o_pos13',.431856,.387658,.066526],
    ['o_pos21',.436328,.380622,.246883],
    ['eff8',.396693,.281278,.100576],
    ['eff13',.317028,.218339,-.044853],
    ['eff21',.242168,.181431,.154873]
  ]
};

function bucket(){return{trades:0,wins:0,losses:0,pnl:0,recent:[]}}
function fresh(){return{
  version:8,threshold:FORECAST_THRESHOLD,intercept:PRIOR.intercept,weights:Object.fromEntries(PRIOR.rows.map(r=>[r[0],r[3]])),updates:0,
  passes:bucket(),rejects:bucket(),lastDecision:null,
  lastLesson:'Predictive v8: SANI predicts the T+1→T+2 direction. Libra estimates whether that prediction will still be alive at Deriv entry. No confirmation-count waiting.',
  paidAckMs:[],paidSlips:[],latencyHoldUntil:0,lastAckMs:0
}}
function load(){try{const raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||'null'),f=fresh();return raw&&raw.version===8?{...f,...raw,weights:{...f.weights,...(raw.weights||{})},passes:{...f.passes,...(raw.passes||{}),recent:Array.isArray(raw.passes?.recent)?raw.passes.recent.slice(-300):[]},rejects:{...f.rejects,...(raw.rejects||{}),recent:Array.isArray(raw.rejects?.recent)?raw.rejects.recent.slice(-300):[]}}:f}catch{return fresh()}}
const state=load();
let latest={ticks:[],signals:[],mission:{}},mountain=analyzeMountain([]),installed=false;
const captured=new Map(),settled=new Set();

function save(){state.passes.recent=(state.passes.recent||[]).slice(-300);state.rejects.recent=(state.rejects.recent||[]).slice(-300);state.paidAckMs=(state.paidAckMs||[]).slice(-80);state.paidSlips=(state.paidSlips||[]).slice(-80);try{localStorage.setItem(STORAGE_KEY,JSON.stringify(state))}catch{}}
function summary(b){const n=Number(b?.trades||0),wins=Number(b?.wins||0),pnl=Number(b?.pnl||0);return{trades:n,wins,losses:n-wins,pnl,winRate:n?wins/n*100:0}}
function recent(rows=[],n=30){const a=(rows||[]).slice(-n),wins=a.filter(r=>r.won).length,pnl=a.reduce((s,r)=>s+Number(r.pnl||0),0);return{trades:a.length,wins,losses:a.length-wins,pnl:Number(pnl.toFixed(2)),winRate:a.length?wins/a.length*100:0}}
function record(b,won,pnl,row){b.trades++;b.pnl=Number((Number(b.pnl||0)+Number(pnl||0)).toFixed(2));won?b.wins++:b.losses++;b.recent.push({...row,won,pnl,at:Date.now()});b.recent=b.recent.slice(-300)}
function median(values=[]){const a=values.map(Number).filter(Number.isFinite).sort((x,y)=>x-y);if(!a.length)return 0;const m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2}
function latencyHeld(){return Date.now()<Number(state.latencyHoldUntil||0)}
function mean(values=[]){return values.length?values.reduce((s,v)=>s+Number(v||0),0)/values.length:0}
function linSlope(values=[]){const n=values.length;if(n<2)return 0;const xm=(n-1)/2,ym=mean(values);let num=0,den=0;for(let i=0;i<n;i++){num+=(i-xm)*(values[i]-ym);den+=(i-xm)**2}return den?num/den:0}
function pathEfficiency(values=[]){if(values.length<2)return 0;let path=0;for(let i=1;i<values.length;i++)path+=Math.abs(values[i]-values[i-1]);return path?Math.abs(values.at(-1)-values[0])/path:0}
function regLast(values=[]){const n=values.length;if(!n)return 0;const slope=linSlope(values),xm=(n-1)/2,intercept=mean(values)-slope*xm;return intercept+slope*(n-1)}
function position(values=[]){if(!values.length)return .5;const lo=Math.min(...values),hi=Math.max(...values);return hi>lo?(values.at(-1)-lo)/(hi-lo):.5}
function saniEdge(signal){const i=signal?.saniIntent||{},p=signal?.pattern||{};return Number(i.edge??p.foundationEdge??p.edge??0)}

function featurePacket(signal,rows=[]){
  const direction=signal?.direction||signal?.sourceDirection||'NONE',sign=direction==='CALL'?1:direction==='PUT'?-1:0;
  const quotes=(rows||[]).map(r=>Number(r?.quote)).filter(Number.isFinite);if(quotes.length<35||!sign)return null;
  const step=mean(quotes.slice(-40).map((v,i,a)=>i?Math.abs(v-a[i-1]):0).slice(1))||1;
  const slope=n=>linSlope(quotes.slice(-n))/step,eff=n=>pathEfficiency(quotes.slice(-n));
  const s2=slope(2),s3=slope(3),s5=slope(5),s8=slope(8),s13=slope(13),s21=slope(21);
  const prev=quotes.slice(0,-1),prevS3=linSlope(prev.slice(-3))/step;
  const fast=regLast(quotes.slice(-5)),slow=regLast(quotes.slice(-21)),fastPrev=regLast(prev.slice(-5)),slowPrev=regLast(prev.slice(-21));
  const spread=(fast-slow)/step,spreadPrev=(fastPrev-slowPrev)/step,spreadVel=spread-spreadPrev;
  const curv=((quotes.at(-1)-quotes.at(-2))-(quotes.at(-2)-quotes.at(-3)))/step;
  const orient=v=>v*sign;
  const pos=n=>{const p=position(quotes.slice(-n));return sign===1?p:1-p};
  return{
    edge:saniEdge(signal),
    o_slope2:orient(s2),o_slope3:orient(s3),o_slope5:orient(s5),o_slope8:orient(s8),o_slope13:orient(s13),o_slope21:orient(s21),
    o_accel3_8:orient(s3-s8),o_accel5_13:orient(s5-s13),o_slope3_delta:orient(s3-prevS3),o_curv:orient(curv),
    o_spread5_21:orient(spread),o_spread_vel:orient(spreadVel),o_spread_project:orient(spread+spreadVel),
    o_pos8:pos(8),o_pos13:pos(13),o_pos21:pos(21),eff8:eff(8),eff13:eff(13),eff21:eff(21)
  };
}
function standardized(features={}){const out={};for(const [name,mu,sd] of PRIOR.rows)out[name]=(Number(features[name]||0)-mu)/(sd||1);return out}
function forecast(signal,rows=[]){
  const features=featurePacket(signal,rows);if(!features)return{ready:false,probability:.5,features:null,zFeatures:null};
  const zFeatures=standardized(features);let z=Number(state.intercept||0);for(const [name] of PRIOR.rows)z+=Number(state.weights?.[name]||0)*Number(zFeatures[name]||0);
  return{ready:true,probability:sigmoid(z),features,zFeatures};
}
function learnForecast(zFeatures,won){
  if(!zFeatures)return;let z=Number(state.intercept||0);for(const [name] of PRIOR.rows)z+=Number(state.weights?.[name]||0)*Number(zFeatures[name]||0);const p=sigmoid(z),y=won?1:0,error=y-p;
  state.intercept=Number(state.intercept||0)+LEARN_RATE*error;
  for(const [name] of PRIOR.rows)state.weights[name]=Number(state.weights?.[name]||0)+LEARN_RATE*error*Number(zFeatures[name]||0);
  state.updates=Number(state.updates||0)+1;
}
function rejected(action,direction,reason,m,extra={}){return{allowed:false,action,direction,reason,mountain:m,forwardOffset:1,...extra}}

function evaluateForward(signal,m=mountain,rows=latest.ticks||[]){
  const direction=signal?.direction||signal?.sourceDirection||signal?.patternMeta?.sourceDirection||'NONE';
  const regime=String(signal?.libra?.regime||signal?.patternMeta?.regime||'UNKNOWN');
  const f=forecast(signal,rows),probability=f.probability,diagnostic={probability,threshold:state.threshold,edge:saniEdge(signal),regime,features:f.features};
  const sniper={score:Number((probability*100).toFixed(1)),entryClass:probability>=state.threshold?'FORECAST_PASS':'FORECAST_WAIT'};
  if(!signal?.sourceApproved||!validDirection(direction))return rejected('SANI QUIET','NONE','SANI has no qualified forward setup.',m,{diagnostic,sniper,regime});
  if(latencyHeld())return rejected('LATENCY HOLD',direction,`Recent Deriv ACK was ${Number(state.lastAckMs||0).toFixed(0)}ms. I will not buy a 1-tick contract while the execution pipe is late.`,m,{diagnostic,sniper,regime});
  if(!m?.ready||!['UP','DOWN'].includes(m.direction))return rejected('NO LOCKED MOUNTAIN',direction,`No locked campaign direction (${m?.direction||'NONE'}). SANI forecast stays shadow.`,m,{diagnostic,sniper,regime});
  if(m.allowedDirection!==direction)return rejected('WRONG MOUNTAIN SIDE',direction,`${m.direction} campaign allows ${m.allowedDirection}; SANI ${direction} is blocked until important structure reverses.`,m,{diagnostic,sniper,regime});
  if(!f.ready)return rejected('FORECAST WARMING',direction,'Not enough tick history to estimate the executable T+1→T+2 window.',m,{diagnostic,sniper,regime});
  if(probability<Number(state.threshold||FORECAST_THRESHOLD))return rejected('FORECAST WAIT',direction,`Ahead-of-entry probability ${(probability*100).toFixed(1)}% is below ${(state.threshold*100).toFixed(0)}%. I am not waiting for confirmation; I am declining a weak forecast.`,m,{diagnostic,sniper,regime});
  return{
    allowed:true,action:'FORECAST PASS',direction,
    reason:`PREDICT BEFORE ENTRY: SANI ${direction} setup + locked ${m.direction} mountain. Estimated executable T+1→T+2 win probability ${(probability*100).toFixed(1)}%. Current ${m.entryMode||'moment'} and ${regime} are diagnostics, not confirmation gates.`,
    mountain:m,forwardOffset:1,diagnostic,sniper,regime,forecastProbability:probability,forecastFeatures:f.features,forecastZFeatures:f.zFeatures
  };
}

function install(){
  if(installed||!window.LIBRA_TEACHER?.decisionFor)return false;installed=true;
  window.LIBRA_TEACHER.decisionFor=(signal)=>{
    mountain=analyzeMountain(latest.ticks||[]);const result=evaluateForward(signal,mountain,latest.ticks||[]);
    state.lastDecision={...result,signalId:signal?.signalId,at:Date.now()};save();window.dispatchEvent(new CustomEvent('libra-forward-decision',{detail:state.lastDecision}));return result;
  };
  return true;
}

function study(){
  for(const row of latest.signals||[]){
    if(!row?.signalId||!row.sourceApproved||!validDirection(row.sourceDirection))continue;
    if(!captured.has(row.signalId)&&!settled.has(row.signalId)){
      const historicalTicks=(latest.ticks||[]).filter(t=>Number(t.epoch)<=Number(row.signalEpoch||Infinity));
      const m=analyzeMountain(historicalTicks),decision=evaluateForward({...row,direction:row.sourceDirection},m,historicalTicks),f=forecast({...row,direction:row.sourceDirection},historicalTicks);
      captured.set(row.signalId,{signalId:row.signalId,signalAt:Number(row.createdAt||Date.now()),direction:row.sourceDirection,regime:row.libra?.regime||'UNKNOWN',decision,mountain:m,zFeatures:f.zFeatures,probability:f.probability});
    }
    if(!settled.has(row.signalId)&&['WON','LOST'].includes(row.shadow?.outcome)){
      const lesson=captured.get(row.signalId);if(!lesson)continue;const won=row.shadow.outcome==='WON',pnl=won?PAYOUT:-1;
      learnForecast(lesson.zFeatures,won);const target=lesson.decision?.allowed?state.passes:state.rejects;
      record(target,won,pnl,{signalId:row.signalId,signalAt:lesson.signalAt,direction:lesson.direction,regime:lesson.regime,mountainDirection:lesson.mountain?.direction||'NONE',moment:lesson.mountain?.entryMode||'NO_TRADE',action:lesson.decision?.action||'WAIT',probability:lesson.probability,entry:row.shadow?.entry,exit:row.shadow?.exit,entryEpoch:row.shadow?.entryEpoch,exitEpoch:row.shadow?.exitEpoch,executionOffset:row.shadow?.executionOffset});
      const p=summary(state.passes);state.lastLesson=`PREDICTIVE CLASSROOM v8: forecast-pass set ${p.trades}T · ${p.winRate.toFixed(1)}% · ${money(p.pnl)}. Model updated ${state.updates} executable outcomes.`;
      settled.add(row.signalId);captured.delete(row.signalId);save();
    }
  }
}

window.addEventListener('libra-state',event=>{latest=event.detail||latest;mountain=analyzeMountain(latest.ticks||[]);install();study()});
window.addEventListener('libra-teacher-paid',event=>{const d=event.detail||{},ack=Number(d.buyAckMs);if(Number.isFinite(ack)){state.lastAckMs=ack;state.paidAckMs.push(ack);if(ack>LATENCY_OUTLIER_MS)state.latencyHoldUntil=Date.now()+LATENCY_HOLD_MS}if(Number.isFinite(Number(d.entrySpot))&&Number.isFinite(Number(d.signalQuote)))state.paidSlips.push(Number(d.entrySpot)-Number(d.signalQuote));save()});

function snapshot(){return{version:'Forward Timing v8 · Predictive',threshold:state.threshold,updates:state.updates,latencyHeld:latencyHeld(),latencyHoldUntil:state.latencyHoldUntil,lastAckMs:state.lastAckMs,passes:summary(state.passes),rejects:summary(state.rejects),recent:recent(state.passes.recent,30),medianBuyAckMs:median(state.paidAckMs),medianEntrySlip:median(state.paidSlips),lastDecision:state.lastDecision,lastLesson:state.lastLesson,mountain}}
window.LIBRA_FORWARD_TIMING={snapshot,forecast:(signal)=>forecast(signal,latest.ticks||[]),evaluate:(signal)=>evaluateForward(signal,analyzeMountain(latest.ticks||[]),latest.ticks||[]),reset:()=>{localStorage.removeItem(STORAGE_KEY);location.reload()}};
install();
