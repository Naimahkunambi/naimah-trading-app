# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time
import websocket
import json
import threading
import random
import plotly.graph_objs as go

st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide", initial_sidebar_state="expanded")

# === INJECT CUSTOM CSS THEME ===
st.markdown("""
    <style>
    body {
        background-color: #1c1c1e;
        color: #ffccff;
    }
    .stApp {
        background-color: #1c1c1e;
    }
    .css-18e3th9, .css-1d391kg {
        background-color: #2e2e32;
    }
    .css-10trblm, .css-1v0mbdj {
        color: #ffccff;
    }
    </style>
""", unsafe_allow_html=True)

# === SETTINGS ===
API_TOKEN = "YOUR_DERIV_TOKEN"
APP_ID = "YOUR_APP_ID"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === GLOBALS ===
if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.00

if "trade_history" not in st.session_state:
    st.session_state.trade_history = []

if "candles" not in st.session_state:
    st.session_state.candles = []

if "streaming" not in st.session_state:
    st.session_state.streaming = False

# === STREAM TICKS ===
def update_candles(tick):
    ts = int(tick["epoch"])
    price = float(tick["quote"])
    timeframe = 60  # 1-minute candles
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
menu = st.sidebar.radio("Boss Babe Menu 💎", ["📈 Chart", "🎯 Start Demo", "📊 Stats", "⚙️ Settings", "🎀 Tips"])

if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=("R_50", update_candles), daemon=True).start()
    st.session_state.streaming = True

# === CHART ===
if menu == "📈 Chart":
    st.header("📈 Boss Babe Playground")
    if st.session_state.candles:
        df = pd.DataFrame(st.session_state.candles)
        fig = go.Figure(data=[go.Candlestick(
            x=df['epoch'],
            open=df['open'],
            high=df['high'],
            low=df['low'],
            close=df['close']
        )])
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Waiting for live chart...")

# === DEMO PLAY ===
elif menu == "🎯 Start Demo":
    st.header("🎯 Boss Babe Demo Trading")

    symbol = st.selectbox("Select Symbol", ["R_10", "R_25", "R_50", "R_75", "R_100", "Volatility 10", "Volatility 25", "Volatility 50", "Volatility 75", "Volatility 100"])
    contract_type = st.selectbox("Select Contract Type", ["Rise/Fall", "Higher/Lower", "Touch/No Touch", "Digits"])

    stake = st.number_input("Stake Amount ($)", min_value=0.35, value=1.00, step=0.01)
    duration = st.number_input("Duration (in ticks)", min_value=1, value=5, step=1)

    indicator = st.selectbox("Choose Indicator", ["Spike Zone", "Volatility Breakout", "Digit Match Detector"])

    if st.button("🚀 Start Demo Trade"):
        entry_price = random.uniform(100, 1000)  # Mock entry
        outcome = random.choice(["Win", "Loss"])
        profit = stake * (0.95 if outcome == "Win" else -1)

        # Update balance
        st.session_state.demo_balance += profit

        # Save to history
        st.session_state.trade_history.append({
            "symbol": symbol,
            "contract": contract_type,
            "entry_price": round(entry_price, 2),
            "outcome": outcome,
            "profit": round(profit, 2),
            "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })

        if outcome == "Win":
            st.success(f"🎉 You WON! Profit: ${profit:.2f}")
        else:
            st.error(f"😢 You LOST. Loss: ${-profit:.2f}")

    # Show balance
    st.metric(label="💰 Demo Balance", value=f"${st.session_state.demo_balance:.2f}")

    # Show trade history
    if st.session_state.trade_history:
        df_history = pd.DataFrame(st.session_state.trade_history)
        st.dataframe(df_history)

# === STATISTICS ===
elif menu == "📊 Stats":
    st.header("📊 Boss Babe Trading Stats")
    if st.session_state.trade_history:
        wins = sum(1 for x in st.session_state.trade_history if x["outcome"] == "Win")
        losses = sum(1 for x in st.session_state.trade_history if x["outcome"] == "Loss")
        total = wins + losses
        win_rate = (wins / total) * 100 if total > 0 else 0

        st.metric("Total Trades", total)
        st.metric("Wins", wins)
        st.metric("Losses", losses)
        st.metric("Win Rate", f"{win_rate:.2f}%")
    else:
        st.info("No trades yet!")

# === SETTINGS ===
elif menu == "⚙️ Settings":
    st.header("⚙️ Boss Babe Settings")
    st.info("More customization coming soon!")

# === TIPS ===
elif menu == "🎀 Tips":
    st.header("🎀 Boss Babe Tips")
    st.success("Rise/Fall = Best during trends")
    st.success("Touch/No Touch = Best during spikes")
    st.success("Digits = Only for tick trades")
    st.info("Stay calm, smart and stylish! 💅")

