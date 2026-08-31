const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sideNet=(side,v)=>side==='LONG'?n(v):-n(v);
const sameSide=(a,b)=>['LONG','SHORT'].includes(a)&&a===b;

export const ENTRY_MASTERS=[
  {id:'P01',zone:'FOLLOW',zoneName:'EARLY TREND',name:'EARLY TREND FOLLOW-THROUGH',style:'CONFIRMED',minAge:2,maxAge:9,minSteps:1.35},
  {id:'P02',zone:'FOLLOW',zoneName:'PULLBACK',name:'TRUE PULLBACK RESUMPTION',style:'CONFIRMED',minAge:2,maxAge:10,minSteps:1.25},
  {id:'P03',zone:'FOLLOW',zoneName:'BREAKOUT',name:'BREAKOUT HOLD + CONTINUATION',style:'CONFIRMED',minAge:3,maxAge:10,minSteps:1.55},
  {id:'P04',zone:'FOLLOW',zoneName:'RETEST',name:'RETEST + ACCELERATION',style:'CONFIRMED',minAge:2,maxAge:10,minSteps:1.35},
  {id:'P05',zone:'FOLLOW',zoneName:'TAKEOVER',name:'WEAK-TREND TAKEOVER',style:'REVERSAL',minAge:3,maxAge:9,minSteps:1.65}
];
export const MOUNTAIN_ZONES={FOLLOW:'FOLLOW-THROUGH PROFIT GATES'};
export function makeStrategies(){return ENTRY_MASTERS.map(x=>({...x,label:`${x.id} · ${x.name}`}))}
export function createEntryTracker(){return{}}

const reject=(reason,extra={})=>({action:'WAIT',side:null,score:0,reason,...extra});
const accept=(side,score,reason,extra={})=>({action:'ENTER',side,score:Math.round(clamp(score,0,100)),reason,...extra});
const trendSide=m=>['LONG','SHORT'].includes(m?.trend?.direction)?m.trend.direction:null;
const px=m=>n(m?.price);
const med=m=>Math.max(n(m?.medianStep,1),1e-9);
const progress=m=>n(m?.mountain?.progress);
const conf=m=>n(m?.trend?.confidence);
const momentumSide=(m,k)=>m?.momentum?.[k]||'NONE';
const legSide=m=>m?.currentLeg?.direction||'NONE';
const structureGood=m=>Boolean(m?.structure?.aligned);
const currentBreak=m=>m?.breakout||m?.lastBreakout||null;

function hardGate(master,m){
  if(!m)return'NO MASTER MAP';
  if(m.phase==='CHOP')return'CHOP · no trade';
  if(progress(m)>=90)return'SUMMIT 90%+ · no chase';
  if(master.id!=='P05'&&conf(m)>=82)return'OVERCONFIDENT / LATE TREND · no trade';
  if(!Number.isFinite(px(m))||!Number.isFinite(med(m)))return'NO PRICE COORDINATES';
  return null;
}

