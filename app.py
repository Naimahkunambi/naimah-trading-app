# 🚀 Boss Babe 5.0 - SmartTrader Boss System
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time
import websocket
import json
import threading
import plotly.graph_objs as go

# === PAGE SETTINGS ===
st.set_page_config(page_title="🚀 Boss Babe 5.0", layout="wide", initial_sidebar_state="expanded")

# === STYLING ===
st.markdown("""
<style>
body { background-color: #d6336c; }
.stApp { background-color: #d6336c; }
.css-18e3th9, .css-1d391kg { background-color: #6c4f3d; }
button { background-color: #6f42c1 !important; color: white !important; font-weight: bold; border-radius: 10px; }
</style>
""", unsafe_allow_html=True)

# === DERIV CONNECTION SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === STATE INITIALIZATION ===
if "candles" not in st.session_state:
    st.session_state.candles = []
if "symbol" not in st.session_state:
    st.session_state.symbol = "R_50"
if "contract_type" not in st.session_state:
    st.session_state.contract_type = "rise_fall"
if "duration" not in st.session_state:
    st.session_state.duration = 1
if "stake" not in st.session_state:
    st.session_state.stake = 1.00
if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.0
if "demo_history" not in st.session_state:
    st.session_state.demo_history = []
if "streaming" not in st.session_state:
    st.session_state.streaming = False

# === FUNCTIONS ===
def update_candles(tick):
    ts = int(tick["epoch"])
    price = float(tick["quote"])
    timeframe = 60
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

    if len(st.session_state.candles) > 200:
        st.session_state.candles.pop(0)

def stream_ticks(symbol, on_new_tick):
    ws = websocket.create_connection(DERIV_API_URL)
    ws.send(json.dumps({"authorize": API_TOKEN}))
    ws.recv()
    ws.send(json.dumps({"ticks": symbol, "subscribe": 1}))
    while True:
        data = json.loads(ws.recv())
        if "tick" in data:
            tick = data["tick"]
            on_new_tick(tick)

def simulate_demo_trade(direction):
    result = np.random.choice(["Win", "Loss"], p=[0.55, 0.45])
    profit = (st.session_state.stake * 0.95) if result == "Win" else -st.session_state.stake
    st.session_state.demo_balance += profit
    st.session_state.demo_history.append({
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "symbol": st.session_state.symbol,
        "direction": direction,
        "stake": st.session_state.stake,
        "duration": st.session_state.duration,
        "contract_type": st.session_state.contract_type,
        "result": result,
        "profit": profit,
        "balance_after": st.session_state.demo_balance
    })
    return result, profit

# === STREAMING ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

# === MENU ===
menu = st.sidebar.radio("Boss Babe Menu", ["📈 Chart", "🛍️ Contract Form", "🎮 Demo Play", "📊 Statistics", "⚙️ Settings"])

# === CHART PAGE ===
if menu == "📈 Chart":
    st.header("📈 Boss Babe Chart View")
    df = pd.DataFrame(st.session_state.candles)
    if not df.empty:
        fig = go.Figure()
        fig.add_trace(go.Candlestick(
            x=pd.to_datetime(df['epoch'], unit='s'),
            open=df['open'],
            high=df['high'],
            low=df['low'],
            close=df['close'],
            increasing_line_color='lightgreen',
            decreasing_line_color='red',
            name="Candles"
        ))
        fig.update_layout(xaxis_rangeslider_visible=False)
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Loading candles...")

# === CONTRACT FORM PAGE ===
elif menu == "🛍️ Contract Form":
    st.header("🛍️ Boss Babe Contract Builder")

    symbols = ["R_10", "R_25", "R_50", "R_75", "R_100", "Boom 1000 Index", "Crash 1000 Index", "Crash 500 Index", "Boom 500 Index"]
    st.session_state.symbol = st.selectbox("Select Symbol:", symbols).replace(" ", "_").upper()

    contract_options = {"Rise/Fall": "rise_fall", "Higher/Lower": "higher_lower"}
    st.session_state.contract_type = contract_options[st.selectbox("Select Contract Type:", list(contract_options.keys()))]

    st.session_state.stake = st.number_input("Stake Amount ($)", min_value=0.35, value=1.00, step=0.01)
    st.session_state.duration = st.number_input("Duration (ticks or minutes)", min_value=1, value=1)

# === DEMO PLAY PAGE ===
elif menu == "🎮 Demo Play":
    st.header("🎮 Boss Babe Demo Play")

    st.metric("💰 Demo Balance", f"${st.session_state.demo_balance:.2f}")

    col1, col2 = st.columns(2)
    with col1:
        if st.button("🚀 Buy Rise"):
            result, profit = simulate_demo_trade("Rise")
            if result == "Win":
                st.success(f"Rise Contract WON! Profit: ${profit:.2f}")
            else:
                st.error(f"Rise Contract LOST! Loss: ${profit:.2f}")

    with col2:
        if st.button("⬇️ Buy Fall"):
            result, profit = simulate_demo_trade("Fall")
            if result == "Win":
                st.success(f"Fall Contract WON! Profit: ${profit:.2f}")
            else:
                st.error(f"Fall Contract LOST! Loss: ${profit:.2f}")

    st.subheader("📝 Demo Trade History")
    if st.session_state.demo_history:
        st.dataframe(pd.DataFrame(st.session_state.demo_history))
    else:
        st.info("No trades yet.")

# === STATISTICS PAGE ===
elif menu == "📊 Statistics":
    st.header("📊 Boss Babe Trading Statistics")

    if st.session_state.demo_history:
        total = len(st.session_state.demo_history)
        wins = sum(1 for x in st.session_state.demo_history if x["result"] == "Win")
        losses = total - wins
        win_rate = (wins / total) * 100
        st.metric("Total Trades", total)
        st.metric("Wins", wins)
        st.metric("Losses", losses)
        st.metric("Win Rate", f"{win_rate:.2f}%")
    else:
        st.info("No trades yet.")

# === SETTINGS PAGE ===
elif menu == "⚙️ Settings":
    st.header("⚙️ Boss Babe Settings")
    st.info("Settings to customize your experience (coming soon!)")
