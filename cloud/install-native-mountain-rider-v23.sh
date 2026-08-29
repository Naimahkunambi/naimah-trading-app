#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
SERVICE="sani-native-speed"
RUNNER="$ROOT/native-speed-runner.mjs"
BOARD="$ROOT/native-speed-dashboard.mjs"
STAMP="$(date +%Y%m%d-%H%M%S)"
BASE="https://raw.githubusercontent.com/Naimahkunambi/naimah-trading-app/codex/milking-zone-lab/cloud"

echo "SANI NATIVE V2.3 · FULL MOUNTAIN RIDER"
echo "Direction = locked mountain. One paid trade rides that direction."
echo "Exit = trailing protection / invalidation / confirmed mountain reversal."
echo "After exit, NO same-direction re-entry until the mountain actually flips."
echo "Demo only. Waiting for any current Demo contract to become FLAT..."

for i in $(seq 1 1440); do
  OPEN="false"
  if [[ -f "$ROOT/demo-live-status.json" ]]; then
    OPEN="$(node - "$ROOT/demo-live-status.json" <<'NODE'
const fs=require('fs');
try { const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); console.log(s?.SANI_ADAPTIVE?.live ? 'true' : 'false'); }
catch { console.log('false'); }
NODE
)"
  fi
  if [[ "$OPEN" == "false" ]]; then break; fi
  if [[ "$i" == "1440" ]]; then
    echo "REFUSED: position stayed open for 6 minutes. Nothing changed."
    exit 2
  fi
  sleep .25
done

sudo systemctl stop "$SERVICE" || true
mkdir -p "$ROOT/v23-backups"
[[ -f "$RUNNER" ]] && cp "$RUNNER" "$ROOT/v23-backups/native-speed-runner-${STAMP}.mjs" || true
[[ -f "$BOARD" ]] && cp "$BOARD" "$ROOT/v23-backups/native-speed-dashboard-${STAMP}.mjs" || true
[[ -f "$ROOT/native-adaptive-state.json" ]] && cp "$ROOT/native-adaptive-state.json" "$ROOT/v23-backups/native-adaptive-state-${STAMP}.json" || true
[[ -f "$ROOT/native-adaptive-trades.csv" ]] && cp "$ROOT/native-adaptive-trades.csv" "$ROOT/v23-backups/native-adaptive-trades-${STAMP}.csv" || true

# Always rebuild from the clean V2 native runner, not from the abandoned leg-harvest experiment.
curl -fL "$BASE/native-speed-runner.mjs" -o "$RUNNER"
curl -fL "$BASE/native-speed-dashboard.mjs" -o "$BOARD"
curl -fL "$BASE/libra-mountain.mjs" -o "$ROOT/libra-mountain.mjs"

python3 - "$RUNNER" <<'PY'
from pathlib import Path
import re,sys
p=Path(sys.argv[1]); s=p.read_text()

# Persist a direction lock after an exit. This is the user's "I exited, now wait until market changes direction" law.
s=s.replace("    this.preArm = null;\n    this.onState = typeof onState === 'function' ? onState : () => {};",
            "    this.preArm = null;\n    this.blockedDirection = persisted?.blockedDirection || null;\n    this.onState = typeof onState === 'function' ? onState : () => {};",1)

candidate_pat=re.compile(r"  candidate\(latencyHeld = false\) \{.*?\n  \}\n\n  unrealized\(",re.S)
m=candidate_pat.search(s)
if not m: raise SystemExit('PATCH REFUSED: candidate block not found')

