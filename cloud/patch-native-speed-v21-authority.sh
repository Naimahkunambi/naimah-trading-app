#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
RUNNER="$ROOT/native-speed-runner.mjs"
BOARD="$ROOT/native-speed-dashboard.mjs"
SERVICE="sani-native-speed"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$RUNNER" || ! -f "$BOARD" ]]; then
  echo "ERROR: V2 files are missing in $ROOT"
  exit 1
fi

echo "SANI V2.1 SPEED AUTHORITY PATCH"
echo "Demo only. Waiting for the current Demo contract to become FLAT before touching execution."

for i in $(seq 1 180); do
  OPEN="false"
  if [[ -f "$ROOT/demo-live-status.json" ]]; then
    OPEN="$(node - "$ROOT/demo-live-status.json" <<'NODE'
const fs=require('fs');
try { const s=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); console.log(s?.SANI_ADAPTIVE?.live ? 'true' : 'false'); }
catch { console.log('false'); }
NODE
)"
  fi
  [[ "$OPEN" == "false" ]] && break
  if [[ "$i" == "180" ]]; then
    echo "REFUSED: still an open Demo contract after 6 minutes. Nothing changed."
    exit 2
  fi
  sleep 2
done

sudo systemctl stop "$SERVICE"
mkdir -p "$ROOT/v21-backups"
cp "$RUNNER" "$ROOT/v21-backups/native-speed-runner-${STAMP}.mjs"
cp "$BOARD" "$ROOT/v21-backups/native-speed-dashboard-${STAMP}.mjs"
[[ -f "$ROOT/native-adaptive-state.json" ]] && cp "$ROOT/native-adaptive-state.json" "$ROOT/v21-backups/native-adaptive-state-${STAMP}.json" || true
[[ -f "$ROOT/native-adaptive-trades.csv" ]] && cp "$ROOT/native-adaptive-trades.csv" "$ROOT/v21-backups/native-adaptive-trades-${STAMP}.csv" || true

python3 - "$RUNNER" "$BOARD" <<'PY'
from pathlib import Path
import re, sys

runner = Path(sys.argv[1])
board = Path(sys.argv[2])
s = runner.read_text()
b = board.read_text()

if 'NATIVE_VM_V21_SPEED_AUTHORITY' in s:
    print('V2.1 already present in runner.')
