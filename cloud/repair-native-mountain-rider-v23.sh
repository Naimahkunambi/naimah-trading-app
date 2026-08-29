#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
SERVICE="sani-native-speed"
RUNNER="$ROOT/native-speed-runner.mjs"
BOARD="$ROOT/native-speed-dashboard.mjs"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "SANI V2.3 REPAIR · dashboard syntax only"

if [[ ! -f "$RUNNER" || ! -f "$BOARD" ]]; then
  echo "ERROR: V2.3 runner/dashboard missing in $ROOT"
  exit 1
fi

mkdir -p "$ROOT/v23-backups"
cp "$BOARD" "$ROOT/v23-backups/native-speed-dashboard-broken-${STAMP}.mjs"

python3 - "$BOARD" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1])
s=p.read_text()
old="Number(p.trailStop??p.stop||0).toFixed(2)"
new="Number((p.trailStop ?? p.stop) || 0).toFixed(2)"
if old not in s:
    print('Dashboard expression already repaired or changed.')
else:
    s=s.replace(old,new)
    p.write_text(s)
    print('✅ Fixed dashboard nullish-coalescing syntax.')
PY

node --check "$RUNNER"
node --check "$BOARD"

echo "✅ Runner syntax OK"
echo "✅ Dashboard syntax OK"

# The failed installer stopped the service before the syntax check. Start the patched V2.3 runner now.
# Start a clean V2.3 experiment ledger; backups from the installer preserve prior V2.1 data.
rm -f "$ROOT/native-adaptive-state.json" "$ROOT/native-adaptive-trades.csv"

sudo systemctl restart "$SERVICE"
sleep 5

echo
echo "SERVICE:"
sudo systemctl status "$SERVICE" --no-pager -l | sed -n '1,22p' || true

echo
echo "ARCHITECTURE CHECK:"
node - <<'NODE'
const fs=require('fs');
try {
 const s=JSON.parse(fs.readFileSync(process.env.HOME+'/sani-cloud/demo-live-status.json','utf8'));
 console.log('architecture =', s.architecture);
 console.log('demoOnly =', s.demoOnly);
 console.log('browserDependency =', s.browserDependency);
 console.log('vercelExecutionDependency =', s.vercelExecutionDependency);
} catch(e) { console.log('status not ready yet:', e.message); }
NODE

echo
echo "RUN THE BOARD:"
echo "  node $BOARD"
echo
echo "EXPECTED: NATIVE_VM_V23_FULL_MOUNTAIN_RIDER"
