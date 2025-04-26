import streamlit as st
import pandas as pd
import numpy as np
import datetime
import time

# Set page configuration (title, layout, initial theme colors)
if 'theme' not in st.session_state:
    # Default theme is White (soft white with pink accents)
    st.session_state['theme'] = 'White'
# Define theme color palettes for White, Pink, Dark modes
def get_theme_config(theme_name):
    if theme_name == 'White':
        return {"primaryColor": "#E91E63", "backgroundColor": "#FFFFFF",
                "secondaryBackgroundColor": "#F0F2F6", "textColor": "#000000"}
    elif theme_name == 'Pink':
        return {"primaryColor": "#E91E63", "backgroundColor": "#FFE6F2",
                "secondaryBackgroundColor": "#FFFFFF", "textColor": "#000000"}
    elif theme_name == 'Dark':
        return {"primaryColor": "#FF4B4B", "backgroundColor": "#262730",
                "secondaryBackgroundColor": "#31333F", "textColor": "#FAFAFA"}
    # Fallback to white theme if unknown
    return {"primaryColor": "#E91E63", "backgroundColor": "#FFFFFF",
            "secondaryBackgroundColor": "#F0F2F6", "textColor": "#000000"}

# Apply the theme from session state
theme_config = get_theme_config(st.session_state['theme'])
st.set_page_config(page_title="Boss Babe Trading Intelligence 3.9", layout="wide", initial_sidebar_state="expanded", theme=theme_config)

# Initialize session state variables for trades and settings if not already
if 'trades' not in st.session_state:
    st.session_state['trades'] = []         # list to record trade history
if 'badges' not in st.session_state:
    st.session_state['badges'] = set()      # set of earned achievement badges
if 'refresh_time' not in st.session_state:
    st.session_state['refresh_time'] = 5    # auto-refresh interval in seconds
if 'auto_refresh' not in st.session_state:
    st.session_state['auto_refresh'] = False # whether to auto-refresh Chart/Signals
if 'trade_amount' not in st.session_state:
    st.session_state['trade_amount'] = 100.0 # default stake amount for demo trades
if 'last_prices' not in st.session_state:
    st.session_state['last_prices'] = {}    # store last price per symbol for continuity in simulation

# Define a list of symbols/markets to support
SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "BTCUSD"]

# Helper function to generate random OHLC candlestick data for simulation
def generate_random_ohlc(n=50, start_price=1.0):
    """Generate n periods of random OHLC data starting from start_price."""
    opens = []
    highs = []
    lows = []
    closes = []
    price = start_price
    for i in range(n):
        open_price = price
        # simulate price movement as a random percentage change
        drift = np.random.normal(0, 0.005)  # mean 0, std 0.5%
        close_price = open_price * (1 + drift)
        # Ensure high and low encompass open/close
        if close_price >= open_price:
            high_price = close_price * (1 + abs(np.random.normal(0, 0.002)))
            low_price  = open_price  * (1 - abs(np.random.normal(0, 0.002)))
        else:
            high_price = open_price  * (1 + abs(np.random.normal(0, 0.002)))
            low_price  = close_price * (1 - abs(np.random.normal(0, 0.002)))
        # Guarantee high is the max and low is the min
        high_price = max(high_price, open_price, close_price)
        low_price  = min(low_price, open_price, close_price)
        # Append OHLC
        opens.append(open_price)
        highs.append(high_price)
        lows.append(low_price)
        closes.append(close_price)
        price = close_price  # next period starts at last close
    return pd.DataFrame({"Open": opens, "High": highs, "Low": lows, "Close": closes})

# Main app title
st.title("Boss Babe Trading Intelligence 3.9")

# Sidebar page navigation
page = st.sidebar.selectbox("Navigate", ["Chart Playground", "Signal Generator", "Demo Play", "Statistics", "Settings"])

