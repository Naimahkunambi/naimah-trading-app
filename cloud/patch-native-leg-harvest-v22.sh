#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
RUNNER="$ROOT/native-speed-runner.mjs"
BOARD="$ROOT/native-speed-dashboard.mjs"
SERVICE="sani-native-speed"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$RUNNER" || ! -f "$BOARD" ]]; then
  echo "ERROR: native SPEED files are missing in $ROOT"
  exit 1
fi

echo "SANI V2.2 LEG HARVEST PATCH"
echo "Goal: enter near a fresh swing low/high, hold the active leg, exit near the next swing high/low."
echo "No fixed profit target. $1 is the Demo stake, not a $1 profit ceiling."
echo "Waiting for the current Demo position to become FLAT before changing execution..."

# Drain safely: wait for a flat instant, then stop quickly.
for i in $(seq 1 1440); do
  OPEN="false"
  if [[ -f "$ROOT/demo-live-status.json" ]]; then
    OPEN="$(node - "$ROOT/demo-live-status.json" <<'NODE'
const fs=require('fs');
try {
  const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  console.log(s?.SANI_ADAPTIVE?.live ? 'true' : 'false');
} catch { console.log('false'); }
NODE
)"
  fi
  if [[ "$OPEN" == "false" ]]; then
    sudo systemctl stop "$SERVICE"
    break
  fi
  if [[ "$i" == "1440" ]]; then
    echo "REFUSED: position stayed open for 6 minutes. Nothing changed."
    exit 2
  fi
  sleep 0.25
done

mkdir -p "$ROOT/v22-backups"
cp "$RUNNER" "$ROOT/v22-backups/native-speed-runner-${STAMP}.mjs"
cp "$BOARD" "$ROOT/v22-backups/native-speed-dashboard-${STAMP}.mjs"
[[ -f "$ROOT/native-adaptive-state.json" ]] && cp "$ROOT/native-adaptive-state.json" "$ROOT/v22-backups/native-adaptive-state-${STAMP}.json" || true
[[ -f "$ROOT/native-adaptive-trades.csv" ]] && cp "$ROOT/native-adaptive-trades.csv" "$ROOT/v22-backups/native-adaptive-trades-${STAMP}.csv" || true

python3 - "$RUNNER" <<'PY'
from pathlib import Path
import re, sys

p=Path(sys.argv[1])
s=p.read_text()

# Remove an older V2.2 method block if the script is rerun.
s=re.sub(r"\n  directionalLegSpeed\(side\) \{.*?\n  \}\n\n  swingState\(\) \{.*?\n  \}\n(?=\n  appetite\()", "\n", s, flags=re.S)

# Insert leg intelligence before appetite(). This keeps the existing mountain model for macro context,
# but no longer forces the paid direction to equal the macro mountain direction.
anchor="  appetite(speed, m) {"
if anchor not in s:
    raise SystemExit('PATCH REFUSED: appetite() anchor not found')

