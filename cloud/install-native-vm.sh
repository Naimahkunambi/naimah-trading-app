#!/usr/bin/env bash
set -euo pipefail

ROOT="$HOME/sani-cloud"
BRANCH="codex/milking-zone-lab"
REPO="https://raw.githubusercontent.com/Naimahkunambi/naimah-trading-app/${BRANCH}"
OLD_SERVICE="sani-night-shift"
NEW_SERVICE="sani-native-demo"
USER_NAME="$(id -un)"

mkdir -p "$ROOT"
cd "$ROOT"

echo "SANI NATIVE VM installer"
echo "This installs COMET + LAST MAN GRAB directly on the VM."
echo "Demo only. Vercel/Playwright are not used for execution."

if [[ ! -f "$ROOT/deriv-demo.json" ]]; then
  echo "ERROR: $ROOT/deriv-demo.json is missing."
  exit 1
fi

# Never cut over while the old bridge says a Demo contract is still open.
if [[ -f "$ROOT/demo-live-status.json" ]]; then
  if node - "$ROOT/demo-live-status.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
try {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const open = Boolean(s?.COMET?.live || s?.LAST_MAN_GRAB?.live);
  process.exit(open ? 0 : 1);
} catch { process.exit(1); }
NODE
  then
    echo "REFUSED: the current bridge reports an open Demo contract."
    echo "Wait until COMET.live and LAST_MAN_GRAB.live are null, then run this installer again."
    exit 2
  fi
fi

curl -fL "$REPO/cloud/libra-mountain.mjs" -o "$ROOT/libra-mountain.mjs"
curl -fL "$REPO/cloud/native-engines.mjs" -o "$ROOT/native-engines.mjs"
curl -fL "$REPO/cloud/native-runner.mjs" -o "$ROOT/native-runner.mjs"

if [[ ! -f "$ROOT/package.json" ]]; then
  printf '%s\n' '{"name":"sani-native-vm","private":true,"type":"module"}' > "$ROOT/package.json"
fi
npm install --prefix "$ROOT" --omit=dev ws >/dev/null

node --check "$ROOT/libra-mountain.mjs"
node --check "$ROOT/native-engines.mjs"
node --check "$ROOT/native-runner.mjs"

# Stop the browser relay before the native runner starts. We do not want two
# independent processes copying the same COMET/LMS signals into one Demo account.
sudo systemctl stop "$OLD_SERVICE" 2>/dev/null || true
sudo systemctl disable "$OLD_SERVICE" 2>/dev/null || true

sudo tee "/etc/systemd/system/${NEW_SERVICE}.service" >/dev/null <<EOF
[Unit]
Description=SANI Native COMET + LAST MAN GRAB Deriv Demo Engine
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
ExecStart=/usr/bin/node ${ROOT}/native-runner.mjs
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$NEW_SERVICE"
sudo systemctl restart "$NEW_SERVICE"
sleep 4

echo
echo "Native service status:"
sudo systemctl status "$NEW_SERVICE" --no-pager -l || true

echo
echo "Use these commands later:"
echo "  watch -n 30 cat $ROOT/demo-live-status.json"
echo "  sudo journalctl -u $NEW_SERVICE -f -o cat"
echo "  tail -n 30 $ROOT/native-demo-trades.csv"
echo
echo "If you ever need to stop trading:"
echo "  sudo systemctl stop $NEW_SERVICE"