# --- Chart Playground Page ---
if page == "Chart Playground":
    st.markdown(f"<div style='background-color:#FFE6F2; padding:10px; border-radius:5px;'><b>How to use this page:</b> Select a symbol to view its live candlestick chart. The chart shows price candles with Boss Babe smart indicators (e.g., moving averages) overlaid. Below the chart, a trend analysis suggests a likely contract type (Rise/Fall, Touch/No Touch, or In/Out) based on current market movement. Use this to plan your trades. (If auto-refresh is enabled in Settings, the chart will update every {st.session_state['refresh_time']} seconds.)</div>", unsafe_allow_html=True)
    # Symbol selection
    symbol = st.selectbox("Select Symbol", SYMBOLS, index=0)
    # Fetch or simulate live candlestick data for the selected symbol
    # Use last known price for continuity or initialize if first time
    last_price = st.session_state['last_prices'].get(symbol, 1.0)
    df = generate_random_ohlc(n=50, start_price=last_price)
    # Update stored last price for this symbol
    st.session_state['last_prices'][symbol] = float(df['Close'].iloc[-1])
    # Compute simple moving averages as example smart indicators
    df['MA_fast'] = df['Close'].rolling(window=5, min_periods=1).mean()
    df['MA_slow'] = df['Close'].rolling(window=10, min_periods=1).mean()
    # Create a candlestick chart using Plotly
    import plotly.graph_objects as go
    # Prepare x-axis as timestamps for realism
    now = datetime.datetime.utcnow()
    time_index = [now - datetime.timedelta(minutes= (len(df)-i)*1) for i in range(len(df))]  # 1-minute intervals
    fig = go.Figure(data=[go.Candlestick(x=time_index,
                                        open=df['Open'], high=df['High'],
                                        low=df['Low'], close=df['Close'],
                                        name='Price')])
    # Add moving average lines
    fig.add_trace(go.Scatter(x=time_index, y=df['MA_fast'], mode='lines', line=dict(width=1.5, color='#ff66c4'), name='MA (5)'))
    fig.add_trace(go.Scatter(x=time_index, y=df['MA_slow'], mode='lines', line=dict(width=1.5, color='#6600cc'), name='MA (10)'))
    # Style the chart layout
    fig.update_layout(title=f"{symbol} Live Chart", xaxis_title="Time", yaxis_title="Price",
                      xaxis_rangeslider_visible=False, legend=dict(y=0.99, x=0.01),
                      paper_bgcolor='rgba(0,0,0,0)', plot_bgcolor='rgba(0,0,0,0)')
    # Display chart
    st.plotly_chart(fig, use_container_width=True)
    # Analyze trend and volatility to suggest a contract type
    start_price = float(df['Close'].iloc[0])
    end_price = float(df['Close'].iloc[-1])
    max_price = float(df['High'].max())
    min_price = float(df['Low'].min())
    change_pct = (end_price - start_price) / start_price
    range_pct = (max_price - min_price) / start_price
    suggestion = ""
    if abs(change_pct) > 0.02:  # if more than ±2% trend over the period
        if change_pct > 0:
            suggestion = "Uptrend detected – likely outcome: Price rising (consider a Rise/Higher contract)."
        else:
            suggestion = "Downtrend detected – likely outcome: Price falling (consider a Fall/Lower contract)."
    elif range_pct > 0.02:  # high volatility, big swings
        suggestion = "High volatility detected – price swings are large (consider Touch/Out contracts)."
    else:
        suggestion = "Low volatility range – price is stable (consider No-Touch or In-Range contracts)."
    # Output suggestion analysis
    st.write(f"**Market Analysis ({symbol}):** {suggestion}")
    # Auto-refresh mechanism if enabled
    if st.session_state['auto_refresh']:
        time.sleep(st.session_state['refresh_time'])
        st.experimental_rerun()

