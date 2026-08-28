import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { analyzeMountain } from './libra-mountain.mjs';

const ROOT = path.join(os.homedir(), 'sani-cloud');
const CREDS_PATH = path.join(ROOT, 'deriv-demo.json');
const STATE_PATH = path.join(ROOT, 'native-adaptive-state.json');
const STATUS_PATH = path.join(ROOT, 'demo-live-status.json');
const CSV_PATH = path.join(ROOT, 'native-adaptive-trades.csv');

const SYMBOL = process.env.SANI_SYMBOL || '1HZ25V';
const MIN_STAKE = 1;
const ALLOWED_MULTIPLIERS = [160, 400, 800, 1200, 1600];
const REQUESTED_MULTIPLIER = Number(process.env.SANI_MULTIPLIER || 160);
const MULTIPLIER = ALLOWED_MULTIPLIERS.includes(REQUESTED_MULTIPLIER) ? REQUESTED_MULTIPLIER : 160;
const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';
const HISTORY_COUNT = 1200;
const PROPOSAL_MAX_AGE_MS = 2500;
const LATENCY_OUTLIER_MS = 1200;
const LATENCY_HOLD_MS = 8000;

const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const now = () => new Date().toISOString();
const mean = a => a.length ? a.reduce((s, v) => s + Number(v || 0), 0) / a.length : 0;
const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value, mode = 0o600) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  try { fs.chmodSync(file, mode); } catch {}
}
function median(values = []) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function pathEfficiency(values = []) {
  if (values.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < values.length; i++) path += Math.abs(values[i] - values[i - 1]);
  return path ? Math.abs(values.at(-1) - values[0]) / path : 0;
}
function slope(values = []) {
  if (values.length < 2) return 0;
  return (values.at(-1) - values[0]) / (values.length - 1);
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function slimMountain(m) {
  return {
    direction: m?.direction || 'NONE',
    entryMode: m?.entryMode || 'NO_TRADE',
    confirmation: Number(m?.confirmation || 0),
    important: m?.important ? { ...m.important } : null,
    start: m?.start ? { ...m.start } : null,
    extreme: m?.extreme ? { ...m.extreme } : null,
    entryAnchor: m?.entryAnchor ? { ...m.entryAnchor } : null,
    efficiency34: Number(m?.efficiency34 || 0),
    reason: m?.reason || ''
  };
}
function appendTradeCsv(trade) {
  const cols = [
    'closed_at','engine','side','appetite','speed_score','entry_confirmation','entry_mode',
    'entry','exit','paper_r','paper_pnl','demo_pnl','peak_demo_pnl','reason',
    'contract_id','stake','multiplier','buy_latency_ms','buy_at','sell_at'
  ];
  if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, cols.join(',') + '\n');
  const row = [
    new Date(trade.closedAt || Date.now()).toISOString(),
    'SANI_ADAPTIVE', trade.side, trade.appetite, trade.entrySpeedScore,
    trade.entryContext?.confirmation ?? '', trade.entryContext?.entryMode || '',
    trade.entry, trade.exit, trade.r, trade.pnl, trade.demoPnl, trade.peakDemoPnl,
    trade.reason, trade.demo?.contractId || '', trade.demo?.stake || '',
    trade.demo?.multiplier || '', trade.demo?.latencyMs ?? '',
    trade.demo?.buyAt || '', trade.demoSellAt || ''
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
    this.req = 2000;
    this.live = null;
    this.pingTimer = null;
    this.proposals = { LONG: null, SHORT: null };
    this.latencyHoldUntil = 0;
    this.lastBuyLatencyMs = 0;
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
    if (String(account.account_type || '').toLowerCase() === 'real') throw new Error('REFUSED: configured account is REAL. SANI native V2 is permanently Demo-only.');
    this.creds = creds;
    this.account = account;
    this.currency = account.currency || 'USD';
    console.log(`[NATIVE V2] verified DEMO ${account.account_id} · ${this.currency} ${account.balance}`);
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

  request(payload, timeoutMs = 12000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Demo trading socket is not open'));
    const req_id = ++this.req;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`Deriv request timeout: ${Object.keys(payload)[0]}`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
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
    this.ws.on('error', e => console.error('[NATIVE V2 WS]', e.message));
    this.ws.on('close', () => {
      console.error('[NATIVE V2] trading socket closed. systemd will restart.');
      setTimeout(() => process.exit(2), 250);
    });
    this.pingTimer = setInterval(() => {
      try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ping: 1 })); } catch {}
    }, 25000);
    await this.request({ balance: 1, subscribe: 1 }).catch(() => null);
    await this.seedProposal('LONG').catch(e => console.error('[NATIVE V2] LONG quote cache:', e.message));
    await this.seedProposal('SHORT').catch(e => console.error('[NATIVE V2] SHORT quote cache:', e.message));
    console.log('[NATIVE V2] ✅ authenticated socket + hot proposal cache connected');
  }

  proposalPayload(side, subscribe = 0) {
    return {
      proposal: 1,
      amount: MIN_STAKE,
      basis: 'stake',
      contract_type: side === 'LONG' ? 'MULTUP' : 'MULTDOWN',
      currency: this.currency,
      duration_unit: 's',
      multiplier: MULTIPLIER,
      underlying_symbol: SYMBOL,
      ...(subscribe ? { subscribe: 1 } : {})
    };
  }

  cacheProposal(side, msg) {
    const p = msg?.proposal;
    if (!p?.id) return;
    this.proposals[side] = {
      id: p.id,
      ask: Number(p.ask_price ?? MIN_STAKE),
      spot: Number(p.spot ?? p.spot_price ?? NaN),
      receivedAt: Date.now()
    };
  }

  async seedProposal(side) {
    const msg = await this.request(this.proposalPayload(side, 1));
    this.cacheProposal(side, msg);
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

    if (msg.msg_type === 'balance' && msg.balance && this.account) {
      this.account.balance = Number(msg.balance.balance);
    }

    if (msg.msg_type === 'proposal' && msg.proposal) {
      const ct = String(msg.echo_req?.contract_type || '').toUpperCase();
      if (ct === 'MULTUP') this.cacheProposal('LONG', msg);
      if (ct === 'MULTDOWN') this.cacheProposal('SHORT', msg);
    }

    if (msg.msg_type !== 'proposal_open_contract' || !msg.proposal_open_contract || !this.live) return;
    const c = msg.proposal_open_contract;
    if (String(c.contract_id || '') !== String(this.live.contractId)) return;
    this.live.lastProfit = Number(c.profit || 0);
    this.live.peakProfit = Math.max(Number(this.live.peakProfit || 0), Number(this.live.lastProfit || 0));
    const closed = Boolean(c.is_sold) || ['sold','won','lost'].includes(String(c.status || '').toLowerCase());
    if (!closed || this.live.closing) return;
    const finished = this.live;
    this.live = null;
    Promise.resolve(this.onForcedClose?.({
      demoPnl: Number(c.profit || finished.lastProfit || 0),
      soldFor: Number(c.sell_price || 0),
      sellAt: Date.now(),
      reason: `DERIV ${String(c.status || 'CLOSED').toUpperCase()}`
    })).catch(e => console.error('[NATIVE V2] forced-close handler:', e.message));
  }

  latencyHeld() {
    return Date.now() < Number(this.latencyHoldUntil || 0);
  }

  currentProfit() {
    return Number(this.live?.lastProfit || 0);
  }

  peakProfit() {
    return Number(this.live?.peakProfit || 0);
  }

  async buy(candidate) {
    if (this.live) throw new Error('One-contract rule: a Demo contract is already open.');
    if (this.latencyHeld()) throw new Error(`LATENCY HOLD until ${new Date(this.latencyHoldUntil).toISOString()}`);

    const side = candidate.side;
    const signalAt = Date.now();
    let cached = this.proposals[side];
    let source = 'HOT';
    if (!cached?.id || Date.now() - cached.receivedAt > PROPOSAL_MAX_AGE_MS) {
      source = 'FRESH';
      const msg = await this.request(this.proposalPayload(side, 0));
      this.cacheProposal(side, msg);
      cached = this.proposals[side];
    }
    if (!cached?.id) throw new Error('No valid multiplier proposal id.');

    let b;
    try {
      b = await this.request({ buy: cached.id, price: Number.isFinite(cached.ask) ? cached.ask : MIN_STAKE });
    } catch (e) {
      const msg = await this.request(this.proposalPayload(side, 0));
      this.cacheProposal(side, msg);
      cached = this.proposals[side];
      b = await this.request({ buy: cached.id, price: Number.isFinite(cached.ask) ? cached.ask : MIN_STAKE });
      source = 'RETRY';
    }

    const bought = b.buy;
    if (!bought?.contract_id) throw new Error('Buy returned no contract id.');
    const buyAt = Date.now();
    const latencyMs = buyAt - signalAt;
    this.lastBuyLatencyMs = latencyMs;
    if (latencyMs > LATENCY_OUTLIER_MS) this.latencyHoldUntil = Date.now() + LATENCY_HOLD_MS;

    this.live = {
      contractId: bought.contract_id,
      side,
      stake: MIN_STAKE,
      multiplier: MULTIPLIER,
      buyPrice: Number(bought.buy_price ?? cached.ask ?? MIN_STAKE),
      signalAt, buyAt, latencyMs, proposalSource: source,
      lastProfit: 0, peakProfit: 0, closing: false
    };
    await this.request({ proposal_open_contract: 1, contract_id: Number(this.live.contractId), subscribe: 1 })
      .catch(e => console.error('[NATIVE V2] monitor subscribe:', e.message));
    console.log(`[NATIVE V2] ✅ BOUGHT ${side} · ${candidate.appetite} · speed ${candidate.entrySpeedScore}/100 · $1 x${MULTIPLIER} · ${latencyMs}ms · ${source}`);
    return { ...this.live };
  }

  async sell(reason = 'ENGINE EXIT') {
    if (!this.live) throw new Error('No live Demo contract to sell.');
    this.live.closing = true;
    const live = this.live;
    try {
      const r = await this.request({ sell: Number(live.contractId), price: 0 });
      const sold = r.sell;
      const soldFor = Number(sold?.sold_for || 0);
      const demoPnl = Number((soldFor - Number(live.buyPrice || live.stake || 0)).toFixed(4));
      if (sold?.balance_after != null && this.account) this.account.balance = Number(sold.balance_after);
      this.live = null;
      console.log(`[NATIVE V2] ✅ SOLD · ${reason} · P/L ${demoPnl >= 0 ? '+' : ''}$${demoPnl.toFixed(2)} · balance ${this.account?.balance}`);
      return { demoPnl, soldFor, sellAt: Date.now(), peakDemoPnl: Number(live.peakProfit || 0) };
    } catch (e) {
      live.closing = false;
      this.live = live;
      throw e;
    }
  }

  close() {
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }
}