function baseSignal(master,m){
  const trend=trendSide(m),p=progress(m),c=conf(m),phase=m.phase;
  if(master.id==='P01'){
    if(!trend)return null;
    if(p<28||p>72||c<18||c>76)return null;
    if(!['IMPULSE','TRENDING','RESUMPTION'].includes(phase))return null;
    if(!structureGood(m)||momentumSide(m,'s20')!==trend||momentumSide(m,'s40')!==trend)return null;
    if(m.location==='AT_TREND_EDGE'&&p>65)return null;
    return{side:trend,reason:`trend established · ${phase} · progress ${p}%`,score:52+c*.35};
  }
  if(master.id==='P02'){
    if(!trend||!m?.pullback?.recent)return null;
    const d=n(m.pullback.depth),r=n(m.pullback.recovery);
    if(p<35||p>88||c>78||d<.16||d>.52||r<.22||r>1.15)return null;
    if(!['RESUMPTION','TRENDING','TRANSITION'].includes(phase))return null;
    if(!structureGood(m)||momentumSide(m,'s20')!==trend)return null;
    return{side:trend,reason:`pullback ${(d*100).toFixed(0)}% · recovery ${(r*100).toFixed(0)}%`,score:62+c*.25};
  }
  if(master.id==='P03'){
    const b=currentBreak(m);if(!b)return null;
    const side=b.direction,age=n(b.ageSec,99);
    if(!['LONG','SHORT'].includes(side)||age>8||p<38||p>88)return null;
    if(trend&&side!==trend)return null;
    if(c>78||!structureGood(m))return null;
    if(momentumSide(m,'s20')!==side)return null;
    return{side,reason:`break ${b.level} held · age ${age}s`,score:66+c*.22};
  }
  if(master.id==='P04'){
    const rt=m?.retest;if(!rt||!rt.touched||!rt.held||!rt.recovered)return null;
    const side=rt.direction;if(!['LONG','SHORT'].includes(side))return null;
    if(p<40||p>88||n(rt.touchAgeSec,99)>12||c>78)return null;
    if(trend&&side!==trend)return null;
    if(!structureGood(m)||momentumSide(m,'s20')!==side)return null;
    return{side,reason:`retest ${rt.level} held + recovered`,score:70+c*.20};
  }
  const b=currentBreak(m),rev=m?.reversal;
  let side=null,why='';
  if(rev&&n(rev.ageSec,99)<=8){side=rev.direction;why=`protected ${rev.level} broke`}
  else if(b&&n(b.ageSec,99)<=6){side=b.direction;why=`opposite breakout ${b.level}`}
  if(!['LONG','SHORT'].includes(side))return null;
  if(trend&&side===trend)return null;
  if(c>25||p<38||p>66)return null;
  if(!['TRANSITION','PULLBACK','RESUMPTION','BREAKOUT'].includes(phase))return null;
  return{side,reason:`weak old trend ${c}% · ${why}`,score:74+(25-c)};
}

function invalidated(candidate,m){
  if(!candidate)return true;
  if(candidate.mountainId!==m?.mountain?.id)return true;
  if(progress(m)>=90)return true;
  if(m.phase==='CHOP')return true;
  const adverse=sideNet(candidate.side,px(m)-candidate.anchorPrice)/med(m);
  return adverse<=-1.15;
}

function followThrough(master,m,candidate,now){
  const age=(now-candidate.armedAt)/1000;
  if(age>master.maxAge)return{ready:false,expired:true,reason:`candidate expired ${age.toFixed(1)}s`};
  const favorable=sideNet(candidate.side,px(m)-candidate.anchorPrice)/med(m);
  const s10=momentumSide(m,'s10'),s20=momentumSide(m,'s20'),leg=legSide(m);
  const directionAlive=s10===candidate.side&&s20===candidate.side&&leg===candidate.side;
  if(age<master.minAge)return{ready:false,reason:`armed · waiting persistence ${age.toFixed(1)}/${master.minAge}s`,favorable};
  if(!directionAlive)return{ready:false,reason:`armed · waiting 10s/20s/current-leg agreement`,favorable};
  if(favorable<master.minSteps)return{ready:false,reason:`armed · follow-through ${favorable.toFixed(2)}/${master.minSteps.toFixed(2)} steps`,favorable};
  if(master.id==='P01'&&momentumSide(m,'s40')!==candidate.side)return{ready:false,reason:'armed · 40s confirmation lost',favorable};
  if(master.id==='P02'&&n(m?.pullback?.recovery)>1.25)return{ready:false,expired:true,reason:'resumption already overextended',favorable};
  if(master.id==='P03'){
    const b=currentBreak(m);if(!b||b.direction!==candidate.side)return{ready:false,expired:true,reason:'breakout event lost',favorable};
    const level=n(b.level),held=candidate.side==='LONG'?px(m)>level+med(m)*.45:px(m)<level-med(m)*.45;
    if(!held)return{ready:false,reason:'break level not yet held',favorable};
  }
  if(master.id==='P04'&&(!m?.retest?.held||!m?.retest?.recovered))return{ready:false,expired:true,reason:'retest failed',favorable};
  if(master.id==='P05'){
    if(conf(m)>45&&trendSide(m)===candidate.side)return{ready:false,reason:'waiting takeover to settle, not chasing new confidence',favorable};
    if(momentumSide(m,'s40')===candidate.opposedTrend)return{ready:false,reason:'old 40s trend still dominant',favorable};
  }
  return{ready:true,favorable,age};
}

