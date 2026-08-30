const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const abs=v=>Math.abs(n(v));
const dir=v=>n(v)>0?'LONG':n(v)<0?'SHORT':null;
const aligned=(a,b)=>a&&b&&a===b;
const opposite=s=>s==='LONG'?'SHORT':'LONG';
const h=(eyes,k)=>eyes?.horizons?.[k]||null;
const step=eyes=>Math.max(n(eyes?.median_step,1),1e-9);
const sideNet=(side,v)=>side==='LONG'?n(v):-n(v);

export const ENTRY_RULES={
  E1:{name:'IMPULSE ATTACK',description:'Attack a fresh directional burst when 20s/40s agree and path quality is strong.'},
  E2:{name:'PULLBACK + RESUMPTION',description:'Join the 90s move after a short counter-leg starts resolving back with the main direction.'},
  E3:{name:'STRUCTURE BREAK',description:'Trade a break beyond the latest meaningful swing with 20s/40s confirmation.'}
};
export const EXIT_RULES={
  X1:{name:'STRUCTURE INVALIDATION',description:'Exit when the thesis direction loses short structure or the protected swing is violated.'},
  X2:{name:'MOMENTUM DIES',description:'Exit when 10s/20s momentum materially reverses or efficiency collapses.'},
  X3:{name:'TARGET + TIME HYBRID',description:'Take strong profit, cut clear pain, or time out a stale trade.'}
};
export const TRAIL_RULES={
  T1:{name:'FAST',description:'Tight local trail after first profit.',gap:.12,minLock:.01},
  T2:{name:'BALANCED',description:'Moderate trail designed to leave more breathing room.',gap:.22,minLock:.01},
  T3:{name:'ADAPTIVE',description:'Trail gap expands/contracts with current median step and trend strength.',gap:.18,minLock:.01}
};

export function makeStrategies(){const out=[];for(const e of Object.keys(ENTRY_RULES))for(const x of Object.keys(EXIT_RULES))for(const t of Object.keys(TRAIL_RULES))out.push({id:`${e}-${x}-${t}`,entry:e,exit:x,trail:t,label:`${e} · ${x} · ${t}`});return out}

function freshImpulse(eyes){const s=step(eyes),a=h(eyes,'s10'),b=h(eyes,'s20'),c=h(eyes,'s40'),d=h(eyes,'s90');if(!a||!b||!c)return null;const side=dir(b.net);if(!side||!aligned(side,dir(c.net)))return null;const fresh=abs(a.net)>=s*2.5&&abs(b.net)>=s*4.5;const quality=n(b.efficiency)>=.42&&n(c.efficiency)>=.28&&n(a.strength)>=1.1;const background=!d||dir(d.net)===side||abs(d.net)<s*4;const notDead=n(b.from_high)>-abs(b.range)*.98||side==='SHORT';const notDead2=n(b.from_low)<abs(b.range)*.98||side==='LONG';if(fresh&&quality&&background&&notDead&&notDead2)return{side,reason:`20s ${n(b.net).toFixed(2)} · 40s ${n(c.net).toFixed(2)} · eff ${n(b.efficiency).toFixed(2)}`};return null}

function pullbackResumption(eyes){const s=step(eyes),a=h(eyes,'s10'),b=h(eyes,'s20'),c=h(eyes,'s40'),d=h(eyes,'s90');if(!a||!b||!c||!d)return null;const main=dir(d.net);if(!main||abs(d.net)<s*7||n(d.efficiency)<.22)return null;const resumed10=dir(a.net)===main&&sideNet(main,a.net)>=s*2;const fortySupports=dir(c.net)===main&&sideNet(main,c.net)>=s*3;const twentyNotOpposed=sideNet(main,b.net)>=-s*2.5;const locationOkay=main==='LONG'?n(d.from_high)<=-s*.2:n(d.from_low)>=s*.2;const recovering=n(a.efficiency)>=.35&&n(a.strength)>=.8;if(resumed10&&fortySupports&&twentyNotOpposed&&recovering&&locationOkay)return{side:main,reason:`90s main ${n(d.net).toFixed(2)} · 10s resumed ${n(a.net).toFixed(2)}`};return null}

