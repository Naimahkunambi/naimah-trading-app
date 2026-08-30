const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const r=(v,d=2)=>Number.isFinite(Number(v))?Number(Number(v).toFixed(d)):null;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sgn=v=>n(v)>0?1:n(v)<0?-1:0;
const side=v=>sgn(v)>0?'LONG':sgn(v)<0?'SHORT':'NONE';
const same=(a,b)=>a!=='NONE'&&a===b;
const H=(eyes,k)=>eyes?.horizons?.[k]||null;

function swingStructure(swings=[]){
  const highs=swings.filter(x=>x.type==='HIGH'),lows=swings.filter(x=>x.type==='LOW');
  const labels=[];
  for(let i=0;i<swings.length;i++){
    const x=swings[i];
    const prior=swings.slice(0,i).filter(y=>y.type===x.type).at(-1);
    if(!prior){labels.push(x.type);continue}
    if(x.type==='HIGH')labels.push(n(x.price)>n(prior.price)?'HH':'LH');
    else labels.push(n(x.price)>n(prior.price)?'HL':'LL');
  }
  const recent=labels.slice(-6),bull=recent.filter(x=>x==='HH'||x==='HL').length,bear=recent.filter(x=>x==='LH'||x==='LL').length;
  let bias='MIXED';if(bull>=3&&bull>bear)bias='BULLISH';else if(bear>=3&&bear>bull)bias='BEARISH';
  return{
    bias,sequence:recent.join(' → ')||'BUILDING',
    lastHigh:highs.at(-1)||null,lastLow:lows.at(-1)||null,
    protectedLow:lows.at(-1)||null,protectedHigh:highs.at(-1)||null,
    bull,bear
  };
}

function horizonVote(eyes){
  const med=Math.max(n(eyes?.median_step,1),1e-9);
  const defs=[['s20',1],['s40',1.45],['s90',2],['s180',1.35],['s300',.8]];
  let raw=0,total=0;
  const detail={};
  for(const [k,w] of defs){
    const q=H(eyes,k);if(!q)continue;
    const z=n(q.net)/(med*Math.max(2,Math.sqrt(n(q.up_steps)+n(q.down_steps))));
    const quality=.35+.65*clamp(n(q.efficiency),0,1);
    const vote=clamp(z,-3,3)*w*quality;
    raw+=vote;total+=3*w;detail[k]={dir:side(q.net),net:r(q.net),eff:r(q.efficiency,3),strength:r(q.strength,2)};
  }
  const normalized=total?raw/total:0;
  return{normalized,detail};
}

function recentLeg(eyes,structure){
  const px=n(eyes?.last_price),sw=eyes?.candidate_swings||[],last=sw.at(-1),prev=sw.at(-2);
  if(last){
    const d=px-n(last.price);return{direction:side(d),startPrice:r(last.price),startType:last.type,net:r(d),ageSec:n(last.ago_seconds),fromSwing:true};
  }
  const q=H(eyes,'s10');return{direction:side(q?.net),startPrice:r(q?.open),startType:'WINDOW',net:r(q?.net),ageSec:10,fromSwing:false};
}

function journey(swings=[],px){
  const pts=swings.slice(-6).map(x=>({type:x.type,price:r(x.price),agoSec:n(x.ago_seconds)}));
  const legs=[];
  for(let i=1;i<pts.length;i++)legs.push({dir:pts[i].price>pts[i-1].price?'UP':'DOWN',from:pts[i-1].price,to:pts[i].price,size:r(Math.abs(pts[i].price-pts[i-1].price))});
  if(pts.length)legs.push({dir:px>pts.at(-1).price?'UP':'DOWN',from:pts.at(-1).price,to:r(px),size:r(Math.abs(px-pts.at(-1).price)),live:true});
  return{points:pts,legs:legs.slice(-6)};
}

function inferTrendStart(structure,trend,now){
  const anchor=trend==='LONG'?structure.lastLow:trend==='SHORT'?structure.lastHigh:null;
  return anchor?{at:now-n(anchor.ago_seconds)*1000,price:n(anchor.price)}:{at:now,price:null};
}

function location(eyes,trend){
  const q=H(eyes,'s90');if(!q)return'UNKNOWN';const range=Math.max(n(q.range),1e-9),fromHigh=Math.abs(n(q.from_high)),fromLow=Math.abs(n(q.from_low));
  if(fromHigh/range<=.12)return trend==='LONG'?'AT_TREND_EDGE':'NEAR_HIGH';
  if(fromLow/range<=.12)return trend==='SHORT'?'AT_TREND_EDGE':'NEAR_LOW';
  if(trend==='LONG'&&fromHigh/range>=.28&&fromHigh/range<=.62)return'PULLBACK_ZONE';
  if(trend==='SHORT'&&fromLow/range>=.28&&fromLow/range<=.62)return'PULLBACK_ZONE';
  return'MID_RANGE';
}

