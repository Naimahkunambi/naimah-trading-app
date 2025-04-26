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

st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide", initial_sidebar_state="expanded")

# === INJECT CUSTOM CSS THEME ===
st.markdown("""
    <style>
    body {
        background-color: #fff5f8;
    }
    .stApp {
        background-color: #fff5f8;
    }
    .css-18e3th9, .css-1d391kg {
        background-color: #ffe6f2;
    }
    .css-10trblm, .css-1v0mbdj {
        color: #222;
    }
    </style>
""", unsafe_allow_html=True)

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
menu = st.sidebar.radio("Menu", ["📈 Chart Playground", "📜 Signal Generator", "🎉 Demo Play", "🔢 Real Trades", "📊 Statistics", "⚙️ Settings"])

if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

if menu == "📈 Chart Playground":
    st.header("📈 Your Trading Playground")
    st.info("Enjoy beautiful candles and Boss Babe indicators!")

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

elif menu == "📜 Signal Generator":
    st.header("📜 Boss Babe Signal Generator")
    st.info("Coming soon with smart contract type suggestions!")

elif menu == "🎉 Demo Play":
    st.header("🎉 Boss Babe Demo Play")
    st.info("Coming soon with fun demo trades!")

elif menu == "🔢 Real Trades":
    st.header("🔢 Boss Babe Real Trades")
    st.info("Coming soon with real execution!")

elif menu == "📊 Statistics":
    st.header("📊 Boss Babe Trading Statistics")
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
    st.info("Customize your experience (more settings coming soon!)")