candidate=r'''  candidate(latencyHeld = false) {
    const m = this.latestMountain;
    const sp = this.latestSpeed;
    this.preArm = null;
    this.latestAppetite = 'STAND_DOWN';

    if (latencyHeld || this.position || !m?.ready || !['UP','DOWN'].includes(m.direction)) return null;

    // Once a mountain changes direction, the previous-direction lock is released.
    if (this.blockedDirection && m.direction !== this.blockedDirection) this.blockedDirection = null;
    if (this.blockedDirection === m.direction) return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch) return null;

    // Earliest practical entry windows WITH the mountain. Never buy the pullback against it.
    const early = m.entryMode === 'EARLY_MOMENTUM'
      && sp.score >= 48 && sp.s3 > .04 && sp.s5 > -.03;

    const prePullbackEnd = m.entryMode === 'WAIT_PULLBACK_END'
      && Number(m.confirmation || 0) >= 3
      && sp.score >= 50 && sp.s3 > .06 && sp.accel > -.04;

    const pullbackEnd = m.entryMode === 'PULLBACK_END'
      && sp.score >= 38 && sp.s3 > .02;

    if (!early && !prePullbackEnd && !pullbackEnd) return null;

    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const entryMode = early ? 'MOUNTAIN_START' : prePullbackEnd ? 'PRE_PULLBACK_END' : 'PULLBACK_END';
    const mountainKey = `${m.direction}|${Number(m.start?.epoch || m.important?.epoch || m.extreme?.epoch || 0)}`;
    const key = `${side}|${mountainKey}`;
    if (this.hasUsed(key)) return null;

    const step = this.step();
    const buffer = Math.max(step * 1.25, 1e-9);
    const minDistance = Math.max(step * 6, 1e-9);
    const important = Number(m.important?.quote);
    let stop;
    if (side === 'LONG') {
      const structural = Number.isFinite(important) && important < quote ? important - buffer : quote - minDistance;
      stop = Math.min(structural, quote - minDistance);
    } else {
      const structural = Number.isFinite(important) && important > quote ? important + buffer : quote + minDistance;
      stop = Math.max(structural, quote + minDistance);
    }
    const riskDistance = Math.abs(quote - stop);
    if (!(riskDistance > 0)) return null;

    // $1 is the Deriv stake. There is deliberately NO fixed profit target.
    const units = 1 / riskDistance;
    this.latestAppetite = 'MOUNTAIN_RIDE';

    return {
      side, appetite:'MOUNTAIN_RIDE', entry:quote, stop, trailStop:stop, target:null,
      targetR:null, units, riskDollars:1, plannedRiskDistance:riskDistance,
      openedAt:Date.now(), openedEpoch:epoch, entryKey:key, mountainKey,
      bestR:0, peakDemoPnl:0, entrySpeedScore:sp.score,
      entrySpeedLabel:sp.label, entryContext:{...slimMountain(m),entryMode},
      lastTrailedImportantEpoch:Number(m.important?.epoch || 0)
    };
  }

  unrealized('''
s=s[:m.start()]+candidate+s[m.end():]

manage_pat=re.compile(r"  manage\(actualDemoPnl = 0, peakDemoPnl = 0\) \{.*?\n  \}\n\n  commitExit\(",re.S)
m=manage_pat.search(s)
if not m: raise SystemExit('PATCH REFUSED: manage block not found')