class AdaptiveEngine {
  constructor({ persisted = null, onState = null }) {
    this.name = 'SANI_ADAPTIVE';
    this.ticks = [];
    this.position = persisted?.position || null;
    this.trades = Array.isArray(persisted?.trades) ? persisted.trades.slice(0, 1500) : [];
    this.demoPnl = Number(persisted?.demoPnl || 0);
    this.paperPnl = Number(persisted?.paperPnl || 0);
    this.lastCloseEpoch = Number(persisted?.lastCloseEpoch || 0);
    this.usedEntryKeys = Array.isArray(persisted?.usedEntryKeys) ? persisted.usedEntryKeys.slice(-500) : [];
    this.latestMountain = analyzeMountain([]);
    this.latestSpeed = { score: 0, label: 'WARMING' };
    this.latestAppetite = 'STAND_DOWN';
    this.preArm = null;
    this.onState = typeof onState === 'function' ? onState : () => {};
  }

  prime(rows = []) {
    const map = new Map();
    for (const r of rows) {
      const epoch = Number(r?.epoch), quote = Number(r?.quote);
      if (Number.isFinite(epoch) && Number.isFinite(quote)) map.set(`${epoch}:${quote}`, { epoch, quote });
    }
    this.ticks = [...map.values()].sort((a, b) => a.epoch - b.epoch).slice(-5000);
    this.latestMountain = analyzeMountain(this.ticks);
    this.latestSpeed = this.speedMetrics(this.latestMountain);
  }

