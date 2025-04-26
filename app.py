# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
st.set_page_config(page_title="🚀 Private Trading Web App", layout="wide")

# === OTHER IMPORTS ===
import requests
import json
import datetime
import websocket
import time
import re

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === PAGE TITLE ===
st.title("🚀 Private Trading Web App")
st.subheader("Auto Signal Reception + Manual Execute + History")

# === STATE MEMORY ===
if "signals" not in st.session_state:
    st.session_state.signals = []

if "manual_signals" not in st.session_state:
    st.session_state.manual_signals = []

if "executed_trades" not in st.session_state:
    st.session_state.executed_trades = []

# === FUNCTIONS ===

def execute_deriv_trade(symbol, contract_type, lot_size):
    try:
        ws = websocket.create_connection(DERIV_API_URL)
        auth_data = {"authorize": API_TOKEN}
        ws.send(json.dumps(auth_data))
        auth_response = json.loads(ws.recv())
        if auth_response.get("error"):
            st.error(f"Authorization failed: {auth_response['error']['message']}")
            return
        trade_data = {
            "buy": 1,
            "price": lot_size,
            "parameters": {
                "contract_type": contract_type,
                "symbol": symbol,
                "duration": 5,
                "duration_unit": "m",
                "basis": "stake",
                "amount": lot_size,
                "currency": "USD"
            },
            "req_id": 1
        }
        ws.send(json.dumps(trade_data))
        buy_response = json.loads(ws.recv())

        if buy_response.get("error"):
            st.error(f"Trade failed: {buy_response['error']['message']}")
        else:
            st.success(f"🚀 Trade placed successfully on {symbol}!")

        ws.close()
    except Exception as e:
        st.error(f"❌ Error during trade execution: {str(e)}")

# === SIGNAL PARSING FUNCTION ===
def parse_signals(raw_text):
    pattern = re.compile(r"Symbol: (.*?)\n.*?Signal: (.*?)\nEntry: (.*?)\nStop Loss.*?: (.*?)\nTP1.*?: (.*?)\nTP2.*?: (.*?)\n", re.DOTALL)
    matches = pattern.findall(raw_text)
    parsed = []
    for match in matches:
        symbol, signal_type, entry, sl, tp1, tp2 = match
        parsed.append({
            "symbol": symbol.strip(),
            "entry": float(entry.strip()),
            "sl": float(sl.strip()),
            "tp1": float(tp1.strip()),
            "tp2": float(tp2.strip()),
            "signal_type": signal_type.strip()
        })
    return parsed

# === SIDEBAR MENU ===
menu = st.sidebar.radio("Menu", ["📈 Dashboard", "📜 History", "⚙️ Settings"])

# === DASHBOARD ===
if menu == "📈 Dashboard":
    st.header("📈 Trading Dashboard")

    st.subheader("📅 Paste Signal Text")
    raw_text = st.text_area("Paste full signal text here:")

    if st.button("🔍 Parse Signals"):
        parsed_signals = parse_signals(raw_text)
        if parsed_signals:
            st.session_state.manual_signals.extend(parsed_signals)
            st.success(f"Parsed {len(parsed_signals)} signals successfully!")
        else:
            st.warning("No valid signals found in text.")

    if len(st.session_state.manual_signals) > 0:
        st.subheader("📊 Parsed Manual Trades:")

        for idx, signal in enumerate(st.session_state.manual_signals):
            with st.expander(f"{signal['symbol']} | {signal['signal_type']} - Entry: {signal['entry']}"):
                st.write(f"**Stop Loss:** {signal['sl']}")
                st.write(f"**TP1:** {signal['tp1']}")
                st.write(f"**TP2:** {signal['tp2']}")

                lot_size = st.number_input("💵 Lot Size (Stake $)", value=0.35, key=f"manual_lot_{idx}")
                tp_choice = st.selectbox("🎯 Choose Take Profit", ("TP1", "TP2"), key=f"manual_tp_choice_{idx}")

                if st.button("🚀 Execute Trade", key=f"manual_execute_{idx}"):
                    selected_tp = signal['tp1'] if tp_choice == "TP1" else signal['tp2']
                    contract_type = "CALL" if "Buy" in signal['signal_type'] else "PUT"

                    execute_deriv_trade(
                        symbol=signal['symbol'],
                        contract_type=contract_type,
                        lot_size=lot_size
                    )

                    trade_record = {
                        "symbol": signal['symbol'],
                        "entry": signal['entry'],
                        "sl": signal['sl'],
                        "tp": selected_tp,
                        "lot": lot_size,
                        "contract_type": contract_type,
                        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    }
                    st.session_state.executed_trades.append(trade_record)
                    st.success("✅ Manual Trade Executed Successfully!")

# === HISTORY ===
elif menu == "📜 History":
    st.header("📜 Executed Trade History")

    if len(st.session_state.executed_trades) == 0:
        st.info("No trades executed yet.")
    else:
        for trade in st.session_state.executed_trades:
            st.write(f"Symbol: {trade['symbol']}, Entry: {trade['entry']}, SL: {trade['sl']}, TP: {trade['tp']}, Lot: {trade['lot']}, Type: {trade['contract_type']}, Time: {trade['time']}")

# === SETTINGS ===
elif menu == "⚙️ Settings":
    st.header("⚙️ API Settings")
    st.write(f"**Current API Token:** {API_TOKEN[:5]}...{API_TOKEN[-5:]}")
    st.write(f"**Current App ID:** {APP_ID}")
    st.info("🚀 In future versions you can edit these inside the app easily.")
