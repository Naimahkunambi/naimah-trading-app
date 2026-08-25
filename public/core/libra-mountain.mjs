const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const finite=v=>Number.isFinite(Number(v));
const median=values=>{const rows=values.filter(finite).map(Number).sort((a,b)=>a-b);if(!rows.length)return 0;const m=Math.floor(rows.length/2);return rows.length%2?rows[m]:(rows[m-1]+rows[m])/2};
const mean=values=>values.length?values.reduce((a,v)=>a+Number(v||0),0)/values.length:0;

function cleanTicks(input=[],limit=420){
  const out=[];let last='';
  for(const raw of input||[]){const epoch=Number(raw?.epoch),quote=Number(raw?.quote);if(!finite(epoch)||!finite(quote))continue;const key=`${epoch}:${quote}`;if(key===last)continue;out.push({epoch,quote});last=key}
  return out.sort((a,b)=>a.epoch-b.epoch).slice(-limit);
}
function stepStats(rows){
  const diffs=[];for(let i=1;i<rows.length;i++)diffs.push(Math.abs(rows[i].quote-rows[i-1].quote));
  const recent=diffs.slice(-80).filter(v=>v>0),typical=median(recent)||mean(recent)||1,avg=mean(recent)||typical;
  return{typical,avg};
}
function pathEfficiency(rows){if(rows.length<2)return 0;let path=0;for(let i=1;i<rows.length;i++)path+=Math.abs(rows[i].quote-rows[i-1].quote);return path?Math.abs(rows.at(-1).quote-rows[0].quote)/path:0}
function normSlope(rows,n,step){const slice=rows.slice(-Math.max(2,n));if(slice.length<2)return 0;return (slice.at(-1).quote-slice[0].quote)/Math.max(1,slice.length-1)/Math.max(step,1e-9)}
function directionalCount(rows,n,sign){const slice=rows.slice(-Math.max(2,n));let count=0;for(let i=1;i<slice.length;i++){const d=slice[i].quote-slice[i-1].quote;if(sign>0&&d>0)count++;if(sign<0&&d<0)count++}return count}

function rawPivots(rows,step){
  const candidates=[];
  for(let i=1;i<rows.length-1;i++){
    const p=rows[i].quote,l=rows[i-1].quote,r=rows[i+1].quote;
    if(p>=l&&p>=r&&(p>l||p>r))candidates.push({...rows[i],index:i,type:'H'});
    if(p<=l&&p<=r&&(p<l||p<r))candidates.push({...rows[i],index:i,type:'L'});
  }
  if(candidates.length){const first=candidates[0];candidates.unshift({...rows[0],index:0,type:first.type==='H'?'L':'H',syntheticStart:true})}
  const prominence=Math.max(step*.45,1e-9),out=[];
  for(const pivot of candidates){
    if(!out.length){out.push(pivot);continue}
    const last=out.at(-1);
    if(last.type===pivot.type){
      const moreExtreme=pivot.type==='H'?pivot.quote>=last.quote:pivot.quote<=last.quote;
      if(moreExtreme)out[out.length-1]=pivot;
      continue;
    }
    if(Math.abs(pivot.quote-last.quote)>=prominence)out.push(pivot);
  }
  return out;
}

function labelPivots(pivots,tol){
  let lastHigh=null,lastLow=null;
  return pivots.map(p=>{
    let label=p.type;
    if(p.type==='H'){
      if(lastHigh)label=p.quote>lastHigh.quote+tol?'HH':p.quote<lastHigh.quote-tol?'LH':'EH';
      lastHigh=p;
    }else{
      if(lastLow)label=p.quote>lastLow.quote+tol?'HL':p.quote<lastLow.quote-tol?'LL':'EL';
      lastLow=p;
    }
    return{...p,label,important:false};
  });
}

