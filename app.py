# === PAGE SETTINGS FIRST ===
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time
import websocket
import json
import threading
import plotly.graph_objs as go

st.set_page_config(page_title="🎀 Boss Babe 6.7 Trading Playground", layout="wide", initial_sidebar_state="expanded")

# === CUSTOM THEME ===
st.markdown("""
<style>
body {
    background-color: #0d0d0d;
}
.stApp {
    background-color: #0d0d0d;
}
.css-10trblm, .css-1v0mbdj, .css-1d391kg {
    color: #ff66cc;
}
.css-18e3th9 {
    background-color: #330033;
}
</style>
""", unsafe_allow_html=True)

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = "wss://ws.binaryws.com/websockets/v3?app_id=" + str(APP_ID)

# === GLOBALS ===
if "candles" not in st.session_state:
    st.session_state.candles = []
if "symbol" not in st.session_state:
    st.session_state.symbol = "R_50"
if "demo_balance" not in st.session_state:
    st.session_state.demo_balance = 1000.00
if "demo_history" not in st.session_state:
    st.session_state.demo_history = []
if "trade_active" not in st.session_state:
    st.session_state.trade_active = False
if "entry_price" not in st.session_state:
    st.session_state.entry_price = None
if "target_price" not in st.session_state:
    st.session_state.target_price = None
if "contract_type" not in st.session_state:
    st.session_state.contract_type = None
if "expiry_ticks" not in st.session_state:
    st.session_state.expiry_ticks = 5
if "current_ticks" not in st.session_state:
    st.session_state.current_ticks = 0

# === FUNCTIONS ===
def update_candles(tick):
    ts = int(tick["epoch"])
    price = float(tick["quote"])
    timeframe = 60  # 1min
    candle_time = ts - (ts % timeframe)

    if len(st.session_state.candles) == 0 or st.session_state.candles[-1]["epoch"] < candle_time:
        st.session_state.candles.append({"epoch": candle_time, "open": price, "high": price, "low": price, "close": price})
    else:
        candle = st.session_state.candles[-1]
        candle["high"] = max(candle["high"], price)
        candle["low"] = min(candle["low"], price)
        candle["close"] = price

    if len(st.session_state.candles) > 150:
        st.session_state.candles.pop(0)

    # Live monitoring if trade active
    if st.session_state.trade_active:
        st.session_state.current_ticks += 1
        check_trade_outcome(price)

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

def start_demo_trade(entry_price, contract_type, expiry_ticks=5):
    st.session_state.trade_active = True
    st.session_state.entry_price = entry_price
    st.session_state.contract_type = contract_type
    st.session_state.expiry_ticks = expiry_ticks
    st.session_state.current_ticks = 0
    if contract_type in ["Touch", "No Touch"]:
        st.session_state.target_price = entry_price * (1.0015 if np.random.rand() > 0.5 else 0.9985)

def check_trade_outcome(latest_price):
    if st.session_state.current_ticks >= st.session_state.expiry_ticks:
        result = "Loss"
        ct = st.session_state.contract_type
        ep = st.session_state.entry_price
        tp = st.session_state.target_price

        if ct in ["Rise", "Fall"]:
            if (ct == "Rise" and latest_price > ep) or (ct == "Fall" and latest_price < ep):
                result = "Win"
        elif ct in ["Touch", "No Touch"]:
            if (ct == "Touch" and ((ep < tp and latest_price >= tp) or (ep > tp and latest_price <= tp))):
                result = "Win"
            elif (ct == "No Touch" and ((ep < tp and latest_price < tp) or (ep > tp and latest_price > tp))):
                result = "Win"

        # Update balance
        if result == "Win":
            st.session_state.demo_balance += 0.90
        else:
            st.session_state.demo_balance -= 1.00

        # Record history
        st.session_state.demo_history.append({
            "Symbol": st.session_state.symbol,
            "Contract": ct,
            "Entry": ep,
            "Exit": latest_price,
            "Result": result
        })

        # Reset
        st.session_state.trade_active = False
        st.session_state.entry_price = None
        st.session_state.target_price = None
        st.session_state.current_ticks = 0

        # Pop up
        if result == "Win":
            st.success("🎉 You WON the Demo Trade!")
        else:
            st.error("😔 You LOST the Demo Trade.")

# === UI ===
menu = st.sidebar.radio("Boss Babe Menu 💗", ["📈 Chart Playground", "🌟 Start Demo Play", "📉 Trading Stats", "⚙️ Settings"])

if menu == "📈 Chart Playground":
    st.header("Boss Babe Playground 🌟")
    st.info("Live Candle Chart + Demo Trading View")

    df = pd.DataFrame(st.session_state.candles)
    if not df.empty:
        fig = go.Figure()
        fig.add_trace(go.Candlestick(x=df['epoch'], open=df['open'], high=df['high'], low=df['low'], close=df['close']))

        if st.session_state.entry_price:
            fig.add_hline(y=st.session_state.entry_price, line_color="yellow", line_dash="solid")
        if st.session_state.target_price:
            fig.add_hline(y=st.session_state.target_price, line_color="purple", line_dash="dash")

        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Waiting for live candles...")

if menu == "🌟 Start Demo Play":
    st.header("Start Boss Babe Demo Play 🎉")
    symbol = st.text_input("Select Symbol", value=st.session_state.symbol)
    contract_type = st.selectbox("Select Contract Type", ["Rise", "Fall", "Touch", "No Touch"])
    stake = st.number_input("Stake ($)", value=1.00)
    expiry_ticks = st.number_input("Duration (Ticks)", value=5)
    start = st.button("🎉 START DEMO TRADE")

    if start:
        st.session_state.symbol = symbol
        start_demo_trade(entry_price=st.session_state.candles[-1]['close'], contract_type=contract_type, expiry_ticks=int(expiry_ticks))
        st.success("Demo Trade Started!")

if menu == "📉 Trading Stats":
    st.header("Boss Babe Trading Statistics 🌟")
    st.metric("Demo Balance", f"${st.session_state.demo_balance:.2f}")
    st.subheader("Trade History")
    if st.session_state.demo_history:
        st.dataframe(pd.DataFrame(st.session_state.demo_history))
    else:
        st.info("No trades yet!")

if menu == "⚙️ Settings":
    st.header("Boss Babe Settings 🔧")
    st.info("Coming soon with Deriv login, themes, and auto setups!")

# === LAUNCH LIVE STREAM ===
if "streaming" not in st.session_state:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True
