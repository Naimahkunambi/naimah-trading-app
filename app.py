# === PAGE SETTINGS (MUST BE FIRST) ===
import streamlit as st
st.set_page_config(page_title="🚀 Boss Babe Trading Intelligence", layout="wide")

# === OTHER IMPORTS ===
import websocket
import json
import pandas as pd
import plotly.graph_objs as go
import threading
import time

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

# === FUNCTIONS ===

def fetch_initial_candles(symbol, granularity=60, count=100):
    ws = websocket.create_connection(DERIV_API_URL)
    request = {
        "ticks_history": symbol,
        "style": "candles",
        "count": count,
        "granularity": granularity,
        "end": "latest"
    }
    ws.send(json.dumps(request))
    response = json.loads(ws.recv())
    ws.close()
    candles = response.get("candles", [])
    return candles


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

    # Limit to 100 candles
    if len(st.session_state.candles) > 100:
        st.session_state.candles.pop(0)


def plot_candles():
    if len(st.session_state.candles) == 0:
        st.warning("No candle data to display yet.")
        return

    df = pd.DataFrame(st.session_state.candles)
    fig = go.Figure(data=[go.Candlestick(
        x=pd.to_datetime(df["epoch"], unit='s'),
        open=df["open"],
        high=df["high"],
        low=df["low"],
        close=df["close"],
        increasing_line_color='pink',
        decreasing_line_color='lightblue'
    )])

    fig.update_layout(
        xaxis_rangeslider_visible=False,
        template="plotly_white",
        height=600,
        margin=dict(l=20, r=20, t=30, b=20)
    )

    st.plotly_chart(fig, use_container_width=True)


# === BOSS BABE SMART INDICATORS ===
def boss_babe_indicator():
    if len(st.session_state.candles) == 0:
        return None

    last_close = st.session_state.candles[-1]["close"]
    last_open = st.session_state.candles[-1]["open"]

    if last_close > last_open:
        st.success("✨ Bullish Push Detected - Consider CALL contracts!")
    else:
        st.error("💔 Bearish Push Detected - Consider PUT contracts!")


# === UI ===
menu = st.sidebar.radio("Menu", ["📈 Chart Playground", "📜 Signal Generator", "🎉 Demo Play", "🔢 Real Trades", "📊 Statistics", "⚙️ Settings"])

if menu == "📈 Chart Playground":
    st.header("📈 Your Trading Playground")

    symbols = ["R_10", "R_25", "R_50", "R_75", "R_100", "V10", "V25", "V50", "V75", "V100"]
    selected_symbol = st.selectbox("Select Symbol", symbols)

    if selected_symbol != st.session_state.symbol:
        st.session_state.symbol = selected_symbol
        st.session_state.candles = fetch_initial_candles(selected_symbol)

    st.info("Boss Babe Chart Auto-Updating Every 5s")

    plot_candles()
    boss_babe_indicator()

# === TICKS STREAM ===
if "streaming" not in st.session_state:
    threading.Thread(target=stream_ticks, args=(st.session_state.symbol, update_candles), daemon=True).start()
    st.session_state.streaming = True

# === OTHER MENUS PLACEHOLDER ===
if menu == "📜 Signal Generator":
    st.header("📜 Boss Babe Signal Generator (Coming Soon)")

if menu == "🎉 Demo Play":
    st.header("🎉 Boss Babe Demo Play (Coming Soon)")

if menu == "🔢 Real Trades":
    st.header("🔢 Boss Babe Real Trades (Coming Soon)")

if menu == "📊 Statistics":
    st.header("📊 Boss Babe Trading Statistics (Coming Soon)")

if menu == "⚙️ Settings":
    st.header("⚙️ Settings")
    st.info("More Customizations Coming Soon!")
