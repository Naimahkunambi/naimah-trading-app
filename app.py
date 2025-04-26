# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide")

# === OTHER IMPORTS ===
import websocket
import json
import pandas as pd
import plotly.graph_objs as go
import threading
import time

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === PAGE TITLE ===
st.title("🚀 Boss Babe Trading Intelligence")
st.subheader("Smart. Stylish. Unstoppable.")

# === GLOBALS ===
if "candles" not in st.session_state:
    st.session_state.candles = []

if "symbol" not in st.session_state:
    st.session_state.symbol = "R_50"

if "demo_results" not in st.session_state:
    st.session_state.demo_results = []

# === FUNCTIONS ===
def update_candles(tick):
    ts = int(tick["epoch"])
    price = float(tick["quote"])
    timeframe = 60  # 1 minute
    candle_time = ts - (ts % timeframe)

    if len(st.session_state.candles) == 0 or st.session_state.candles[-1]["epoch"] < candle_time:
        st.session_state.candles.append({
            "epoch": candle_time,
            "open": price,
            "high": price,
            "low": price,
            "close": price
        })
    else:
        candle = st.session_state.candles[-1]
        candle["high"] = max(candle["high"], price)
        candle["low"] = min(candle["low"], price)
        candle["close"] = price

    if len(st.session_state.candles) > 100:
        st.session_state.candles.pop(0)


def stream_ticks(symbol, on_new_tick):
    ws = websocket.create_connection(DERIV_API_URL)
    auth_data = {"authorize": API_TOKEN}
    ws.send(json.dumps(auth_data))
    ws.recv()

    tick_request = {
        "ticks": symbol,
        "subscribe": 1
    }
    ws.send(json.dumps(tick_request))

    while True:
        data = json.loads(ws.recv())
        if "tick" in data:
            tick = data["tick"]
            on_new_tick(tick)

# === UI ===
menu = st.sidebar.radio("Menu", ["📈 Chart Playground", "📜 Signal Generator", "🎉 Demo Play", "🔢 Real Trades", "📊 Statistics", "⚙️ Settings"])

if menu == "📈 Chart Playground":
    st.header("📈 Your Trading Playground")
    st.info("Chart and indicators coming soon!")

if "streaming" not in st.session_state:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

if menu == "📜 Signal Generator":
    st.header("📜 Boss Babe Signal Generator (Coming Soon)")

if menu == "🎉 Demo Play":
    st.header("🎉 Boss Babe Demo Play (Coming Soon)")

if menu == "🔢 Real Trades":
    st.header("🔢 Boss Babe Real Trades (Coming Soon)")

if menu == "📊 Statistics":
    st.header("📊 Boss Babe Trading Statistics")

    total_trades = len(st.session_state.demo_results)
    wins = st.session_state.demo_results.count("Win")
    losses = st.session_state.demo_results.count("Loss")
    win_rate = (wins / total_trades * 100) if total_trades > 0 else 0

    col1, col2, col3 = st.columns(3)

    with col1:
        st.metric(label="🎯 Total Demo Trades", value=total_trades)
    with col2:
        st.metric(label="🏆 Wins", value=wins)
    with col3:
        st.metric(label="💔 Losses", value=losses)

    st.metric(label="🔥 Win Rate", value=f"{win_rate:.2f}%")

    if total_trades > 0:
        st.subheader("📋 Demo Trade History")
        trade_data = {"Result": st.session_state.demo_results}
        st.dataframe(pd.DataFrame(trade_data))
    else:
        st.info("No demo trades recorded yet. Go slay some markets first, Queen! 👑")

if menu == "⚙️ Settings":
    st.header("⚙️ Settings")
    st.info("More Customizations Coming Soon!")
