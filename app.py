# 🚀 Boss Babe 6.7 Lite Trading Web App
import streamlit as st
import pandas as pd
import numpy as np
import plotly.graph_objs as go
import random
import time

# === PAGE CONFIG ===
st.set_page_config(page_title="🎀 Boss Babe Trading Intelligence 6.7 Lite", layout="wide")

# === CUSTOM CSS THEME ===
st.markdown("""
    <style>
    body, .stApp {
        background-color: #2c003e;
        color: #ffc0cb;
    }
    .stButton>button {
        background-color: #800080;
        color: white;
    }
    .stMetric {
        color: #ffc0cb;
    }
    </style>
""", unsafe_allow_html=True)

# === SESSION VARIABLES ===
if "candles" not in st.session_state:
    st.session_state.candles = []
if "wallet" not in st.session_state:
    st.session_state.wallet = 1000.00
if "history" not in st.session_state:
    st.session_state.history = []
if "current_trade" not in st.session_state:
    st.session_state.current_trade = None
if "tick_count" not in st.session_state:
    st.session_state.tick_count = 0
if "indicator" not in st.session_state:
    st.session_state.indicator = "Spike Zone"

# === FUNCTION TO CREATE CANDLES ===
def generate_candle(last_price):
    direction = random.choice(["up", "down"])
    if direction == "up":
        close = last_price + random.uniform(0.5, 1.5)
    else:
        close = last_price - random.uniform(0.5, 1.5)
    high = max(last_price, close) + random.uniform(0.1, 0.5)
    low = min(last_price, close) - random.uniform(0.1, 0.5)
    return {"open": last_price, "high": high, "low": low, "close": close}

# === FUNCTION TO PLACE DEMO TRADE ===
def place_demo_trade(symbol, contract, stake, duration, indicator):
    entry_price = st.session_state.candles[-1]["close"]
    expiry_tick = st.session_state.tick_count + duration
    st.session_state.current_trade = {
        "symbol": symbol,
        "contract": contract,
        "stake": stake,
        "duration": duration,
        "indicator": indicator,
        "entry_price": entry_price,
        "expiry_tick": expiry_tick
    }

# === FUNCTION TO MONITOR TRADE ===
def check_trade_outcome():
    trade = st.session_state.current_trade
    if trade and st.session_state.tick_count >= trade["expiry_tick"]:
        final_price = st.session_state.candles[-1]["close"]
        win = False
        if trade["contract"] == "Rise/Fall":
            if final_price > trade["entry_price"]:
                win = True
        if win:
            profit = trade["stake"] * 0.95
            st.session_state.wallet += trade["stake"] + profit
            result = "WIN"
        else:
            st.session_state.wallet -= trade["stake"]
            result = "LOSS"
        st.success(f"🎉 You {result}! {'+' if result=='WIN' else '-'}${trade['stake']:.2f}")
        st.session_state.history.append({
            "Symbol": trade["symbol"],
            "Contract": trade["contract"],
            "Indicator": trade["indicator"],
            "Result": result,
            "Profit/Loss": (profit if win else -trade["stake"])
        })
        st.session_state.current_trade = None

# === MENU ===
menu = st.sidebar.radio("🎀 Boss Babe Menu 💎", ["📈 Chart", "🎯 Start Demo", "📊 Stats", "⚙️ Settings", "🎀 Tips"])

# === CHART PAGE ===
if menu == "📈 Chart":
    st.title("📈 Boss Babe Chart Playground")
    st.info("Loading live candles... enjoy!")
    # Create random candles
    if not st.session_state.candles:
        price = 100.0
        for _ in range(30):
            candle = generate_candle(price)
            st.session_state.candles.append(candle)
            price = candle["close"]
    else:
        last = st.session_state.candles[-1]["close"]
        st.session_state.candles.append(generate_candle(last))
        if len(st.session_state.candles) > 50:
            st.session_state.candles.pop(0)
        st.session_state.tick_count += 1
        check_trade_outcome()

    df = pd.DataFrame(st.session_state.candles)
    fig = go.Figure(data=[go.Candlestick(
        open=df['open'], high=df['high'],
        low=df['low'], close=df['close']
    )])
    fig.update_layout(height=500)
    st.plotly_chart(fig, use_container_width=True)

# === DEMO TRADE PAGE ===
elif menu == "🎯 Start Demo":
    st.title("🎯 Start Your Boss Babe Demo Trade!")
    symbol = st.selectbox("Select Symbol 🎯", ["R_10", "R_25", "R_50", "R_75", "R_100"], index=2)
    contract = st.selectbox("Contract Type 💬", ["Rise/Fall", "Touch/No Touch", "Digits"])
    stake = st.number_input("Stake Amount ($)", 1.0, 1000.0, 1.0)
    duration = st.slider("Duration (Ticks)", 1, 10, 5)
    indicator = st.selectbox("Choose Indicator ✨", ["Spike Zone", "Trend Zone", "Volatility Spike"])

    if st.button("🚀 Place Demo Trade"):
        place_demo_trade(symbol, contract, stake, duration, indicator)
        st.success("🚀 Trade Started!")

# === STATISTICS PAGE ===
elif menu == "📊 Stats":
    st.title("📊 Boss Babe Statistics")
    st.metric("💰 Wallet Balance", f"${st.session_state.wallet:.2f}")
    if st.session_state.history:
        df = pd.DataFrame(st.session_state.history)
        st.dataframe(df)
        wins = sum(1 for h in st.session_state.history if h["Result"] == "WIN")
        losses = sum(1 for h in st.session_state.history if h["Result"] == "LOSS")
        st.metric("✅ Total Wins", wins)
        st.metric("❌ Total Losses", losses)
        win_rate = (wins / (wins + losses)) * 100 if (wins + losses) > 0 else 0
        st.metric("🎯 Win Rate", f"{win_rate:.2f}%")
    else:
        st.info("No trades yet.")

# === SETTINGS PAGE ===
elif menu == "⚙️ Settings":
    st.title("⚙️ Settings")
    if st.button("💎 Reset Demo Wallet"):
        st.session_state.wallet = 1000.00
        st.success("Wallet Reset Successfully!")
    theme_choice = st.selectbox("🎨 Choose Theme", ["Dark Pink", "Boss Babe Purple", "Classic White"])
    st.info(f"Selected Theme: {theme_choice} (Themes feature coming in full Boss Babe 7.0!)")

# === TIPS PAGE ===
elif menu == "🎀 Tips":
    st.title("🎀 Boss Babe Tips Zone")
    st.info("Rise/Fall = Best during trends 📈")
    st.info("Touch/No Touch = Best during spikes ⚡")
    st.info("Digits = Only for tick-based scalps 🎯")
    st.success("Stay calm, smart, and stylish, Queen! 💅")

