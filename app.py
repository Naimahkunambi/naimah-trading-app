# 🚀 Boss Babe Trading Intelligence 4.2

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
st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide", initial_sidebar_state="expanded")

# === CUSTOM THEME ===
st.markdown("""
    <style>
    body {
        background-color: #d6336c;
    }
    .stApp {
        background-color: #d6336c;
    }
    .css-18e3th9, .css-1d391kg {
        background-color: #6c4f3d;
    }
    .css-10trblm, .css-1v0mbdj {
        color: #ffffff;
    }
    button {
        background-color: #6f42c1 !important;
        color: white !important;
        border-radius: 10px;
        font-weight: bold;
    }
    </style>
""", unsafe_allow_html=True)

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === STATE ===
if "candles" not in st.session_state:
    st.session_state.candles = []

if "symbol" not in st.session_state:
    st.session_state.symbol = "R_50"

if "contract_type" not in st.session_state:
    st.session_state.contract_type = "rise_fall"

if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.0

if "demo_results" not in st.session_state:
    st.session_state.demo_results = []

if "streaming" not in st.session_state:
    st.session_state.streaming = False

if "signals" not in st.session_state:
    st.session_state.signals = []

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

    generate_signals()

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

def generate_signals():
    df = pd.DataFrame(st.session_state.candles)
    if len(df) < 10:
        return
    last = df.iloc[-1]
    prev = df.iloc[-2]

    # Spike Detector
    if abs(last["high"] - last["low"]) > 2 * abs(last["open"] - last["close"]):
        st.session_state.signals.append({
            "type": "🎯 Spike Zone",
            "action": "Higher/Lower",
            "price": last["close"],
            "time": datetime.datetime.now().strftime("%H:%M:%S")
        })

    # Volatility Breakout
    mean_range = (df['high'] - df['low']).mean()
    last_range = last['high'] - last['low']
    if last_range > 1.5 * mean_range:
        st.session_state.signals.append({
            "type": "💥 Breakout",
            "action": "Rise/Fall",
            "price": last["close"],
            "time": datetime.datetime.now().strftime("%H:%M:%S")
        })

def place_demo_trade(result):
    if result == "Win":
        st.session_state.demo_balance += np.random.uniform(1, 5)
        st.session_state.demo_results.append("Win")
    else:
        st.session_state.demo_balance -= np.random.uniform(1, 5)
        st.session_state.demo_results.append("Loss")

# === STREAM INIT ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

# === MENU ===
menu = st.sidebar.radio("Boss Babe Menu", ["📈 Chart Playground", "🎮 Demo Play", "📊 Statistics", "⚙️ Settings"])

# === MAIN LOGIC ===
if menu == "📈 Chart Playground":
    st.header("📈 Boss Babe Chart Playground")

    symbols = ["R_10", "R_25", "R_50", "R_75", "R_100", "Boom 1000 Index", "Crash 1000 Index", "Crash 500 Index", "Boom 500 Index"]
    chosen_symbol = st.selectbox("Choose Symbol:", symbols)
    st.session_state.symbol = chosen_symbol.replace(" ", "_").upper()

    contract_choices = {"Rise/Fall": "rise_fall", "Higher/Lower": "higher_lower", "Digits": "digits", "Multiplier": "multiplier"}
    contract_type = st.selectbox("Choose Contract Type:", list(contract_choices.keys()))
    st.session_state.contract_type = contract_choices[contract_type]

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
        st.info("Waiting for candle data...")

    # Show signals
    st.subheader("🚨 Live Signals")
    if st.session_state.signals:
        for signal in st.session_state.signals[-3:]:
            with st.expander(f"{signal['type']} at {signal['time']}"):
                st.write(f"Suggested Action: {signal['action']}")
                if st.button(f"✅ Accept Signal at {signal['price']} ({signal['action']})"):
                    place_demo_trade("Win")
    else:
        st.info("No signals detected yet. Boss Babe system is scanning...")

elif menu == "🎮 Demo Play":
    st.header("🎮 Boss Babe Demo Play")
    st.metric("Demo Balance", f"${st.session_state.demo_balance:.2f}")

    col1, col2 = st.columns(2)
    with col1:
        if st.button("✅ BUY (Demo Play)"):
            place_demo_trade("Win")
            st.success("Demo Buy placed!")

    with col2:
        if st.button("❌ SELL (Demo Play)"):
            place_demo_trade("Loss")
            st.error("Demo Sell placed!")

elif menu == "📊 Statistics":
    st.header("📊 Boss Babe Statistics")
    if st.session_state.demo_results:
        total = len(st.session_state.demo_results)
        wins = st.session_state.demo_results.count("Win")
        losses = st.session_state.demo_results.count("Loss")
        win_rate = (wins / total) * 100
        st.metric("Total Trades", total)
        st.metric("Wins", wins)
        st.metric("Losses", losses)
        st.metric("Win Rate", f"{win_rate:.2f}%")
    else:
        st.info("No trades yet.")

elif menu == "⚙️ Settings":
    st.header("⚙️ Boss Babe Settings")
    st.info("More boss settings coming soon!")

