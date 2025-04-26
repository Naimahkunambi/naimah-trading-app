# === PAGE SETTINGS ===
import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time
import websocket
import json
import threading
import plotly.graph_objs as go

st.set_page_config(page_title="💎 Boss Babe 7.0 Trading Playground", layout="wide", initial_sidebar_state="expanded")

# === CUSTOM STYLING ===
st.markdown("""
<style>
body, .stApp {background-color: #1c1c1c;}
.css-10trblm, .css-1v0mbdj, .css-1d391kg {color: #ff99cc;}
.css-18e3th9 {background-color: #330033;}
</style>
""", unsafe_allow_html=True)

# === CONSTANTS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === GLOBAL STATES ===
for key, default in {
    "candles": [],
    "symbol": "R_50",
    "demo_balance": 1000.0,
    "demo_history": [],
    "trade_active": False,
    "entry_price": None,
    "target_price": None,
    "contract_type": None,
    "expiry_ticks": 5,
    "current_ticks": 0,
    "streaming": False
}.items():
    if key not in st.session_state:
        st.session_state[key] = default

# === FUNCTIONS ===
def update_candles(tick):
    ts = int(tick["epoch"])
    price = float(tick["quote"])
    timeframe = 60
    candle_time = ts - (ts % timeframe)

    if not st.session_state.candles or st.session_state.candles[-1]["epoch"] < candle_time:
        st.session_state.candles.append({"epoch": candle_time, "open": price, "high": price, "low": price, "close": price})
    else:
        candle = st.session_state.candles[-1]
        candle.update({
            "high": max(candle["high"], price),
            "low": min(candle["low"], price),
            "close": price
        })

    if len(st.session_state.candles) > 300:
        st.session_state.candles.pop(0)

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
            on_new_tick(data["tick"])

def start_demo_trade(entry_price, contract_type, expiry_ticks=5):
    st.session_state.update({
        "trade_active": True,
        "entry_price": entry_price,
        "contract_type": contract_type,
        "expiry_ticks": expiry_ticks,
        "current_ticks": 0,
        "target_price": entry_price * (1.001 if np.random.rand() > 0.5 else 0.999)
    })

def check_trade_outcome(latest_price):
    if st.session_state.current_ticks >= st.session_state.expiry_ticks:
        result = "Loss"
        ct, ep, tp = st.session_state.contract_type, st.session_state.entry_price, st.session_state.target_price

        if ct in ["Rise", "Fall"]:
            if (ct == "Rise" and latest_price > ep) or (ct == "Fall" and latest_price < ep):
                result = "Win"
        elif ct in ["Touch", "No Touch"]:
            if (ct == "Touch" and ((ep < tp and latest_price >= tp) or (ep > tp and latest_price <= tp))):
                result = "Win"
            if (ct == "No Touch" and ((ep < tp and latest_price < tp) or (ep > tp and latest_price > tp))):
                result = "Win"

        if result == "Win":
            st.session_state.demo_balance += 0.90
        else:
            st.session_state.demo_balance -= 1.00

        st.session_state.demo_history.append({
            "Symbol": st.session_state.symbol,
            "Contract": ct,
            "Entry": ep,
            "Exit": latest_price,
            "Result": result,
            "Time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })

        st.session_state.trade_active = False
        if result == "Win":
            st.success("\ud83c\udf89 Boss Babe Victory! \ud83d\udcc8")
        else:
            st.error("\ud83d\ude14 Boss Babe Loss... Let's get the next one!")

# === INTERFACE ===
menu = st.sidebar.radio("Boss Babe Menu 💎", ["\ud83d\udcc8 Chart", "\ud83d\udcc9 Start Demo", "\ud83d\udcca Stats", "\u2699\ufe0f Settings", "\ud83d\udc84 Tips"])

if menu == "\ud83d\udcc8 Chart":
    st.header("Boss Babe Charts \ud83d\udcc8")
    df = pd.DataFrame(st.session_state.candles)
    if not df.empty:
        fig = go.Figure()
        fig.add_trace(go.Candlestick(x=df['epoch'], open=df['open'], high=df['high'], low=df['low'], close=df['close']))
        if st.session_state.entry_price:
            fig.add_hline(y=st.session_state.entry_price, line_color="yellow")
        if st.session_state.target_price:
            fig.add_hline(y=st.session_state.target_price, line_color="pink")
        st.plotly_chart(fig, use_container_width=True)
    else:
        st.info("Loading candles...")

if menu == "\ud83d\udcc9 Start Demo":
    st.header("Start Your Boss Babe Demo Trade \ud83c\udf1f")
    st.selectbox("Symbol", ["R_50", "R_75", "Volatility 10", "Volatility 100"], key="symbol")
    st.selectbox("Contract Type", ["Rise", "Fall", "Touch", "No Touch"], key="contract_type")
    stake = st.number_input("Stake ($)", value=1.00)
    ticks = st.number_input("Expiry (Ticks)", value=5)
    start = st.button("\ud83c\udf89 START DEMO TRADE")

    if start:
        start_demo_trade(entry_price=st.session_state.candles[-1]['close'], contract_type=st.session_state.contract_type, expiry_ticks=int(ticks))
        st.success("Demo Trade Started!")

if menu == "\ud83d\udcca Stats":
    st.header("Boss Babe Stats \ud83d\udcca")
    st.metric("Demo Balance", f"${st.session_state.demo_balance:.2f}")
    if st.session_state.demo_history:
        st.dataframe(pd.DataFrame(st.session_state.demo_history))
    else:
        st.info("No trades yet!")

if menu == "\u2699\ufe0f Settings":
    st.header("Settings (Future: Deriv Login) \ud83d\udd27")
    st.info("Coming Soon!")

if menu == "\ud83d\udc84 Tips":
    st.header("\ud83d\udc84 Boss Babe Tips")
    st.success("Rise/Fall = Best during strong trends")
    st.warning("Touch/No Touch = Best during sudden spikes")
    st.info("Digits = Best for very short tick trades!")
    st.balloons()

# === START STREAMING ===
if not st.session_state.streaming:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True
