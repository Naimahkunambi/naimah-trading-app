import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { CometNativeEngine, LastManGrabNativeEngine, NativeEngineMeta } from './native-engines.mjs';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const CREDS_PATH = path.join(ROOT, 'deriv-demo.json');
const STATE_PATH = path.join(ROOT, 'native-engine-state.json');
const STATUS_PATH = path.join(ROOT, 'demo-live-status.json');
const CSV_PATH = path.join(ROOT, 'native-demo-trades.csv');
const SYMBOL = process.env.SANI_SYMBOL || '1HZ25V';
const MIN_STAKE = 1;
const ALLOWED_MULTIPLIERS = [160, 400, 800, 1200, 1600];
const REQUESTED_MULTIPLIER = Number(process.env.SANI_MULTIPLIER || 160);
const MULTIPLIER = ALLOWED_MULTIPLIERS.includes(REQUESTED_MULTIPLIER) ? REQUESTED_MULTIPLIER : 160;
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_COUNT = 1200;

const now = () => new Date().toISOString();
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value, mode = 0o600) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  try { fs.chmodSync(file, mode); } catch {}
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function appendTradeCsv(engineName, trade) {
  const cols = ['closed_at','engine','side','entry','exit','paper_r','paper_pnl','demo_pnl','reason','entry_mode','entry_power','contract_id','stake','multiplier','buy_at','sell_at'];
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, cols.join(',') + '\n');
  const row = [
    new Date(trade.closedAt || Date.now()).toISOString(), engineName, trade.side, trade.entry, trade.exit,
    trade.r, trade.pnl, trade.demoPnl, trade.reason, trade.entryContext?.entryMode || '', trade.entryPower ?? '',
    trade.demo?.contractId || '', trade.demo?.stake || '', trade.demo?.multiplier || '', trade.demo?.buyAt || '', trade.demoSellAt || ''
  ];
  fs.appendFileSync(CSV_PATH, row.map(csvEscape).join(',') + '\n');
}

class DerivDemoBroker {
  constructor({ onForcedClose }) {
    this.onForcedClose = onForcedClose;
    this.ws = null;
    this.account = null;
    this.currency = 'USD';
    this.creds = null;
    this.pending = new Map();
    this.req = 1000;
    this.live = new Map();
    this.pingTimer = null;
  }

  async verifyDemoAccount() {
    const creds = readJson(CREDS_PATH, null);
    if (!creds?.appId || !creds?.token || !creds?.accountId) throw new Error(`Missing Demo credentials in ${CREDS_PATH}`);
    const r = await fetch('https://api.derivws.com/trading/v1/options/accounts', {
      headers: { 'Deriv-App-ID': String(creds.appId), Authorization: `Bearer ${creds.token}`, Accept: 'application/json' }
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`Account API returned non-JSON: ${text.slice(0, 120)}`); }
    if (!r.ok) throw new Error(j?.errors?.[0]?.message || `Account check failed ${r.status}`);
    const rows = Array.isArray(j.data) ? j.data : [j.data].filter(Boolean);
    const account = rows.find(a => String(a.account_id) === String(creds.accountId));
    if (!account) throw new Error('Configured Demo account was not returned by Deriv.');
    if (String(account.account_type || '').toLowerCase() === 'real') throw new Error('REFUSED: configured account is REAL. Native SANI is permanently Demo-only.');
    this.creds = creds;
    this.account = account;
    this.currency = account.currency || 'USD';
    console.log(`[NATIVE DEMO] verified ${account.account_id} · ${this.currency} ${account.balance}`);
  }

  async otpUrl() {
    const r = await fetch(`https://api.derivws.com/trading/v1/options/accounts/${encodeURIComponent(this.creds.accountId)}/otp`, {
      method: 'POST',
      headers: { 'Deriv-App-ID': String(this.creds.appId), Authorization: `Bearer ${this.creds.token}` }
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`OTP API returned non-JSON: ${text.slice(0, 120)}`); }
    if (!r.ok || !j?.data?.url) throw new Error(j?.errors?.[0]?.message || `OTP failed ${r.status}`);
    return j.data.url;
  }