methods=r'''  directionalLegSpeed(side) {
    const q=this.ticks.map(r=>Number(r.quote));
    if(q.length<8) return {score:0,label:'WARMING',d1:0,s3:0,s5:0,s8:0,accel:0,eff5:0,eff8:0};
    const step=Math.max(this.step(),1e-9);
    const sign=side==='LONG'?1:-1;
    const d1=(q.at(-1)-q.at(-2))/step*sign;
    const s3=slope(q.slice(-3))/step*sign;
    const s5=slope(q.slice(-5))/step*sign;
    const s8=slope(q.slice(-8))/step*sign;
    const accel=s3-s8;
    const eff5=pathEfficiency(q.slice(-5));
    const eff8=pathEfficiency(q.slice(-8));
    const impulse=clamp((Math.max(0,d1)*.48+Math.max(0,s3)*.34+Math.max(0,s5)*.18)/.85,0,1);
    const turn=clamp((accel+.18)/.55,0,1);
    const coherence=[d1>0,s3>0,s5>-.04].filter(Boolean).length/3;
    const score=Math.round(100*(impulse*.48+coherence*.25+eff5*.14+eff8*.08+turn*.05));
    return {score:clamp(score,0,100),label:score>=78?'FAST':score>=55?'FLOWING':score>=35?'SLOW':'STALLING',d1,s3,s5,s8,accel,eff5,eff8};
  }

  swingState() {
    const m=this.latestMountain;
    const pivots=Array.isArray(m?.pivots)?m.pivots:[];
    const last=pivots.at(-1)||null;
    const previous=pivots.at(-2)||null;
    const current=this.ticks.at(-1)||null;
    const step=Math.max(this.step(),1e-9);
    const q=this.ticks.map(r=>Number(r.quote));
    const recent13=q.slice(-13);
    const range13=recent13.length?Math.max(...recent13)-Math.min(...recent13):0;
    const eff13=pathEfficiency(recent13);
    let alternations=0,lastSign=0;
    for(let i=Math.max(1,q.length-13);i<q.length;i++){
      const d=Math.sign(q[i]-q[i-1]);
      if(d&&lastSign&&d!==lastSign)alternations++;
      if(d)lastSign=d;
    }
    const chop=m?.direction==='CHOP'||(recent13.length>=9&&eff13<.28&&range13<step*5.5&&alternations>=5);
    if(!last||!current) return {ready:false,chop,side:'NONE',class:'WAIT',pivot:null,previous:null,age:99,bounce:0,speed:{score:0,label:'WARMING'}};

    const age=Math.max(0,(this.ticks.length-1)-Number(last.index??this.ticks.length-99));
    const side=last.type==='L'?'LONG':'SHORT';
    const speed=this.directionalLegSpeed(side);
    const bounce=Math.abs(Number(current.quote)-Number(last.quote))/step;
    const macroSame=(m.direction==='UP'&&side==='LONG')||(m.direction==='DOWN'&&side==='SHORT');
    const macroOpposite=(m.direction==='UP'&&side==='SHORT')||(m.direction==='DOWN'&&side==='LONG');
    const klass=macroSame?'CONTINUATION':macroOpposite?'COUNTER_LEG':'NEW_LEG';

    // Pivot is known one tick after the extreme. That is our prospective approximation
    // to the user's "enter near the bottom/top", without pretending we know the future.
    const fresh=age<=2;
    const continuationReady=fresh&&bounce>=.28&&speed.d1>.05&&speed.s3>.02&&speed.score>=42;
    const counterReady=fresh&&bounce>=.38&&speed.d1>.08&&speed.s3>.05&&speed.accel>-.04&&speed.score>=58;
    const newLegReady=fresh&&bounce>=.32&&speed.d1>.06&&speed.s3>.03&&speed.score>=50;
    const entryReady=!chop&&(macroSame?continuationReady:macroOpposite?counterReady:newLegReady);

    return {
      ready:true,chop,side,class:klass,pivot:{epoch:last.epoch,quote:last.quote,type:last.type,label:last.label||last.type},
      previous:previous?{epoch:previous.epoch,quote:previous.quote,type:previous.type,label:previous.label||previous.type}:null,
      age,bounce,speed,entryReady,macroDirection:m?.direction||'NONE',macroMoment:m?.entryMode||'NO_TRADE',
      reason:chop?'CHOP: ignore both sides.':entryReady?`${klass} ${side} from fresh ${last.label||last.type} pivot.`:`Waiting for the fresh ${last.label||last.type} turn to actually move away from the pivot.`
    };
  }

'''
s=s.replace(anchor,methods+anchor,1)

# Make latestSwing first-class state.
s=s.replace("    this.preArm = null;\n    this.onState", "    this.preArm = null;\n    this.latestSwing = { ready:false, side:'NONE', class:'WAIT' };\n    this.onState",1)
s=s.replace("    this.latestSpeed = this.speedMetrics(this.latestMountain);\n  }\n\n  pushTick", "    this.latestSpeed = this.speedMetrics(this.latestMountain);\n    this.latestSwing = this.swingState();\n  }\n\n  pushTick",1)
s=s.replace("    this.latestSpeed = this.speedMetrics(this.latestMountain);\n    return true;", "    this.latestSpeed = this.speedMetrics(this.latestMountain);\n    this.latestSwing = this.swingState();\n    return true;",1)

