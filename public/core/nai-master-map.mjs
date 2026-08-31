const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const r=(v,d=2)=>Number.isFinite(Number(v))?Number(Number(v).toFixed(d)):null;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sgn=v=>n(v)>0?1:n(v)<0?-1:0;
const side=v=>sgn(v)>0?'LONG':sgn(v)<0?'SHORT':'NONE';
const same=(a,b)=>a!=='NONE'&&a===b;
const H=(eyes,k)=>eyes?.horizons?.[k]||null;

function swingStructure(swings=[]){
  const highs=swings.filter(x=>x.type==='HIGH'),lows=swings.filter(x=>x.type==='LOW'),labels=[];
  for(let i=0;i<swings.length;i++){
    const x=swings[i],prior=swings.slice(0,i).filter(y=>y.type===x.type).at(-1);
    if(!prior){labels.push(x.type);continue}
    if(x.type==='HIGH')labels.push(n(x.price)>n(prior.price)?'HH':'LH');
    else labels.push(n(x.price)>n(prior.price)?'HL':'LL');
  }
  const recent=labels.slice(-6),bull=recent.filter(x=>x==='HH'||x==='HL').length,bear=recent.filter(x=>x==='LH'||x==='LL').length;
  let bias='MIXED';if(bull>=3&&bull>bear)bias='BULLISH';else if(bear>=3&&bear>bull)bias='BEARISH';
  return{bias,sequence:recent.join(' → ')||'BUILDING',lastHigh:highs.at(-1)||null,lastLow:lows.at(-1)||null,protectedLow:lows.at(-1)||null,protectedHigh:highs.at(-1)||null,bull,bear};
}

function horizonVote(eyes){
  const med=Math.max(n(eyes?.median_step,1),1e-9),defs=[['s20',1],['s40',1.45],['s90',2],['s180',1.35],['s300',.8]];let raw=0,total=0;const detail={};
  for(const [k,w] of defs){const q=H(eyes,k);if(!q)continue;const z=n(q.net)/(med*Math.max(2,Math.sqrt(n(q.up_steps)+n(q.down_steps)))),quality=.35+.65*clamp(n(q.efficiency),0,1),vote=clamp(z,-3,3)*w*quality;raw+=vote;total+=3*w;detail[k]={dir:side(q.net),net:r(q.net),eff:r(q.efficiency,3),strength:r(q.strength,2)}}
  return{normalized:total?raw/total:0,detail};
}

function recentLeg(eyes){
  const px=n(eyes?.last_price),sw=eyes?.candidate_swings||[],last=sw.at(-1);if(last){const d=px-n(last.price);return{direction:side(d),startPrice:r(last.price),startType:last.type,net:r(d),ageSec:n(last.ago_seconds),fromSwing:true}}
  const q=H(eyes,'s10');return{direction:side(q?.net),startPrice:r(q?.open),startType:'WINDOW',net:r(q?.net),ageSec:10,fromSwing:false};
}

function journey(swings=[],px){
  const pts=swings.slice(-6).map(x=>({type:x.type,price:r(x.price),agoSec:n(x.ago_seconds)})),legs=[];
  for(let i=1;i<pts.length;i++)legs.push({dir:pts[i].price>pts[i-1].price?'UP':'DOWN',from:pts[i-1].price,to:pts[i].price,size:r(Math.abs(pts[i].price-pts[i-1].price))});
  if(pts.length)legs.push({dir:px>pts.at(-1).price?'UP':'DOWN',from:pts.at(-1).price,to:r(px),size:r(Math.abs(px-pts.at(-1).price)),live:true});
  return{points:pts,legs:legs.slice(-6)};
}