# --- Signal Generator Page ---
elif page == "Signal Generator":
    st.markdown(f"<div style='background-color:#FFE6F2; padding:10px; border-radius:5px;'><b>How to use this page:</b> View automatically generated trading signals for various assets. Each row shows a market symbol, a suggested contract (with direction), and the probability of that outcome based on recent price movement. Use these signals as ideas – for example, a strong upward probability might suggest a Rise contract. The signals update every {st.session_state['refresh_time']} seconds if auto-refresh is on.</div>", unsafe_allow_html=True)
    # Generate signals for each symbol
    signals_data = []
    for sym in SYMBOLS:
        # Use last price if available, else initialize
        base_price = st.session_state['last_prices'].get(sym, 1.0)
        df_sym = generate_random_ohlc(n=20, start_price=base_price)
        # Update last price for symbol
        st.session_state['last_prices'][sym] = float(df_sym['Close'].iloc[-1])
        # Simple analysis: count how many candles closed up vs down
        up_moves = (df_sym['Close'] > df_sym['Open']).sum()
        down_moves = (df_sym['Close'] < df_sym['Open']).sum()
        total = len(df_sym)
        prob_up = (up_moves/total)*100.0
        prob_down = (down_moves/total)*100.0
        # Determine suggestion based on trend and volatility
        suggestion = ""
        probability = 0.0
        price_change = (float(df_sym['Close'].iloc[-1]) - float(df_sym['Open'].iloc[0])) / float(df_sym['Open'].iloc[0])
        volatility = (float(df_sym['High'].max()) - float(df_sym['Low'].min())) / float(df_sym['Open'].iloc[0])
        if abs(price_change) > 0.005:  # trend threshold (~0.5%)
            if price_change > 0:
                suggestion = "Rise (Up)"
                probability = prob_up
            else:
                suggestion = "Fall (Down)"
                probability = prob_down
        elif volatility > 0.01:  # high volatility scenario
            suggestion = "Touch (Volatile)"
            probability = min(99.0, volatility*1000)  # just a scaled guess
        else:
            suggestion = "In-Range (Stable)"
            probability = min(99.0, 100 - volatility*1000)
        probability = round(probability, 1)
        signals_data.append((sym, suggestion, f"{probability}%"))
    # Display signals in a table
    signals_table = "| Symbol | Suggested Signal | Probability |\n|---|---|---|\n"
    for sym, sugg, prob in signals_data:
        signals_table += f"| {sym} | {sugg} | {prob} |\n"
    st.markdown(signals_table)
    # Auto-refresh signals
    if st.session_state['auto_refresh']:
        time.sleep(st.session_state['refresh_time'])
        st.experimental_rerun()

