import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const STATUS_PATH = path.join(ROOT, 'demo-live-status.json');
const CSV_PATH = path.join(ROOT, 'native-adaptive-trades.csv');
const REFRESH_MS = 3000;

const A={reset:'\x1b[0m',bold:'\x1b[1m',dim:'\x1b[2m',green:'\x1b[32m',red:'\x1b[31m',yellow:'\x1b[33m',cyan:'\x1b[36m',magenta:'\x1b[35m'};
const readJson=(f,d=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const cm=v=>`${Number(v||0)>=0?A.green:A.red}${money(v)}${A.reset}`;
const pad=(s,n)=>{s=String(s??'');return s.length>=n?s.slice(0,n):s+' '.repeat(n-s.length)};
function parseCsvLine(line){const out=[];let s='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){s+='"';i++}else q=!q}else if(c===','&&!q){out.push(s);s=''}else s+=c}out.push(s);return out}
function recentTrades(n=10){try{const lines=fs.readFileSync(CSV_PATH,'utf8').trim().split(/\r?\n/);if(lines.length<2)return[];const h=parseCsvLine(lines[0]);return lines.slice(1).slice(-n).reverse().map(line=>{const v=parseCsvLine(line),r={};h.forEach((k,i)=>r[k]=v[i]);return r})}catch{return[]}}
function shortMode(m){return String(m||'').replaceAll('_',' ')}
function render(){
  const s=readJson(STATUS_PATH,null);console.clear();
  console.log(`${A.bold}${A.cyan}SANI NATIVE V2 · SPEED BOARD${A.reset}`);
  console.log(`${A.dim}${new Date().toLocaleString()} · read-only · Demo only${A.reset}\n`);
  if(!s){console.log(`${A.red}Waiting for ${STATUS_PATH}${A.reset}`);return}
  const e=s.SANI_ADAPTIVE||{};const m=e.mountain||{};const sp=e.speed||{};const p=e.live;
  console.log(`${A.bold}ACCOUNT${A.reset}  ${s.demoOnly?'DEMO ONLY':'CHECK'}  ${s.symbol||'—'}  x${s.multiplier||'—'}  Balance ${A.bold}$${Number(s.balance||0).toFixed(2)}${A.reset}`);
  console.log(`${A.bold}SESSION${A.reset}  ${e.trades||0}T  ${e.wins||0}W/${e.losses||0}L  win ${Number(e.winRate||0).toFixed(1)}%  Demo ${cm(e.realized)}  Model ${cm(e.paperRealized)}`);
  console.log(`${A.dim}Architecture ${s.architecture||'—'} · One contract ${String(Boolean(s.oneContractRule))} · Browser ${String(Boolean(s.browserDependency))} · Vercel ${String(Boolean(s.vercelExecutionDependency))}${A.reset}`);
  console.log(`\n${A.bold}${A.magenta}BRAIN${A.reset}`);
  console.log(`  Mountain: ${A.bold}${m.direction||'NONE'}${A.reset}  Moment: ${shortMode(m.entryMode)}  Confirm: ${Number(m.confirmation||0)}/6`);
  console.log(`  SPEED: ${A.bold}${Number(sp.score||0)}/100 ${sp.label||''}${A.reset}  s3 ${Number(sp.s3||0).toFixed(2)}  s5 ${Number(sp.s5||0).toFixed(2)}  s8 ${Number(sp.s8||0).toFixed(2)}  accel ${Number(sp.accel||0).toFixed(2)}`);
  console.log(`  Appetite: ${A.bold}${e.appetite||'STAND_DOWN'}${A.reset}`);
  console.log(`  Pre-arm: ${e.preArm?`${e.preArm.side} · speed ${e.preArm.speedScore}/100 · confirm ${e.preArm.confirmation}/6`:'—'}`);
  console.log(`  Latency: ${Number(s.lastBuyLatencyMs||0)}ms  Hold: ${s.latencyHold?A.yellow+'YES'+A.reset:'NO'}`);
  if(m.reason)console.log(`  ${A.dim}${String(m.reason).slice(0,170)}${A.reset}`);
  console.log(`\n${A.bold}POSITION${A.reset}`);
  if(!p)console.log(`  ${A.dim}FLAT${A.reset}`);
  else{
    console.log(`  ${A.bold}${p.side}${A.reset} · ${p.appetite} · entry ${Number(p.entry).toFixed(2)} · stop ${Number(p.trailStop??p.stop).toFixed(2)} · target ${Number(p.target).toFixed(2)}`);
    console.log(`  Actual now ${cm(p.actualPnl)} · Peak actual ${cm(p.peakActualPnl)} · Buy latency ${Number(p.buyLatencyMs||0)}ms · entry speed ${Number(p.entrySpeedScore||0)}/100`);
  }
  console.log(`\n${A.bold}RECENT DEMO CLOSES${A.reset}`);
  const rows=recentTrades();
  if(!rows.length)console.log(`  ${A.dim}No closed V2 trades yet.${A.reset}`);
  else{
    console.log(`${A.dim}  ${pad('TIME',10)} ${pad('SIDE',6)} ${pad('MODE',8)} ${pad('SPEED',7)} ${pad('DEMO',9)} ${pad('PEAK',9)} REASON${A.reset}`);
    for(const r of rows){const t=r.closed_at?new Date(r.closed_at).toLocaleTimeString([], {hour12:false}).slice(0,8):'—';console.log(`  ${pad(t,10)} ${pad(r.side,6)} ${pad(r.appetite,8)} ${pad(r.speed_score,7)} ${pad(money(r.demo_pnl),9)} ${pad(money(r.peak_demo_pnl),9)} ${String(r.reason||'').slice(0,60)}`)}
  }
  console.log(`\n${A.dim}Refresh ${REFRESH_MS/1000}s · Ctrl+C closes dashboard only. Trading keeps running.${A.reset}`);
}
render();setInterval(render,REFRESH_MS);