export function entryDecision(master,m,tracker={},now=Date.now()){
  const gate=hardGate(master,m);if(gate){delete tracker[master.id];return reject(gate)}
  let c=tracker[master.id];
  if(c&&invalidated(c,m)){delete tracker[master.id];c=null}
  const base=baseSignal(master,m);
  if(!c){
    if(!base)return reject('No qualified setup');
    c={side:base.side,armedAt:now,anchorPrice:px(m),anchorMapId:m.id,mountainId:m.mountain.id,baseProgress:progress(m),baseConfidence:conf(m),baseReason:base.reason,opposedTrend:trendSide(m)};
    tracker[master.id]=c;
    return reject(`ARMED ${base.side} · ${base.reason}`,{candidate:true,candidateAge:0,candidateSteps:0});
  }
  if(base&&base.side!==c.side){delete tracker[master.id];return reject('Candidate direction changed · reset')}
  const ft=followThrough(master,m,c,now);
  if(ft.expired){delete tracker[master.id];return reject(ft.reason)}
  if(!ft.ready)return reject(ft.reason,{candidate:true,candidateAge:(now-c.armedAt)/1000,candidateSteps:ft.favorable});
  delete tracker[master.id];
  const score=clamp(70+ft.favorable*7+(master.id==='P05'?8:0),0,100);
  return accept(c.side,score,`${c.baseReason} · FOLLOW-THROUGH ${ft.favorable.toFixed(2)} steps / ${ft.age.toFixed(1)}s`,{candidateAge:ft.age,candidateSteps:ft.favorable,armedPx:c.anchorPrice});
}

export const SHARED_EXIT={name:'FAIR EXIT',profitTarget:.75,lossCut:.55,staleSec:95,maxSec:180,trendFlipConfidence:68};
export const SHARED_TRAIL={name:'FAIR TRAIL',activation:.18,gap:.16,minLock:.04};
export function sharedExitDecision(position,map){if(!position)return null;const age=(Date.now()-position.boughtAt)/1000,side=position.side,trend=map?.trend?.direction;if(n(position.liveProfit)>=SHARED_EXIT.profitTarget)return'SHARED PROFIT TARGET';if(n(position.liveProfit)<=-SHARED_EXIT.lossCut)return'SHARED LOSS CUT';if(trend&&trend!=='NONE'&&trend!==side&&n(map?.trend?.confidence)>=SHARED_EXIT.trendFlipConfidence)return'SHARED MASTER TREND FLIP';if(age>=SHARED_EXIT.staleSec&&n(position.liveProfit)<.10)return'SHARED STALE EXIT';if(age>=SHARED_EXIT.maxSec)return'SHARED MAX HOLD';return null}
export function sharedTrailSettings(position=null){const peak=n(position?.peakProfit);const armed=peak>=SHARED_TRAIL.activation;return{enabled:armed,trailGap:SHARED_TRAIL.gap,minLock:SHARED_TRAIL.minLock,name:SHARED_TRAIL.name}}

export function summarizeStrategy(strategy,trades,open=null){const rows=trades.filter(x=>x.owner===strategy.id),wins=rows.filter(x=>x.pnl>0),losses=rows.filter(x=>x.pnl<0),sum=a=>a.reduce((s,x)=>s+n(x.pnl),0),pnl=sum(rows),grossWin=sum(wins),grossLoss=Math.abs(sum(losses)),avg=a=>a.length?sum(a)/a.length:0;let peak=0,dd=0,equity=0;for(const row of [...rows].reverse()){equity+=n(row.pnl);peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity)}return{id:strategy.id,zone:strategy.zone,zoneName:strategy.zoneName,name:strategy.name,style:strategy.style,trades:rows.length,wins:wins.length,losses:losses.length,pnl:Number(pnl.toFixed(4)),winRate:rows.length?wins.length/rows.length*100:0,avgWin:avg(wins),avgLoss:avg(losses),expectancy:rows.length?pnl/rows.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?99:0,maxDrawdown:dd,open:Boolean(open),live:n(open?.liveProfit),peakLive:n(open?.peakProfit)}}
