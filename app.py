# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide")

# === OTHER IMPORTS ===
import requests
import json
import datetime
import websocket
import time
import re
import plotly.graph_objs as go

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === PAGE TITLE ===
st.title("🚀 Boss Babe Trading Intelligence")
st.subheader("Smart. Stylish. Unstoppable.")

# === STATE MEMORY ===
if "signals" not in st.session_state:
    st.session_state.signals = []

if "manual_signals" not in st.session_state:
    st.session_state.manual_signals = []

if "executed_trades" not in st.session_state:
    st.session_state.executed_trades = []

if "active_contracts" not in st.session_state:
    st.session_state.active_contracts = []

if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.0

# === FUNCTIONS ===

def execute_deriv_trade(symbol, contract_type, lot_size, is_demo=True):
    if is_demo:
        st.session_state.demo_balance -= lot_size
        trade_record = {
            "symbol": symbol,
            "lot_size": lot_size,
            "contract_type": contract_type,
            "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "status": "Demo - Pending"
        }
        st.session_state.active_contracts.append(trade_record)
        st.success("🚀 Demo trade placed successfully!")
        return

    try:
        ws = websocket.create_connection(DERIV_API_URL)
        auth_data = {"authorize": API_TOKEN}
        ws.send(json.dumps(auth_data))
        ws.recv()

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
        ws.recv()
        st.success("🚀 Real trade placed successfully!")
        ws.close()

    except Exception as e:
        st.error(f"❌ Error during trade execution: {str(e)}")


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
menu = st.sidebar.radio("Menu", ["📈 Chart Playground", "📃 Signal Generator", "🎉 Demo Play", "🔢 Real Trades", "📊 Statistics", "⚙️ Settings"])

# === CHART PLAYGROUND ===
if menu == "📈 Chart Playground":
    st.header("📈 Your Trading Playground")

    symbol = st.text_input("Enter Symbol (e.g. R_50)", value="R_50")
    timeframe = st.selectbox("Timeframe", ["1m", "5m", "15m", "1h", "4h", "1d"])

    st.subheader("🔹 Choose Indicators")
    show_rsi = st.checkbox("Show RSI")
    show_ma = st.checkbox("Show Moving Average")

    st.subheader("👀 Chart View")
    st.info("(Charts are coming soon in Phase 3 update!)")

# === SIGNAL GENERATOR ===
elif menu == "📃 Signal Generator":
    st.header("📃 Boss Babe Signal Lab")

    st.subheader("Paste Signal Text")
    raw_text = st.text_area("Paste your full signal text below:")

    if st.button("🔍 Parse Signals"):
        parsed_signals = parse_signals(raw_text)
        if parsed_signals:
            st.session_state.manual_signals.extend(parsed_signals)
            st.success(f"Parsed {len(parsed_signals)} signals successfully!")
        else:
            st.warning("No valid signals found.")

    if len(st.session_state.manual_signals) > 0:
        st.subheader("Parsed Manual Trades:")

        for idx, signal in enumerate(st.session_state.manual_signals):
            with st.expander(f"{signal['symbol']} | {signal['signal_type']} - Entry: {signal['entry']}"):
                st.write(f"**Stop Loss:** {signal['sl']}")
                st.write(f"**TP1:** {signal['tp1']}")
                st.write(f"**TP2:** {signal['tp2']}")
                lot_size = st.number_input("Stake ($)", value=0.35, key=f"lot_{idx}")
                if st.button("🚀 Execute Demo Trade", key=f"execute_demo_{idx}"):
                    contract_type = "CALL" if "Buy" in signal['signal_type'] else "PUT"
                    execute_deriv_trade(signal['symbol'], contract_type, lot_size, is_demo=True)

# === DEMO PLAY ===
elif menu == "🎉 Demo Play":
    st.header("🎉 Practice Like a Boss")

    st.subheader("Choose Symbol")
    demo_symbol = st.text_input("Enter Demo Symbol (e.g. R_50)", value="R_50")
    demo_lot = st.number_input("Demo Lot Size ($)", value=0.35)
    contract_type = st.selectbox("Choose Contract Type", ["CALL", "PUT"])

    if st.button("🎉 Place Demo Trade"):
        execute_deriv_trade(demo_symbol, contract_type, demo_lot, is_demo=True)

    st.write("\n")
    st.subheader("💼 Active Demo Trades")

    if len(st.session_state.active_contracts) == 0:
        st.info("No active demo trades yet.")
    else:
        for trade in st.session_state.active_contracts:
            st.write(f"{trade['time']}: {trade['symbol']} | {trade['contract_type']} | ${trade['lot_size']} | {trade['status']}")

# === REAL TRADES ===
elif menu == "🔢 Real Trades":
    st.header("🔢 Go Live With Real Trades")
    st.info("Feature launching soon in Phase 3!")

# === STATISTICS ===
elif menu == "📊 Statistics":
    st.header("📊 Track Your Boss Moves")

    st.subheader("Demo Balance")
    st.metric(label="Balance ($)", value=round(st.session_state.demo_balance, 2))

    st.subheader("Trade History")
    if len(st.session_state.executed_trades) == 0:
        st.info("No trades executed yet.")
    else:
        for trade in st.session_state.executed_trades:
            st.write(f"{trade['time']}: {trade['symbol']} | {trade['contract_type']} | ${trade['lot_size']}")

# === SETTINGS ===
elif menu == "⚙️ Settings":
    st.header("⚙️ Customize Your Trading")
    st.write("(Theme settings and more coming soon in Phase 3!)")