  async connect() {
    const url = await this.otpUrl();
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timeout = setTimeout(() => reject(new Error('Authenticated Demo WebSocket timeout')), 15000);
      ws.once('open', () => { clearTimeout(timeout); this.ws = ws; resolve(); });
      ws.once('error', e => { clearTimeout(timeout); reject(e); });
    });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('error', e => console.error('[NATIVE DEMO WS]', e.message));
    this.ws.on('close', () => {
      console.error('[NATIVE DEMO] authenticated socket closed. Exiting so systemd can restart cleanly.');
      setTimeout(() => process.exit(2), 250);
    });
    this.pingTimer = setInterval(() => {
      try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ping: 1 })); } catch {}
    }, 25000);
    await this.request({ balance: 1, subscribe: 1 }).catch(() => null);
    console.log('[NATIVE DEMO] ✅ authenticated trading socket connected');
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      clearTimeout(p.timeout);
      if (msg.error) p.reject(new Error(`${msg.error.code || 'DerivError'}: ${msg.error.message || 'request failed'}`));
      else p.resolve(msg);
    }
    if (msg.msg_type === 'balance' && msg.balance && this.account) this.account.balance = Number(msg.balance.balance);
    if (msg.msg_type !== 'proposal_open_contract' || !msg.proposal_open_contract) return;
    const c = msg.proposal_open_contract;
    const id = String(c.contract_id || '');
    for (const [name, live] of this.live.entries()) {
      if (String(live.contractId) !== id) continue;
      live.lastProfit = Number(c.profit || 0);
      const closed = Boolean(c.is_sold) || ['sold', 'won', 'lost'].includes(String(c.status || '').toLowerCase());
      if (!closed || live.closing) continue;
      const demoPnl = Number(c.profit || live.lastProfit || 0);
      this.live.delete(name);
      Promise.resolve(this.onForcedClose?.(name, { demoPnl, soldFor: Number(c.sell_price || 0), sellAt: Date.now(), reason: `DERIV ${String(c.status || 'CLOSED').toUpperCase()}` }))
        .catch(e => console.error('[NATIVE DEMO] forced-close handler:', e.message));
    }
  }

  request(payload, timeoutMs = 12000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Demo trading socket is not open'));
    const req_id = ++this.req;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(req_id); reject(new Error(`Deriv request timeout: ${Object.keys(payload)[0]}`)); }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  async restore(name, position) {
    const d = position?.demo;
    if (!d?.contractId) return;
    this.live.set(name, { ...d, name, closing: false, lastProfit: Number(d.lastProfit || 0) });
    try {
      await this.request({ proposal_open_contract: 1, contract_id: Number(d.contractId), subscribe: 1 });
      console.log(`[NATIVE DEMO] restored ${name} contract ${d.contractId}`);
    } catch (e) {
      console.error(`[NATIVE DEMO] restore ${name}:`, e.message);
    }
  }

  async buy(name, candidate) {
    if (this.live.has(name)) throw new Error(`${name} already has a live Demo contract`);
    const paperStake = Number(candidate.riskDollars || 1);
    const stake = Math.max(MIN_STAKE, paperStake);
    const contract_type = candidate.side === 'LONG' ? 'MULTUP' : 'MULTDOWN';
    const signalAt = Date.now();
    const p = await this.request({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type,
      currency: this.currency,
      duration_unit: 's',
      multiplier: MULTIPLIER,
      underlying_symbol: SYMBOL
    });
    const prop = p.proposal;
    if (!prop?.id) throw new Error('Proposal returned no id');
    const ask = Number(prop.ask_price ?? stake);
    const b = await this.request({ buy: prop.id, price: Number.isFinite(ask) ? ask : stake });
    const bought = b.buy;
    if (!bought?.contract_id) throw new Error('Buy returned no contract id');
    const live = {
      name, contractId: bought.contract_id, side: candidate.side, paperStake, stake, multiplier: MULTIPLIER,
      buyPrice: Number(bought.buy_price ?? ask ?? stake), signalAt, buyAt: Date.now(), latencyMs: Date.now() - signalAt,
      lastProfit: 0, closing: false
    };
    this.live.set(name, live);
    await this.request({ proposal_open_contract: 1, contract_id: Number(live.contractId), subscribe: 1 }).catch(e => console.error(`[NATIVE DEMO] ${name} monitor subscribe:`, e.message));
    console.log(`[NATIVE DEMO] ✅ ${name} BOUGHT ${candidate.side} · contract ${live.contractId} · $${stake.toFixed(2)} x${MULTIPLIER} · ${live.latencyMs}ms`);
    return live;
  }

  async sell(name, reason = 'ENGINE EXIT') {
    const live = this.live.get(name);
    if (!live) throw new Error(`${name} has no live Demo contract to sell`);
    live.closing = true;
    try {
      const r = await this.request({ sell: Number(live.contractId), price: 0 });
      const sold = r.sell;
      const soldFor = Number(sold?.sold_for || 0);
      const demoPnl = Number((soldFor - Number(live.buyPrice || live.stake || 0)).toFixed(4));
      if (sold?.balance_after != null && this.account) this.account.balance = Number(sold.balance_after);
      this.live.delete(name);
      console.log(`[NATIVE DEMO] ✅ ${name} SOLD · ${reason} · P/L ${demoPnl >= 0 ? '+' : ''}$${demoPnl.toFixed(2)} · balance ${this.account?.balance}`);
      return { demoPnl, soldFor, sellAt: Date.now() };
    } catch (e) {
      live.closing = false;
      throw e;
    }
  }

  close() {
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }
}