manage=r'''  manage(actualDemoPnl = 0, peakDemoPnl = 0) {
    if (!this.position) return null;
    const p = this.position;
    const m = this.latestMountain;
    const sp = this.latestSpeed;
    const q = Number(this.ticks.at(-1)?.quote);
    if (!Number.isFinite(q)) return null;
    const u = this.unrealized(q);
    p.bestR = Math.max(Number(p.bestR || 0), u.r);
    p.peakDemoPnl = Math.max(Number(p.peakDemoPnl || 0), Number(peakDemoPnl || 0), Number(actualDemoPnl || 0));

    // 1) Hard structural trailing stop.
    if (p.side === 'LONG' && q <= p.trailStop) return { reason:'TRAIL / STRUCTURE INVALIDATED', quote:q };
    if (p.side === 'SHORT' && q >= p.trailStop) return { reason:'TRAIL / STRUCTURE INVALIDATED', quote:q };

    // 2) The mountain itself owns direction. Only a true structural flip ends that directional thesis.
    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
    if (opposite) return { reason:'CONFIRMED MOUNTAIN REVERSAL', quote:q };

    // 3) Every new important HL/LH ratchets the trailing stop forward. Never backward.
    const important = Number(m.important?.quote);
    const importantEpoch = Number(m.important?.epoch || 0);
    if (Number.isFinite(important) && importantEpoch > Number(p.lastTrailedImportantEpoch || 0)) {
      const buffer = Math.max(this.step() * 1.10, 1e-9);
      const candidateStop = p.side === 'LONG' ? important - buffer : important + buffer;
      if (p.side === 'LONG' && candidateStop > p.trailStop && candidateStop < q) p.trailStop = candidateStop;
      if (p.side === 'SHORT' && candidateStop < p.trailStop && candidateStop > q) p.trailStop = candidateStop;
      p.lastTrailedImportantEpoch = importantEpoch;
    }

    // 4) If the mountain is flattening near its top/bottom, tighten rather than instantly abandoning it.
    if (m.entryMode === 'EXHAUSTION' && actualDemoPnl > 0) {
      const recent = this.ticks.slice(-6).map(r => Number(r.quote)).filter(Number.isFinite);
      if (recent.length >= 4) {
        const micro = p.side === 'LONG' ? Math.min(...recent.slice(0,-1)) : Math.max(...recent.slice(0,-1));
        if (p.side === 'LONG' && micro > p.trailStop && micro < q) p.trailStop = micro;
        if (p.side === 'SHORT' && micro < p.trailStop && micro > q) p.trailStop = micro;
      }
    }

    // 5) Actual Deriv profit trailing is deliberately loose. It protects a meaningful run,
    // but does not turn every tiny green flicker into a scalp.
    if (p.peakDemoPnl >= .12 && actualDemoPnl > 0) {
      const keep = p.peakDemoPnl >= .40 ? .45 : .30;
      const floor = Math.max(.02, p.peakDemoPnl * keep);
      if (actualDemoPnl <= floor && (m.entryMode === 'EXHAUSTION' || sp.score < 30)) {
        return { reason:'ACTUAL PROFIT TRAIL · MOUNTAIN FADING', quote:q };
      }
    }

    this.onState();
    return null;
  }

  commitExit('''
s=s[:m.start()]+manage+s[m.end():]

# After any exit, block another trade in the same mountain direction until analyzeMountain flips.
s=s.replace("    this.lastCloseEpoch = Number(this.ticks.at(-1)?.epoch || this.lastCloseEpoch);\n    this.position = null;",
            "    this.lastCloseEpoch = Number(this.ticks.at(-1)?.epoch || this.lastCloseEpoch);\n    this.blockedDirection = p.side === 'LONG' ? 'UP' : 'DOWN';\n    this.position = null;",1)

# Snapshot + persistence/status.
s=s.replace("      preArm: this.preArm", "      preArm: this.preArm,\n      blockedDirection: this.blockedDirection",1)
s=s.replace("      usedEntryKeys: engine.usedEntryKeys", "      usedEntryKeys: engine.usedEntryKeys,\n      blockedDirection: engine.blockedDirection",1)
s=s.replace("      target: s.position.target,", "      target: null,",1)
s=s.replace("      entrySpeedScore: s.position.entrySpeedScore", "      entrySpeedScore: s.position.entrySpeedScore,\n      mountainKey: s.position.mountainKey || null,\n      blockedDirection: engine.blockedDirection",1)
s=s.replace("    preArm: s.preArm", "    preArm: s.preArm,\n    blockedDirection: s.blockedDirection",1)