else:
    # 1. Replace candidate policy. SPEED is now an entry authority, not just an appetite label.
    pat = re.compile(r"  candidate\(latencyHeld = false\) \{.*?\n  \}\n\n  unrealized\(", re.S)
    m = pat.search(s)
    if not m:
        raise SystemExit('PATCH REFUSED: candidate() block not found')

    candidate = r'''  candidate(latencyHeld = false) {
    const m = this.latestMountain;
    const s = this.latestSpeed;
    this.latestAppetite = this.appetite(s, m);
    this.preArm = null;

    if (latencyHeld || this.position || !m?.ready || !['UP','DOWN'].includes(m.direction)) return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch) return null;
    if (this.lastCloseEpoch && epoch - this.lastCloseEpoch < 3) return null;

    // SPEED V2.1: no paid entry while movement is slow/stalling.
    if (s.score < 55) return null;

    // Earlier sniper window. The mountain is retained, the pullback is still labelled WAIT,
    // but short-horizon velocity has already curved back with the mountain.
    const preArmLive = m.entryMode === 'WAIT_PULLBACK_END'
      && Number(m.confirmation || 0) >= 3
      && Number(m.confirmation || 0) <= 4
      && s.s3 > .08
      && s.s5 > -.05
      && s.accel > -.02
      && s.score >= 60;

    const confirmedLive = m.entryMode === 'PULLBACK_END'
      && s.s3 > .08
      && s.s5 > -.02
      && s.score >= 60;

    const earlyLive = m.entryMode === 'EARLY_MOMENTUM'
      && s.s3 > .10
      && s.s5 > .02
      && s.score >= 65;

    if (!preArmLive && !confirmedLive && !earlyLive) return null;

    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const appetite = this.appetite(s, m);
    if (appetite === 'STAND_DOWN') return null;

    const entryMode = preArmLive ? 'SPEED_PRE_ARM' : m.entryMode;
    if (preArmLive) {
      this.preArm = {
        side,
        speedScore: s.score,
        confirmation: Number(m.confirmation || 0),
        epoch,
        quote,
        policy: 'LIVE_SPEED_PRE_ARM'
      };
    }

    const key = this.entryKey({ ...m, entryMode }, side);
    if (this.hasUsed(key)) return null;

    const cfg = appetite === 'GRAB'
      ? { riskModel: .40, targetR: .80 }
      : appetite === 'TRAIL'
        ? { riskModel: .70, targetR: 1.60 }
        : { riskModel: 1.00, targetR: 3.00 };

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
    const target = side === 'LONG' ? quote + riskDistance * cfg.targetR : quote - riskDistance * cfg.targetR;
    const units = cfg.riskModel / riskDistance;
    const entryContext = { ...slimMountain(m), entryMode };

    return {
      side, appetite, entry: quote, stop, trailStop: stop, target,
      targetR: cfg.targetR, units, riskDollars: cfg.riskModel,
      plannedRiskDistance: riskDistance,
      openedAt: Date.now(), openedEpoch: epoch, entryKey: key,
      bestR: 0, peakDemoPnl: 0, speedAgainstTicks: 0,
      entrySpeedScore: s.score,
      entrySpeedLabel: s.label, entryContext
    };
  }

  unrealized('''
    s = s[:m.start()] + candidate + s[m.end():]

    # 2. Model target may never masquerade as a winning exit while Deriv P/L is negative.
    old = "    if (p.side === 'LONG' && q >= p.target) return { reason: 'DYNAMIC TARGET', quote: p.target };\n    if (p.side === 'SHORT' && q <= p.target) return { reason: 'DYNAMIC TARGET', quote: p.target };"
    new = "    const modelTargetHit = (p.side === 'LONG' && q >= p.target) || (p.side === 'SHORT' && q <= p.target);\n    if (modelTargetHit && actualDemoPnl > 0.005) return { reason: 'ACTUAL + MODEL TARGET', quote: p.target };"
    if old not in s:
        raise SystemExit('PATCH REFUSED: dynamic target block not found')
    s = s.replace(old, new, 1)

    # 3. SPEED owns early exits. Do not wait for the whole mountain to formally reverse.
    old = "    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');\n    if (opposite) return { reason: 'CONFIRMED MOUNTAIN REVERSAL · FAST EXIT', quote: q };"
    new = """    const sameMountain = (p.side === 'LONG' && m.direction === 'UP') || (p.side === 'SHORT' && m.direction === 'DOWN');
    const speedDrop = Number(p.entrySpeedScore || 0) - Number(s.score || 0);
    const speedAgainst = sameMountain && Number(s.s3 || 0) < -.08 && Number(s.s5 || 0) <= .02;
    p.speedAgainstTicks = speedAgainst ? Number(p.speedAgainstTicks || 0) + 1 : 0;

    const speedCash = p.appetite === 'GRAB'
      ? (p.speedAgainstTicks >= 1 || s.score < 35 || speedDrop >= 25)
      : p.appetite === 'TRAIL'
        ? (p.speedAgainstTicks >= 2 || s.score < 30 || speedDrop >= 35)
        : (p.speedAgainstTicks >= 2 || s.score < 25 || speedDrop >= 40 || m.entryMode === 'EXHAUSTION');

    if (actualDemoPnl > 0.005 && speedCash) return { reason: `SPEED AUTHORITY · CASH ${p.appetite}`, quote: q };
    if (p.speedAgainstTicks >= 2 && actualDemoPnl <= -.01) return { reason: 'SPEED REVERSAL · CUT EARLY', quote: q };

    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
    if (opposite) return { reason: 'CONFIRMED MOUNTAIN REVERSAL · FAST EXIT', quote: q };"""
    if old not in s:
        raise SystemExit('PATCH REFUSED: mountain reversal block not found')
    s = s.replace(old, new, 1)

    # 4. Current appetite displayed by the board must be current, not stale from the entry tick.
    s = s.replace("      appetite: this.latestAppetite,", "      appetite: this.appetite(this.latestSpeed, this.latestMountain),", 1)

    # 5. Put speed authority telemetry in live status.
    old = "      entryConfirmation: s.position.entryContext?.confirmation || 0,\n      entrySpeedScore: s.position.entrySpeedScore"
    new = "      entryConfirmation: s.position.entryContext?.confirmation || 0,\n      entrySpeedScore: s.position.entrySpeedScore,\n      currentSpeedScore: Number(s.speed?.score || 0),\n      speedDelta: Number(s.speed?.score || 0) - Number(s.position.entrySpeedScore || 0),\n      speedAgainstTicks: Number(s.position.speedAgainstTicks || 0)"
    if old not in s:
        raise SystemExit('PATCH REFUSED: live status telemetry anchor not found')
    s = s.replace(old, new, 1)

    s = s.replace("architecture: 'NATIVE_VM_V2_SPEED'", "architecture: 'NATIVE_VM_V21_SPEED_AUTHORITY'", 1)
    runner.write_text(s)

# Dashboard patch
b = b.replace('SANI NATIVE V2 · SPEED BOARD', 'SANI NATIVE V2.1 · SPEED AUTHORITY BOARD')
old_line = "    console.log(`  Actual now ${cm(p.actualPnl)} · Peak actual ${cm(p.peakActualPnl)} · Buy latency ${Number(p.buyLatencyMs||0)}ms · entry speed ${Number(p.entrySpeedScore||0)}/100`);"
new_line = "    console.log(`  Actual now ${cm(p.actualPnl)} · Peak actual ${cm(p.peakActualPnl)} · Buy latency ${Number(p.buyLatencyMs||0)}ms`);\n    console.log(`  SPEED entry ${Number(p.entrySpeedScore||0)}/100 → now ${Number(p.currentSpeedScore||sp.score||0)}/100 · Δ ${Number(p.speedDelta||0)>=0?'+':''}${Number(p.speedDelta||0)} · against ${Number(p.speedAgainstTicks||0)} tick(s)`);"
if old_line in b:
    b = b.replace(old_line, new_line, 1)
board.write_text(b)

print('✅ V2.1 installed: SPEED controls paid entry + early exit; actual Deriv P/L controls target claims.')
PY

node --check "$RUNNER"
node --check "$BOARD"

# Fresh scoreboard for a clean V2.1 comparison. Prior run is backed up above.
rm -f "$ROOT/native-adaptive-state.json" "$ROOT/native-adaptive-trades.csv"

sudo systemctl restart "$SERVICE"
sleep 5

echo
echo "V2.1 SERVICE:"
sudo systemctl status "$SERVICE" --no-pager -l | sed -n '1,18p' || true

echo
echo "RUN THE BOARD:"
echo "  node $BOARD"
echo
echo "EXPECTED ARCHITECTURE: NATIVE_VM_V21_SPEED_AUTHORITY"
echo "Fresh scoreboard started. Demo balance itself was NOT reset."