class PublicMarketFeed {
  constructor({ onHistory, onTick }) {
    this.onHistory = onHistory;
    this.onTick = onTick;
    this.ws = null;
    this.subscriptionId = null;
    this.reconnectAttempt = 0;
    this.manual = false;
    this.primed = false;
    this.pendingTicks = [];
  }

  connect() {
    this.manual = false;
    const ws = new WebSocket(PUBLIC_WS);
    this.ws = ws;
    ws.on('open', () => {
      this.reconnectAttempt = 0;
      ws.send(JSON.stringify({ ticks_history: SYMBOL, count: HISTORY_COUNT, end: 'latest', style: 'ticks', req_id: 1 }));
      ws.send(JSON.stringify({ ticks: SYMBOL, subscribe: 1, req_id: 2 }));
      console.log(`[NATIVE FEED] connected ${SYMBOL}; loading ${HISTORY_COUNT} ticks`);
    });
    ws.on('message', raw => this.handle(raw));
    ws.on('error', e => console.error('[NATIVE FEED]', e.message));
    ws.on('close', () => {
      this.ws = null;
      if (this.manual) return;
      const delay = Math.min(15000, 800 * (2 ** Math.min(this.reconnectAttempt++, 5)));
      console.error(`[NATIVE FEED] disconnected; retry in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
    });
  }

  async handle(raw) {
    let d;
    try { d = JSON.parse(String(raw)); } catch { return; }
    if (d.error) { console.error('[NATIVE FEED] Deriv error:', d.error.message || d.error.code); return; }
    if (d.msg_type === 'history' && d.history) {
      const rows = (d.history.prices || []).map((quote, i) => ({ epoch: Number((d.history.times || [])[i]), quote: Number(quote) }));
      await this.onHistory(rows);
      this.primed = true;
      console.log(`[NATIVE FEED] ✅ primed ${rows.length} ticks`);
      const queued = this.pendingTicks.splice(0);
      for (const t of queued) await this.onTick(t.epoch, t.quote);
      return;
    }
    if (d.msg_type === 'tick' && d.tick) {
      this.subscriptionId = d.subscription?.id || this.subscriptionId;
      const row = { epoch: Number(d.tick.epoch), quote: Number(d.tick.quote) };
      if (!this.primed) this.pendingTicks.push(row);
      else await this.onTick(row.epoch, row.quote);
    }
  }

  close() {
    this.manual = true;
    try { if (this.subscriptionId && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ forget: this.subscriptionId })); } catch {}
    try { this.ws?.close(); } catch {}
  }
}

const persisted = readJson(STATE_PATH, {});
let broker;
let feed;
let latestQuote = null;
let tickChain = Promise.resolve();
let writing = false;
const engines = {};

function persistState() {
  if (writing) return;
  writing = true;
  try {
    writeJson(STATE_PATH, {
      version: 1,
      updatedAt: now(),
      COMET: engines.COMET?.snapshot() || null,
      LAST_MAN_GRAB: engines.LAST_MAN_GRAB?.snapshot() || null
    });
  } finally { writing = false; }
}

engines.COMET = new CometNativeEngine({ persisted: persisted.COMET, riskDollars: 1, targetR: 2, onState: persistState });
engines.LAST_MAN_GRAB = new LastManGrabNativeEngine({ persisted: persisted.LAST_MAN_GRAB, riskCap: 1, onState: persistState });

function statusFor(engine) {
  const s = engine.snapshot();
  return {
    live: s.position ? {
      contractId: s.position.demo?.contractId || null,
      side: s.position.side,
      entry: s.position.entry,
      stop: s.position.stop,
      trailStop: s.position.trailStop,
      target: s.position.target,
      paperStake: s.position.riskDollars,
      stake: s.position.demo?.stake || null,
      multiplier: s.position.demo?.multiplier || MULTIPLIER,
      buyAt: s.position.demo?.buyAt || null,
      entryMode: s.position.entryContext?.entryMode || null,
      power: s.position.entryPower ?? null
    } : null,
    trades: s.trades.length,
    wins: s.wins,
    losses: s.losses,
    winRate: s.winRate,
    realized: s.demoPnl,
    paperRealized: s.paperPnl,
    mountain: s.mountain,
    ...(engine.name === 'LAST_MAN_GRAB' ? { power: s.power, fixedMode: 'GRAB' } : {})
  };
}

function writeStatus(extra = {}) {
  writeJson(STATUS_PATH, {
    checkedAt: now(),
    architecture: 'NATIVE_VM_V1',
    demoOnly: true,
    accountId: broker?.account?.account_id || null,
    balance: broker?.account?.balance != null ? Number(broker.account.balance) : null,
    currency: broker?.currency || 'USD',
    symbol: SYMBOL,
    requestedMultiplier: REQUESTED_MULTIPLIER,
    multiplier: MULTIPLIER,
    derivAllowedMultipliers: ALLOWED_MULTIPLIERS,
    derivMinimumStake: MIN_STAKE,
    browserDependency: false,
    vercelExecutionDependency: false,
    COMET: statusFor(engines.COMET),
    LAST_MAN_GRAB: statusFor(engines.LAST_MAN_GRAB),
    logic: NativeEngineMeta,
    ...extra
  }, 0o644);
}

async function forcedClose(name, info) {
  const engine = engines[name];
  if (!engine?.position) return;
  const quote = Number(latestQuote ?? engine.ticks.at(-1)?.quote ?? engine.position.entry);
  const trade = engine.commitExit(info.reason || 'DERIV CLOSED', quote, info);
  if (trade) appendTradeCsv(name, trade);
  writeStatus({ lastEvent: `${name} forced close` });
}

async function processEngine(name, engine, epoch, quote) {
  const intent = engine.onTick(epoch, quote);
  if (!intent) return;
  if (intent.action === 'ENTRY') {
    try {
      const live = await broker.buy(name, intent.candidate);
      engine.commitEntry(intent.candidate, live);
      console.log(`[NATIVE ENGINE] 🎯 ${name} ${intent.candidate.side} · ${intent.candidate.entryContext?.entryMode || ''} @ ${intent.candidate.entry}`);
      writeStatus({ lastEvent: `${name} ENTRY ${intent.candidate.side}` });
    } catch (e) { console.error(`[NATIVE ENGINE] ${name} ENTRY rejected:`, e.message); }
    return;
  }
  if (intent.action === 'EXIT') {
    try {
      const demo = await broker.sell(name, intent.reason);
      const trade = engine.commitExit(intent.reason, intent.quote, demo);
      if (trade) appendTradeCsv(name, trade);
      writeStatus({ lastEvent: `${name} EXIT ${intent.reason}` });
    } catch (e) { console.error(`[NATIVE ENGINE] ${name} EXIT failed, position remains live:`, e.message); }
  }
}

async function processTick(epoch, quote) {
  latestQuote = Number(quote);
  await processEngine('COMET', engines.COMET, epoch, quote);
  await processEngine('LAST_MAN_GRAB', engines.LAST_MAN_GRAB, epoch, quote);
  writeStatus();
}

async function main() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`Missing ${CREDS_PATH}. Keep your existing Demo credential file there.`);
  broker = new DerivDemoBroker({ onForcedClose: forcedClose });
  await broker.verifyDemoAccount();
  await broker.connect();
  await broker.restore('COMET', engines.COMET.position);
  await broker.restore('LAST_MAN_GRAB', engines.LAST_MAN_GRAB.position);

  feed = new PublicMarketFeed({
    onHistory: async rows => {
      engines.COMET.prime(rows);
      engines.LAST_MAN_GRAB.prime(rows);
      persistState();
      writeStatus({ lastEvent: `Primed ${rows.length} ticks` });
    },
    onTick: async (epoch, quote) => {
      tickChain = tickChain.then(() => processTick(epoch, quote)).catch(e => console.error('[NATIVE TICK]', e.message));
      await tickChain;
    }
  });
  feed.connect();

  setInterval(() => {
    writeStatus({ heartbeat: now() });
    const c = statusFor(engines.COMET);
    const l = statusFor(engines.LAST_MAN_GRAB);
    console.log(`[NATIVE MONEY] balance=${broker.account?.balance} · COMET trades=${c.trades} W=${c.wins} L=${c.losses} P/L=${c.realized >= 0 ? '+' : ''}$${Number(c.realized).toFixed(2)} · LMS_GRAB trades=${l.trades} W=${l.wins} L=${l.losses} P/L=${l.realized >= 0 ? '+' : ''}$${Number(l.realized).toFixed(2)}`);
  }, 30000);

  console.log('==============================================');
  console.log(' SANI NATIVE VM V1 IS RUNNING');
  console.log(' COMET = original extracted logic');
  console.log(' LAST MAN = GRAB only');
  console.log(' DERIV = DEMO only');
  console.log(' BROWSER / VERCEL EXECUTION = NONE');
  console.log('==============================================');
  writeStatus({ lastEvent: 'Native VM started' });
}

async function shutdown(signal) {
  console.log(`[NATIVE] ${signal}; saving state and closing sockets.`);
  persistState();
  writeStatus({ stoppedAt: now(), stopSignal: signal });
  feed?.close();
  broker?.close();
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  console.error('[NATIVE FATAL]', e.stack || e.message);
  try { writeStatus({ fatal: e.message, failedAt: now() }); } catch {}
  process.exit(1);
});