export class NaiMasterMap{
  constructor(){this.id=0;this.map=null;this.trend='NONE';this.trendStartedAt=0;this.trendStartPrice=null;this.phase='UNKNOWN';this.phaseStartedAt=0;this.lastPullbackAt=0;this.lastPullbackDepth=0;this.breakout=null;}
  update(eyes,{now=Date.now()}={}){
    if(!eyes)return this.map;
    this.id+=1;
    const px=n(eyes.last_price),med=Math.max(n(eyes.median_step,1),1e-9),structure=swingStructure(eyes.candidate_swings||[]),vote=horizonVote(eyes);
    let score=vote.normalized;
    if(structure.bias==='BULLISH')score+=.18;if(structure.bias==='BEARISH')score-=.18;
    const q90=H(eyes,'s90'),q20=H(eyes,'s20'),q10=H(eyes,'s10'),q40=H(eyes,'s40');
    const candidate=score>=.16?'LONG':score<=-.16?'SHORT':'NONE';
    const confidence=Math.round(clamp(Math.abs(score)/.72*100,0,100));
    const previousTrend=this.trend;
    if(candidate!=='NONE'&&(this.trend==='NONE'||candidate===this.trend||confidence>=58)){
      if(candidate!==this.trend){this.trend=candidate;const inferred=inferTrendStart(structure,candidate,now);this.trendStartedAt=inferred.at;this.trendStartPrice=inferred.price??px;this.lastPullbackAt=0;this.lastPullbackDepth=0;}
    }else if(candidate==='NONE'&&confidence<18&&this.trend!=='NONE'&&Math.abs(n(q90?.net))<med*3){this.trend='NONE';this.trendStartedAt=now;this.trendStartPrice=px;}

    const prevMap=this.map,prevHigh=prevMap?.structure?.lastHigh?.price,prevLow=prevMap?.structure?.lastLow?.price;
    if(Number.isFinite(prevHigh)&&px>prevHigh+med*.35&&(prevMap?.price??px)<=prevHigh+med*.35)this.breakout={direction:'LONG',level:prevHigh,at:now};
    if(Number.isFinite(prevLow)&&px<prevLow-med*.35&&(prevMap?.price??px)>=prevLow-med*.35)this.breakout={direction:'SHORT',level:prevLow,at:now};
    if(this.breakout&&now-this.breakout.at>12000)this.breakout=null;

    const leg=recentLeg(eyes,structure),trend=this.trend,short10=side(q10?.net),short20=side(q20?.net),mid40=side(q40?.net),main90=side(q90?.net);
    const align10=same(short10,trend),align20=same(short20,trend),align40=same(mid40,trend),counter10=short10!=='NONE'&&trend!=='NONE'&&short10!==trend;
    const trendTravel=this.trendStartPrice==null?0:(trend==='LONG'?px-this.trendStartPrice:this.trendStartPrice-px);
    const range90=Math.max(n(q90?.range),med),edgeDist=trend==='LONG'?Math.abs(n(q90?.from_high)):trend==='SHORT'?Math.abs(n(q90?.from_low)):range90;
    const extended=trend!=='NONE'&&edgeDist/range90<.08&&trendTravel>med*10&&n(q90?.efficiency)>.28;
    let phase='TRANSITION';
    if(trend==='NONE')phase=n(q20?.efficiency)<.16&&n(q40?.efficiency)<.18?'CHOP':'TRANSITION';
    else if(this.breakout&&this.breakout.direction===trend)phase='BREAKOUT';
    else if(counter10&&side(q20?.net)!==trend&&Math.abs(n(q20?.net))>med*2)phase='PULLBACK';
    else if(extended&&align10&&align20)phase='EXTENDED';
    else if(align10&&align20&&align40){
      const strong=n(q10?.strength)>=1||n(q20?.strength)>=1.1;
      phase=this.lastPullbackAt&&now-this.lastPullbackAt<45000?'RESUMPTION':strong?'IMPULSE':'TRENDING';
    }else if(align20&&align40)phase='TRENDING';
    else phase='TRANSITION';

    const priorPhase=this.phase;
    if(phase==='PULLBACK'){
      this.lastPullbackAt=now;
      const anchor=trend==='LONG'?structure.lastHigh:structure.lastLow;
      if(anchor&&trendTravel>0)this.lastPullbackDepth=clamp(Math.abs(px-n(anchor.price))/Math.max(Math.abs(trendTravel),med),0,2);
    }
    if(phase!==this.phase){this.phase=phase;this.phaseStartedAt=now;}
    const loc=location(eyes,trend),j=journey(eyes.candidate_swings||[],px);
    const protectedLevel=trend==='LONG'?structure.protectedLow?.price:trend==='SHORT'?structure.protectedHigh?.price:null;
    const structureAligned=trend==='LONG'?structure.bias!=='BEARISH':trend==='SHORT'?structure.bias!=='BULLISH':false;

    this.map={
      id:this.id,at:now,price:r(px),medianStep:r(med,4),
      trend:{direction:trend,confidence,ageSec:trend==='NONE'?0:Math.max(0,Math.round((now-this.trendStartedAt)/1000)),startPrice:r(this.trendStartPrice),travel:r(trendTravel),changed:previousTrend!==trend},
      phase,currentLeg:leg,previousPhase:priorPhase,phaseAgeSec:Math.max(0,Math.round((now-this.phaseStartedAt)/1000)),
      structure:{...structure,aligned:structureAligned,protectedLevel:r(protectedLevel)},
      breakout:this.breakout?{direction:this.breakout.direction,level:r(this.breakout.level),ageSec:Math.round((now-this.breakout.at)/1000)}:null,
      location:loc,
      pullback:{recent:Boolean(this.lastPullbackAt&&now-this.lastPullbackAt<45000),ageSec:this.lastPullbackAt?Math.round((now-this.lastPullbackAt)/1000):null,depth:r(this.lastPullbackDepth,3)},
      momentum:{s10:short10,s20:short20,s40:mid40,s90:main90,aligned10:align10,aligned20:align20,aligned40:align40,eff20:r(q20?.efficiency,3),strength10:r(q10?.strength,2),strength20:r(q20?.strength,2)},
      horizons:vote.detail,
      journey:j,
      pattern:`${structure.sequence} · ${phase} · ${trend}`
    };
    return this.map;
  }
}
