# === BOSS BABE FINAL BUILD ===
import streamlit as st
import pandas as pd
import numpy as np
import time
import json
import websocket
import threading
import plotly.graph_objs as go
import random

# === PAGE CONFIG ===
st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide", initial_sidebar_state="expanded")

# === STYLE (Dark Pink Theme) ===
st.markdown("""
    <style>
    body {
        background-color: #1a001a;
    }
    .stApp {
        background-color: #1a001a;
    }
    .css-1d391kg, .css-18e3th9 {
        background-color: #330033;
    }
    .css-10trblm, .css-1v0mbdj {
        color: #ffb6c1;
    }
    .stButton>button {
        background-color: #a020f0;
        color: white;
    }
    .stRadio>div>label>div {
        color: #ffb6c1;
    }
    </style>
""", unsafe_allow_html=True)

# === SETTINGS ===
API_TOKEN = "YOUR_DERIV_API_TOKEN"
APP_ID = "YOUR_DERIV_APP_ID"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === MEMORY ===
if "candles" not in st.session_state:
    st.session_state.candles = []
if "streaming" not in st.session_state:
    st.session_state.streaming = False
if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.0
if "history" not in st.session_state:
    st.session_state.history = []

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

    if len(st.session_state.candles) > 150:
        st.session_state.candles.pop(0)

def stream_ticks(symbol):
    ws = websocket.create_connection(DERIV_API_URL)
    auth = {"authorize": API_TOKEN}
    ws.send(json.dumps(auth))
    ws.recv()

    sub = {"ticks": symbol, "subscribe": 1}
    ws.send(json.dumps(sub))

    while True:
        data = json.loads(ws.recv())
        if "tick" in data:
            update_candles(data["tick"])

def place_demo_trade(contract_type, stake, duration, indicator_signal):
    entry_price = st.session_state.candles[-1]['close'] if st.session_state.candles else 1000
    result = "Win" if random.random() < indicator_signal else "Loss"
    payout = stake * 1.95 if result == "Win" else 0

    st.session_state.demo_balance += (payout - stake)

    st.session_state.history.append({
        "Contract Type": contract_type,
        "Entry Price": entry_price,
        "Stake": stake,
        "Result": result,
        "Profit": payout - stake,
        "Time": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    })

# === BOSS BABE MENU ===
menu = st.sidebar.radio("Boss Babe Menu 💎", ["📈 Chart", "🎯 Start Demo", "📋 History", "📊 Stats", "⚙️ Settings", "🎀 Tips"])

# === CONNECT STREAM ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=("R_100",), daemon=True).start()
    st.session_state.streaming = True

# === PAGES ===

if menu == "📈 Chart":
    st.header("📈 Boss Babe Chart Playground")
    df = pd.DataFrame(st.session_state.candles)
    if not df.empty:
        fig = go.Figure(data=[go.Candlestick(
            x=df['epoch'],
            open=df['open'],
            high=df['high'],
            low=df['low'],
            close=df['close'],
            increasing_line_color='green',
            decreasing_line_color='red'
        )])
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Loading live candles...")

if menu == "🎯 Start Demo":
    st.header("🎯 Start Your Boss Babe Demo Trade!")

    symbol = st.selectbox("Select Symbol 🎯", ["R_50", "R_75", "R_100", "Volatility 10", "Volatility 25"])
    contract_type = st.selectbox("Contract Type 💬", ["Rise/Fall", "Higher/Lower", "Touch/No Touch", "Digits"])
    stake = st.number_input("Stake Amount ($)", value=1.0, min_value=0.35, step=0.01)
    duration = st.number_input("Duration (Ticks)", value=5, min_value=1)
    indicator = st.selectbox("Choose Indicator ✨", ["Spike Zone", "Volatility Breakout", "Support/Resistance"])

    if st.button("🚀 Place Demo Trade"):
        indicator_signal = 0.65 if indicator == "Spike Zone" else 0.55
        place_demo_trade(contract_type, stake, duration, indicator_signal)
        st.success("🎉 Trade placed successfully! Watch history below.")

if menu == "📋 History":
    st.header("📋 Boss Babe Trade History")
    if st.session_state.history:
        st.dataframe(pd.DataFrame(st.session_state.history))
    else:
        st.info("No trades yet!")

if menu == "📊 Stats":
    st.header("📊 Boss Babe Statistics")
    total_trades = len(st.session_state.history)
    wins = sum(1 for x in st.session_state.history if x["Result"] == "Win")
    win_rate = (wins / total_trades) * 100 if total_trades > 0 else 0
    total_profit = sum(x["Profit"] for x in st.session_state.history)

    st.metric("Total Trades", total_trades)
    st.metric("Win Rate %", f"{win_rate:.2f}%")
    st.metric("Total Profit", f"${total_profit:.2f}")
    st.metric("Demo Balance", f"${st.session_state.demo_balance:.2f}")

if menu == "⚙️ Settings":
    st.header("⚙️ Customize Boss Babe Settings")
    new_balance = st.number_input("Set Starting Balance ($)", value=1000.0, min_value=100.0, step=50.0)
    if st.button("💾 Save Balance"):
        st.session_state.demo_balance = new_balance
        st.success(f"Balance reset to ${new_balance:.2f}!")

if menu == "🎀 Tips":
    st.header("🎀 Boss Babe Tips Zone")
    st.success("Rise/Fall = Best during trends 📈")
    st.warning("Touch/No Touch = Best during spikes ⚡")
    st.info("Digits = Only for tick-based scalps 🎯")
    st.balloons()