  pushTick(epoch, quote) {
    epoch = Number(epoch); quote = Number(quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return false;
    const last = this.ticks.at(-1);
    if (last && last.epoch === epoch && last.quote === quote) return false;
    this.ticks.push({ epoch, quote });
    if (this.ticks.length > 5000) this.ticks.splice(0, this.ticks.length - 5000);
    this.latestMountain = analyzeMountain(this.ticks);
    this.latestSpeed = this.speedMetrics(this.latestMountain);
    return true;
  }

  step() {
    const d = [];
    for (let i = Math.max(1, this.ticks.length - 80); i < this.ticks.length; i++) {
      const v = Math.abs(this.ticks[i].quote - this.ticks[i - 1].quote);
      if (v > 0) d.push(v);
    }
    return median(d) || mean(d) || 1;
  }

  speedMetrics(m = this.latestMountain) {
    if (!m?.ready || !['UP','DOWN'].includes(m.direction) || this.ticks.length < 13) {
      return { score: 0, label: 'WARMING', s3: 0, s5: 0, s8: 0, accel: 0, eff8: 0, eff13: 0 };
    }
    const q = this.ticks.map(r => Number(r.quote));
    const step = Math.max(this.step(), 1e-9);
    const sign = m.direction === 'UP' ? 1 : -1;
    const s3 = slope(q.slice(-3)) / step * sign;
    const s5 = slope(q.slice(-5)) / step * sign;
    const s8 = slope(q.slice(-8)) / step * sign;
    const accel = s3 - s8;
    const eff8 = pathEfficiency(q.slice(-8));
    const eff13 = pathEfficiency(q.slice(-13));
    const coherence = [s3 > 0, s5 > 0, s8 > 0].filter(Boolean).length / 3;
    const velocity = clamp((Math.max(0, s3) * .50 + Math.max(0, s5) * .30 + Math.max(0, s8) * .20) / .60, 0, 1);
    const acceleration = clamp((accel + .25) / .60, 0, 1);
    const score = Math.round(100 * (velocity * .40 + coherence * .25 + eff8 * .18 + eff13 * .10 + acceleration * .07));
    return {
      score: clamp(score, 0, 100),
      label: score >= 78 ? 'FAST' : score >= 55 ? 'FLOWING' : score >= 35 ? 'SLOW' : 'STALLING',
      s3, s5, s8, accel, eff8, eff13
    };
  }

  appetite(speed, m) {
    if (!m?.ready || !['UP','DOWN'].includes(m.direction)) return 'STAND_DOWN';
    if (['EXHAUSTION','LATE_OR_WAIT','NO_TRADE'].includes(m.entryMode)) return 'STAND_DOWN';
    if (speed.score >= 80 && speed.eff13 >= .42) return 'RUNNER';
    if (speed.score >= 60) return 'TRAIL';
    if (speed.score >= 35) return 'GRAB';
    return 'STAND_DOWN';
  }

  entryKey(m, side) {
    const structural = Number(m?.entryAnchor?.epoch || m?.important?.epoch || m?.extreme?.epoch || 0);
    return structural ? `${side}|${m.direction}|${m.entryMode}|${structural}` : '';
  }

  hasUsed(key) { return Boolean(key && this.usedEntryKeys.includes(key)); }
  markUsed(key) {
    if (!key) return;
    this.usedEntryKeys = [...new Set([...this.usedEntryKeys, key])].slice(-500);
  }

  candidate(latencyHeld = false) {
    const m = this.latestMountain;
    const s = this.latestSpeed;
    this.latestAppetite = this.appetite(s, m);
    this.preArm = null;

    if (latencyHeld || this.position || !m?.ready || !['UP','DOWN'].includes(m.direction)) return null;

    if (m.entryMode === 'WAIT_PULLBACK_END' && Number(m.confirmation || 0) >= 3 && s.s3 > .08 && s.accel > -.02 && s.score >= 55) {
      this.preArm = {
        side: m.direction === 'UP' ? 'LONG' : 'SHORT',
        speedScore: s.score,
        confirmation: Number(m.confirmation || 0),
        epoch: Number(this.ticks.at(-1)?.epoch || 0),
        quote: Number(this.ticks.at(-1)?.quote || 0)
      };
      return null;
    }

    if (!['PULLBACK_END','EARLY_MOMENTUM'].includes(m.entryMode)) return null;
    if (m.entryMode === 'PULLBACK_END' && (s.s3 <= .03 || s.score < 35)) return null;
    if (m.entryMode === 'EARLY_MOMENTUM' && s.score < 60) return null;

    const appetite = this.appetite(s, m);
    if (appetite === 'STAND_DOWN') return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote), epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch) return null;
    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const key = this.entryKey(m, side);
    if (this.hasUsed(key)) return null;