function structureEvents(pivots,tol){
  const events=[];
  for(let i=2;i<pivots.length;i++){
    const a=pivots[i-2],b=pivots[i-1],c=pivots[i];
    if(a.type==='H'&&b.type==='L'&&c.type==='H'&&c.quote>a.quote+tol){
      events.push({direction:'UP',at:c.epoch,index:c.index,important:{...b,label:'HL',important:true},extreme:{...c,label:'HH'},priorExtreme:a});
    }
    if(a.type==='L'&&b.type==='H'&&c.type==='L'&&c.quote<a.quote-tol){
      events.push({direction:'DOWN',at:c.epoch,index:c.index,important:{...b,label:'LH',important:true},extreme:{...c,label:'LL'},priorExtreme:a});
    }
  }
  return events;
}

function findStart(rows,event,direction,step){
  const end=Math.max(0,Number(event?.priorExtreme?.index??event?.index??rows.length-1));
  const from=Math.max(0,end-42),slice=rows.slice(from,end+1);
  if(!slice.length)return rows[0]||null;
  const point=direction==='UP'?slice.reduce((a,b)=>b.quote<a.quote?b:a):slice.reduce((a,b)=>b.quote>a.quote?b:a);
  const move=Math.abs(Number(event?.extreme?.quote??rows.at(-1).quote)-point.quote);
  return move>=step*3?point:(rows[Math.max(0,end-12)]||point);
}

function establishMountain(rows,pivots,events,step,tol){
  let state={direction:'NONE',start:null,important:null,extreme:null,confirmedAt:0,reason:'No locked mountain yet.'};
  for(const event of events){
    if(state.direction==='NONE'){
      state={direction:event.direction,start:findStart(rows,event,event.direction,step),important:event.important,extreme:event.extreme,confirmedAt:event.at,reason:`${event.direction} structure confirmed by ${event.direction==='UP'?'HH + HL':'LL + LH'}.`};
      continue;
    }
    if(event.direction===state.direction){state.important=event.important;state.extreme=event.extreme;state.confirmedAt=event.at;state.reason=`${event.direction} mountain retained; latest important ${event.important.label} held and produced ${event.extreme.label}.`;continue}
    if(state.direction==='UP'&&event.direction==='DOWN'){
      const broke=state.important&&event.extreme.quote<state.important.quote-tol;
      const lowerHigh=state.extreme&&event.important.quote<state.extreme.quote-tol;
      if(broke&&lowerHigh)state={direction:'DOWN',start:findStart(rows,event,'DOWN',step),important:event.important,extreme:event.extreme,confirmedAt:event.at,reason:'UP mountain ended only after important HL broke and LH + LL confirmed DOWN.'};
    }else if(state.direction==='DOWN'&&event.direction==='UP'){
      const broke=state.important&&event.extreme.quote>state.important.quote+tol;
      const higherLow=state.extreme&&event.important.quote>state.extreme.quote+tol;
      if(broke&&higherLow)state={direction:'UP',start:findStart(rows,event,'UP',step),important:event.important,extreme:event.extreme,confirmedAt:event.at,reason:'DOWN mountain ended only after important LH broke and HL + HH confirmed UP.'};
    }
  }
  return state;
}

function directMountain(rows,step){
  const slice=rows.slice(-24);if(slice.length<7)return null;
  const net=slice.at(-1).quote-slice[0].quote,eff=pathEfficiency(slice),distance=Math.abs(net)/Math.max(step,1e-9);
  if(distance<4.2||eff<.62)return null;
  const direction=net>0?'UP':'DOWN';
  const start=direction==='UP'?slice.reduce((a,b)=>b.quote<a.quote?b:a):slice.reduce((a,b)=>b.quote>a.quote?b:a);
  return{direction,start,important:null,extreme:{...slice.at(-1),label:direction==='UP'?'HH':'LL'},confirmedAt:slice.at(-1).epoch,reason:`Direct ${direction} mountain: strong one-way distance with no proper pullback yet.`,direct:true};
}