function inferTrendStart(structure,trend,now){const anchor=trend==='LONG'?structure.lastLow:trend==='SHORT'?structure.lastHigh:null;return anchor?{at:now-n(anchor.ago_seconds)*1000,price:n(anchor.price)}:{at:now,price:null}}
function location(eyes,trend){
  const q=H(eyes,'s90');if(!q)return'UNKNOWN';const range=Math.max(n(q.range),1e-9),fromHigh=Math.abs(n(q.from_high)),fromLow=Math.abs(n(q.from_low));
  if(fromHigh/range<=.12)return trend==='LONG'?'AT_TREND_EDGE':'NEAR_HIGH';if(fromLow/range<=.12)return trend==='SHORT'?'AT_TREND_EDGE':'NEAR_LOW';
  if(trend==='LONG'&&fromHigh/range>=.28&&fromHigh/range<=.62)return'PULLBACK_ZONE';if(trend==='SHORT'&&fromLow/range>=.28&&fromLow/range<=.62)return'PULLBACK_ZONE';return'MID_RANGE';
}
function progressScore({ageSec,travel,med,journey,edgeRatio,confidence}){
  const age=clamp(ageSec/180,0,1),distance=clamp(Math.abs(travel)/(med*28),0,1),legs=clamp((journey?.legs?.length||0)/6,0,1),edge=clamp(1-edgeRatio,0,1),conf=clamp(confidence/100,0,1);
  return Math.round(clamp((distance*.34+age*.22+legs*.18+edge*.16+conf*.10)*100,0,100));
}

