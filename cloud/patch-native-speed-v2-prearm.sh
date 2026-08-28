#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
RUNNER="$ROOT/native-speed-runner.mjs"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$RUNNER" ]]; then
  echo "ERROR: $RUNNER not found."
  exit 1
fi

cp "$RUNNER" "$ROOT/native-speed-runner-before-prearm-${STAMP}.mjs"

python3 - "$RUNNER" <<'PY'
from pathlib import Path
import re, sys

p = Path(sys.argv[1])
s = p.read_text()

# 1) Persist a short anti-churn cooldown across restarts.
old = "    this.lastCloseEpoch = Number(persisted?.lastCloseEpoch || 0);\n    this.usedEntryKeys = Array.isArray(persisted?.usedEntryKeys) ? persisted.usedEntryKeys.slice(-500) : [];"
new = "    this.lastCloseEpoch = Number(persisted?.lastCloseEpoch || 0);\n    this.cooldownUntilEpoch = Number(persisted?.cooldownUntilEpoch || 0);\n    this.usedEntryKeys = Array.isArray(persisted?.usedEntryKeys) ? persisted.usedEntryKeys.slice(-500) : [];"
if old not in s:
    raise SystemExit("PATCH REFUSED: constructor anchor not found")
s = s.replace(old, new, 1)

# 2) Replace late-entry policy. PRE-ARM becomes the only Demo entry path.
pat = re.compile(r"  candidate\(latencyHeld = false\) \{.*?\n  \}\n\n  unrealized\(", re.S)
match = pat.search(s)
if not match:
    raise SystemExit("PATCH REFUSED: candidate() block not found")

candidate = r'''  candidate(latencyHeld = false) {
    const m = this.latestMountain;
    const s = this.latestSpeed;
    this.latestAppetite = this.appetite(s, m);
    this.preArm = null;

    if (latencyHeld || this.position || !m?.ready || !['UP','DOWN'].includes(m.direction)) return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch || epoch <= this.cooldownUntilEpoch) return null;

    // SPEED V2 thesis: do not pay for the fully-confirmed pullback end.
    // Enter one structural beat earlier, while the mountain is retained and the turn is forming.
    if (m.entryMode !== 'WAIT_PULLBACK_END') return null;

    const confirmation = Number(m.confirmation || 0);
    const primaryPreArm = confirmation === 3 && s.s3 > .08 && s.accel > -.02 && s.score >= 55;
    const fastPreArm = confirmation === 4 && s.s3 > .12 && s.accel > .12 && s.score >= 70;
    if (!primaryPreArm && !fastPreArm) return null;

    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const appetite = this.appetite(s, m);
    if (appetite === 'STAND_DOWN') return null;

    this.preArm = {
      side,
      speedScore: s.score,
      confirmation,
      epoch,
      quote,
      policy: 'LIVE_PRE_ARM'
    };

    const entryContext = slimMountain(m);
    entryContext.entryMode = 'PRE_PULLBACK_END';
    const key = this.entryKey({ ...m, entryMode: 'PRE_PULLBACK_END' }, side);
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

    return {
      side, appetite, entry: quote, stop, trailStop: stop, target,
      targetR: cfg.targetR, units, riskDollars: cfg.riskModel,
      plannedRiskDistance: riskDistance,
      openedAt: Date.now(), openedEpoch: epoch, entryKey: key,
      bestR: 0, peakDemoPnl: 0, oppositeTicks: 0,
      entrySpeedScore: s.score, entrySpeedLabel: s.label,
      entryContext
    };
  }

  unrealized('''
s = s[:match.start()] + candidate + s[match.end():]

# 3) A one-tick mountain flip is not enough to eject us. Require persistence for two ticks.
old = "    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');\n    if (opposite) return { reason: 'CONFIRMED MOUNTAIN REVERSAL · FAST EXIT', quote: q };"
new = "    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');\n    p.oppositeTicks = opposite ? Number(p.oppositeTicks || 0) + 1 : 0;\n    if (p.oppositeTicks >= 2) return { reason: 'CONFIRMED MOUNTAIN REVERSAL · 2-TICK EXIT', quote: q };"
if old not in s:
    raise SystemExit("PATCH REFUSED: reversal block not found")
s = s.replace(old, new, 1)

# 4) After a close, stop machine-gun re-entry into the same noisy patch.
old = "    this.lastCloseEpoch = Number(this.ticks.at(-1)?.epoch || this.lastCloseEpoch);\n    this.position = null;"
new = "    this.lastCloseEpoch = Number(this.ticks.at(-1)?.epoch || this.lastCloseEpoch);\n    const cooldownTicks = trade.demoPnl > 0 ? 3 : (String(reason).includes('REVERSAL') ? 8 : 6);\n    this.cooldownUntilEpoch = this.lastCloseEpoch + cooldownTicks;\n    this.position = null;"
if old not in s:
    raise SystemExit("PATCH REFUSED: commitExit cooldown anchor not found")
s = s.replace(old, new, 1)

# 5) Expose cooldown to dashboard/status and persist it.
old = "      preArm: this.preArm\n    };"
new = "      preArm: this.preArm,\n      cooldownUntilEpoch: this.cooldownUntilEpoch,\n      cooldownRemaining: Math.max(0, Number(this.cooldownUntilEpoch || 0) - Number(this.ticks.at(-1)?.epoch || 0))\n    };"
if old not in s:
    raise SystemExit("PATCH REFUSED: snapshot anchor not found")
s = s.replace(old, new, 1)

old = "      lastCloseEpoch: engine.lastCloseEpoch,\n      usedEntryKeys: engine.usedEntryKeys"
new = "      lastCloseEpoch: engine.lastCloseEpoch,\n      cooldownUntilEpoch: engine.cooldownUntilEpoch,\n      usedEntryKeys: engine.usedEntryKeys"
if old not in s:
    raise SystemExit("PATCH REFUSED: persisted state anchor not found")
s = s.replace(old, new, 1)

old = "    preArm: s.preArm\n  };"
new = "    preArm: s.preArm,\n    cooldownUntilEpoch: s.cooldownUntilEpoch,\n    cooldownRemaining: s.cooldownRemaining\n  };"
if old not in s:
    raise SystemExit("PATCH REFUSED: statusEngine anchor not found")
s = s.replace(old, new, 1)

s = s.replace("  console.log(' PRE-ARM = SHADOW ONLY FOR NOW');", "  console.log(' PRE-ARM = ONLY LIVE DEMO ENTRY POLICY');\n  console.log(' PULLBACK_END / EARLY_MOMENTUM = OBSERVE ONLY');", 1)

p.write_text(s)
print("✅ SPEED V2 patched: PRE-ARM live only + 2-tick reversal + anti-churn cooldown")
PY

node --check "$RUNNER"

echo
echo "Patch installed. Runner syntax is valid."
echo "Do NOT restart while a Demo contract is open."
echo "When status SANI_ADAPTIVE.live is null, restart with:"
echo "  sudo systemctl restart sani-native-speed"