# --- Demo Play Page ---
elif page == "Demo Play":
    st.markdown("<div style='background-color:#FFE6F2; padding:10px; border-radius:5px;'><b>How to use this page:</b> Practice trading with virtual money. Select an asset, choose a contract type and condition (Rise/Fall, Higher/Lower, Touch/No Touch, or In/Out), and enter an amount. Click 'Place Trade' to simulate a trade. The result (win/lose) and price movement in pips will be shown immediately, and the trade will be added to your history below. Use this to test strategies risk-free and track your performance.</div>", unsafe_allow_html=True)
    # Trade form for user inputs
    with st.form(key="trade_form"):
        col1, col2 = st.columns(2)
        with col1:
            symbol = st.selectbox("Symbol", SYMBOLS)
            contract_category = st.selectbox("Contract Type", ["Rise/Fall", "Higher/Lower", "Touch/No Touch", "In/Out"])
        with col2:
            # Depending on category, show appropriate options
            if contract_category == "Rise/Fall":
                contract_choice = st.radio("Prediction", ["Rise (Price will end higher)", "Fall (Price will end lower)"])
            elif contract_category == "Higher/Lower":
                contract_choice = st.radio("Prediction", ["Higher (Exit above target)", "Lower (Exit below target)"])
            elif contract_category == "Touch/No Touch":
                contract_choice = st.radio("Prediction", ["Touch (Will touch barrier)", "No Touch (Won't touch barrier)"])
            else:  # In/Out
                contract_choice = st.radio("Prediction", ["In (Stays within range)", "Out (Goes outside range)"])
        amount = st.number_input("Stake Amount", min_value=0.0, value=st.session_state['trade_amount'], step=1.0)
        submit_trade = st.form_submit_button("Place Trade")
    if submit_trade:
        # Determine a short symbol price simulation for this trade
        entry_price = st.session_state['last_prices'].get(symbol, 1.0)
        # Simulate small random movement (for outcome within a short timeframe)
        # We'll simulate a tiny series of random moves to determine outcome
        sim_steps = 5
        current_price = entry_price
        high_price = entry_price
        low_price = entry_price
        for i in range(sim_steps):
            # simulate next price step (random walk)
            step_change = np.random.normal(0, 0.002)  # small random move (std 0.2%)
            new_price = current_price * (1 + step_change)
            high_price = max(high_price, new_price)
            low_price = min(low_price, new_price)
            current_price = new_price
        exit_price = current_price  # final price after simulation
        # Determine trade outcome based on contract type
        outcome = "Loss"
        contract_name = ""  # short name like "Rise", "Fall", etc.
        # Identify chosen contract name and logic
        if contract_category == "Rise/Fall":
            if contract_choice.startswith("Rise"):
                contract_name = "Rise"
                if exit_price > entry_price:
                    outcome = "Win"
            else:
                contract_name = "Fall"
                if exit_price < entry_price:
                    outcome = "Win"
        elif contract_category == "Higher/Lower":
            # For Higher/Lower, define barrier as entry price for simplicity
            barrier = entry_price  # (In a real scenario, barrier might be entry +/- a fixed offset)
            if contract_choice.startswith("Higher"):
                contract_name = "Higher"
                # Win if exit above barrier
                if exit_price > barrier:
                    outcome = "Win"
            else:
                contract_name = "Lower"
                if exit_price < barrier:
                    outcome = "Win"
        elif contract_category == "Touch/No Touch":
            # Define an upper barrier a bit above entry
            barrier = entry_price * 1.0010  # ~0.1% above entry
            if contract_choice.startswith("Touch"):
                contract_name = "Touch"
                # Win if price touched/exceeded barrier at any point
                if high_price >= barrier:
                    outcome = "Win"
            else:
                contract_name = "No Touch"
                # Win if price never reaches barrier
                if high_price < barrier:
                    outcome = "Win"
        else:  # In/Out
            # Define range around entry (±0.05%)
            upper_barrier = entry_price * 1.0005
            lower_barrier = entry_price * 0.9995
            if contract_choice.startswith("In"):
                contract_name = "In"
                # Win if price stayed within [lower_barrier, upper_barrier]
                if high_price < upper_barrier and low_price > lower_barrier:
                    outcome = "Win"
            else:
                contract_name = "Out"
                # Win if price went outside the range (above upper or below lower at some point)
                if high_price >= upper_barrier or low_price <= lower_barrier:
                    outcome = "Win"
        # Calculate pip difference for tracking (1 pip = 0.0001 price change for simplicity)
        price_diff = exit_price - entry_price
        pips_moved = price_diff * 10000  # convert to "pips"
        # For tracking, record positive pips for wins, negative for losses
        pip_result = abs(pips_moved) if outcome == "Win" else -abs(pips_moved)
        pip_result = round(pip_result, 1)
        # Update last price for symbol to allow continuity
        st.session_state['last_prices'][symbol] = float(exit_price)
        # Record the trade in history
        trade_record = {
            "symbol": symbol,
            "contract": contract_name,
            "result": outcome,
            "pips": pip_result,
            "amount": amount
        }
        st.session_state['trades'].append(trade_record)
        # Display trade outcome to user
        price_direction = "up" if price_diff >= 0 else "down"
        st.write(f"Entry Price: {entry_price:.5f} | Exit Price: {exit_price:.5f}")
        if outcome == "Win":
            st.success(f"✅ Trade WON! Price went {price_direction} {abs(pips_moved):.1f} pips.")
        else:
            st.error(f"❌ Trade LOST. Price went {price_direction} {abs(pips_moved):.1f} pips.")
        # Show updated trade history table
        history_df = pd.DataFrame(st.session_state['trades'])
        # If history exists, present it in a friendly format
        if not history_df.empty:
            history_df.index = history_df.index + 1  # 1-index the trades
            history_display = history_df[["symbol", "contract", "result", "pips", "amount"]]
            history_display.rename(columns={"symbol": "Symbol", "contract": "Contract", "result": "Result", "pips": "Pips", "amount": "Stake"}, inplace=True)
            st.table(history_display)
        # Update achievement badges based on new trade
        # First trade badge
        if len(st.session_state['trades']) == 1:
            st.session_state['badges'].add("First Trade 🎉")
        # 10 trades completed badge
        if len(st.session_state['trades']) == 10:
            st.session_state['badges'].add("10 Trades Completed 🏅")
        # Winning streak badge (10 wins in a row)
        if outcome == "Win":
            # check current streak of consecutive wins from end of history
            recent_streak = 0
            for t in reversed(st.session_state['trades']):
                if t['result'] == "Win":
                    recent_streak += 1
                else:
                    break
            if recent_streak == 10:
                st.session_state['badges'].add("10 Wins in a Row 🏆")
        else:
            # reset streak if a loss (not explicitly stored, we just won't award until streak forms again)
            pass

