import streamlit as st
import pandas as pd
import numpy as np
import websocket
import json
import threading
import time

# === CONFIGURATION ===
st.set_page_config(page_title="🎀 Boss Babe Digit Analyzer", layout="wide", initial_sidebar_state="expanded")

# === DERIV API CONNECTION ===
API_TOKEN = "YOUR_API_TOKEN"
APP_ID = "YOUR_APP_ID"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === STREAMLIT MEMORY ===
if "ticks" not in st.session_state:
    st.session_state.ticks = []

if "analyzing" not in st.session_state:
    st.session_state.analyzing = False

# === FUNCTION TO STREAM TICKS ===
def stream_ticks(symbol):
    try:
        ws = websocket.create_connection(DERIV_API_URL)
        ws.send(json.dumps({"authorize": API_TOKEN}))
        ws.recv()

        request = {"ticks": symbol, "subscribe": 1}
        ws.send(json.dumps(request))

        while st.session_state.analyzing:
            data = json.loads(ws.recv())
            if "tick" in data:
                tick = data["tick"]
                epoch = tick["epoch"]
                quote = float(tick["quote"])
                last_digit = int(str(quote)[-1])

                st.session_state.ticks.append({
                    "time": time.strftime('%H:%M:%S', time.gmtime(epoch)),
                    "price": quote,
                    "last_digit": last_digit
                })

                if len(st.session_state.ticks) > 100:
                    st.session_state.ticks.pop(0)

    except Exception as e:
        st.error(f"Tick Stream Error: {str(e)}")

# === MAIN PAGE ===
st.title("🎀 Boss Babe Digit Analyzer")
st.caption("Smart. Stylish. Unstoppable. Let's predict digits like a queen 👑!")

symbol = st.text_input("Enter Symbol (example: R_50)", value="R_50")

col1, col2 = st.columns(2)

with col1:
    if st.button("🚀 Start Analyzing"):
        st.session_state.analyzing = True
        threading.Thread(target=stream_ticks, args=(symbol,), daemon=True).start()

with col2:
    if st.button("🛑 Stop"):
        st.session_state.analyzing = False

# === DISPLAY TICK DATA ===
if st.session_state.ticks:
    df = pd.DataFrame(st.session_state.ticks)
    st.subheader("📈 Live Tick Stream")
    st.dataframe(df.tail(20), use_container_width=True)

    # === DIGIT ANALYSIS ===
    st.subheader("🎯 Digit Analysis")
    digit_counts = df['last_digit'].value_counts().sort_index()

    chart_data = pd.DataFrame({
        "Digit": range(10),
        "Count": [digit_counts.get(i, 0) for i in range(10)]
    })

    st.bar_chart(chart_data.set_index("Digit"))

    # Suggest Strongest Digits
    most_common_digit = chart_data.sort_values(by="Count", ascending=False).iloc[0]["Digit"]
    st.success(f"👑 Most Frequent Digit: {int(most_common_digit)}")

    win_chance = (chart_data["Count"].max() / chart_data["Count"].sum()) * 100
    st.metric("📈 Current Digit Win Probability", f"{win_chance:.2f}%")

    if win_chance > 20:
        st.balloons()
        st.info("💖 TIP: Good condition for Digit Matches trading!")

else:
    st.warning("Waiting for live ticks...")

