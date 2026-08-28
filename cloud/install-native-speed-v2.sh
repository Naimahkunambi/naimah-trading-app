#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
BRANCH="codex/milking-zone-lab"
REPO="https://raw.githubusercontent.com/Naimahkunambi/naimah-trading-app/${BRANCH}"
OLD_NATIVE="sani-native-demo"
NEW_NATIVE="sani-native-speed"
USER_NAME="$(id -un)"

mkdir -p "$ROOT"
cd "$ROOT"

echo "SANI NATIVE V2 SPEED installer"
echo "Demo only. One brain. One contract. Speed-adaptive appetite."

if [[ ! -f "$ROOT/deriv-demo.json" ]]; then
  echo "ERROR: $ROOT/deriv-demo.json is missing."
  exit 1
fi

# Never cut over if V1 currently reports an open Demo contract.
if [[ -f "$ROOT/demo-live-status.json" ]]; then
  if node - "$ROOT/demo-live-status.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const open = Boolean(s?.COMET?.live || s?.LAST_MAN_GRAB?.live || s?.SANI_ADAPTIVE?.live);
  process.exit(open ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    echo "REFUSED: status reports an open Demo contract."
    echo "Wait until the live field is null, then run this installer again."
    exit 2
  fi
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ROOT/v1-backups"
[[ -f "$ROOT/native-engine-state.json" ]] && cp "$ROOT/native-engine-state.json" "$ROOT/v1-backups/native-engine-state-${STAMP}.json" || true
[[ -f "$ROOT/native-demo-trades.csv" ]] && cp "$ROOT/native-demo-trades.csv" "$ROOT/v1-backups/native-demo-trades-${STAMP}.csv" || true

curl -fL "$REPO/cloud/libra-mountain.mjs" -o "$ROOT/libra-mountain.mjs"
curl -fL "$REPO/cloud/native-speed-runner.mjs" -o "$ROOT/native-speed-runner.mjs"
curl -fL "$REPO/cloud/native-speed-dashboard.mjs" -o "$ROOT/native-speed-dashboard.mjs"

if [[ ! -f "$ROOT/package.json" ]]; then
  printf '%s\n' '{"name":"sani-native-vm","private":true,"type":"module"}' > "$ROOT/package.json"
fi
npm install --prefix "$ROOT" --omit=dev ws >/dev/null

node --check "$ROOT/libra-mountain.mjs"
node --check "$ROOT/native-speed-runner.mjs"
node --check "$ROOT/native-speed-dashboard.mjs"

# Stop and disable V1 so only one executor can touch the Demo account.
sudo systemctl stop "$OLD_NATIVE" 2>/dev/null || true
sudo systemctl disable "$OLD_NATIVE" 2>/dev/null || true
sudo systemctl stop sani-night-shift 2>/dev/null || true
sudo systemctl disable sani-night-shift 2>/dev/null || true

# Fresh V2 scoreboard. Demo account balance itself is not reset.
rm -f "$ROOT/native-adaptive-state.json"
rm -f "$ROOT/native-adaptive-trades.csv"

sudo tee "/etc/systemd/system/${NEW_NATIVE}.service" >/dev/null <<EOF
[Unit]
Description=SANI Native V2 Speed Adaptive Deriv Demo Engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
Environment=NODE_ENV=production
Environment=SANI_SYMBOL=1HZ25V
Environment=SANI_MULTIPLIER=160
ExecStart=/usr/bin/node ${ROOT}/native-speed-runner.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$NEW_NATIVE"
sudo systemctl restart "$NEW_NATIVE"
sleep 5

echo
echo "V2 service status:"
sudo systemctl status "$NEW_NATIVE" --no-pager -l || true

echo
echo "LIVE BOARD:"
echo "  node $ROOT/native-speed-dashboard.mjs"
echo
echo "RAW LOG:"
echo "  sudo journalctl -u $NEW_NATIVE -f -o cat"
echo
echo "STATUS JSON:"
echo "  watch -n 30 cat $ROOT/demo-live-status.json"
echo
echo "TRADES CSV:"
echo "  tail -n 30 $ROOT/native-adaptive-trades.csv"
echo
echo "STOP TRADING:"
echo "  sudo systemctl stop $NEW_NATIVE"