# Replace candidate() completely. No GRAB/TRAIL/RUNNER. One trade = one market leg.
pat=re.compile(r"  candidate\(latencyHeld = false\) \{.*?\n  \}\n\n  unrealized\(",re.S)
m=pat.search(s)
if not m: raise SystemExit('PATCH REFUSED: candidate() block not found')
candidate=r'''  candidate(latencyHeld = false) {
    const sw=this.swingState();
    this.latestSwing=sw;
    this.preArm=null;
    this.latestAppetite=sw.entryReady?'LEG':'STAND_DOWN';
    if(latencyHeld||this.position||!sw.ready||sw.chop||!sw.entryReady) return null;

    const current=this.ticks.at(-1);
    const quote=Number(current?.quote),epoch=Number(current?.epoch||0);
    if(!Number.isFinite(quote)||!epoch||epoch<=this.lastCloseEpoch) return null;
    if(this.lastCloseEpoch&&epoch-this.lastCloseEpoch<1) return null;

    const side=sw.side;
    const key=`${side}|LEG|${sw.pivot?.epoch||0}|${sw.pivot?.type||''}`;
    if(this.hasUsed(key)) return null;

    const step=Math.max(this.step(),1e-9);
    const pivotQuote=Number(sw.pivot?.quote);
    const buffer=step*1.15;
    const stop=side==='LONG'?pivotQuote-buffer:pivotQuote+buffer;
    const riskDistance=Math.max(Math.abs(quote-stop),step*.75);
    const units=1/riskDistance;

    return {
      side,appetite:'LEG',entry:quote,stop,trailStop:stop,target:null,
      targetR:null,units,riskDollars:1,plannedRiskDistance:riskDistance,
      openedAt:Date.now(),openedEpoch:epoch,entryKey:key,bestR:0,peakDemoPnl:0,
      entrySpeedScore:sw.speed.score,entrySpeedLabel:sw.speed.label,
      entryPivot:{...sw.pivot},legClass:sw.class,entryLegSide:sw.side,
      againstTicks:0,
      entryContext:{...slimMountain(this.latestMountain),entryMode:`LEG_FROM_${sw.pivot?.label||sw.pivot?.type||'PIVOT'}`}
    };
  }

  unrealized('''
s=s[:m.start()]+candidate+s[m.end():]

# Replace manage() completely. Exit = end of the leg, not a fixed target.
pat=re.compile(r"  manage\(actualDemoPnl = 0, peakDemoPnl = 0\) \{.*?\n  \}\n\n  commitExit\(",re.S)
m=pat.search(s)
if not m: raise SystemExit('PATCH REFUSED: manage() block not found')
manage=r'''  manage(actualDemoPnl = 0, peakDemoPnl = 0) {
    if(!this.position)return null;
    const p=this.position;
    const q=Number(this.ticks.at(-1)?.quote);
    if(!Number.isFinite(q))return null;
    const sw=this.swingState();
    this.latestSwing=sw;
    const held=this.directionalLegSpeed(p.side);
    const u=this.unrealized(q);
    p.bestR=Math.max(Number(p.bestR||0),u.r);
    p.peakDemoPnl=Math.max(Number(p.peakDemoPnl||0),Number(peakDemoPnl||0),Number(actualDemoPnl||0));

    // Structural invalidation: the pivot we entered from has failed.
    if(p.side==='LONG'&&q<=p.stop)return{reason:'ENTRY PIVOT BROKE · CUT',quote:q};
    if(p.side==='SHORT'&&q>=p.stop)return{reason:'ENTRY PIVOT BROKE · CUT',quote:q};

    // Primary harvest exit: the next opposite pivot has actually formed.
    const nextOpposite=sw?.pivot&&Number(sw.pivot.epoch)>Number(p.entryPivot?.epoch||0)
      &&((p.side==='LONG'&&sw.pivot.type==='H')||(p.side==='SHORT'&&sw.pivot.type==='L'));
    if(nextOpposite)return{reason:p.side==='LONG'?'SWING HIGH FORMED · EXIT LEG':'SWING LOW FORMED · EXIT LEG',quote:q};

    // Speed is now measured in the position's direction, not normalized to the macro mountain.
    const hardAgainst=held.d1<-.10&&held.s3<-.05;
    p.againstTicks=hardAgainst?Number(p.againstTicks||0)+1:0;
    const speedDrop=Number(p.entrySpeedScore||0)-Number(held.score||0);
    const fading=held.s3<.02||held.score<35||speedDrop>=35;

    // If the leg has paid us and then starts dying, bank it. No target ceiling.
    if(actualDemoPnl>.005&&fading)return{reason:'LEG FADING · TAKE ACTUAL PROFIT',quote:q};

    // If the turn is clearly wrong, leave quickly instead of waiting for the macro mountain to reverse.
    if(p.againstTicks>=2&&actualDemoPnl<=-.005)return{reason:'LEG TURNED AGAINST · CUT EARLY',quote:q};

    // Profit protection only activates after a meaningful actual Deriv peak AND a fade.
    if(p.peakDemoPnl>=.05&&actualDemoPnl>0){
      const floor=Math.max(.01,p.peakDemoPnl*.45);
      if(actualDemoPnl<=floor&&held.s3<.08)return{reason:'LEG PROFIT GIVEBACK · EXIT',quote:q};
    }

    // If live price degenerates into chop, do not keep paying to sit inside noise.
    if(sw.chop&&actualDemoPnl<=0&&held.score<35)return{reason:'CHOP FORMED · EXIT',quote:q};

    this.onState();
    return null;
  }

  commitExit('''
