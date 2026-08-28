import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const STATUS = path.join(ROOT, 'demo-live-status.json');
const CSV = path.join(ROOT, 'native-mountain-grab-trades.csv');
const R=3000;
const A={x:'\x1b[0m',b:'\x1b[1m',d:'\x1b[2m',g:'\x1b[32m',r:'\x1b[31m',y:'\x1b[33m',c:'\x1b[36m',m:'\x1b[35m'};
const j=()=>{try{return JSON.parse(fs.readFileSync(STATUS,'utf8'))}catch{return null}};
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const col=v=>`${Number(v||0)>=0?A.g:A.r}${money(v)}${A.x}`;
const pad=(v,n)=>{v=String(v??'');return v.length>=n?v.slice(0,n):v+' '.repeat(n-v.length)};
function csvLine(line){const a=[];let s='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){s+='"';i++}else q=!q}else if(c===','&&!q){a.push(s);s=''}else s+=c}a.push(s);return a}
function recent(n=12){try{const lines=fs.readFileSync(CSV,'utf8').trim().split(/\r?\n/);if(lines.length<2)return[];const h=csvLine(lines[0]);return lines.slice(1).slice(-n).reverse().map(l=>{const v=csvLine(l),o={};h.forEach((k,i)=>o[k]=v[i]);return o})}catch{return[]}}
function render(){console.clear();const s=j();console.log(`${A.b}${A.c}SANI NATIVE V3 · MOUNTAIN + GRAB${A.x}`);console.log(`${A.d}${new Date().toLocaleString()} · Demo only · read-only monitor${A.x}\n`);if(!s){console.log('Waiting for status...');return}const e=s.SANI_MOUNTAIN_GRAB||{},m=e.mountain||{},p=e.live,g=e.grab||{};
console.log(`${A.b}ACCOUNT${A.x}  ${s.demoOnly?'DEMO ONLY':'CHECK'}  ${s.symbol||'—'}  $${Number(s.stake||0).toFixed(2)} x${s.multiplier||'—'}  Balance ${A.b}$${Number(s.balance||0).toFixed(2)}${A.x}`);
console.log(`${A.b}SESSION${A.x}  ${e.trades||0}T  ${e.wins||0}W/${e.losses||0}L  win ${Number(e.winRate||0).toFixed(1)}%  Actual ${col(e.realized)}  Model ${col(e.modelRealized)}`);
console.log(`${A.dim||A.d}Architecture ${s.architecture||'—'} · one contract ${String(Boolean(s.oneContractRule))} · browser ${String(Boolean(s.browserDependency))} · Vercel ${String(Boolean(s.vercelExecutionDependency))}${A.x}`);
console.log(`\n${A.b}${A.m}MOUNTAIN ENTRY BRAIN${A.x}`);
console.log(`  Direction: ${A.b}${m.direction||'NONE'}${A.x}  State: ${m.state||'—'}  Moment: ${String(m.entryMode||'').replaceAll('_',' ')}  Confirm: ${Number(m.confirmation||0)}/6`);
console.log(`  Important: ${m.important?`${m.important.label||m.important.type} @ ${Number(m.important.quote).toFixed(2)}`:'—'}  Extreme: ${m.extreme?`${m.extreme.label||m.extreme.type} @ ${Number(m.extreme.quote).toFixed(2)}`:'—'}`);
console.log(`  ${A.d}${String(m.reason||'').slice(0,180)}${A.x}`);
console.log(`\n${A.b}GRAB MANAGEMENT${A.x}`);
console.log(`  TP ${Number(g.targetR||.8).toFixed(2)}R · protect ${Number(g.protectAt||.35).toFixed(2)}R → lock +${Number(g.lockR||.05).toFixed(2)}R · cash guard ${Number(g.cashGuardAt||.58).toFixed(2)}R → +${Number(g.cashGuardR||.25).toFixed(2)}R · structural trail from ${Number(g.trailAt||.6).toFixed(2)}R`);
console.log(`\n${A.b}POSITION${A.x}`);if(!p)console.log(`  ${A.d}FLAT${A.x}`);else{console.log(`  ${A.b}${p.side}${A.x} · ${p.entryMode} · confirm ${p.entryConfirmation}/6`);console.log(`  signal ${Number(p.signalQuote).toFixed(2)} · entry ${Number(p.entry).toFixed(2)} · stop ${Number(p.trailStop).toFixed(2)} · TP ${Number(p.target).toFixed(2)}`);console.log(`  Actual ${col(p.actualPnl)} · Peak ${col(p.peakActualPnl)} · Trough ${col(p.troughActualPnl)}`);console.log(`  timing tick→signal ${Number(p.tickToSignalMs||0).toFixed(1)}ms · signal→send ${Number(p.signalToSendMs||0).toFixed(1)}ms · send→ack ${Number(p.sendToAckMs||0).toFixed(1)}ms · total ${Number(p.signalToAckMs||0).toFixed(1)}ms · ${p.proposalSource||'—'}`)}
console.log(`\n${A.b}LAST SIGNAL${A.x}  ${e.lastSignal?`${e.lastSignal.side} · ${e.lastSignal.entryMode} · ${e.lastSignal.confirmation}/6 @ ${Number(e.lastSignal.quote).toFixed(2)}`:'—'}`);
console.log(`\n${A.b}RECENT ACTUAL DEMO CLOSES${A.x}`);const rows=recent();if(!rows.length)console.log(`  ${A.d}No V3 closes yet.${A.x}`);else{console.log(`${A.d}  ${pad('TIME',9)} ${pad('SIDE',6)} ${pad('ENTRY',17)} ${pad('DEMO',8)} ${pad('PEAK',8)} ${pad('SIG→SEND',10)} ${pad('ACK',7)} REASON${A.x}`);for(const r of rows){const t=r.closed_at?new Date(r.closed_at).toLocaleTimeString([], {hour12:false}).slice(0,8):'—';console.log(`  ${pad(t,9)} ${pad(r.side,6)} ${pad(r.entry_mode,17)} ${pad(money(r.demo_pnl),8)} ${pad(money(r.peak_demo_pnl),8)} ${pad(`${Number(r.signal_to_send_ms||0).toFixed(1)}ms`,10)} ${pad(`${Number(r.send_to_ack_ms||0).toFixed(0)}ms`,7)} ${String(r.reason||'').slice(0,46)}`)}}
console.log(`\n${A.d}Refresh ${R/1000}s · Ctrl+C closes dashboard only. Trading continues.${A.x}`)}
render();setInterval(render,R);