s=s.replace("architecture: 'NATIVE_VM_V2_SPEED'", "architecture: 'NATIVE_VM_V23_FULL_MOUNTAIN_RIDER'",1)
s=s.replace("version: 2,", "version: 23,",1)
s=s.replace(" SANI NATIVE VM V2 · SPEED IS RUNNING", " SANI NATIVE VM V2.3 · FULL MOUNTAIN RIDER IS RUNNING")
s=s.replace(" ONE BRAIN · ONE CONTRACT · ADAPTIVE APPETITE", " ONE BRAIN · ONE CONTRACT · ONE DIRECTION PER MOUNTAIN")
s=s.replace(" DIRECTION = LIBRA MOUNTAIN", " DIRECTION = LIBRA MOUNTAIN · NO COUNTERTREND PAID TRADES")
s=s.replace(" SPEED = VELOCITY + COHERENCE + ACCELERATION", " ENTRY = EARLY MOUNTAIN / PULLBACK RETURN · HOLD = FULL DIRECTION")
s=s.replace(" PROFIT PROTECTION = ACTUAL DERIV P/L FIRST", " EXIT = STRUCTURAL TRAIL / PROFIT TRAIL / CONFIRMED REVERSAL")
s=s.replace(" PRE-ARM = SHADOW ONLY FOR NOW", " AFTER EXIT = WAIT FOR DIRECTION FLIP BEFORE NEXT PAID TRADE")
s=s.replace("Native V2 Speed started", "Native V2.3 Full Mountain Rider started")
s=s.replace("[NATIVE V2 MONEY]", "[NATIVE V2.3 MONEY]")
s=s.replace("[NATIVE V2] 🎯 ENTRY ${candidate.side} · ${candidate.appetite} · ${candidate.entryContext.entryMode} · speed ${candidate.entrySpeedScore}/100", "[NATIVE V2.3] 🎯 MOUNTAIN ENTRY ${candidate.side} · ${candidate.entryContext.entryMode} · speed ${candidate.entrySpeedScore}/100")

p.write_text(s)
print('✅ V2.3 runner patched: full mountain direction + trailing stop + flip-only re-entry.')
PY

