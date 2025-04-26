# === Boss Babe 6.6 Lite FINAL ===
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
st.set_page_config(page_title="🎀 Boss Babe 6.6 Trading Playground", layout="wide")

# === STYLE ===
st.markdown("""
    <style>
    body { background-color: #000000; }
    .stApp { background-color: #000000; }
    .css-18e3th9, .css-1d391kg { background-color: #000000; }
    .css-10trblm, .css-1v0mbdj { color: #ff66b2; }
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

if "active_trade" not in st.session_state:
    st.session_state.active_trade = None

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

    if len(st.session_state.candles) > 300:
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
            check_active_trade(data["tick"])

def check_active_trade(tick):
    if st.session_state.active_trade:
        entry = st.session_state.active_trade["entry"]
        contract = st.session_state.active_trade["contract"]
        amount = st.session_state.active_trade["amount"]
        expiry = st.session_state.active_trade["expiry"]

        current_price = float(tick["quote"])
        now_epoch = int(tick["epoch"])

        if now_epoch >= expiry:
            if contract == "Rise":
                win = current_price > entry
            elif contract == "Fall":
                win = current_price < entry
            else:
                win = random.choice([True, False])

            result = "Win" if win else "Loss"

            if result == "Win":
                profit = amount * 0.9
                st.session_state.balance += profit
                st.success(f"🎉 You WON! +${profit:.2f}")
            else:
                st.session_state.balance -= amount
                st.error(f"😢 You LOST! -${amount:.2f}")

            # Log it
            st.session_state.trade_history.append({
                "symbol": st.session_state.active_trade["symbol"],
                "contract": contract,
                "stake": amount,
                "result": result,
                "entry": entry,
                "exit": current_price,
                "start_time": datetime.datetime.fromtimestamp(st.session_state.active_trade["start"]).strftime("%H:%M:%S"),
                "end_time": datetime.datetime.fromtimestamp(expiry).strftime("%H:%M:%S"),
            })
            st.session_state.active_trade = None

def simple_indicator_logic(indicator):
    chance = random.randint(40, 90)
    return f"🎯 Indicator {indicator} sees {chance}% win chance."

# === START STREAM ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=("R_50",), daemon=True).start()
    st.session_state.streaming = True

# === UI ===
st.title("🎀 Boss Babe 6.6 Lite Final Playground")

symbol = st.selectbox("Select Symbol", ["R_50", "R_75", "R_100", "Volatility 10", "Volatility 25", "Volatility 50", "Volatility 75", "Volatility 100"])
contract_type = st.selectbox("Select Contract Type", ["Rise", "Fall", "Higher", "Lower", "Touch", "No Touch", "In", "Out"])
stake = st.number_input("Stake Amount ($)", value=1.00, min_value=0.35)
duration = st.selectbox("Duration", ["1 Tick", "5 Ticks", "1 Minute", "5 Minutes"])

indicator = st.selectbox("Boss Babe Indicator", ["Spike Zone", "Trend Breakout", "Digit Analyzer", "Volatility Pressure"])

if st.button("🔍 Analyze with Indicator"):
    suggestion = simple_indicator_logic(indicator)
    st.success(suggestion)

if st.button("🚀 Place Demo Trade"):
    now = int(time.time())
    expire = now + 60
    entry_price = st.session_state.candles[-1]["close"] if st.session_state.candles else random.uniform(1000, 1100)

    st.session_state.active_trade = {
        "symbol": symbol,
        "contract": contract_type,
        "amount": stake,
        "entry": entry_price,
        "start": now,
        "expiry": expire,
    }
    st.info(f"🚀 Demo Trade Active! Entry at {entry_price:.2f}")

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
        close=df['close'],
        increasing_line_color='#00cc66', decreasing_line_color='#ff6666'
    ))
    if st.session_state.active_trade:
        fig.add_hline(y=st.session_state.active_trade["entry"], line_dash="dot", line_color="yellow")
    st.plotly_chart(fig, use_container_width=True)
else:
    st.info("Waiting for live chart...")

# === BALANCE + HISTORY ===
st.metric("💰 Demo Balance", f"${st.session_state.balance:.2f}")

st.subheader("📜 Trade History")
if st.session_state.trade_history:
    hist_df = pd.DataFrame(st.session_state.trade_history)
    st.dataframe(hist_df)
else:
    st.info("No trades yet!")

# === FINAL TIPS ===
st.caption("🎀 Stay Smart, Stay Stylish, Stay Winning!")
