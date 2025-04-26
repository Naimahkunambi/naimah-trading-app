# === Boss Babe 6.5 Lite Final ===
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import websocket
import json
import threading
import plotly.graph_objs as go
import random
import time

# === PAGE SETTINGS ===
st.set_page_config(page_title="🎀 Boss Babe 6.5 Trading Intelligence", layout="wide", initial_sidebar_state="expanded")

# === STYLE ===
st.markdown("""
    <style>
    body { background-color: #ffe6f2; }
    .stApp { background-color: #ffe6f2; }
    .css-18e3th9, .css-1d391kg { background-color: #ffe6f2; }
    .css-10trblm, .css-1v0mbdj { color: #400040; }
    </style>
""", unsafe_allow_html=True)

# === GLOBALS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

if "candles" not in st.session_state:
    st.session_state.candles = []

if "balance" not in st.session_state:
    st.session_state.balance = 1000

if "trade_history" not in st.session_state:
    st.session_state.trade_history = []

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

def stream_ticks(symbol):
    ws = websocket.create_connection(DERIV_API_URL)
    auth_data = {"authorize": API_TOKEN}
    ws.send(json.dumps(auth_data))
    ws.recv()

    tick_request = {"ticks": symbol, "subscribe": 1}
    ws.send(json.dumps(tick_request))

    while True:
        data = json.loads(ws.recv())
        if "tick" in data:
            update_candles(data["tick"])

def simple_analyze(symbol, contract_type):
    # Very basic random "analysis" to simulate
    chance = random.randint(1, 100)
    if contract_type in ["Rise", "Up", "Higher"]:
        return "Buy" if chance > 45 else "Don't Buy"
    elif contract_type in ["Fall", "Down", "Lower"]:
        return "Sell" if chance > 45 else "Don't Sell"
    elif contract_type in ["Touch"]:
        return "Touch likely" if chance > 50 else "No Touch likely"
    elif contract_type in ["No Touch"]:
        return "No Touch likely" if chance > 50 else "Touch likely"
    elif contract_type in ["In"]:
        return "Stay In" if chance > 50 else "Go Out"
    elif contract_type in ["Out"]:
        return "Go Out" if chance > 50 else "Stay In"
    else:
        return "50/50 - Watch Chart Carefully"

# === START STREAM ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=("R_50",), daemon=True).start()
    st.session_state.streaming = True

# === MENU ===
st.title("🎀 Boss Babe 6.5 Lite - Demo Trading")

symbol = st.selectbox("Select Symbol", ["R_50", "R_75", "R_100", "Volatility 10", "Volatility 75", "Volatility 100", "Jump 10", "Jump 25", "Bear Market", "Bull Market"])
contract_type = st.selectbox("Select Contract Type", ["Rise", "Fall", "Up", "Down", "Higher", "Lower", "Touch", "No Touch", "In", "Out", "Even", "Odd", "Digit Match", "Digit Differs"])

stake = st.number_input("Stake Amount ($)", value=1.00, min_value=0.35)
duration = st.selectbox("Duration", ["1 tick", "5 ticks", "10 ticks", "1 minute", "5 minutes"])

indicator = st.selectbox("Choose Indicator", ["Spike Zone", "Trend Breakout", "Digit Analyzer", "Volatility Strength"])

if st.button("🔍 Analyze & Suggest Trade"):
    suggestion = simple_analyze(symbol, contract_type)
    st.success(f"📈 Suggestion: {suggestion}")

if st.button("🚀 Place Demo Trade"):
    # Simulate outcome
    result = random.choice(["Win", "Loss"])
    if result == "Win":
        profit = stake * 0.9
        st.session_state.balance += profit
        st.success(f"🎉 You WON! Profit: ${profit:.2f}")
    else:
        loss = stake
        st.session_state.balance -= loss
        st.error(f"😢 You LOST! Loss: ${loss:.2f}")

    # Log trade
    st.session_state.trade_history.append({
        "symbol": symbol,
        "contract": contract_type,
        "stake": stake,
        "duration": duration,
        "indicator": indicator,
        "result": result,
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    })

# === LIVE CHART ===
st.subheader("📈 Live Chart")
df = pd.DataFrame(st.session_state.candles)
if not df.empty:
    fig = go.Figure()
    fig.add_trace(go.Candlestick(
        x=pd.to_datetime(df['epoch'], unit='s'),
        open=df['open'],
        high=df['high'],
        low=df['low'],
        close=df['close']
    ))
    st.plotly_chart(fig, use_container_width=True)
else:
    st.info("Waiting for live chart...")

# === BALANCE AND HISTORY ===
st.metric("💰 Demo Balance", f"${st.session_state.balance:.2f}")

st.subheader("📜 Trade History")
if st.session_state.trade_history:
    st.dataframe(pd.DataFrame(st.session_state.trade_history))
else:
    st.info("No trades yet.")

# === TIPS ===
st.sidebar.subheader("🎀 Boss Babe Tips")
st.sidebar.info("""
- Rise/Fall = Best during trends
- Touch/No Touch = Best during spikes
- Digits = Only for tick trades
- Stay calm, smart and stylish! 💅
""")
