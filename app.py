# Install libraries if needed
# !pip install streamlit requests websocket-client

import streamlit as st
import requests
import json
import datetime
import websocket
import time

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === State Memory ===
if "signals" not in st.session_state:
    st.session_state.signals = []

if "executed_trades" not in st.session_state:
    st.session_state.executed_trades = []

# === Handle Incoming Signals (NEW CODE)
query_params = st.experimental_get_query_params()
if "signal" in query_params:
    try:
        signal_data = json.loads(query_params["signal"][0])
        st.session_state.signals.append(signal_data)
        st.success("✅ New signal received!")
    except Exception as e:
        st.error(f"Failed to receive signal: {e}")

# === Title
st.set_page_config(page_title="🚀 Private Trading Web App", layout="wide")
st.title("🚀 Private Trading Web App")
st.subheader("Auto Signal Reception + Manual Execute + History")

# === Sidebar Menu
menu = st.sidebar.radio("Menu", ["📈 Dashboard", "📜 History", "⚙️ Settings"])

# === Functions ===

def execute_deriv_trade(symbol, contract_type, lot_size):
    """Connect to Deriv API and place a trade."""
    try:
        ws = websocket.create_connection(DERIV_API_URL)

        # 1. Authorize
        auth_data = {
            "authorize": API_TOKEN
        }
        ws.send(json.dumps(auth_data))
        auth_response = json.loads(ws.recv())
        if auth_response.get("error"):
            st.error(f"Authorization failed: {auth_response['error']['message']}")
            return
        st.success("✅ Authorized successfully!")

        # 2. Buy contract
        trade_data = {
            "buy": 1,
            "price": lot_size,   # stake amount in USD
            "parameters": {
                "contract_type": contract_type,
                "symbol": symbol,
                "duration": 1,
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

def add_dummy_signal():
    """Simulate a dummy signal (for testing only)."""
    st.session_state.signals.append({
        "symbol": "R_75",
        "entry": 126929.81,
        "sl": 127199.18,
        "tp1": 126587.44,
        "tp2": 126151.92,
        "signal_type": "Sell Stop"
    })

# === Pages ===

# === Dashboard ===
if menu == "📈 Dashboard":
    st.header("📈 Trading Dashboard")

    # TEST BUTTON: Simulate new signal (replace this with your real webhook/Colab signals)
    if st.button("➕ Add Dummy Signal"):
        add_dummy_signal()

    if len(st.session_state.signals) == 0:
        st.info("Waiting for trading signals...")
    else:
        for idx, signal in enumerate(st.session_state.signals):
            with st.expander(f"Signal {idx+1}: {signal['symbol']} | {signal['signal_type']}"):
                st.write(f"**Entry:** {signal['entry']}")
                st.write(f"**Stop Loss:** {signal['sl']}")
                st.write(f"**TP1:** {signal['tp1']}")
                st.write(f"**TP2:** {signal['tp2']}")
                st.write(f"**Signal Type:** {signal['signal_type']}")

                lot_size = st.number_input("💵 Lot Size (Stake $)", value=0.35, key=f"lot_{idx}")
                tp_choice = st.selectbox("🎯 Choose Take Profit", ("TP1", "TP2"), key=f"tp_choice_{idx}")

                if st.button("🚀 Execute Trade", key=f"execute_{idx}"):
                    selected_tp = signal['tp1'] if tp_choice == "TP1" else signal['tp2']
                    contract_type = "PUT" if "Sell" in signal['signal_type'] else "CALL"

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
                    st.success("✅ Trade recorded successfully!")

# === History ===
elif menu == "📜 History":
    st.header("📜 Executed Trade History")

    if len(st.session_state.executed_trades) == 0:
        st.info("No trades executed yet.")
    else:
        for trade in st.session_state.executed_trades:
            st.write(f"Symbol: {trade['symbol']}, Entry: {trade['entry']}, SL: {trade['sl']}, TP: {trade['tp']}, Lot: {trade['lot']}, Type: {trade['contract_type']}, Time: {trade['time']}")

# === Settings ===
elif menu == "⚙️ Settings":
    st.header("⚙️ API Settings")
    st.write(f"**Current API Token:** {API_TOKEN[:5]}...{API_TOKEN[-5:]}")
    st.write(f"**Current App ID:** {APP_ID}")
    st.info("🚀 In future versions you can edit these inside the app easily.")
