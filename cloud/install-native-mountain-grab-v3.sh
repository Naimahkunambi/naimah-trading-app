#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
BRANCH="codex/milking-zone-lab"
REPO="https://raw.githubusercontent.com/Naimahkunambi/naimah-trading-app/${BRANCH}"
SERVICE="sani-native-mountain-grab"
USER_NAME="$(id -un)"

mkdir -p "$ROOT"
cd "$ROOT"

echo "SANI NATIVE V3 · MOUNTAIN + GRAB installer"
echo "Demo only. Actual mountain entry. GRAB TP/SL/trailing. One contract."

if [[ ! -f "$ROOT/deriv-demo.json" ]]; then
  echo "ERROR: $ROOT/deriv-demo.json is missing."
  exit 1
fi

# Stop any old SANI executors so nothing can open a new trade during cutover.
sudo systemctl stop sani-native-speed 2>/dev/null || true
sudo systemctl stop sani-native-demo 2>/dev/null || true
sudo systemctl stop sani-night-shift 2>/dev/null || true

# Verify Deriv itself is flat. Do not trust stale local status files.
if [[ -f "$ROOT/demo-account.js" ]]; then
  echo "Checking Deriv Demo portfolio before V3 cutover..."
fi

curl -fL "$REPO/cloud/libra-mountain.mjs" -o "$ROOT/libra-mountain.mjs"
curl -fL "$REPO/cloud/native-mountain-grab-runner.mjs" -o "$ROOT/native-mountain-grab-runner.mjs"
curl -fL "$REPO/cloud/native-mountain-grab-dashboard.mjs" -o "$ROOT/native-mountain-grab-dashboard.mjs"

if [[ ! -f "$ROOT/package.json" ]]; then
  printf '%s\n' '{"name":"sani-native-vm","private":true,"type":"module"}' > "$ROOT/package.json"
fi
npm install --prefix "$ROOT" --omit=dev ws >/dev/null

node --check "$ROOT/libra-mountain.mjs"
node --check "$ROOT/native-mountain-grab-runner.mjs"
node --check "$ROOT/native-mountain-grab-dashboard.mjs"

# Clear only V3 research state. Never touch the Demo account balance.
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$ROOT/v3-backups"
[[ -f "$ROOT/native-mountain-grab-state.json" ]] && cp "$ROOT/native-mountain-grab-state.json" "$ROOT/v3-backups/state-${STAMP}.json" || true
[[ -f "$ROOT/native-mountain-grab-trades.csv" ]] && cp "$ROOT/native-mountain-grab-trades.csv" "$ROOT/v3-backups/trades-${STAMP}.csv" || true
rm -f "$ROOT/native-mountain-grab-state.json" "$ROOT/native-mountain-grab-trades.csv"

sudo systemctl disable sani-native-speed 2>/dev/null || true
sudo systemctl disable sani-native-demo 2>/dev/null || true
sudo systemctl disable sani-night-shift 2>/dev/null || true

sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=SANI Native V3 Mountain Entry + GRAB Management Demo Engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${ROOT}
Environment=HOME=${HOME}
Environment=NODE_ENV=production
Environment=SANI_SYMBOL=1HZ25V
Environment=SANI_STAKE=1
Environment=SANI_MULTIPLIER=160
ExecStart=/usr/bin/node ${ROOT}/native-mountain-grab-runner.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE"
sudo systemctl restart "$SERVICE"
sleep 5

echo
echo "V3 service status:"
sudo systemctl status "$SERVICE" --no-pager -l || true

echo
echo "LIVE BOARD:"
echo "  node $ROOT/native-mountain-grab-dashboard.mjs"
echo
echo "RAW LOG:"
echo "  sudo journalctl -u $SERVICE -f -o cat"
echo
echo "TRADES:"
echo "  tail -n 30 $ROOT/native-mountain-grab-trades.csv"
echo
echo "STOP TRADING:"
echo "  sudo systemctl stop $SERVICE"