function structureBreak(eyes){const s=step(eyes),a=h(eyes,'s10'),b=h(eyes,'s20'),c=h(eyes,'s40'),sw=Array.isArray(eyes?.candidate_swings)?eyes.candidate_swings:[];if(!a||!b||!c||sw.length<2)return null;const px=n(eyes.last_price),lastHigh=[...sw].reverse().find(x=>x.type==='HIGH'),lastLow=[...sw].reverse().find(x=>x.type==='LOW');if(lastHigh&&px>n(lastHigh.price)+s*.35&&dir(b.net)==='LONG'&&dir(c.net)==='LONG'&&n(b.efficiency)>=.3)return{side:'LONG',reason:`broke HIGH ${n(lastHigh.price).toFixed(2)} · px ${px.toFixed(2)}`};if(lastLow&&px<n(lastLow.price)-s*.35&&dir(b.net)==='SHORT'&&dir(c.net)==='SHORT'&&n(b.efficiency)>=.3)return{side:'SHORT',reason:`broke LOW ${n(lastLow.price).toFixed(2)} · px ${px.toFixed(2)}`};return null}

export function entrySignal(entryId,eyes){if(entryId==='E1')return freshImpulse(eyes);if(entryId==='E2')return pullbackResumption(eyes);if(entryId==='E3')return structureBreak(eyes);return null}

function structureExit(position,eyes){const s=step(eyes),side=position.side,a=h(eyes,'s20'),b=h(eyes,'s40'),sw=Array.isArray(eyes?.candidate_swings)?eyes.candidate_swings:[];if(!a||!b)return null;const strongOpp=sideNet(side,a.net)<-s*3&&sideNet(side,b.net)<-s*3;const lastHigh=[...sw].reverse().find(x=>x.type==='HIGH'),lastLow=[...sw].reverse().find(x=>x.type==='LOW'),px=n(eyes.last_price);const swingBroken=side==='LONG'&&lastLow&&px<n(lastLow.price)-s*.5||side==='SHORT'&&lastHigh&&px>n(lastHigh.price)+s*.5;if(strongOpp||swingBroken)return'X1 STRUCTURE INVALIDATED';return null}
function momentumExit(position,eyes){const s=step(eyes),side=position.side,a=h(eyes,'s10'),b=h(eyes,'s20');if(!a||!b)return null;const reverse=sideNet(side,a.net)<-s*2.2&&sideNet(side,b.net)<-s*2.5;const collapse=n(b.efficiency)<.13&&position.peakProfit>0.08&&position.liveProfit<position.peakProfit*.35;if(reverse||collapse)return'X2 MOMENTUM DIED';return null}
function hybridExit(position){const age=(Date.now()-position.boughtAt)/1000;if(position.liveProfit>=.95)return'X3 PROFIT TARGET';if(position.liveProfit<=-.85)return'X3 LOSS CUT';if(age>=75&&position.liveProfit<.12)return'X3 STALE 75S';if(age>=150)return'X3 MAX 150S';return null}
export function exitSignal(exitId,position,eyes){if(exitId==='X1')return structureExit(position,eyes);if(exitId==='X2')return momentumExit(position,eyes);if(exitId==='X3')return hybridExit(position);return null}

export function trailSettings(trailId,eyes,position=null){const base=TRAIL_RULES[trailId]||TRAIL_RULES.T2;if(trailId!=='T3')return{trailGap:base.gap,minLock:base.minLock,name:base.name};const s=step(eyes),a=h(eyes,'s20'),strength=n(a?.strength),eff=n(a?.efficiency),p=Math.max(0,n(position?.peakProfit));let gap=.18;if(strength>=2&&eff>=.45)gap=.30;else if(strength>=1.2&&eff>=.3)gap=.24;else if(strength<.7||eff<.18)gap=.13;if(p>=.75)gap=Math.min(gap,.20);return{trailGap:Number(gap.toFixed(2)),minLock:.01,name:'ADAPTIVE'} }

export function summarizeStrategy(strategy,trades,open=null){const rows=trades.filter(x=>x.owner===strategy.id),wins=rows.filter(x=>x.pnl>0),losses=rows.filter(x=>x.pnl<0),sum=a=>a.reduce((s,x)=>s+n(x.pnl),0),pnl=sum(rows),grossWin=sum(wins),grossLoss=Math.abs(sum(losses)),avg=a=>a.length?sum(a)/a.length:0;let peak=0,dd=0,equity=0;for(const r of [...rows].reverse()){equity+=n(r.pnl);peak=Math.max(peak,equity);dd=Math.max(dd,peak-equity)}return{id:strategy.id,entry:strategy.entry,exit:strategy.exit,trail:strategy.trail,trades:rows.length,wins:wins.length,losses:losses.length,pnl:Number(pnl.toFixed(4)),winRate:rows.length?wins.length/rows.length*100:0,avgWin:avg(wins),avgLoss:avg(losses),expectancy:rows.length?pnl/rows.length:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?99:0,maxDrawdown:dd,open:Boolean(open),live:n(open?.liveProfit),peakLive:n(open?.peakProfit)} }
