# === PAGE SETTINGS ===
import streamlit as st
st.set_page_config(page_title="👑 Boss Babe Trading Intelligence Web App", layout="wide")

# === OTHER IMPORTS ===
import requests
import json
import datetime
import websocket
import time
import re
import pandas as pd
import plotly.graph_objs as go
import random

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === STATE MEMORY ===
if "signals" not in st.session_state:
    st.session_state.signals = []

if "manual_signals" not in st.session_state:
    st.session_state.manual_signals = []

if "executed_trades" not in st.session_state:
    st.session_state.executed_trades = []

if "demo_trades" not in st.session_state:
    st.session_state.demo_trades = []

if "chart_data" not in st.session_state:
    st.session_state.chart_data = None

if "active_contracts" not in st.session_state:
    st.session_state.active_contracts = []

if "badges" not in st.session_state:
    st.session_state.badges = []

# === FUNCTIONS ===

def fetch_ticks(symbol="R_75", count=100):
    try:
        ws = websocket.create_connection(DERIV_API_URL)
        auth_data = {"authorize": API_TOKEN}
        ws.send(json.dumps(auth_data))
        auth_response = json.loads(ws.recv())
        request_data = {
            "ticks_history": symbol,
            "end": "latest",
            "count": count,
            "style": "ticks",
            "granularity": 0
        }
        ws.send(json.dumps(request_data))
        data = json.loads(ws.recv())
        ws.close()
        if "history" in data:
            return data["history"]["times"], data["history"]["prices"]
        return None, None
    except Exception as e:
        st.error(f"Error fetching ticks: {str(e)}")
        return None, None

def fetch_candles(symbol="R_75", count=100, granularity=60):
    try:
        ws = websocket.create_connection(DERIV_API_URL)
        auth_data = {"authorize": API_TOKEN}
        ws.send(json.dumps(auth_data))
        auth_response = json.loads(ws.recv())
        request_data = {
            "ticks_history": symbol,
            "end": "latest",
            "count": count,
            "style": "candles",
            "granularity": granularity
        }
        ws.send(json.dumps(request_data))
        data = json.loads(ws.recv())
        ws.close()
        if "candles" in data:
            return pd.DataFrame(data["candles"])
        return None
    except Exception as e:
        st.error(f"Error fetching candles: {str(e)}")
        return None

def parse_signals(raw_text):
    pattern = re.compile(r"Symbol: (.*?)\n.*?Signal: (.*?)\nEntry: (.*?)\nStop Loss.*?: (.*?)\nTP1.*?: (.*?)\nTP2.*?: (.*?)\n", re.DOTALL)
    matches = pattern.findall(raw_text)
    parsed = []
    for match in matches:
        symbol, signal_type, entry, sl, tp1, tp2 = match
        parsed.append({
            "symbol": symbol.strip(),
            "entry": float(entry.strip()),
            "sl": float(sl.strip()),
            "tp1": float(tp1.strip()),
            "tp2": float(tp2.strip()),
            "signal_type": signal_type.strip()
        })
    return parsed

def suggest_expiry(signal_type):
    if "Sell" in signal_type or "Buy" in signal_type:
        return "5 minutes"
    return "1 minute"

def random_quote():
    quotes = [
        "✨ Bosses don't chase. They attract.",
        "🌸 Risk smart. Rest confident.",
        "🚀 Big dreams need bigger discipline.",
        "👑 Trade like the Queen you are."
    ]
    return random.choice(quotes)

# === SIDEBAR MENU ===
st.sidebar.title("👑 Boss Babe Desk")
menu = st.sidebar.radio("Navigate", [
    "📈 Dashboard", 
    "📉 Charts", 
    "📝 Signals", 
    "🎮 Demo Play", 
    "💸 Real Trades", 
    "📊 Statistics", 
    "🏆 Badges", 
    "⚙️ Settings"
])

# === MAIN BODY ===

# === DASHBOARD ===
if menu == "📈 Dashboard":
    st.header("📈 Dashboard")
    st.subheader(random_quote())

# === CHARTS ===
elif menu == "📉 Charts":
    st.header("📉 Charts Playground")
    symbol = st.text_input("Enter Symbol (e.g., R_75)", value="R_75")
    chart_mode = st.radio("Chart Type", ["Candles", "Ticks"], horizontal=True)

    if st.button("🔄 Load Chart"):
        if chart_mode == "Ticks":
            times, prices = fetch_ticks(symbol=symbol, count=100)
            if times and prices:
                fig = go.Figure(data=go.Scatter(x=pd.to_datetime(times, unit="s"), y=prices, mode='lines'))
                fig.update_layout(title=f"Tick Chart - {symbol}", template="plotly_white")
                st.plotly_chart(fig, use_container_width=True)
        else:
            df = fetch_candles(symbol=symbol, count=100, granularity=60)
            if df is not None:
                fig = go.Figure(data=[go.Candlestick(
                    x=pd.to_datetime(df["epoch"], unit="s"),
                    open=df["open"],
                    high=df["high"],
                    low=df["low"],
                    close=df["close"]
                )])
                fig.update_layout(title=f"Candlestick Chart - {symbol}", template="plotly_white")
                st.plotly_chart(fig, use_container_width=True)

# === SIGNALS ===
elif menu == "📝 Signals":
    st.header("📝 Signal Management")
    raw_text = st.text_area("Paste your trading signal here:")

    if st.button("🔍 Parse Signals"):
        parsed_signals = parse_signals(raw_text)
        if parsed_signals:
            st.session_state.manual_signals.extend(parsed_signals)
            st.success(f"✅ Parsed {len(parsed_signals)} signals!")
        else:
            st.warning("⚠️ No valid signals found.")

    if len(st.session_state.manual_signals) > 0:
        st.subheader("🗂️ Parsed Signals")
        for idx, signal in enumerate(st.session_state.manual_signals):
            with st.expander(f"{signal['symbol']} | {signal['signal_type']} - Entry {signal['entry']}"):
                st.write(f"**Stop Loss:** {signal['sl']}")
                st.write(f"**TP1:** {signal['tp1']}")
                st.write(f"**TP2:** {signal['tp2']}")
                expiry_advice = suggest_expiry(signal['signal_type'])
                st.info(f"💡 Suggested Expiry: **{expiry_advice}**")

# === DEMO PLAY ===
elif menu == "🎮 Demo Play":
    st.header("🎮 Demo Play Mode (Smart Analyzer Coming Soon)")

# === REAL TRADES ===
elif menu == "💸 Real Trades":
    st.header("💸 Real Trading Mode (Connect to Deriv Coming Soon)")

# === STATISTICS ===
elif menu == "📊 Statistics":
    st.header("📊 Your Trading Statistics")
    st.write("🚀 Coming Soon in Phase 2.5!")

# === BADGES ===
elif menu == "🏆 Badges":
    st.header("🏆 Achievements")
    st.write("🌸 Coming soon: Earn badges for your trading journey!")

# === SETTINGS ===
elif menu == "⚙️ Settings":
    st.header("⚙️ Settings & Info")
    st.write(f"Current API Token: {API_TOKEN[:5]}...{API_TOKEN[-5:]}")
    st.write(f"App ID: {APP_ID}")
    st.info("Theme: Pastel Boss Babe Vibes ✨")

# === FOOTER ===
st.write("---")
st.write("🌸 Created by Naimah — For Boss Babes Everywhere 🌸")