# --- Statistics Page ---
elif page == "Statistics":
    st.markdown("<div style='background-color:#FFE6F2; padding:10px; border-radius:5px;'><b>How to use this page:</b> Review your trading performance metrics and achievements. See total trades, wins/losses, win rate, average pips per trade, and your most-used contract type. Check the Achievements section for badges earned (e.g., streaks or milestones). Use these stats to understand your strengths and areas to improve.</div>", unsafe_allow_html=True)
    trades = st.session_state['trades']
    total_trades = len(trades)
    if total_trades == 0:
        st.info("No trades have been placed yet. Trade on the Demo Play page to see statistics.")
    else:
        # Calculate stats
        wins = sum(1 for t in trades if t['result'] == "Win")
        losses = sum(1 for t in trades if t['result'] == "Loss")
        win_rate = (wins / total_trades) * 100.0
        # Average pips (consider positive for wins, negative for losses as recorded)
        avg_pips = np.mean([t['pips'] for t in trades]) if trades else 0.0
        # Determine favorite contract type by usage count
        contract_counts = {"Rise/Fall": 0, "Higher/Lower": 0, "Touch/No Touch": 0, "In/Out": 0}
        for t in trades:
            c = t['contract']
            if c in ["Rise", "Fall"]:
                contract_counts["Rise/Fall"] += 1
            elif c in ["Higher", "Lower"]:
                contract_counts["Higher/Lower"] += 1
            elif c in ["Touch", "No Touch"]:
                contract_counts["Touch/No Touch"] += 1
            elif c in ["In", "Out"]:
                contract_counts["In/Out"] += 1
        # Favorite = contract type with max count
        favorite_type = max(contract_counts, key=contract_counts.get)
        # Display the stats
        col1, col2, col3 = st.columns(3)
        col1.metric("Total Trades", total_trades)
        col1.metric("Wins", wins)
        col1.metric("Losses", losses)
        col2.metric("Win Rate", f"{win_rate:.1f}%")
        col2.metric("Avg Pips/Trade", f"{avg_pips:.1f}")
        col3.metric("Favorite Contract", favorite_type)
        # Achievements / Badges
        st.subheader("🎖 Achievements")
        if len(st.session_state['badges']) == 0:
            st.write("No badges earned yet. Keep trading to unlock achievements!")
        else:
            for badge in st.session_state['badges']:
                st.write(f"- **{badge}**")

# --- Settings Page ---
elif page == "Settings":
    st.markdown("<div style='background-color:#FFE6F2; padding:10px; border-radius:5px;'><b>How to use this page:</b> Customize the app to your preference. Choose a theme (White for default light theme, Pink for a pink-hued theme, or Dark for night mode). Set the auto-refresh interval in seconds for live data updates, and toggle auto-refresh on/off. You can also set the default stake amount for demo trades. Your changes will apply immediately and persist during this session.</div>", unsafe_allow_html=True)
    # Theme selection
    theme_choice = st.radio("Select Theme", ["White", "Pink", "Dark"], index=["White","Pink","Dark"].index(st.session_state['theme']), key='theme')
    st.write(f"**Current theme:** {theme_choice}")
    # Auto-refresh interval and toggle
    st.slider("Auto-Refresh Interval (seconds)", min_value=1, max_value=60, value=st.session_state['refresh_time'], key='refresh_time')
    st.checkbox("Enable auto-refresh on Chart & Signals", value=st.session_state['auto_refresh'], key='auto_refresh')
    # Default trade amount
    st.number_input("Default Trade Amount for Demo (stake)", min_value=0.0, value=st.session_state['trade_amount'], step=1.0, key='trade_amount')
    st.info("Settings updated. You can now navigate to other pages to see changes in effect (e.g., theme colors or auto-refresh).")
