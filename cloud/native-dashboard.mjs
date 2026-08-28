import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const STATUS_PATH = process.env.SANI_STATUS_PATH || path.join(ROOT, 'demo-live-status.json');
const CSV_PATH = process.env.SANI_TRADES_CSV || path.join(ROOT, 'native-demo-trades.csv');
const REFRESH_MS = Math.max(1000, Number(process.env.SANI_DASHBOARD_REFRESH_MS || 3000));
const RECENT_TRADES = Math.max(3, Number(process.env.SANI_DASHBOARD_RECENT || 8));

const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', white: '\x1b[37m'
};

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function money(v) {
  const n = Number(v || 0);
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function colorMoney(v) {
  const n = Number(v || 0);
  return `${n >= 0 ? A.green : A.red}${money(n)}${A.reset}`;
}
function pct(v) { return `${Number(v || 0).toFixed(1)}%`; }
function n2(v) { return Number.isFinite(Number(v)) ? Number(v).toFixed(2) : '—'; }
function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }
function shortMode(mode) {
  const m = String(mode || 'NO_TRADE');
  if (m === 'PULLBACK_END') return 'PULLBACK END';
  if (m === 'EARLY_MOMENTUM') return 'EARLY MOMENTUM';
  if (m === 'WAIT_PULLBACK_END') return 'WAIT PULLBACK END';
  if (m === 'LATE_OR_WAIT') return 'LATE / WAIT';
  return m.replaceAll('_', ' ');
}
function sniperGate(engine, isLms = false) {
  const m = engine?.mountain || {};
  if (!['UP','DOWN'].includes(String(m.direction))) return { ok: false, label: 'WAIT · NO LOCKED MOUNTAIN' };
  if (!['PULLBACK_END','EARLY_MOMENTUM'].includes(String(m.entryMode))) return { ok: false, label: `WAIT · ${shortMode(m.entryMode)}` };
  if (isLms && Number(engine?.power || 0) < 45) return { ok: false, label: `WAIT · POWER ${Number(engine?.power || 0)}/100 < 45` };
  return { ok: true, label: `ARMED · ${shortMode(m.entryMode)}` };
}

function parseCsvLine(line) {
  const out = []; let s = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { s += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { out.push(s); s = ''; }
    else s += c;
  }
  out.push(s);
  return out;
}
function recentTrades() {
  try {
    const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const head = parseCsvLine(lines[0]);
    return lines.slice(-RECENT_TRADES).reverse().map(line => {
      const vals = parseCsvLine(line); const r = {};
      head.forEach((h, i) => r[h] = vals[i]);
      return r;
    });
  } catch { return []; }
}
function posLine(e) {
  const p = e?.live;
  if (!p) return `${A.dim}FLAT${A.reset}`;
  return `${A.bold}${p.side}${A.reset} @ ${n2(p.entry)}  stop ${n2(p.trailStop ?? p.stop)}  target ${n2(p.target)}  x${p.multiplier ?? '—'}`;
}
function engineBlock(name, e, isLms = false) {
  const gate = sniperGate(e, isLms);
  const m = e?.mountain || {};
  const lines = [];
  lines.push(`${A.bold}${A.magenta}${name}${A.reset}  ${e?.trades || 0}T  ${e?.wins || 0}W/${e?.losses || 0}L  win ${pct(e?.winRate)}  Demo ${colorMoney(e?.realized)}  Model ${colorMoney(e?.paperRealized)}`);
  lines.push(`  Position: ${posLine(e)}`);
  lines.push(`  Mountain: ${A.bold}${m.direction || 'NONE'}${A.reset}  Moment: ${shortMode(m.entryMode)}  Confirm: ${Number(m.confirmation || 0)}/6${isLms ? `  Power: ${Number(e?.power || 0)}/100  Mode: GRAB` : ''}`);
  lines.push(`  Entry gate: ${gate.ok ? A.green + '🎯 ' : A.yellow + '⌛ '}${gate.label}${A.reset}`);
  if (m.reason) lines.push(`  ${A.dim}${String(m.reason).slice(0, 150)}${A.reset}`);
  return lines.join('\n');
}

function render() {
  const s = readJson(STATUS_PATH, null);
  console.clear();
  console.log(`${A.bold}${A.cyan}SANI NATIVE DEMO · LIVE BOARD${A.reset}`);
  console.log(`${A.dim}${new Date().toLocaleString()} · read-only monitor · trading logic untouched${A.reset}`);
  console.log('');
  if (!s) {
    console.log(`${A.red}Status file not found yet:${A.reset} ${STATUS_PATH}`);
    return;
  }
  const total = Number(s.COMET?.realized || 0) + Number(s.LAST_MAN_GRAB?.realized || 0);
  const model = Number(s.COMET?.paperRealized || 0) + Number(s.LAST_MAN_GRAB?.paperRealized || 0);
  console.log(`${A.bold}ACCOUNT${A.reset}  ${s.demoOnly ? 'DEMO ONLY' : 'CHECK MODE'}  ${s.symbol || '—'}  x${s.multiplier || '—'}  Balance ${A.bold}$${Number(s.balance || 0).toFixed(2)}${A.reset}`);
  console.log(`${A.bold}SESSION${A.reset}  Demo combined ${colorMoney(total)}  Model combined ${colorMoney(model)}  Last event: ${s.lastEvent || '—'}`);
  console.log(`${A.dim}Architecture ${s.architecture || '—'} · Browser dependency ${String(Boolean(s.browserDependency))} · Vercel execution ${String(Boolean(s.vercelExecutionDependency))}${A.reset}`);
  console.log('\n' + engineBlock('COMET', s.COMET, false));
  console.log('\n' + engineBlock('LAST MAN · GRAB', s.LAST_MAN_GRAB, true));

  const rows = recentTrades();
  console.log(`\n${A.bold}RECENT DEMO CLOSES${A.reset}`);
  if (!rows.length) console.log(`${A.dim}  No closed native trades yet.${A.reset}`);
  else {
    console.log(`${A.dim}  ${pad('TIME',10)} ${pad('ENGINE',14)} ${pad('SIDE',6)} ${pad('DEMO',9)} ${pad('R',7)} ${pad('MOMENT',18)} REASON${A.reset}`);
    for (const r of rows) {
      const t = r.closed_at ? new Date(r.closed_at).toLocaleTimeString([], { hour12: false }).slice(0,8) : '—';
      const pnl = Number(r.demo_pnl || 0);
      console.log(`  ${pad(t,10)} ${pad(r.engine === 'LAST_MAN_GRAB' ? 'LMS GRAB' : r.engine,14)} ${pad(r.side,6)} ${pad(money(pnl),9)} ${pad(`${Number(r.paper_r || 0).toFixed(2)}R`,7)} ${pad(shortMode(r.entry_mode),18)} ${String(r.reason || '').slice(0,55)}`);
    }
  }
  console.log(`\n${A.dim}Refresh ${REFRESH_MS/1000}s · Ctrl+C exits dashboard only. Trading service keeps running.${A.reset}`);
}

render();
setInterval(render, REFRESH_MS);
