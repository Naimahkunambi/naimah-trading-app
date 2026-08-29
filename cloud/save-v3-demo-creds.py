#!/usr/bin/env python3
import getpass
import json
import os
from pathlib import Path

ROOT = Path.home() / "sani-cloud"
OUT = ROOT / "deriv-demo-v3.json"

print("\n=== SANI V3 DEDICATED DERIV DEMO ===\n")
print("This file is ONLY for V3 Mountain + GRAB.")
print("Your browser COMET / LAST MAN credentials are not changed.\n")

app_id = input("Paste V3 Deriv App ID, then press Enter: ").strip()
token = getpass.getpass("Paste V3 DEMO token (hidden), then press Enter: ").strip()
account_id = input("Paste V3 DEMO account ID, then press Enter: ").strip()

if not app_id or not token or not account_id:
    raise SystemExit("❌ Missing value. Nothing saved.")

ROOT.mkdir(parents=True, exist_ok=True)
with OUT.open("w", encoding="utf-8") as f:
    json.dump({"appId": app_id, "token": token, "accountId": account_id}, f)

os.chmod(OUT, 0o600)

print("\n✅ V3 dedicated Demo credentials saved.")
print(f"File: {OUT}")
print(f"App ID: {app_id}")
print(f"Demo account: {account_id}")
print(f"Token length: {len(token)} characters")
print("Token itself was NOT printed.\n")