    const cfg = appetite === 'GRAB'
      ? { riskModel: .40, targetR: .80 }
      : appetite === 'TRAIL'
        ? { riskModel: .70, targetR: 1.60 }
        : { riskModel: 1.00, targetR: 3.00 };

    const step = this.step();
    const buffer = Math.max(step * 1.25, 1e-9);
    const minDistance = Math.max(step * 6, 1e-9);
    const important = Number(m.important?.quote);
    let stop;
    if (side === 'LONG') {
      const structural = Number.isFinite(important) && important < quote ? important - buffer : quote - minDistance;
      stop = Math.min(structural, quote - minDistance);
    } else {
      const structural = Number.isFinite(important) && important > quote ? important + buffer : quote + minDistance;
      stop = Math.max(structural, quote + minDistance);
    }
    const riskDistance = Math.abs(quote - stop);
    if (!(riskDistance > 0)) return null;
    const target = side === 'LONG' ? quote + riskDistance * cfg.targetR : quote - riskDistance * cfg.targetR;
    const units = cfg.riskModel / riskDistance;

    return {
      side, appetite, entry: quote, stop, trailStop: stop, target,
      targetR: cfg.targetR, units, riskDollars: cfg.riskModel,
      plannedRiskDistance: riskDistance,
      openedAt: Date.now(), openedEpoch: epoch, entryKey: key,
      bestR: 0, peakDemoPnl: 0, entrySpeedScore: s.score,
      entrySpeedLabel: s.label, entryContext: slimMountain(m)
    };
  }

  unrealized(quote = this.ticks.at(-1)?.quote) {
    const p = this.position;
    if (!p || !Number.isFinite(Number(quote))) return { pnl: 0, r: 0 };
    const delta = p.side === 'LONG' ? Number(quote) - p.entry : p.entry - Number(quote);
    const pnl = delta * p.units;
    return { pnl, r: p.riskDollars ? pnl / p.riskDollars : 0 };
  }

  commitEntry(candidate, demo) {
    this.position = { ...candidate, demo: { ...demo } };
    this.markUsed(candidate.entryKey);
    this.onState();
  }

  manage(actualDemoPnl = 0, peakDemoPnl = 0) {
    if (!this.position) return null;
    const p = this.position;
    const m = this.latestMountain;
    const s = this.latestSpeed;
    const q = Number(this.ticks.at(-1)?.quote);
    if (!Number.isFinite(q)) return null;
    const u = this.unrealized(q);
    p.bestR = Math.max(Number(p.bestR || 0), u.r);
    p.peakDemoPnl = Math.max(Number(p.peakDemoPnl || 0), Number(peakDemoPnl || 0), Number(actualDemoPnl || 0));

    if (p.side === 'LONG' && q <= p.trailStop) return { reason: 'STOP / INVALIDATION', quote: p.trailStop };
    if (p.side === 'SHORT' && q >= p.trailStop) return { reason: 'STOP / INVALIDATION', quote: p.trailStop };
    if (p.side === 'LONG' && q >= p.target) return { reason: 'DYNAMIC TARGET', quote: p.target };
    if (p.side === 'SHORT' && q <= p.target) return { reason: 'DYNAMIC TARGET', quote: p.target };

    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
    if (opposite) return { reason: 'CONFIRMED MOUNTAIN REVERSAL · FAST EXIT', quote: q };

    const demoCfg = p.appetite === 'GRAB'
      ? { arm: .06, floor: .01, keep: .38 }
      : p.appetite === 'TRAIL'
        ? { arm: .10, floor: .02, keep: .35 }
        : { arm: .15, floor: .03, keep: .30 };
    if (p.peakDemoPnl >= demoCfg.arm) {
      const givebackFloor = Math.max(demoCfg.floor, p.peakDemoPnl * demoCfg.keep);
      if (actualDemoPnl <= givebackFloor) {
        return { reason: `ACTUAL PROFIT TRAIL · ${p.appetite}`, quote: q };
      }
    }

    if (s.score < 28 && actualDemoPnl > 0) return { reason: 'SPEED FADE · CASH OUT', quote: q };

    if (m.entryMode === 'EXHAUSTION' && actualDemoPnl > 0) {
      return { reason: 'EXHAUSTION · CASH ACTUAL PROFIT', quote: q };
    }

    if (actualDemoPnl > 0.01) {
      if (p.appetite === 'GRAB' && u.r >= .58) {
        const lockR = .25;
        const stop = p.side === 'LONG' ? p.entry + p.plannedRiskDistance * lockR : p.entry - p.plannedRiskDistance * lockR;
        p.trailStop = p.side === 'LONG' ? Math.max(p.trailStop, stop) : Math.min(p.trailStop, stop);
      }
      if (p.appetite !== 'GRAB' && u.r >= 1) {
        const lockR = p.appetite === 'TRAIL' ? .10 : .15;
        const stop = p.side === 'LONG' ? p.entry + p.plannedRiskDistance * lockR : p.entry - p.plannedRiskDistance * lockR;
        p.trailStop = p.side === 'LONG' ? Math.max(p.trailStop, stop) : Math.min(p.trailStop, stop);
      }
      if (u.r >= (p.appetite === 'RUNNER' ? 1.35 : .90) && Number.isFinite(Number(m.important?.quote))) {
        const st = Number(m.important.quote);
        if (p.side === 'LONG' && st > p.trailStop && st < q) p.trailStop = st;
        if (p.side === 'SHORT' && st < p.trailStop && st > q) p.trailStop = st;
      }
    }

    this.onState();
    return null;
  }

  commitExit(reason, quote, demo) {
    if (!this.position) return null;
    const p = this.position;
    const u = this.unrealized(quote);
    const trade = {
      ...p,
      exit: Number(quote),
      closedAt: Date.now(),
      pnl: Number(u.pnl.toFixed(4)),
      r: Number(u.r.toFixed(4)),
      reason,
      demoPnl: Number(demo?.demoPnl || 0),
      peakDemoPnl: Math.max(Number(p.peakDemoPnl || 0), Number(demo?.peakDemoPnl || 0)),
      demoSoldFor: demo?.soldFor != null ? Number(demo.soldFor) : null,
      demoSellAt: demo?.sellAt || Date.now(),
      exitContext: slimMountain(this.latestMountain)
    };
    this.trades.unshift(trade);
    this.trades = this.trades.slice(0, 1500);
    this.paperPnl = Number((this.paperPnl + trade.pnl).toFixed(4));
    this.demoPnl = Number((this.demoPnl + trade.demoPnl).toFixed(4));
    this.lastCloseEpoch = Number(this.ticks.at(-1)?.epoch || this.lastCloseEpoch);
    this.position = null;
    this.onState();
    return trade;
  }

  snapshot() {
    const wins = this.trades.filter(t => Number(t.demoPnl || 0) > 0).length;
    return {
      name: this.name,
      position: this.position,
      trades: this.trades,
      demoPnl: this.demoPnl,
      paperPnl: this.paperPnl,
      wins,
      losses: this.trades.length - wins,
      winRate: this.trades.length ? Number((wins / this.trades.length * 100).toFixed(1)) : 0,
      mountain: slimMountain(this.latestMountain),
      speed: this.latestSpeed,
      appetite: this.latestAppetite,
      preArm: this.preArm
    };
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
      const queued = this.pendingTicks.splice(0);
      for (const t of queued) await this.onTick(t.epoch, t.quote);
      console.log(`[NATIVE FEED] ✅ primed ${rows.length} ticks`);
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
const engine = new AdaptiveEngine({ persisted, onState: persistState });

function persistState() {
  if (writing) return;
  writing = true;
  try {
    const s = engine.snapshot();
    writeJson(STATE_PATH, {
      version: 2,
      updatedAt: now(),
      position: s.position,
      trades: s.trades,
      demoPnl: s.demoPnl,
      paperPnl: s.paperPnl,
      lastCloseEpoch: engine.lastCloseEpoch,
      usedEntryKeys: engine.usedEntryKeys
    });
  } finally { writing = false; }
}

function statusEngine() {
  const s = engine.snapshot();
  return {
    live: s.position ? {
      contractId: s.position.demo?.contractId || null,
      side: s.position.side,
      appetite: s.position.appetite,
      entry: s.position.entry,
      stop: s.position.stop,
      trailStop: s.position.trailStop,
      target: s.position.target,
      paperRisk: s.position.riskDollars,
      stake: s.position.demo?.stake || MIN_STAKE,
      multiplier: s.position.demo?.multiplier || MULTIPLIER,
      buyAt: s.position.demo?.buyAt || null,
      buyLatencyMs: s.position.demo?.latencyMs ?? null,
      actualPnl: broker?.currentProfit() ?? 0,
      peakActualPnl: broker?.peakProfit() ?? 0,
      entryMode: s.position.entryContext?.entryMode || null,
      entryConfirmation: s.position.entryContext?.confirmation || 0,
      entrySpeedScore: s.position.entrySpeedScore
    } : null,
    trades: s.trades.length,
    wins: s.wins,
    losses: s.losses,
    winRate: s.winRate,
    realized: s.demoPnl,
    paperRealized: s.paperPnl,
    mountain: s.mountain,
    speed: s.speed,
    appetite: s.appetite,
    preArm: s.preArm
  };
}

function writeStatus(extra = {}) {
  writeJson(STATUS_PATH, {
    checkedAt: now(),
    architecture: 'NATIVE_VM_V2_SPEED',
    demoOnly: true,
    accountId: broker?.account?.account_id || null,
    balance: broker?.account?.balance != null ? Number(broker.account.balance) : null,
    currency: broker?.currency || 'USD',
    symbol: SYMBOL,
    multiplier: MULTIPLIER,
    derivAllowedMultipliers: ALLOWED_MULTIPLIERS,
    derivMinimumStake: MIN_STAKE,
    browserDependency: false,
    vercelExecutionDependency: false,
    oneContractRule: true,
    latencyHold: broker?.latencyHeld() || false,
    lastBuyLatencyMs: Number(broker?.lastBuyLatencyMs || 0),
    SANI_ADAPTIVE: statusEngine(),
    ...extra
  }, 0o644);
}

async function forcedClose(info) {
  if (!engine.position) return;
  const quote = Number(latestQuote ?? engine.ticks.at(-1)?.quote ?? engine.position.entry);
  const trade = engine.commitExit(info.reason || 'DERIV CLOSED', quote, info);
  if (trade) appendTradeCsv(trade);
  writeStatus({ lastEvent: 'Forced Deriv close' });
}

async function processTick(epoch, quote) {
  latestQuote = Number(quote);
  if (!engine.pushTick(epoch, quote)) return;

  if (engine.position) {
    const exit = engine.manage(broker.currentProfit(), broker.peakProfit());
    if (exit) {
      try {
        const demo = await broker.sell(exit.reason);
        const trade = engine.commitExit(exit.reason, exit.quote, demo);
        if (trade) appendTradeCsv(trade);
        writeStatus({ lastEvent: `EXIT ${exit.reason}` });
      } catch (e) {
        console.error('[NATIVE V2] EXIT failed, position remains live:', e.message);
      }
      return;
    }
  }

  if (!engine.position) {
    const candidate = engine.candidate(broker.latencyHeld());
    if (candidate) {
      try {
        const live = await broker.buy(candidate);
        engine.commitEntry(candidate, live);
        console.log(`[NATIVE V2] 🎯 ENTRY ${candidate.side} · ${candidate.appetite} · ${candidate.entryContext.entryMode} · speed ${candidate.entrySpeedScore}/100`);
        writeStatus({ lastEvent: `ENTRY ${candidate.side} ${candidate.appetite}` });
      } catch (e) {
        console.error('[NATIVE V2] ENTRY rejected:', e.message);
      }
    }
  }
  writeStatus();
}

async function main() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`Missing ${CREDS_PATH}`);
  broker = new DerivDemoBroker({ onForcedClose: forcedClose });
  await broker.verifyDemoAccount();
  await broker.connect();

  if (engine.position) {
    console.log('[NATIVE V2] persisted position found. Clearing local position because V2 owns one fresh Demo contract only.');
    engine.position = null;
    persistState();
  }

  feed = new PublicMarketFeed({
    onHistory: async rows => {
      engine.prime(rows);
      persistState();
      writeStatus({ lastEvent: `Primed ${rows.length} ticks` });
    },
    onTick: async (epoch, quote) => {
      tickChain = tickChain.then(() => processTick(epoch, quote)).catch(e => console.error('[NATIVE V2 TICK]', e.message));
      await tickChain;
    }
  });
  feed.connect();

  setInterval(() => {
    writeStatus({ heartbeat: now() });
    const s = statusEngine();
    console.log(`[NATIVE V2 MONEY] balance=${broker.account?.balance} · ${s.trades}T ${s.wins}W/${s.losses}L · Demo=${s.realized >= 0 ? '+' : ''}$${Number(s.realized).toFixed(2)} · speed=${s.speed?.score || 0}/100 ${s.speed?.label || ''} · appetite=${s.appetite} · latency=${broker.lastBuyLatencyMs || 0}ms`);
  }, 30000);

  console.log('====================================================');
  console.log(' SANI NATIVE VM V2 · SPEED IS RUNNING');
  console.log(' ONE BRAIN · ONE CONTRACT · ADAPTIVE APPETITE');
  console.log(' DIRECTION = LIBRA MOUNTAIN');
  console.log(' SPEED = VELOCITY + COHERENCE + ACCELERATION');
  console.log(' PROFIT PROTECTION = ACTUAL DERIV P/L FIRST');
  console.log(' PRE-ARM = SHADOW ONLY FOR NOW');
  console.log(' DERIV = DEMO ONLY · $1 MINIMUM · x160');
  console.log(' COMET / LAST MAN PUBLIC PAGES = UNTOUCHED');
  console.log('====================================================');
  writeStatus({ lastEvent: 'Native V2 Speed started' });
}

async function shutdown(signal) {
  console.log(`[NATIVE V2] ${signal}; saving state and closing sockets.`);
  persistState();
  writeStatus({ stoppedAt: now(), stopSignal: signal });
  feed?.close();
  broker?.close();
  setTimeout(() => process.exit(0), 150);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  console.error('[NATIVE V2 FATAL]', e.stack || e.message);
  try { writeStatus({ fatal: e.message, failedAt: now() }); } catch {}
  process.exit(1);
});