s=s[:m.start()]+manage+s[m.end():]

# Add swing to snapshot.
s=s.replace("      speed: this.latestSpeed,\n      appetite: this.latestAppetite,", "      speed: this.latestSpeed,\n      swing: this.latestSwing,\n      appetite: this.latestSwing?.entryReady ? 'LEG' : 'STAND_DOWN',",1)

# Live status telemetry: target is intentionally absent; show leg data instead.
s=re.sub(r"      target: s\.position\.target,\n", "      target: null,\n", s, count=1)
s=s.replace("      entrySpeedScore: s.position.entrySpeedScore", "      entrySpeedScore: s.position.entrySpeedScore,\n      currentLegSpeedScore: engine.directionalLegSpeed(s.position.side).score,\n      currentLegSpeed: engine.directionalLegSpeed(s.position.side),\n      entryPivot: s.position.entryPivot || null,\n      legClass: s.position.legClass || null,\n      againstTicks: Number(s.position.againstTicks || 0)",1)
s=s.replace("    preArm: s.preArm", "    preArm: s.preArm,\n    swing: s.swing",1)

# Version labels.
s=re.sub(r"architecture: 'NATIVE_VM_V2(?:1_SPEED_AUTHORITY|_SPEED)?'", "architecture: 'NATIVE_VM_V22_LEG_HARVEST'", s, count=1)
s=s.replace("version: 2,", "version: 22,",1)
s=s.replace(" SANI NATIVE VM V2 · SPEED IS RUNNING", " SANI NATIVE VM V2.2 · LEG HARVEST IS RUNNING")
s=s.replace(" ONE BRAIN · ONE CONTRACT · ADAPTIVE APPETITE", " ONE BRAIN · ONE CONTRACT · PIVOT-TO-PIVOT LEG HARVEST")
s=s.replace(" DIRECTION = LIBRA MOUNTAIN", " MACRO = HH/HL/LH/LL MOUNTAIN · PAID DIRECTION = ACTIVE LEG")
s=s.replace(" SPEED = VELOCITY + COHERENCE + ACCELERATION", " ENTRY = FRESH PIVOT TURN · HOLD = LEG · EXIT = NEXT PIVOT / FADE")
s=s.replace(" PROFIT PROTECTION = ACTUAL DERIV P/L FIRST", " $1 = STAKE, NOT PROFIT TARGET · NO FIXED PROFIT CEILING")
s=s.replace(" PRE-ARM = SHADOW ONLY FOR NOW", " CHOP = STAND DOWN · COUNTER-LEG REQUIRES STRONGER TURN")
s=s.replace("Native V2 Speed started", "Native V2.2 Leg Harvest started")
s=s.replace("[NATIVE V2 MONEY]", "[NATIVE V2.2 MONEY]")
s=s.replace("[NATIVE V2] 🎯 ENTRY ${candidate.side} · ${candidate.appetite} · ${candidate.entryContext.entryMode} · speed ${candidate.entrySpeedScore}/100", "[NATIVE V2.2] 🎯 LEG ENTRY ${candidate.side} · ${candidate.legClass} · from ${candidate.entryPivot?.label||candidate.entryPivot?.type} · speed ${candidate.entrySpeedScore}/100")