function progressionWeak(pivots,direction,step){
  const same=pivots.filter(p=>direction==='UP'?p.type==='H':p.type==='L').slice(-3);if(same.length<3)return false;
  const a=Math.abs(same[1].quote-same[0].quote),b=Math.abs(same[2].quote-same[1].quote);
  return b<step*1.05||b<Math.max(step*.5,a*.35);
}

function entryState(rows,mountain,pivots,step){
  const direction=mountain.direction,current=rows.at(-1),sign=direction==='UP'?1:-1;
  if(!['UP','DOWN'].includes(direction))return{mode:'NO_TRADE',allowedDirection:'NONE',anchor:null,confirmation:0,reason:'No locked mountain.'};
  const recent21=rows.slice(-21),eff21=pathEfficiency(recent21),s3=normSlope(rows,3,step)*sign,s5=normSlope(rows,5,step)*sign,s8=normSlope(rows,8,step)*sign;
  const accel=s3-s8;
  const q=rows.map(r=>r.quote),n=q.length,curve=n>=3?((q[n-1]-q[n-2])-(q[n-2]-q[n-3]))/Math.max(step,1e-9)*sign:0;
  const confirms=directionalCount(rows,4,sign);
  const lastExtreme=[...pivots].reverse().find(p=>direction==='UP'?p.type==='H':p.type==='L')||mountain.extreme;
  const fromIndex=Math.max(0,Number(lastExtreme?.index??Math.max(0,rows.length-12)));
  const since=rows.slice(fromIndex);
  const anchor=direction==='UP'?since.reduce((a,b)=>b.quote<a.quote?b:a):since.reduce((a,b)=>b.quote>a.quote?b:a);
  const pullbackDistance=lastExtreme?Math.abs(lastExtreme.quote-anchor.quote):0;
  const hasPullback=Boolean(lastExtreme&&anchor.epoch>lastExtreme.epoch&&pullbackDistance>=step*.75);
  const anchorPos=rows.findIndex(r=>r.epoch===anchor.epoch&&r.quote===anchor.quote),ageFromAnchor=anchorPos>=0?rows.length-1-anchorPos:99;
  const recoverDistance=Math.abs(current.quote-anchor.quote)/Math.max(step,1e-9);
  const lastThree=rows.slice(-4,-1).map(r=>r.quote);
  const smallBreak=lastThree.length?direction==='UP'?current.quote>Math.max(...lastThree):current.quote<Math.min(...lastThree):false;
  const confirmation=[s3>.06,accel>-.02,curve>-.15,confirms>=2,smallBreak,recoverDistance>=.35].filter(Boolean).length;
  const weak=progressionWeak(pivots,direction,step)||(eff21<.22&&rows.length>30);
  const startIndex=mountain.start?rows.findIndex(r=>r.epoch===mountain.start.epoch&&r.quote===mountain.start.quote):-1;
  const ageFromStart=startIndex>=0?rows.length-1-startIndex:99;
  const distanceFromStart=mountain.start?Math.abs(current.quote-mountain.start.quote)/Math.max(step,1e-9):99;

  if(weak)return{mode:'EXHAUSTION',allowedDirection:direction==='UP'?'CALL':'PUT',anchor,confirmation,reason:'Mountain still points the same way, but progression is flattening. No fresh sniper entry.'};
  if(hasPullback){
    if(ageFromAnchor<=7&&confirmation>=4)return{mode:'PULLBACK_END',allowedDirection:direction==='UP'?'CALL':'PUT',anchor,confirmation,reason:`Pullback is curling back with the ${direction} mountain. This is the preferred sniper zone.`};
    return{mode:'WAIT_PULLBACK_END',allowedDirection:direction==='UP'?'CALL':'PUT',anchor,confirmation,reason:`Opposite move is still treated as a pullback. Wait for curve/slope/2–3 confirmations back ${direction}.`};
  }
  if(mountain.direct&&ageFromStart<=12&&distanceFromStart<=8.5&&s5>.08&&confirms>=2)return{mode:'EARLY_MOMENTUM',allowedDirection:direction==='UP'?'CALL':'PUT',anchor:mountain.start,confirmation,reason:`Direct ${direction} mountain. Momentum is early enough to join; do not chase it later.`};
  return{mode:'LATE_OR_WAIT',allowedDirection:direction==='UP'?'CALL':'PUT',anchor:null,confirmation,reason:`Mountain is ${direction}, but there is no fresh pullback-end entry. Wait rather than enter in the middle/top of the move.`};
}

