import streamlit as st
import pandas as pd
import numpy as np
import websocket
import json
import threading
import time
from queue import Queue

# === CONFIGURATION ===
st.set_page_config(page_title="🎀 Boss Babe Digit Analyzer", layout="wide", initial_sidebar_state="expanded")

# === SETTINGS ===
API_TOKEN = "kabW2n8VL3raHpF"
APP_ID = "70487"
DERIV_API_URL = f"wss://ws.binaryws.com/websockets/v3?app_id={APP_ID}"

# === SESSION STATE INIT ===
if "tick_data" not in st.session_state:
    st.session_state.tick_data = []

if "analyzing" not in st.session_state:
    st.session_state.analyzing = False

if "error_msg" not in st.session_state:
    st.session_state.error_msg = None

if "tick_queue" not in st.session_state:
    st.session_state.tick_queue = Queue()

# === THREAD CLASS ===
class TickStreamer(threading.Thread):
    def __init__(self, symbol, queue):
        super().__init__(daemon=True)
        self.symbol = symbol
        self.queue = queue
        self.running = True

    def run(self):
        try:
            ws = websocket.create_connection(DERIV_API_URL)
            ws.send(json.dumps({"authorize": API_TOKEN}))
            ws.recv()
            ws.send(json.dumps({"ticks": self.symbol, "subscribe": 1}))

            while self.running:
                response = json.loads(ws.recv())
                if "tick" in response:
                    tick = response["tick"]
                    epoch = tick["epoch"]
                    quote = float(tick["quote"])
                    last_digit = int(str(quote)[-1])
                    self.queue.put({
                        "time": time.strftime('%H:%M:%S', time.gmtime(epoch)),
                        "price": quote,
                        "last_digit": last_digit
                    })

        except Exception as e:
            st.session_state.error_msg = str(e)

# === UI ===
st.title("🎀 Boss Babe Digit Analyzer")
st.caption("Smart. Stylish. Unstoppable. Let's predict digits like a queen 👑!")

symbol = st.text_input("Enter Symbol (example: R_50)", value="R_50")

col1, col2 = st.columns(2)

with col1:
    if st.button("🚀 Start Analyzing") and not st.session_state.analyzing:
        st.session_state.tick_data = []
        st.session_state.tick_queue = Queue()
        st.session_state.analyzing = True
        st.session_state.error_msg = None
        streamer = TickStreamer(symbol, st.session_state.tick_queue)
        streamer.start()
        st.session_state.streamer = streamer

with col2:
    if st.button("🛑 Stop") and st.session_state.analyzing:
        st.session_state.analyzing = False
        if hasattr(st.session_state, "streamer"):
            st.session_state.streamer.running = False

# === ERROR DISPLAY ===
if st.session_state.error_msg:
    st.error(f"⛔ Error: {st.session_state.error_msg}")

# === HANDLE QUEUE & DISPLAY ===
while not st.session_state.tick_queue.empty():
    tick = st.session_state.tick_queue.get()
    st.session_state.tick_data.append(tick)
    if len(st.session_state.tick_data) > 100:
        st.session_state.tick_data.pop(0)

if st.session_state.tick_data:
    df = pd.DataFrame(st.session_state.tick_data)
    st.subheader("📈 Live Tick Stream")
    st.dataframe(df.tail(20), use_container_width=True)

    latest = st.session_state.tick_data[-1]
    st.markdown(f"""
    ### 🆕 Latest Tick
    - **🕒 Time:** `{latest['time']}`
    - **💰 Price:** `{latest['price']}`
    - **🎯 Last Digit:** `{latest['last_digit']}`
    """)

    # === DIGIT ANALYSIS ===
    st.subheader("🎯 Digit Analysis")
    digit_counts = df['last_digit'].value_counts().sort_index()
    chart_data = pd.DataFrame({
        "Digit": range(10),
        "Count": [digit_counts.get(i, 0) for i in range(10)]
    })
    st.bar_chart(chart_data.set_index("Digit"))

    most_common = chart_data.sort_values("Count", ascending=False).iloc[0]["Digit"]
    st.success(f"👑 Most Frequent Digit: {int(most_common)}")

    win_chance = (chart_data["Count"].max() / chart_data["Count"].sum()) * 100
    st.metric("📈 Current Digit Win Probability", f"{win_chance:.2f}%")

    if win_chance > 20:
        # st.balloons()
        st.info("💖 TIP: Good condition for Digit Matches trading!")

elif st.session_state.analyzing:
    st.warning("Waiting for live ticks...")
else:
    st.info("Start analyzing to see tick data.")

# === AUTO REFRESH ===
if st.session_state.analyzing:
    time.sleep(1)
    st.rerun()