p.write_text(s)
print('✅ Runner now trades fresh pivot-to-pivot legs. Fixed target logic removed from paid decisions.')
PY

cat > "$BOARD" <<'EOF'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const ROOT=path.join(os.homedir(),'sani-cloud');
const STATUS_PATH=path.join(ROOT,'demo-live-status.json');
const CSV_PATH=path.join(ROOT,'native-adaptive-trades.csv');
const REFRESH_MS=2000;
const A={reset:'\x1b[0m',bold:'\x1b[1m',dim:'\x1b[2m',green:'\x1b[32m',red:'\x1b[31m',yellow:'\x1b[33m',cyan:'\x1b[36m',magenta:'\x1b[35m'};
const readJson=(f,d=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const money=v=>`${Number(v||0)>=0?'+':'-'}$${Math.abs(Number(v||0)).toFixed(2)}`;
const cm=v=>`${Number(v||0)>=0?A.green:A.red}${money(v)}${A.reset}`;
const pad=(s,n)=>{s=String(s??'');return s.length>=n?s.slice(0,n):s+' '.repeat(n-s.length)};
function parseCsvLine(line){const out=[];let s='',q=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(q&&line[i+1]==='"'){s+='"';i++}else q=!q}else if(c===','&&!q){out.push(s);s=''}else s+=c}out.push(s);return out}
function recentTrades(n=10){try{const lines=fs.readFileSync(CSV_PATH,'utf8').trim().split(/\r?\n/);if(lines.length<2)return[];const h=parseCsvLine(lines[0]);return lines.slice(1).slice(-n).reverse().map(line=>{const v=parseCsvLine(line),r={};h.forEach((k,i)=>r[k]=v[i]);return r})}catch{return[]}}
function piv(p){return p?`${p.label||p.type}@${Number(p.quote||0).toFixed(2)}`:'—'}
function render(){
  const s=readJson(STATUS_PATH,null);console.clear();
  console.log(`${A.bold}${A.cyan}SANI NATIVE V2.2 · LEG HARVEST BOARD${A.reset}`);
  console.log(`${A.dim}${new Date().toLocaleString()} · read-only · Demo only · one contract${A.reset}\n`);
  if(!s){console.log(`${A.red}Waiting for ${STATUS_PATH}${A.reset}`);return}
  const e=s.SANI_ADAPTIVE||{},m=e.mountain||{},sw=e.swing||{},p=e.live;
  console.log(`${A.bold}ACCOUNT${A.reset}  DEMO ONLY  ${s.symbol||'—'} x${s.multiplier||'—'}  Balance ${A.bold}$${Number(s.balance||0).toFixed(2)}${A.reset}`);
  console.log(`${A.bold}SESSION${A.reset}  ${e.trades||0}T ${e.wins||0}W/${e.losses||0}L  win ${Number(e.winRate||0).toFixed(1)}%  Actual Demo ${cm(e.realized)}`);
  console.log(`${A.dim}Architecture ${s.architecture||'—'} · Browser ${String(Boolean(s.browserDependency))} · Vercel ${String(Boolean(s.vercelExecutionDependency))}${A.reset}`);

  console.log(`\n${A.bold}${A.magenta}MARKET MAP${A.reset}`);
  console.log(`  Macro mountain: ${A.bold}${m.direction||'NONE'}${A.reset} · structure moment ${String(m.entryMode||'').replaceAll('_',' ')} · confirm ${Number(m.confirmation||0)}/6`);
  console.log(`  Last pivot: ${A.bold}${piv(sw.pivot)}${A.reset} · previous ${piv(sw.previous)} · age ${Number(sw.age??99)} tick(s) · move-away ${Number(sw.bounce||0).toFixed(2)} step`);
  console.log(`  Active leg candidate: ${A.bold}${sw.side||'NONE'}${A.reset} · ${sw.class||'WAIT'} · leg speed ${Number(sw.speed?.score||0)}/100 ${sw.speed?.label||''}`);
  console.log(`  Chop: ${sw.chop?A.yellow+'YES · IGNORE'+A.reset:'NO'} · Entry ready: ${sw.entryReady?A.green+'YES'+A.reset:'NO'}`);
  if(sw.reason)console.log(`  ${A.dim}${String(sw.reason).slice(0,175)}${A.reset}`);

  console.log(`\n${A.bold}TRADE LAW${A.reset}`);
  console.log(`  L pivot → LONG leg → exit when H pivot / leg fades.`);
  console.log(`  H pivot → SHORT leg → exit when L pivot / leg fades.`);
  console.log(`  Macro HH/HL/LH/LL gives context. It does NOT force one paid direction for the whole mountain.`);
  console.log(`  $1 is stake. There is NO fixed $1 profit target.`);

  console.log(`\n${A.bold}POSITION${A.reset}`);
  if(!p)console.log(`  ${A.dim}FLAT · waiting for a fresh pivot turn${A.reset}`);
  else{
    const ls=p.currentLegSpeed||{};
    console.log(`  ${A.bold}${p.side}${A.reset} · ${p.legClass||'LEG'} · entered from ${piv(p.entryPivot)} · entry ${Number(p.entry||0).toFixed(2)}`);
    console.log(`  Actual now ${cm(p.actualPnl)} · Peak actual ${cm(p.peakActualPnl)} · latency ${Number(p.buyLatencyMs||0)}ms`);
    console.log(`  Leg speed entry ${Number(p.entrySpeedScore||0)}/100 → now ${Number(p.currentLegSpeedScore||0)}/100 · d1 ${Number(ls.d1||0).toFixed(2)} s3 ${Number(ls.s3||0).toFixed(2)} s5 ${Number(ls.s5||0).toFixed(2)} · against ${Number(p.againstTicks||0)} tick(s)`);
    console.log(`  ${A.dim}HOLD while this leg lives. No target cap. Exit on next opposite pivot or a genuine leg fade/invalid turn.${A.reset}`);
  }

  console.log(`\n${A.bold}RECENT DEMO CLOSES${A.reset}`);
  const rows=recentTrades();
  if(!rows.length)console.log(`  ${A.dim}No closed V2.2 trades yet.${A.reset}`);
  else{
    console.log(`${A.dim}  ${pad('TIME',10)} ${pad('SIDE',6)} ${pad('SPEED',7)} ${pad('DEMO',9)} ${pad('PEAK',9)} REASON${A.reset}`);
    for(const r of rows){const t=r.closed_at?new Date(r.closed_at).toLocaleTimeString([], {hour12:false}).slice(0,8):'—';console.log(`  ${pad(t,10)} ${pad(r.side,6)} ${pad(r.speed_score,7)} ${pad(money(r.demo_pnl),9)} ${pad(money(r.peak_demo_pnl),9)} ${String(r.reason||'').slice(0,72)}`)}
  }
  console.log(`\n${A.dim}Refresh ${REFRESH_MS/1000}s · Ctrl+C closes dashboard only. Trading service keeps running.${A.reset}`);
}
render();setInterval(render,REFRESH_MS);
EOF

node --check "$RUNNER"
node --check "$BOARD"

# Fresh experiment. Backups above preserve the old V2.1 data.
rm -f "$ROOT/native-adaptive-state.json" "$ROOT/native-adaptive-trades.csv"

sudo systemctl restart "$SERVICE"
sleep 5

echo
echo "V2.2 SERVICE:"
sudo systemctl status "$SERVICE" --no-pager -l | sed -n '1,20p' || true

echo
echo "RUN THE BOARD:"
echo "  node $BOARD"
echo
echo "EXPECTED: NATIVE_VM_V22_LEG_HARVEST"
echo "The Demo balance itself was NOT reset. Previous V2.1 logs were backed up under $ROOT/v22-backups/."