export function analyzeMountain(inputTicks=[]){
  const rows=cleanTicks(inputTicks);if(rows.length<7)return{ready:false,direction:'NONE',allowedDirection:'NONE',state:'WARMING',entryMode:'NO_TRADE',pivots:[],reason:`Need more market shape (${rows.length}/7).`};
  const{typical,avg}=stepStats(rows),step=Math.max(typical,avg*.55,1e-9),tol=step*.35;
  let pivots=labelPivots(rawPivots(rows,step),tol);
  const events=structureEvents(pivots,tol);
  let mountain=establishMountain(rows,pivots,events,step,tol);
  if(mountain.direction==='NONE')mountain=directMountain(rows,step)||mountain;
  if(mountain.important){pivots=pivots.map(p=>p.epoch===mountain.important.epoch&&p.type===mountain.important.type?{...p,important:true,label:mountain.important.label}:p)}
  const recent=rows.slice(-34),eff34=pathEfficiency(recent),range34=Math.max(...recent.map(r=>r.quote))-Math.min(...recent.map(r=>r.quote));
  const chop=mountain.direction==='NONE'&&eff34<.34&&range34<=step*8.5;
  if(chop)return{ready:true,direction:'CHOP',allowedDirection:'NONE',state:'CHOP',entryMode:'NO_TRADE',start:null,important:null,pivots,events,step,efficiency34:eff34,reason:'No meaningful directional distance. Mixed highs/lows are staying horizontal, so this is CHOP.'};
  const entry=entryState(rows,mountain,pivots,step);
  return{
    ready:true,direction:mountain.direction,allowedDirection:entry.allowedDirection,state:mountain.direct?'DIRECT_MOUNTAIN':'STRUCTURED_MOUNTAIN',entryMode:entry.mode,
    start:mountain.start?{epoch:mountain.start.epoch,quote:mountain.start.quote}:null,
    important:mountain.important?{epoch:mountain.important.epoch,quote:mountain.important.quote,type:mountain.important.type,label:mountain.important.label}:null,
    extreme:mountain.extreme?{epoch:mountain.extreme.epoch,quote:mountain.extreme.quote,type:mountain.extreme.type,label:mountain.extreme.label}:null,
    entryAnchor:entry.anchor?{epoch:entry.anchor.epoch,quote:entry.anchor.quote}:null,
    confirmation:entry.confirmation,pivots,events,step,efficiency34:eff34,
    reason:`${mountain.reason} ${entry.reason}`
  };
}

export function mountainAllows(mountain,direction){
  if(!mountain?.ready||!['CALL','PUT'].includes(direction))return{allowed:false,reason:'Mountain is not ready.'};
  if(mountain.direction==='CHOP'||mountain.allowedDirection==='NONE')return{allowed:false,reason:'CHOP. No paid direction.'};
  if(direction!==mountain.allowedDirection)return{allowed:false,reason:`Wrong side of the mountain. ${mountain.direction} mountain allows ${mountain.allowedDirection} only.`};
  if(!['PULLBACK_END','EARLY_MOMENTUM'].includes(mountain.entryMode))return{allowed:false,reason:`Correct mountain side, wrong moment: ${mountain.entryMode}.`};
  return{allowed:true,reason:`${mountain.direction} mountain + ${mountain.entryMode}.`};
}
