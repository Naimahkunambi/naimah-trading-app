# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time
import websocket
import json
import threading
import plotly.graph_objs as go

st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence 7.0", layout="wide", initial_sidebar_state="expanded")

# === INJECT CUSTOM CSS THEME ===
st.markdown("""
    <style>
    body {
        background-color: #1e1e2f;
    }
    .stApp {
        background-color: #1e1e2f;
    }
    .css-18e3th9, .css-1d391kg {
        background-color: #2a2a40;
    }
    .css-10trblm, .css-1v0mbdj {
        color: #ff69b4;
    }
    </style>
""", unsafe_allow_html=True)

# === SETTINGS ===
API_TOKEN = "YOUR_DERIV_API_TOKEN"
APP_ID = "YOUR_APP_ID"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === PAGE TITLE ===
st.title("🚀 Boss Babe Trading Intelligence 7.0")
st.subheader("Smart. Stylish. Unstoppable.")

# === GLOBALS ===
if "candles" not in st.session_state:
    st.session_state.candles = []

if "symbol" not in st.session_state:
    st.session_state.symbol = "R_50"

if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.0

if "demo_results" not in st.session_state:
    st.session_state.demo_results = []

if "streaming" not in st.session_state:
    st.session_state.streaming = False

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

# === MENU ===
menu = st.sidebar.radio("Boss Babe Menu 💎", ["📈 Chart", "📉 Start Demo", "📊 Stats", "⚙️ Settings", "💄 Tips"])

if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

# === PAGES ===
if menu == "📈 Chart":
    st.header("📈 Boss Babe Chart Playground")

    symbol = st.text_input("Enter Symbol (e.g. R_50)", st.session_state.symbol)
    if symbol:
        st.session_state.symbol = symbol

    df = pd.DataFrame(st.session_state.candles)
    if not df.empty:
        fig = go.Figure()
        fig.add_trace(go.Candlestick(
            x=df['epoch'],
            open=df['open'],
            high=df['high'],
            low=df['low'],
            close=df['close']
        ))
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Waiting for candles...")

elif menu == "📉 Start Demo":
    st.header("📉 Boss Babe Demo Trade")

    symbol = st.selectbox("Select Symbol", ["R_10", "R_25", "R_50", "R_75", "R_100"])
    contract = st.selectbox("Select Contract Type", ["Rise", "Fall", "Higher", "Lower", "Touch", "No Touch"])
    stake = st.number_input("Stake Amount ($)", min_value=0.35, value=1.00, step=0.01)
    duration = st.selectbox("Duration", ["5 ticks", "10 ticks", "30 ticks"])

    indicator = st.selectbox("Choose Boss Babe Indicator", ["Spike Zone", "Volatility Breakout", "Digit Analyzer"])

    if st.button("✨ Start Demo Trade"):
        result = np.random.choice(["Win", "Loss"], p=[0.55, 0.45])
        if result == "Win":
            profit = stake * 0.9
            st.session_state.demo_balance += profit
            st.success(f"🎉 You WON! Profit: ${profit:.2f}")
        else:
            st.session_state.demo_balance -= stake
            st.error(f"💔 You LOST! Loss: ${stake:.2f}")
        
        st.session_state.demo_results.append(result)

    st.metric("💰 Demo Balance", f"${st.session_state.demo_balance:.2f}")

elif menu == "📊 Stats":
    st.header("📊 Boss Babe Statistics")
    if st.session_state.demo_results:
        total_trades = len(st.session_state.demo_results)
        wins = st.session_state.demo_results.count("Win")
        losses = st.session_state.demo_results.count("Loss")
        win_rate = (wins / total_trades) * 100

        st.metric("Total Trades", total_trades)
        st.metric("Wins", wins)
        st.metric("Losses", losses)
        st.metric("Win Rate", f"{win_rate:.2f}%")
    else:
        st.info("No demo results yet!")

elif menu == "⚙️ Settings":
    st.header("⚙️ Boss Babe Settings")
    st.write("Customize your trading playground! 🎀")
    st.write("Coming soon: Change themes, reset balance, API settings...")

elif menu == "💄 Tips":
    st.header("💄 Boss Babe Tips")
    st.success("Rise/Fall = Best during trends 📈")
    st.info("Touch/No Touch = Best during spikes ⚡")
    st.warning("Digits = Only for tick trades 🕒")
    st.balloons()