cat > "$BOARD" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ROOT=path.join(os.homedir(),'sani-cloud');
const STATUS=path.join(ROOT,'demo-live-status.json');
const CSV=path.join(ROOT,'native-adaptive-trades.csv');
const A={r:'\x1b[0m',b:'\x1b[1m',d:'\x1b[2m',g:'\x1b[32m',x:'\x1b[31m',y:'\x1b[33m',c:'\x1b[36m',m:'\x1b[35m'};
const read=(f,d=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const cm=v=>`${Number(v||0)>=0?A.g:A.x}${money(v)}${A.r}`;
const pad=(s,n)=>{s=String(s??'');return s.length>=n?s.slice(0,n):s+' '.repeat(n-s.length)};
function parse(line){const o=[];let s='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){s+='"';i++}else q=!q}else if(c===','&&!q){o.push(s);s=''}else s+=c}o.push(s);return o}
function recent(n=10){try{const ls=fs.readFileSync(CSV,'utf8').trim().split(/\r?\n/);if(ls.length<2)return[];const h=parse(ls[0]);return ls.slice(1).slice(-n).reverse().map(l=>{const v=parse(l),r={};h.forEach((k,i)=>r[k]=v[i]);return r})}catch{return[]}}
function pt(p){return p?`${p.label||p.type}@${Number(p.quote||0).toFixed(2)}`:'—'}
function render(){
 const s=read(STATUS);console.clear();
 console.log(`${A.b}${A.c}SANI NATIVE V2.3 · FULL MOUNTAIN RIDER${A.r}`);
 console.log(`${A.d}${new Date().toLocaleString()} · read-only · Demo only${A.r}\n`);
 if(!s){console.log('Waiting for status...');return}
 const e=s.SANI_ADAPTIVE||{},m=e.mountain||{},sp=e.speed||{},p=e.live;
 console.log(`${A.b}ACCOUNT${A.r}  DEMO ONLY  ${s.symbol||'—'} x${s.multiplier||'—'}  Balance ${A.b}$${Number(s.balance||0).toFixed(2)}${A.r}`);
 console.log(`${A.b}SESSION${A.r}  ${e.trades||0}T ${e.wins||0}W/${e.losses||0}L  win ${Number(e.winRate||0).toFixed(1)}%  Actual ${cm(e.realized)}`);
 console.log(`${A.d}Architecture ${s.architecture||'—'} · Browser ${Boolean(s.browserDependency)} · Vercel ${Boolean(s.vercelExecutionDependency)}${A.r}`);
 console.log(`\n${A.b}${A.m}MOUNTAIN${A.r}`);
 console.log(`  Direction: ${A.b}${m.direction||'NONE'}${A.r} · Moment: ${String(m.entryMode||'').replaceAll('_',' ')} · Confirm ${Number(m.confirmation||0)}/6`);
 console.log(`  Start ${pt(m.start)} · Important ${pt(m.important)} · Extreme ${pt(m.extreme)}`);
 console.log(`  Speed ${Number(sp.score||0)}/100 ${sp.label||''} · s3 ${Number(sp.s3||0).toFixed(2)} s5 ${Number(sp.s5||0).toFixed(2)} s8 ${Number(sp.s8||0).toFixed(2)} accel ${Number(sp.accel||0).toFixed(2)}`);
 console.log(`  Same-direction re-entry lock: ${e.blockedDirection?A.y+e.blockedDirection+' · WAIT FOR FLIP'+A.r:'NONE'}`);
 if(m.reason)console.log(`  ${A.d}${String(m.reason).slice(0,180)}${A.r}`);
 console.log(`\n${A.b}POSITION${A.r}`);
 if(!p) console.log(`  ${A.d}FLAT · waiting for early entry WITH the mountain${A.r}`);
 else {
   console.log(`  ${A.b}${p.side}${A.r} · FULL MOUNTAIN RIDE · entry ${Number(p.entry||0).toFixed(2)}`);
   console.log(`  Structural stop ${Number(p.stop||0).toFixed(2)} · trailing stop ${Number(p.trailStop??p.stop||0).toFixed(2)} · NO FIXED TARGET`);
   console.log(`  Actual now ${cm(p.actualPnl)} · Peak actual ${cm(p.peakActualPnl)} · latency ${Number(p.buyLatencyMs||0)}ms`);
   console.log(`  Entry ${String(p.entryMode||'').replaceAll('_',' ')} · entry speed ${Number(p.entrySpeedScore||0)}/100`);
 }
 console.log(`\n${A.b}LAW${A.r}`);
 console.log(`  UP mountain → LONG only. Hold through pullbacks. Trail behind important HLs.`);
 console.log(`  DOWN mountain → SHORT only. Hold through pullbacks. Trail above important LHs.`);
 console.log(`  Exit can happen before the exact peak/trough via trailing protection.`);
 console.log(`  After exit: do NOT re-enter same direction. Wait until the mountain structurally flips.`);
 console.log(`  CHOP: no paid trade. $1 is stake, not a profit target.`);
 console.log(`\n${A.b}RECENT DEMO CLOSES${A.r}`);
 const rows=recent(); if(!rows.length) console.log(`  ${A.d}No closed V2.3 trades yet.${A.r}`); else {
   console.log(`${A.d}  ${pad('TIME',10)} ${pad('SIDE',6)} ${pad('DEMO',9)} ${pad('PEAK',9)} REASON${A.r}`);
   for(const r of rows){const t=r.closed_at?new Date(r.closed_at).toLocaleTimeString([],{hour12:false}).slice(0,8):'—';console.log(`  ${pad(t,10)} ${pad(r.side,6)} ${pad(money(r.demo_pnl),9)} ${pad(money(r.peak_demo_pnl),9)} ${String(r.reason||'').slice(0,75)}`)}
 }
 console.log(`\n${A.d}Refresh 2s · Ctrl+C closes board only. Trading keeps running.${A.r}`);
}
render();setInterval(render,2000);
EOF

node --check "$RUNNER"
node --check "$BOARD"

# New logic = new scoreboard. Prior data is preserved in v23-backups.
rm -f "$ROOT/native-adaptive-state.json" "$ROOT/native-adaptive-trades.csv"

sudo systemctl restart "$SERVICE"
sleep 5

echo
echo "SERVICE:"
sudo systemctl status "$SERVICE" --no-pager -l | sed -n '1,20p' || true
echo
echo "BOARD:"
echo "  node $BOARD"
echo
echo "EXPECTED ARCHITECTURE: NATIVE_VM_V23_FULL_MOUNTAIN_RIDER"
echo "Demo balance was NOT reset. Only the experiment scoreboard was reset."
