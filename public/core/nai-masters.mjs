import {ENTRY_RULES,EXIT_RULES,TRAIL_RULES,exitSignal,trailSettings} from './nai-strategy-lab.mjs';

const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const same=(a,b)=>a&&b&&a===b;
const sideNet=(side,v)=>side==='LONG'?n(v):-n(v);

function personality(strategy){
  const risk=strategy.exit==='X1'?'CAUTIOUS':strategy.exit==='X2'?'MOMENTUM':'PATIENT';
  const runner=strategy.trail==='T3'?'RUNNER':strategy.trail==='T2'?'BALANCED':'QUICK';
  const minTrend=risk==='CAUTIOUS'?54:risk==='MOMENTUM'?46:40;
  const extensionTolerance=runner==='RUNNER'?.78:runner==='BALANCED'?.62:.46;
  return{risk,runner,minTrend,extensionTolerance};
}

function reject(reason){return{action:'WAIT',side:null,score:0,reason}}
function accept(side,score,reason,thesis){return{action:'ENTER',side,score:Math.round(clamp(score,0,100)),reason,thesis}}

function impulseMaster(strategy,map,eyes,p){
  const trend=map?.trend?.direction;if(!['LONG','SHORT'].includes(trend))return reject('No dominant trend');
  if(map.trend.confidence<p.minTrend)return reject(`Trend confidence ${map.trend.confidence}% below ${p.minTrend}%`);
  const m=map.momentum,phase=map.phase;
  const aligned=m.aligned10&&m.aligned20&&(m.aligned40||map.trend.confidence>=68);
  const strong=n(m.strength10)>=.9&&n(m.strength20)>=.8&&n(m.eff20)>=.28;
  if(!aligned||!strong)return reject('Impulse alignment/quality not strong enough');
  if(!['IMPULSE','BREAKOUT','RESUMPTION','TRENDING','EXTENDED'].includes(phase))return reject(`Phase ${phase} is not attackable`);
  if(phase==='EXTENDED'&&p.extensionTolerance<.7)return reject('Too extended for this master');
  if(map.location==='AT_TREND_EDGE'&&p.runner==='QUICK'&&phase!=='BREAKOUT')return reject('Quick master avoids chasing edge');
  const bonus=phase==='BREAKOUT'?14:phase==='IMPULSE'?12:phase==='RESUMPTION'?10:4;
  const score=map.trend.confidence+bonus+n(m.eff20)*20;
  return accept(trend,score,`E1 ${phase} · ${map.pattern}`,`Attack ${trend} while whole-map impulse remains aligned`);
}

function resumptionMaster(strategy,map,eyes,p){
  const trend=map?.trend?.direction;if(!['LONG','SHORT'].includes(trend))return reject('No dominant trend');
  if(map.trend.confidence<Math.max(38,p.minTrend-8))return reject('Main trend too weak');
  if(!map.pullback?.recent)return reject('No recent pullback in master map');
  if(!['RESUMPTION','TRENDING','BREAKOUT'].includes(map.phase))return reject(`Waiting for resumption, now ${map.phase}`);
  if(!map.momentum.aligned10||!map.momentum.aligned20)return reject('Short momentum has not resumed');
  if(!map.structure.aligned)return reject('Structure no longer supports main trend');
  const depth=n(map.pullback.depth);
  if(depth>1.05)return reject('Pullback too deep');
  if(p.risk==='CAUTIOUS'&&depth<.08)return reject('Not enough pullback for cautious resumption master');
  const score=map.trend.confidence+18-clamp(depth*12,0,14)+n(map.momentum.eff20)*14;
  return accept(trend,score,`E2 pullback depth ${depth.toFixed(2)} · ${map.phase}`,`Join ${trend} after pullback resolves without breaking protected structure`);
}

function breakMaster(strategy,map,eyes,p){
  const b=map?.breakout;if(!b||!['LONG','SHORT'].includes(b.direction))return reject('No fresh master-map breakout');
  const trend=map.trend.direction;
  if(trend!==b.direction&&map.trend.confidence>45)return reject('Breakout fights dominant trend');
  if(n(b.ageSec)>9&&p.runner==='QUICK')return reject('Quick breakout master considers break stale');
  if(n(b.ageSec)>12)return reject('Breakout too old');
  if(!map.momentum.aligned20)return reject('20s momentum does not confirm breakout');
  if(p.risk==='CAUTIOUS'&&!map.structure.aligned)return reject('Cautious breakout needs aligned structure');
  const score=map.trend.confidence+20-Math.min(12,n(b.ageSec));
  return accept(b.direction,score,`E3 broke ${n(b.level).toFixed(2)} · age ${b.ageSec}s`,`${b.direction} structure break inside ${map.pattern}`);
}

export function masterEntryDecision(strategy,map,eyes){
  if(!strategy||!map)return reject('Master map unavailable');
  const p=personality(strategy);
  const base=strategy.entry==='E1'?impulseMaster(strategy,map,eyes,p):strategy.entry==='E2'?resumptionMaster(strategy,map,eyes,p):breakMaster(strategy,map,eyes,p);
  return{...base,master:strategy.id,personality:p,entryName:ENTRY_RULES[strategy.entry]?.name,exitName:EXIT_RULES[strategy.exit]?.name,trailName:TRAIL_RULES[strategy.trail]?.name};
}

function mapThesisBroken(position,map,strategy){
  if(!position||!map)return null;const side=position.side,trend=map.trend.direction;
  if(strategy.exit==='X1'){
    if(map.structure?.protectedLevel!=null){const px=n(map.price),lvl=n(map.structure.protectedLevel),step=Math.max(n(map.medianStep,1),1e-9);if(side==='LONG'&&px<lvl-step*.7)return'X1 MASTER PROTECTED LOW BROKEN';if(side==='SHORT'&&px>lvl+step*.7)return'X1 MASTER PROTECTED HIGH BROKEN';}
    if(trend!=='NONE'&&trend!==side&&map.trend.confidence>=58)return'X1 MASTER TREND FLIPPED';
  }
  if(strategy.exit==='X2'){
    if(map.phase==='TRANSITION'&&map.momentum.aligned10===false&&map.momentum.aligned20===false&&position.peakProfit>0)return'X2 MASTER MOMENTUM TRANSITION';
    if(trend!=='NONE'&&trend!==side&&map.trend.confidence>=48)return'X2 MASTER MOMENTUM FLIP';
  }
  if(strategy.exit==='X3'){
    if(trend!=='NONE'&&trend!==side&&map.trend.confidence>=70)return'X3 MASTER HARD TREND FLIP';
  }
  return null;
}

export function masterExitDecision(strategy,position,map,eyes){
  const mapped=mapThesisBroken(position,map,strategy);if(mapped)return mapped;
  return exitSignal(strategy.exit,position,eyes);
}

export function masterTrailSettings(strategy,map,eyes,position=null){
  const base=trailSettings(strategy.trail,eyes,position);
  if(strategy.trail!=='T3'||!map)return base;
  let gap=base.trailGap;
  if(['IMPULSE','RESUMPTION','BREAKOUT'].includes(map.phase)&&map.trend.confidence>=60)gap=Math.max(gap,.24);
  if(map.phase==='EXTENDED')gap=Math.min(gap,.18);
  if(map.phase==='TRANSITION'||map.phase==='CHOP')gap=Math.min(gap,.14);
  return{...base,trailGap:Number(gap.toFixed(2)),name:`${base.name} · ${map.phase}`};
}