export class NaiMasterMap{
  constructor(){
    this.id=0;this.map=null;this.trend='NONE';this.trendStartedAt=0;this.trendStartPrice=null;this.trendChangedAt=0;this.mountainSeq=0;this.mountainId='MNT-0000';
    this.phase='UNKNOWN';this.phaseStartedAt=0;this.pullbackState=null;this.lastPullback=null;this.breakout=null;this.lastBreakout=null;this.retest=null;this.reversalBreak=null;
  }
  update(eyes,{now=Date.now()}={}){
    if(!eyes)return this.map;this.id+=1;
    const px=n(eyes.last_price),med=Math.max(n(eyes.median_step,1),1e-9),structure=swingStructure(eyes.candidate_swings||[]),vote=horizonVote(eyes),prevMap=this.map;
    let score=vote.normalized;if(structure.bias==='BULLISH')score+=.18;if(structure.bias==='BEARISH')score-=.18;
    const q90=H(eyes,'s90'),q20=H(eyes,'s20'),q10=H(eyes,'s10'),q40=H(eyes,'s40'),candidate=score>=.16?'LONG':score<=-.16?'SHORT':'NONE',confidence=Math.round(clamp(Math.abs(score)/.72*100,0,100)),previousTrend=this.trend;

    if(candidate!=='NONE'&&(this.trend==='NONE'||candidate===this.trend||confidence>=58)){
      if(candidate!==this.trend){
        this.trend=candidate;const inferred=inferTrendStart(structure,candidate,now);this.trendStartedAt=inferred.at;this.trendStartPrice=inferred.price??px;this.trendChangedAt=now;this.mountainSeq+=1;this.mountainId=`MNT-${String(this.mountainSeq).padStart(4,'0')}`;this.pullbackState=null;this.lastPullback=null;this.breakout=null;this.lastBreakout=null;this.retest=null;
      }
    }else if(candidate==='NONE'&&confidence<18&&this.trend!=='NONE'&&Math.abs(n(q90?.net))<med*3){this.trend='NONE';this.trendStartedAt=now;this.trendStartPrice=px;this.trendChangedAt=now;this.pullbackState=null;}

    const prevHigh=prevMap?.structure?.lastHigh?.price,prevLow=prevMap?.structure?.lastLow?.price,prevProtected=prevMap?.structure?.protectedLevel,oldTrend=prevMap?.trend?.direction||previousTrend;
    if(Number.isFinite(prevHigh)&&px>prevHigh+med*.35&&(prevMap?.price??px)<=prevHigh+med*.35){this.breakout={direction:'LONG',level:prevHigh,at:now};this.lastBreakout={...this.breakout};this.retest={direction:'LONG',level:prevHigh,breakoutAt:now,touchedAt:null,extreme:px,held:true,recovered:false}}
    if(Number.isFinite(prevLow)&&px<prevLow-med*.35&&(prevMap?.price??px)>=prevLow-med*.35){this.breakout={direction:'SHORT',level:prevLow,at:now};this.lastBreakout={...this.breakout};this.retest={direction:'SHORT',level:prevLow,breakoutAt:now,touchedAt:null,extreme:px,held:true,recovered:false}}
    if(this.breakout&&now-this.breakout.at>12000)this.breakout=null;if(this.lastBreakout&&now-this.lastBreakout.at>60000){this.lastBreakout=null;this.retest=null}

    if(this.retest){
      const d=this.retest.direction,lvl=n(this.retest.level),dist=d==='LONG'?px-lvl:lvl-px;
      if(d==='LONG')this.retest.extreme=Math.min(n(this.retest.extreme,px),px);else this.retest.extreme=Math.max(n(this.retest.extreme,px),px);
      if(!this.retest.touchedAt&&dist<=med*.65&&dist>=-med*1.5)this.retest.touchedAt=now;
      if(d==='LONG'&&px<lvl-med*1.5)this.retest.held=false;if(d==='SHORT'&&px>lvl+med*1.5)this.retest.held=false;
      if(this.retest.touchedAt&&this.retest.held&&dist>=med*.8)this.retest.recovered=true;
    }

    if(Number.isFinite(prevProtected)&&['LONG','SHORT'].includes(oldTrend)){
      const broke=oldTrend==='LONG'?px<prevProtected-med*.7:px>prevProtected+med*.7;
      if(broke)this.reversalBreak={direction:oldTrend==='LONG'?'SHORT':'LONG',level:prevProtected,at:now,oldTrend};
    }
    if(this.reversalBreak&&now-this.reversalBreak.at>20000)this.reversalBreak=null;

    const leg=recentLeg(eyes),trend=this.trend,short10=side(q10?.net),short20=side(q20?.net),mid40=side(q40?.net),main90=side(q90?.net),align10=same(short10,trend),align20=same(short20,trend),align40=same(mid40,trend),counter10=short10!=='NONE'&&trend!=='NONE'&&short10!==trend;
    const trendTravel=this.trendStartPrice==null?0:(trend==='LONG'?px-this.trendStartPrice:this.trendStartPrice-px),range90=Math.max(n(q90?.range),med),edgeDist=trend==='LONG'?Math.abs(n(q90?.from_high)):trend==='SHORT'?Math.abs(n(q90?.from_low)):range90,edgeRatio=clamp(edgeDist/range90,0,1),extended=trend!=='NONE'&&edgeRatio<.08&&trendTravel>med*10&&n(q90?.efficiency)>.28;
    let phase='TRANSITION';
    if(trend==='NONE')phase=n(q20?.efficiency)<.16&&n(q40?.efficiency)<.18?'CHOP':'TRANSITION';
    else if(this.breakout&&this.breakout.direction===trend)phase='BREAKOUT';
    else if(counter10&&side(q20?.net)!==trend&&Math.abs(n(q20?.net))>med*2)phase='PULLBACK';
    else if(extended&&align10&&align20)phase='EXTENDED';
    else if(align10&&align20&&align40){const strong=n(q10?.strength)>=1||n(q20?.strength)>=1.1;phase=this.lastPullback&&now-this.lastPullback.endedAt<45000?'RESUMPTION':strong?'IMPULSE':'TRENDING'}
    else if(align20&&align40)phase='TRENDING';else phase='TRANSITION';

    const priorPhase=this.phase;
    if(phase==='PULLBACK'){
      if(!this.pullbackState||this.pullbackState.trend!==trend){const origin=trend==='LONG'?structure.lastHigh?.price:structure.lastLow?.price;this.pullbackState={trend,startedAt:now,originLevel:n(origin,px),extreme:px}}
      if(trend==='LONG')this.pullbackState.extreme=Math.min(this.pullbackState.extreme,px);else this.pullbackState.extreme=Math.max(this.pullbackState.extreme,px);
    }else if(this.pullbackState&&this.pullbackState.trend===trend){
      const p=this.pullbackState,travelAtStart=Math.max(Math.abs(p.originLevel-this.trendStartPrice),med),depth=Math.abs(p.extreme-p.originLevel)/travelAtStart;
      this.lastPullback={...p,endedAt:now,depth:clamp(depth,0,2)};this.pullbackState=null;
    }
    if(phase!==this.phase){this.phase=phase;this.phaseStartedAt=now}

    const activePb=this.pullbackState||this.lastPullback,pbDepth=activePb?clamp(Math.abs(n(activePb.extreme)-n(activePb.originLevel))/Math.max(Math.abs(n(activePb.originLevel)-n(this.trendStartPrice)),med),0,2):0,pbAge=activePb?Math.round((now-n(activePb.startedAt,now))/1000):null,pbRecovery=activePb&&activePb.extreme!=null?clamp((trend==='LONG'?px-n(activePb.extreme):n(activePb.extreme)-px)/Math.max(Math.abs(n(activePb.originLevel)-n(activePb.extreme)),med),0,2):0;
    const loc=location(eyes,trend),j=journey(eyes.candidate_swings||[],px),protectedLevel=trend==='LONG'?structure.protectedLow?.price:trend==='SHORT'?structure.protectedHigh?.price:null,structureAligned=trend==='LONG'?structure.bias!=='BEARISH':trend==='SHORT'?structure.bias!=='BULLISH':false,ageSec=trend==='NONE'?0:Math.max(0,Math.round((now-this.trendStartedAt)/1000)),progress=progressScore({ageSec,travel:trendTravel,med,journey:j,edgeRatio,confidence});

    this.map={
      id:this.id,at:now,price:r(px),medianStep:r(med,4),mountain:{id:this.mountainId,progress,edgeRatio:r(edgeRatio,3),travelSteps:r(Math.abs(trendTravel)/med,1)},
      trend:{direction:trend,previousDirection:previousTrend,confidence,ageSec,startPrice:r(this.trendStartPrice),travel:r(trendTravel),changed:previousTrend!==trend,changeAgeSec:this.trendChangedAt?Math.round((now-this.trendChangedAt)/1000):null},
      phase,currentLeg:leg,previousPhase:priorPhase,phaseAgeSec:Math.max(0,Math.round((now-this.phaseStartedAt)/1000)),
      structure:{...structure,aligned:structureAligned,protectedLevel:r(protectedLevel)},
      breakout:this.breakout?{direction:this.breakout.direction,level:r(this.breakout.level),ageSec:Math.round((now-this.breakout.at)/1000)}:null,
      lastBreakout:this.lastBreakout?{direction:this.lastBreakout.direction,level:r(this.lastBreakout.level),ageSec:Math.round((now-this.lastBreakout.at)/1000)}:null,
      retest:this.retest?{direction:this.retest.direction,level:r(this.retest.level),ageSec:Math.round((now-this.retest.breakoutAt)/1000),touched:Boolean(this.retest.touchedAt),touchAgeSec:this.retest.touchedAt?Math.round((now-this.retest.touchedAt)/1000):null,held:Boolean(this.retest.held),recovered:Boolean(this.retest.recovered),extreme:r(this.retest.extreme)}:null,
      reversal:this.reversalBreak?{direction:this.reversalBreak.direction,level:r(this.reversalBreak.level),ageSec:Math.round((now-this.reversalBreak.at)/1000),oldTrend:this.reversalBreak.oldTrend}:null,
      location:loc,
      pullback:{active:phase==='PULLBACK',recent:Boolean(activePb&&now-n(activePb.endedAt||activePb.startedAt,now)<50000),ageSec:pbAge,depth:r(pbDepth,3),originLevel:activePb?r(activePb.originLevel):null,extreme:activePb?r(activePb.extreme):null,recovery:r(pbRecovery,3)},
      momentum:{s10:short10,s20:short20,s40:mid40,s90:main90,aligned10:align10,aligned20:align20,aligned40:align40,eff20:r(q20?.efficiency,3),strength10:r(q10?.strength,2),strength20:r(q20?.strength,2)},
      horizons:vote.detail,journey:j,pattern:`${structure.sequence} · ${phase} · ${trend}`
    };
    return this.map;
  }
}
