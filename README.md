# SANI BOS Executor v1

A zero-dependency Deriv Options trading app built around the stateful HH/HL/LH/LL break-of-structure logic from the SANI V25 research.

## Why this is not DBot

The execution path is direct WebSocket code. The default order path uses Deriv's current `buy: "1"` request with contract parameters on the same authenticated WebSocket, removing Blockly, Purchase-block validation, nested dispatchers, and the proposal round-trip.

## Built in so we do not keep rebuilding

- Demo + real Options accounts. Real is deliberately gated by typing `REAL`.
- Adjustable stake, duration, unit, TP, SL, max trades, bull side, bear side, open-contract lock, cooldown and signal-send guard.
- Direct Buy or Proposal → Buy execution mode.
- Timing Lab scores every BOS virtually at T+1, T+2 and T+3 while actual trading continues.
- Actual latency telemetry: request ACK and Deriv server start-time delay.
- CSV export and journal.
- Browser executor for immediate use.
- `worker.mjs` for always-on execution on a persistent Node host.
- `worker-server.mjs` provides remote start/stop/config/status endpoints so the dashboard architecture can be extended without rewriting the strategy.
- No third-party npm packages. Node 22+ is enough.

## Run locally

```bash
npm run test
npm run check
npm run dev
```
Open http://localhost:3000.

## Connect Deriv

Use a Deriv App ID and a PAT/OAuth token with `trade` scope. The app obtains a 120-second OTP URL from the current Options API and then opens the authenticated WebSocket. Demo is the intended testing mode.

The browser stores the token in `sessionStorage` only. The token is not written to localStorage. The Vercel/local API proxy does not persist it.

## Always-on worker

Set environment variables from `.env.example` on a persistent Node/Docker host and run:

```bash
npm run worker
```

The worker shares the same BOS strategy and direct-buy protocol. Closing the browser does not stop a separately hosted worker.

## Security note

Never commit a Deriv token. If an older public repository revision contained a hard-coded token, revoke/rotate it in Deriv because deleting it from the current files does not remove it from Git history.

## Current defaults

- Volatility 25 (1s): `1HZ25V`
- $1 stake
- 1 tick
- Bull BOS → CALL
- Bear BOS → PUT
- Direct Buy
- TP +$2
- SL -$3
- max 10 trades
- cooldown disabled by default
- Timing Lab T+1 / T+2 / T+3

The app supports real accounts technically, but real-money use should wait until Demo execution timing and expectancy are independently validated.
