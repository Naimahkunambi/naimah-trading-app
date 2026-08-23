import { SaniEngine, DEFAULT_CONFIG } from './core/engine.mjs';

const $ = id => document.getElementById(id);
const nowPerf = () => globalThis.performance?.now?.() ?? Date.now();

const LEDGER_KEY = 'sani.masterTrader.signalLedger.v6.5';
const OFFSET_KEY = 'sani.patternTrader.entryOffsets.v2';
const LONG = 200;
const AUTH = 80;
const FAST = 20;
const WAVE = 64;
const DURATION = 3;
const MIN_Q = 55;
const HARD_DAMAGE = 0.786;
const GOLDEN_MIN = 0.382;
const GOLDEN_MAX = 0.618;
const FIRE_MIN = 0.34;
const FIRE_MAX = 0.64;
const TOUCH_MAX_AGE = 3;

let accounts = [];
let selectedAccount = null;
let lastOtpContext = null;
let lastDiagnostics = null;
let lastSignalEpoch = 0;
let cooldownUntil = 0;
let ledger = load(LEDGER_KEY);
const contractToLedger = new Map();

const strategy = {
  session: 'NEUTRAL',
  candidate: 'NEUTRAL',
  candidateCount: 0,
  invalidation: 0,
  sessionId: 0
};

const engine = new SaniEngine({
  ...DEFAULT_CONFIG,
  symbol: '1HZ25V',
  stake: 1,
  duration: DURATION,
  durationUnit: 't',
  executionMethod: 'direct',
  oneOpenContract: true,
  takeProfit: 0,
  stopLoss: 0,
  maxTrades: 100,
  maxConsecutiveLosses: 0,
  cooldownTicks: 0,
  maxSignalToSendMs: 250,
  reconnect: true,
  maxReconnectAttempts: 8
});
engine.onTick = function pocketLockTick(tick) {
  this.lastTick = tick;
  this.ticksSeen += 1;
  this.emit();
};

function load(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function save() {
  ledger = ledger.slice(0, 5000);
  try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch {}
}
function symbol() { return $('obsSymbol')?.value?.trim() || '1HZ25V'; }
function ticks() {
  try {
    const rows = JSON.parse(localStorage.getItem(`sani.observatory.ticks.${symbol()}`) || '[]');
    return Array.isArray(rows)
      ? rows.map(x => ({ epoch: +x.epoch, quote: +x.quote }))
        .filter(x => Number.isFinite(x.epoch) && Number.isFinite(x.quote))
        .sort((a, b) => a.epoch - b.epoch)
      : [];
  } catch { return []; }
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function avgStep(p) {
  if (p.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < p.length; i += 1) s += Math.abs(p[i] - p[i - 1]);
  return s / (p.length - 1);
}
function eff(p) {
  if (p.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < p.length; i += 1) path += Math.abs(p[i] - p[i - 1]);
  return path ? Math.abs(p.at(-1) - p[0]) / path : 0;
}
function turns(p) {
  const signs = [];
  for (let i = 1; i < p.length; i += 1) {
    const d = p[i] - p[i - 1];
    if (d) signs.push(Math.sign(d));
  }
  if (signs.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < signs.length; i += 1) if (signs[i] !== signs[i - 1]) n += 1;
  return n / (signs.length - 1);
}
function linSlope(p) {
  const n = p.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(p);
  let num = 0, den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xm;
    num += dx * (p[i] - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}
function pivots(p, r = 2) {
  const highs = [], lows = [];
  for (let i = r; i < p.length - r; i += 1) {
    const left = p.slice(i - r, i);
    const right = p.slice(i + 1, i + r + 1);
    const hi = left.every(v => p[i] >= v) && right.every(v => p[i] >= v) && [...left, ...right].some(v => p[i] > v);
    const lo = left.every(v => p[i] <= v) && right.every(v => p[i] <= v) && [...left, ...right].some(v => p[i] < v);
    if (hi) highs.push({ i, quote: p[i] });
    if (lo) lows.push({ i, quote: p[i] });
  }
  return { highs, lows };
}
function struct(p, r = 3) {
  const x = pivots(p, r), h = x.highs.slice(-2), l = x.lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}
function metrics(rows, r = 3) {
  const p = rows.map(x => x.quote), step = avgStep(p), slope = linSlope(p);
  return {
    slopeNorm: step ? slope / step : 0,
    efficiency: eff(p),
    turnRate: turns(p),
    avgStep: step,
    net: p.at(-1) - p[0],
    structure: struct(p, r)
  };
}
function trend200(m) {
  const bull = [m.slopeNorm >= .055, m.efficiency >= .10, m.net > 0, m.structure === 'BULL'].filter(Boolean).length;
  const bear = [m.slopeNorm <= -.055, m.efficiency >= .10, m.net < 0, m.structure === 'BEAR'].filter(Boolean).length;
  if (bull >= 3 && m.slopeNorm > 0) return 'BULL';
  if (bear >= 3 && m.slopeNorm < 0) return 'BEAR';
  return 'NEUTRAL';
}
function trend80(m) {
  if (Math.abs(m.slopeNorm) < .078 || m.efficiency < .065) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0 && (m.structure === 'BULL' || m.slopeNorm >= .13)) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0 && (m.structure === 'BEAR' || m.slopeNorm <= -.13)) return 'BEAR';
  return 'NEUTRAL';
}
function fastTrend(m) {
  if (Math.abs(m.slopeNorm) < .07 || m.efficiency < .08) return 'NEUTRAL';
  return m.slopeNorm > 0 && m.net > 0 ? 'BULL' : m.slopeNorm < 0 && m.net < 0 ? 'BEAR' : 'NEUTRAL';
}
function chop(m80, m20) {
  const score = (
    clamp((.16 - m80.efficiency) / .16, 0, 1) +
    clamp((m80.turnRate - .49) / .25, 0, 1) +
    clamp((.065 - Math.abs(m80.slopeNorm)) / .065, 0, 1) +
    clamp((m20.turnRate - .66) / .2, 0, 1)
  ) / 4;
  return { score, isChop: score >= .68 };
}
function vol(m200, m80, m20) {
  const a = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const b = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (a < .40 || b < .50) return 'DEAD';
  if (a > 2.15 || m20.turnRate > .87) return 'CHAOTIC';
  return 'HEALTHY';
}

function updateSession(active, fast, isChop, volatility) {
  const authority = !isChop && volatility === 'HEALTHY' ? active : 'NEUTRAL';
  if (strategy.session === 'NEUTRAL') {
    const candidate = authority !== 'NEUTRAL' ? authority : fast;
    if (candidate === 'NEUTRAL') {
      strategy.candidate = 'NEUTRAL';
      strategy.candidateCount = 0;
      return;
    }
    if (strategy.candidate === candidate) strategy.candidateCount += 1;
    else { strategy.candidate = candidate; strategy.candidateCount = 1; }
    if (strategy.candidateCount >= 2) {
      strategy.session = candidate;
      strategy.sessionId += 1;
      strategy.invalidation = 0;
    }
    return;
  }
  if (authority === strategy.session || (authority === 'NEUTRAL' && fast === strategy.session)) {
    strategy.invalidation = 0;
    return;
  }
  strategy.invalidation += authority !== 'NEUTRAL' && authority !== strategy.session ? 2 : 1;
  if (strategy.invalidation >= 3) {
    const replacement = authority !== 'NEUTRAL' ? authority : fast;
    strategy.session = replacement !== strategy.session ? replacement : 'NEUTRAL';
    strategy.sessionId += 1;
    strategy.candidate = 'NEUTRAL';
    strategy.candidateCount = 0;
    strategy.invalidation = 0;
  }
}

function liveWave(rows, direction) {
  const p = rows.map(x => x.quote), step = avgStep(p) || 1, x = pivots(p, 2);
  if (direction === 'BULL') {
    for (const low of [...x.lows].reverse()) {
      const future = p.slice(low.i + 1);
      if (future.length < 3) continue;
      const high = Math.max(...future), i = low.i + 1 + future.indexOf(high);
      if (high - low.quote >= step * 3.2 && i - low.i >= 3) return waveFrom(rows, direction, low, { i, quote: high }, step);
    }
  } else if (direction === 'BEAR') {
    for (const high of [...x.highs].reverse()) {
      const future = p.slice(high.i + 1);
      if (future.length < 3) continue;
      const low = Math.min(...future), i = high.i + 1 + future.indexOf(low);
      if (high.quote - low >= step * 3.2 && i - high.i >= 3) return waveFrom(rows, direction, high, { i, quote: low }, step);
    }
  }
  return null;
}
function waveFrom(rows, direction, start, end, step) {
  const p = rows.map(x => x.quote);
  const range = direction === 'BULL' ? end.quote - start.quote : start.quote - end.quote;
  if (!(range > 0)) return null;
  const after = p.slice(end.i + 1), current = p.at(-1);
  const retraces = after.map(v => direction === 'BULL' ? (end.quote - v) / range : (v - end.quote) / range);
  const maxRetrace = retraces.length ? Math.max(...retraces) : 0;
  const currentRetrace = direction === 'BULL' ? (end.quote - current) / range : (current - end.quote) / range;
  return { direction, start, end, step, range, retraces, maxRetrace, currentRetrace };
}
function fibPrice(w, ratio) {
  return w.direction === 'BULL' ? w.end.quote - w.range * ratio : w.end.quote + w.range * ratio;
}
function keyFor(w, rows) {
  return w ? `${strategy.sessionId}:${w.direction}:${rows[w.start.i]?.epoch}` : '';
}
function traded(key) {
  return ledger.some(r => r.waveKey === key && Number.isFinite(+r.contractId));
}
function pocketTouch(w) {
  if (!w?.retraces?.length) return { touched: false, zone: 'NONE', age: Infinity, touchRatio: 0 };
  let idx = -1, ratio = 0;
  for (let i = 0; i < w.retraces.length; i += 1) {
    const r = w.retraces[i];
    if (r >= GOLDEN_MIN && r <= GOLDEN_MAX) { idx = i; ratio = r; }
  }
  return { touched: idx >= 0, zone: idx >= 0 ? 'GOLDEN' : 'NONE', age: idx >= 0 ? w.retraces.length - 1 - idx : Infinity, touchRatio: ratio };
}
function microTurn(rows, direction, step) {
  const p = rows.map(x => x.quote), n = p.length;
  if (n < 4) return { ok: false, strength: 0, kind: 'NONE' };
  const c = p[n - 1], a = p[n - 2], b = p[n - 3], d = p[n - 4];
  const strength = Math.abs(c - a) / (step || 1);
  if (direction === 'BULL') {
    const turn = c > a && a <= b && c - a >= step * .08;
    const break2 = c > a && c > b && c - a >= step * .14;
    return { ok: turn || break2, strength, kind: turn ? 'TURN' : break2 ? 'BREAK2' : 'NONE' };
  }
  if (direction === 'BEAR') {
    const turn = c < a && a >= b && a - c >= step * .08;
    const break2 = c < a && c < b && a - c >= step * .14;
    return { ok: turn || break2, strength, kind: turn ? 'TURN' : break2 ? 'BREAK2' : 'NONE' };
  }
  return { ok: false, strength: 0, kind: 'NONE' };
}
function phase(w, touch, turn) {
  if (!w) return 'SEARCHING';
  if (w.maxRetrace > HARD_DAMAGE) return 'REANCHOR';
  if (w.currentRetrace < 0) return 'EXTENDING';
  if (!touch.touched) return w.maxRetrace < GOLDEN_MIN ? 'RETRACE' : 'ARMING';
  if (touch.age > TOUCH_MAX_AGE) return 'REANCHOR';
  if (w.currentRetrace < FIRE_MIN) return 'NO_CHASE';
  if (w.currentRetrace > FIRE_MAX) return 'TOO_DEEP';
  if (turn.ok) return 'SNIPER';
  return 'POCKET';
}
function qScore(d) {
  let q = 0;
  const r = d.wave.currentRetrace;
  if (r >= GOLDEN_MIN && r <= GOLDEN_MAX) q += 34;
  else if (r >= FIRE_MIN && r < GOLDEN_MIN) q += 22;
  else q -= 25;
  q += d.m80.efficiency >= .18 ? 17 : d.m80.efficiency >= .11 ? 11 : 6;
  const slope = Math.abs(d.m80.slopeNorm);
  q += slope >= .20 ? 14 : slope >= .12 ? 10 : 5;
  q += d.turn.strength >= .60 ? 16 : d.turn.strength >= .25 ? 11 : 6;
  q += d.chopScore <= .20 ? 10 : d.chopScore <= .38 ? 6 : 0;
  if (d.regime200 === d.session) q += 4;
  if (d.fast === d.session) q += 6;
  if (d.touch.age === 0) q += 8;
  else if (d.touch.age === 1) q += 5;
  else if (d.touch.age >= 3) q -= 8;
  if (d.wave.maxRetrace > .70) q -= 20;
  return clamp(Math.round(q), 0, 100);
}

function evaluate(snapshot) {
  const all = ticks();
  if (all.length < LONG) return { ready: false, reason: `Need ${LONG} ticks (${all.length}/${LONG})`, phase: 'WARMING', rows: all };
  const r200 = all.slice(-LONG), r80 = all.slice(-AUTH), r20 = all.slice(-FAST);
  let waveRows = all.slice(-WAVE);
  const m200 = metrics(r200, 4), m80 = metrics(r80, 3), m20 = metrics(r20, 2);
  const regime200 = trend200(m200), active80 = trend80(m80), fast = fastTrend(m20);
  const c = chop(m80, m20), volatility = vol(m200, m80, m20);
  updateSession(active80, fast, c.isChop, volatility);
  const session = strategy.session;
  let wave = session === 'BULL' || session === 'BEAR' ? liveWave(waveRows, session) : null;
  let touch = pocketTouch(wave);
  let turn = microTurn(r20, session, wave?.step || m20.avgStep || 1);
  let ph = phase(wave, touch, turn);
  let key = keyFor(wave, waveRows);

  if (wave && (ph === 'REANCHOR' || ph === 'NO_CHASE')) {
    for (const width of [42, 30, 24]) {
      const tight = all.slice(-width), next = liveWave(tight, session);
      if (!next) continue;
      const nextTouch = pocketTouch(next), nextTurn = microTurn(r20, session, next.step || m20.avgStep || 1), nextPhase = phase(next, nextTouch, nextTurn);
      if (nextPhase !== 'REANCHOR' && nextPhase !== 'NO_CHASE') {
        waveRows = tight;
        wave = next;
        touch = nextTouch;
        turn = nextTurn;
        ph = nextPhase;
        key = keyFor(wave, waveRows);
        break;
      }
    }
  }

  const duplicate = traded(key);
  const q = wave ? qScore({ wave, touch, turn, m80, chopScore: c.score, regime200, session, fast }) : 0;
  const permission = session !== 'NEUTRAL' && (active80 === session || (active80 === 'NEUTRAL' && fast === session));
  const inFireWindow = Boolean(wave && wave.currentRetrace >= FIRE_MIN && wave.currentRetrace <= FIRE_MAX);
  const ready = Boolean(
    permission && !c.isChop && volatility === 'HEALTHY' && wave &&
    wave.maxRetrace <= HARD_DAMAGE && touch.touched && touch.age <= TOUCH_MAX_AGE &&
    inFireWindow && turn.ok && q >= MIN_Q && !duplicate
  );

  let reason = 'Scanning live waves';
  if (c.isChop) reason = `CHOP veto ${(c.score * 100).toFixed(0)}%`;
  else if (volatility !== 'HEALTHY') reason = `Volatility ${volatility}`;
  else if (session === 'NEUTRAL') reason = `No active session · 80 ${active80} · FAST ${fast}`;
  else if (active80 === 'NEUTRAL' && fast !== session) reason = `80 neutral; FAST does not support ${session}`;
  else if (!wave) reason = 'Building fresh live impulse';
  else if (wave.maxRetrace > HARD_DAMAGE) reason = 'Wave damaged; rolling anchor';
  else if (!touch.touched) reason = `Retrace ${(wave.maxRetrace * 100).toFixed(1)}% · waiting for 38.2–61.8% pocket`;
  else if (touch.age > TOUCH_MAX_AGE) reason = 'Pocket touch stale; rolling anchor';
  else if (wave.currentRetrace < FIRE_MIN) reason = `NO CHASE · price escaped pocket to ${(wave.currentRetrace * 100).toFixed(1)}%`;
  else if (wave.currentRetrace > FIRE_MAX) reason = `Too deep at ${(wave.currentRetrace * 100).toFixed(1)}% · wait/re-anchor`;
  else if (!turn.ok) reason = `ARMED ${(wave.currentRetrace * 100).toFixed(1)}% · waiting first micro turn`;
  else if (q < MIN_Q) reason = `Turn confirmed but Q${q} below ${MIN_Q}`;
  else if (duplicate) reason = 'Wave already traded; waiting next wave';
  else if (ready) reason = `POCKET LOCK + ${turn.kind} · FIRE NOW`;

  return {
    ready, reason, rows: all, waveRows, epoch: all.at(-1).epoch, quote: all.at(-1).quote,
    regime200, active80, fast, session, phase: ph,
    chop: c.isChop, chopScore: c.score, volatility,
    m200, m80, m20, wave, touch, turn, waveKey: key, quality: q, inFireWindow
  };
}

function offsets() { return load(OFFSET_KEY).map(Number).filter(Number.isFinite).slice(-50); }
function offsetEstimate() {
  const a = offsets().map(v => Math.max(1, Math.min(10, Math.round(v)))).sort((a, b) => a - b);
  if (!a.length) return 1;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
function recordOffset(v) {
  if (!Number.isFinite(+v)) return;
  const a = offsets();
  a.push(Math.max(1, Math.min(10, Math.round(+v))));
  try { localStorage.setItem(OFFSET_KEY, JSON.stringify(a.slice(-50))); } catch {}
}
function actualOffset(t) {
  const s = +t?.signalEpoch, e = +t?.entryTickTime;
  if (Number.isFinite(s) && Number.isFinite(e)) return Math.max(1, Math.round(e - s));
  const st = +t?.startTime;
  if (Number.isFinite(s) && Number.isFinite(st)) return Math.max(1, Math.round(st - s) + 1);
}
function latency(o) {
  o = +o;
  return !Number.isFinite(o) ? 'UNKNOWN' : o <= 1 ? 'CLEAN' : o === 2 ? 'LATE +1' : 'LATE +2+';
}
function makeSignal(snapshot, d) {
  if (!d.ready) return null;
  const off = +(snapshot?.executionOffset ?? offsetEstimate());
  return {
    symbol: symbol(), epoch: +(snapshot?.epoch ?? d.epoch), quote: +(snapshot?.quote ?? d.quote),
    direction: d.session === 'BULL' ? 'CALL' : 'PUT', session: d.session, phase: d.phase,
    waveKey: d.waveKey, fibZone: 'POCKET_LOCK', fibTouch: d.touch.touchRatio,
    fibMaxRetrace: d.wave.maxRetrace, fibEntryRetrace: d.wave.currentRetrace,
    quality: d.quality, turnKind: d.turn.kind, turnStrength: d.turn.strength,
    regime200: d.regime200, active80: d.active80, fast: d.fast,
    slope200: d.m200.slopeNorm, slope80: d.m80.slopeNorm, efficiency80: d.m80.efficiency,
    chopScore: d.chopScore, volatility: d.volatility,
    waveStart: d.wave.start.quote, waveEnd: d.wave.end.quote, waveStep: d.wave.step,
    targetPrice: d.wave.end.quote, invalidationPrice: fibPrice(d.wave, HARD_DAMAGE),
    executionOffset: off
  };
}
function ensureRow(s) {
  const key = `${s.symbol}:${s.epoch}:${s.waveKey}`;
  let row = ledger.find(x => x.signalKey === key);
  if (row) return row;
  row = {
    id: `mt65-${s.epoch}-${Date.now()}`, cohort: 'v6.5-pocket-lock-sniper', signalKey: key,
    observedAt: Date.now(), ...s,
    expectedWindow: `T+${s.executionOffset}→T+${s.executionOffset + DURATION}`,
    status: 'QUALIFIED'
  };
  ledger.unshift(row);
  save();
  return row;
}
function patchRow(id, patch) {
  const row = ledger.find(x => x.id === id);
  if (row) { Object.assign(row, patch, { updatedAt: Date.now() }); save(); }
}
function bought() { return ledger.filter(r => Number.isFinite(+r.contractId)).length; }
function cohort() {
  const a = ledger.filter(r => r.status === 'WON' || r.status === 'LOST');
  const wins = a.filter(r => r.status === 'WON').length, losses = a.filter(r => r.status === 'LOST').length;
  const pnl = a.reduce((s, r) => s + (+r.profit || 0), 0);
  const bull = a.filter(r => r.session === 'BULL'), bear = a.filter(r => r.session === 'BEAR');
  return {
    wins, losses, pnl,
    bullW: bull.filter(r => r.status === 'WON').length,
    bullL: bull.filter(r => r.status === 'LOST').length,
    bearW: bear.filter(r => r.status === 'WON').length,
    bearL: bear.filter(r => r.status === 'LOST').length
  };
}
function pathStats(meta, trade) {
  const start = +trade?.entryTickTime, end = +trade?.exitTickTime, entry = +trade?.entrySpot;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(entry)) return {};
  const path = ticks().filter(x => x.epoch >= start && x.epoch <= end).map(x => x.quote);
  if (!path.length) return {};
  const max = Math.max(...path), min = Math.min(...path), call = meta?.direction === 'CALL';
  const mfe = call ? max - entry : entry - min;
  const mae = call ? entry - min : max - entry;
  const target = +meta?.targetPrice;
  const targetTouched = Number.isFinite(target) ? (call ? max >= target : min <= target) : false;
  return { mfe, mae, targetTouched, pathTicks: path.length, pathHigh: max, pathLow: min };
}

function traderConfig() {
  const c = {
    ...engine.config, symbol: symbol(), stake: +$('ptStake').value,
    takeProfit: +$('ptTakeProfit').value, stopLoss: +$('ptStopLoss').value,
    maxTrades: +$('ptMaxTrades').value, duration: DURATION, durationUnit: 't',
    executionMethod: 'direct', oneOpenContract: true, maxSignalToSendMs: 250,
    currency: selectedAccount?.currency || 'USD', reconnect: true, maxReconnectAttempts: 8
  };
  if (!(c.stake > 0)) throw new Error('Stake must be greater than 0.');
  if (!engine.snapshot().running) engine.setConfig(c);
  return c;
}
function auth() {
  const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim(), accountId = $('ptAccount').value;
  selectedAccount = accounts.find(a => a.account_id === accountId) || null;
  if (!appId || !token) throw new Error('App ID and trade token are required.');
  if (!selectedAccount) throw new Error('Load and select a Deriv Options account.');
  if (String(selectedAccount.account_type).toLowerCase() === 'real') throw new Error('Master v6.5 is Demo-only.');
  return { appId, token, accountId };
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store'
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `API ${response.status}`);
  return json;
}
async function freshWs() {
  const data = await api('otp', lastOtpContext || auth());
  if (!data.url) throw new Error('OTP response missing WebSocket URL.');
  return data.url;
}
function err(message) { $('traderError').textContent = message; $('traderError').classList.remove('hidden'); }
function clearErr() { $('traderError').textContent = ''; $('traderError').classList.add('hidden'); }
function accountsUI() {
  const select = $('ptAccount');
  select.innerHTML = accounts.length ? '' : '<option value="">No accounts found</option>';
  for (const a of accounts) {
    const o = document.createElement('option');
    o.value = a.account_id;
    o.textContent = `${String(a.account_type).toUpperCase()} · ${a.account_id} · ${a.currency} ${a.balance}`;
    select.appendChild(o);
  }
  const saved = localStorage.getItem('sani.deriv.accountId');
  if (saved && accounts.some(a => a.account_id === saved)) select.value = saved;
  if (!select.value || String(accounts.find(a => a.account_id === select.value)?.account_type).toLowerCase() === 'real') {
    const demo = accounts.find(a => String(a.account_type).toLowerCase() !== 'real');
    if (demo) select.value = demo.account_id;
  }
  selectedAccount = accounts.find(a => a.account_id === select.value) || null;
  gate();
}
function gate() {
  selectedAccount = accounts.find(a => a.account_id === $('ptAccount').value) || null;
  const real = String(selectedAccount?.account_type || '').toLowerCase() === 'real';
  $('ptRealGate').classList.toggle('hidden', !real);
  $('ptAccountPill').textContent = selectedAccount ? String(selectedAccount.account_type).toUpperCase() : 'NO ACCOUNT';
  $('ptConnect').disabled = !selectedAccount || real;
}

function trade(snapshot) {
  const d = evaluate(snapshot);
  lastDiagnostics = d;
  renderState(d);
  draw();
  renderLedger();
  const s = makeSignal(snapshot, d);
  if (!s) return;
  const row = ensureRow(s), state = engine.snapshot();
  if (s.epoch <= lastSignalEpoch) return;
  if (Date.now() - Number(snapshot.at || 0) > 2500) return patchRow(row.id, { status: 'SKIP STALE' });
  if (state.safeBlocked) return patchRow(row.id, { status: 'SKIP SAFE PAUSE' });
  if (!state.running) return patchRow(row.id, { status: state.connected ? 'OBSERVED' : 'SKIP DISCONNECTED' });
  if (bought() >= +($('ptMaxTrades').value || 100)) {
    patchRow(row.id, { status: 'SKIP COHORT COMPLETE' });
    engine.pause();
    return;
  }
  const cd = +($('ptCooldown').value || 1);
  if (s.epoch < cooldownUntil) return patchRow(row.id, { status: 'SKIP COOLDOWN' });
  if (state.pendingTrade || state.openContracts > 0) return patchRow(row.id, { status: 'SKIP OPEN' });
  try {
    traderConfig();
    lastSignalEpoch = s.epoch;
    cooldownUntil = s.epoch + cd;
    patchRow(row.id, { status: 'ORDER SENT' });
    engine.execute({
      direction: s.direction, structure: 'master-v6.5-pocket-lock-sniper',
      epoch: s.epoch, quote: s.quote, detectedPerf: nowPerf(), detectedWallMs: Date.now(),
      patternMeta: { ...s, ledgerId: row.id, expectedWindow: row.expectedWindow }
    });
    engine.log('success', `MASTER v6.5 FIRE ${s.session} ${s.direction} · LOCK ${(s.fibEntryRetrace * 100).toFixed(1)}% · ${s.turnKind} · Q${s.quality}`);
  } catch (e) {
    patchRow(row.id, { status: 'ERROR', error: e.message });
    err(e.message);
    engine.pause();
  }
}

function esc(v) {
  return String(v ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}
function renderState(d) {
  const set = (id, value) => { if ($(id)) $(id).textContent = value; };
  set('mtRegime200', d?.regime200 || '—');
  set('mtTrend80', d ? `${d.active80}${d.active80 === 'NEUTRAL' && d.fast !== 'NEUTRAL' ? ' · FAST ' + d.fast : ''}` : '—');
  set('mtSession', d?.session && d.session !== 'NEUTRAL' ? `${d.session} · ${d.phase}` : 'NEUTRAL');
  if (!d?.wave) set('mtEntry20', 'SEARCH');
  else if (d.ready) set('mtEntry20', `FIRE ${(d.wave.currentRetrace * 100).toFixed(0)}%`);
  else if (d.phase === 'NO_CHASE') set('mtEntry20', 'NO CHASE');
  else if (d.touch?.touched) set('mtEntry20', `ARMED ${(d.wave.currentRetrace * 100).toFixed(0)}%`);
  else set('mtEntry20', 'WAIT');
  set('mtChop', d ? `${d.chop ? 'VETO' : 'CLEAR'} · ${(d.chopScore * 100).toFixed(0)}%` : '—');
  set('mtVolatility', d?.volatility || '—');
  if (!d || !d.ready) {
    const retrace = d?.wave ? ` · NOW ${(d.wave.currentRetrace * 100).toFixed(1)}%` : '';
    $('ptSignal').innerHTML = `<b>WAIT · ${esc(d?.phase || 'SEARCHING')}</b><span>${esc(d?.reason || 'Scanning')}${retrace}</span>`;
  } else {
    $('ptSignal').innerHTML = `<b class="${d.session === 'BULL' ? 'positive' : 'negative'}">POCKET LOCK · ${d.session === 'BULL' ? 'CALL' : 'PUT'} · Q${d.quality}</b><span>entry ${(d.wave.currentRetrace * 100).toFixed(1)}% · ${d.turn.kind} · no chase</span>`;
  }
}
function renderLedger() {
  const s = cohort();
  $('ptQualified').textContent = String(ledger.length);
  $('ptSkipped').textContent = String(ledger.filter(r => String(r.status).startsWith('SKIP')).length);
  $('ptBought').textContent = String(bought());
  $('ptEntryOffset').textContent = `T+${offsetEstimate()}`;
  $('ptCohortN').textContent = String(s.wins + s.losses);
  $('ptCohortWL').textContent = `${s.wins} / ${s.losses}`;
  $('ptCohortPnl').textContent = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  $('ptBullWL').textContent = `${s.bullW} / ${s.bullL}`;
  $('ptBearWL').textContent = `${s.bearW} / ${s.bearL}`;
  $('ptLedgerRows').innerHTML = ledger.length ? ledger.slice(0, 100).map(r => {
    const tm = new Date(r.observedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const window = r.actualWindow ? `${r.expectedWindow} → ${r.actualWindow}` : r.expectedWindow;
    const entry = `${r.turnKind || '—'} · Q${r.quality ?? '—'} · ${(Number(r.fibEntryRetrace || 0) * 100).toFixed(0)}%`;
    return `<tr><td>${tm}</td><td>${esc(`${r.session || '—'} · ${r.phase || '—'}`)}</td><td>${r.direction || '—'}</td><td>${esc(entry)}</td><td>${Number.isFinite(+r.slope200) ? (+r.slope200).toFixed(3) : '—'}</td><td>${Number.isFinite(+r.slope80) ? (+r.slope80).toFixed(3) : '—'}</td><td>${Number.isFinite(+r.chopScore) ? (+r.chopScore * 100).toFixed(0) + '%' : '—'}</td><td>${r.volatility || '—'}</td><td>${window || '—'}</td><td>${r.latencyClass || '—'}</td><td>${r.status || '—'}${Number.isFinite(+r.mfe) ? ` · MFE ${(+r.mfe).toFixed(1)} / MAE ${(+r.mae).toFixed(1)}` : ''}</td><td>${r.contractId ? '#' + r.contractId : '—'}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.5 pocket-lock setups yet.</td></tr>';
}
function exportCsv() {
  const headers = ['cohort','observed_at','symbol','epoch','quote','session','phase','direction','wave_key','fib_touch','fib_entry_retrace','quality','turn_kind','turn_strength','regime_200','active_80','fast','slope_200','slope_80','efficiency_80','chop_score','volatility','target_price','invalidation_price','expected_window','status','contract_id','profit','actual_window','latency_class','entry_spot','exit_spot','mfe','mae','target_touched','path_ticks','path_high','path_low'];
  const rows = ledger.map(r => [r.cohort,new Date(r.observedAt).toISOString(),r.symbol,r.epoch,r.quote,r.session,r.phase,r.direction,r.waveKey,r.fibTouch,r.fibEntryRetrace,r.quality,r.turnKind,r.turnStrength,r.regime200,r.active80,r.fast,r.slope200,r.slope80,r.efficiency80,r.chopScore,r.volatility,r.targetPrice,r.invalidationPrice,r.expectedWindow,r.status,r.contractId??'',r.profit??'',r.actualWindow??'',r.latencyClass??'',r.entrySpot??'',r.exitSpot??'',r.mfe??'',r.mae??'',r.targetTouched??'',r.pathTicks??'',r.pathHigh??'',r.pathLow??'']);
  const csv = [headers, ...rows].map(a => a.map(v => `"${String(v ?? '').replaceAll('"','""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' })), a = document.createElement('a');
  a.href = url;
  a.download = `master-v6.5-pocket-lock-${new Date().toISOString().replaceAll(':','-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}
function scale(ctx, canvas) {
  const dpr = Math.max(1, devicePixelRatio || 1), rect = canvas.getBoundingClientRect();
  const w = Math.max(300, rect.width || canvas.width), h = Math.max(180, rect.height || canvas.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
function draw() {
  const canvas = $('masterCanvas');
  if (!canvas) return;
  const rows = ticks().slice(-220), ctx = canvas.getContext('2d'), { w, h } = scale(ctx, canvas);
  ctx.clearRect(0, 0, w, h);
  const d = lastDiagnostics, session = d?.session || 'NEUTRAL';
  ctx.fillStyle = session === 'BULL' ? 'rgba(61,191,126,.05)' : session === 'BEAR' ? 'rgba(235,87,87,.05)' : 'rgba(146,153,168,.025)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(146,153,168,.10)';
  for (let x = 0; x <= w; x += w / 8) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
  for (let y = 0; y <= h; y += h / 5) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  if (rows.length < 2) return;
  const prices = rows.map(x => x.quote), min = Math.min(...prices), max = Math.max(...prices), span = max - min || 1;
  const xFor = epoch => 12 + (epoch - rows[0].epoch) / Math.max(1, rows.at(-1).epoch - rows[0].epoch) * (w - 24);
  const yFor = price => h - 18 - (price - min) / span * (h - 36);
  ctx.strokeStyle = 'rgba(215,220,229,.72)'; ctx.lineWidth = 1.5; ctx.beginPath();
  rows.forEach((t,i) => { const x = 12 + i / (rows.length - 1) * (w - 24), y = yFor(t.quote); i ? ctx.lineTo(x,y) : ctx.moveTo(x,y); });
  ctx.stroke();

  const nowRetrace = d?.wave ? d.wave.currentRetrace * 100 : null;
  ctx.fillStyle = 'rgba(245,247,250,.88)'; ctx.font = '12px system-ui';
  ctx.fillText(`200 ${d?.regime200 || '—'}   80 ${d?.active80 || '—'}   FAST ${d?.fast || '—'}   ${session}   ${d?.phase || '—'}   ${Number.isFinite(nowRetrace) ? 'NOW '+nowRetrace.toFixed(1)+'%' : ''}   Q${d?.quality || 0}`, 16, 22);

  if (d?.wave && d?.waveRows) {
    const se = d.waveRows[d.wave.start.i]?.epoch, ee = d.waveRows[d.wave.end.i]?.epoch;
    if (Number.isFinite(se) && Number.isFinite(ee)) {
      const sx = xFor(se), ex = xFor(ee), sy = yFor(d.wave.start.quote), ey = yFor(d.wave.end.quote);
      ctx.strokeStyle = 'rgba(230,195,92,.82)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.fillStyle = '#e6c35c';
      for (const [x,y] of [[sx,sy],[ex,ey]]) { ctx.beginPath(); ctx.arc(x,y,4,0,Math.PI*2); ctx.fill(); }

      const fireTop = yFor(fibPrice(d.wave, FIRE_MIN)), fireBottom = yFor(fibPrice(d.wave, FIRE_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.14)';
      ctx.fillRect(ex, Math.min(fireTop, fireBottom), Math.max(0, w - 12 - ex), Math.abs(fireBottom - fireTop));
      const goldenTop = yFor(fibPrice(d.wave, GOLDEN_MIN)), goldenBottom = yFor(fibPrice(d.wave, GOLDEN_MAX));
      ctx.fillStyle = 'rgba(230,195,92,.09)';
      ctx.fillRect(ex, Math.min(goldenTop, goldenBottom), Math.max(0, w - 12 - ex), Math.abs(goldenBottom - goldenTop));

      for (const [ratio,label] of [[.236,'23.6'],[FIRE_MIN,'FIRE 34'],[.382,'38.2'],[.5,'50'],[.618,'61.8'],[FIRE_MAX,'FIRE 64'],[.786,'78.6 INVALID']]) {
        const y = yFor(fibPrice(d.wave, ratio));
        ctx.strokeStyle = ratio === .786 ? 'rgba(255,116,116,.65)' : (ratio === FIRE_MIN || ratio === FIRE_MAX) ? 'rgba(255,215,105,.9)' : 'rgba(230,195,92,.34)';
        ctx.lineWidth = ratio === FIRE_MIN || ratio === FIRE_MAX ? 1.4 : .8;
        ctx.setLineDash(ratio === .786 ? [4,4] : []);
        ctx.beginPath(); ctx.moveTo(ex,y); ctx.lineTo(w - 12,y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = ratio === .786 ? 'rgba(255,116,116,.9)' : 'rgba(230,195,92,.92)';
        ctx.font = '10px system-ui'; ctx.fillText(label + (String(label).includes('FIRE') || String(label).includes('INVALID') ? '' : '%'), w - 72, y - 3);
      }

      const currentY = yFor(rows.at(-1).quote);
      ctx.strokeStyle = d.ready ? '#67d99a' : d.phase === 'NO_CHASE' ? '#ff7474' : 'rgba(245,247,250,.35)';
      ctx.lineWidth = 1; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(Math.max(ex, w - 190), currentY); ctx.lineTo(w - 12, currentY); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = d.ready ? '#67d99a' : d.phase === 'NO_CHASE' ? '#ff7474' : 'rgba(245,247,250,.85)';
      ctx.beginPath(); ctx.arc(w - 16, currentY, 4, 0, Math.PI * 2); ctx.fill();
      ctx.font = '11px system-ui';
      ctx.fillText(d.ready ? 'FIRE NOW' : d.phase === 'NO_CHASE' ? 'NO CHASE' : d.touch?.touched ? 'ARMED' : 'WAIT POCKET', w - 125, Math.max(36, currentY - 8));
    }
  }

  const recent = rows.slice(-20), pp = pivots(recent.map(x => x.quote), 2);
  const label = (arr, type) => {
    let previous;
    for (const q of arr.slice(-3)) {
      const text = previous === undefined ? type : type === 'H' ? (q.quote > previous ? 'HH' : 'LH') : (q.quote > previous ? 'HL' : 'LL');
      previous = q.quote;
      const t = recent[q.i];
      if (t) { ctx.fillStyle = 'rgba(245,247,250,.88)'; ctx.font = '11px system-ui'; ctx.fillText(text, xFor(t.epoch)+4, yFor(t.quote)+(type === 'H' ? -7 : 14)); }
    }
  };
  label(pp.highs, 'H'); label(pp.lows, 'L');

  const visibleStart = rows[0].epoch, visibleEnd = rows.at(-1).epoch;
  for (const r of ledger.filter(r => !Number.isFinite(+r.contractId) && +r.epoch >= visibleStart && +r.epoch <= visibleEnd)) {
    const x = xFor(+r.epoch), y = yFor(+r.quote);
    ctx.strokeStyle = r.direction === 'CALL' ? 'rgba(103,217,154,.7)' : 'rgba(255,116,116,.7)';
    ctx.strokeRect(x - 4, y - 4, 8, 8);
  }
  for (const r of ledger.filter(r => Number.isFinite(+r.contractId) && Number(r.entryTickTime ?? r.epoch) >= visibleStart && Number(r.entryTickTime ?? r.epoch) <= visibleEnd)) {
    const ep = Number(r.entryTickTime ?? r.epoch), price = Number(r.entrySpot ?? r.quote);
    const x = xFor(ep), y = yFor(price), call = r.direction === 'CALL';
    ctx.fillStyle = call ? '#67d99a' : '#ff7474';
    ctx.beginPath();
    if (call) { ctx.moveTo(x,y-10); ctx.lineTo(x-6,y+5); ctx.lineTo(x+6,y+5); }
    else { ctx.moveTo(x,y+10); ctx.lineTo(x-6,y-5); ctx.lineTo(x+6,y-5); }
    ctx.closePath(); ctx.fill();
    ctx.font = '10px system-ui'; ctx.fillText('E', x + 7, y - 7);
    const ee = +r.exitTickTime, xp = +r.exitSpot;
    if (Number.isFinite(ee) && Number.isFinite(xp) && ee >= visibleStart && ee <= visibleEnd) {
      const ex = xFor(ee), ey = yFor(xp);
      ctx.strokeStyle = r.status === 'WON' ? '#67d99a' : '#ff7474'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(ex,ey); ctx.stroke();
      ctx.beginPath(); ctx.arc(ex,ey,5,0,Math.PI*2); ctx.stroke();
      ctx.fillStyle = r.status === 'WON' ? '#67d99a' : '#ff7474'; ctx.font = '10px system-ui';
      ctx.fillText(`X ${Number(r.profit || 0) >= 0 ? '+' : ''}${Number(r.profit || 0).toFixed(2)}`, ex + 7, ey - 7);
    }
  }
  $('masterCanvasCaption').textContent = `${session} · ${d?.phase || 'SEARCHING'} · POCKET LOCK 34–64% · gold core 38.2–61.8% · red 78.6%=invalid · ${rows.length} ticks`;
}

const baseBuy = engine.onBuy.bind(engine);
engine.onBuy = function onPocketBuy(message) {
  const pending = this.pending.get(Number(message.req_id));
  const meta = pending?.signal?.patternMeta ? { ...pending.signal.patternMeta } : null;
  baseBuy(message);
  const id = Number(message?.buy?.contract_id), trade = this.trades.find(x => Number(x.contractId) === id);
  if (!trade || !meta) return;
  trade.patternMeta = meta;
  trade.ledgerId = meta.ledgerId;
  trade.expectedWindow = meta.expectedWindow;
  contractToLedger.set(id, meta.ledgerId);
  patchRow(meta.ledgerId, { status:'BOUGHT', contractId:id, buyAckMs:trade.sendToAckMs });
  this.emit();
};
const baseContract = engine.onContract.bind(engine);
engine.onContract = function onPocketContract(contract) {
  const id = Number(contract?.contract_id);
  baseContract(contract);
  const trade = this.trades.find(x => Number(x.contractId) === id);
  if (!trade?.patternMeta || !(contract?.is_sold || contract?.is_expired)) return;
  const o = actualOffset(trade);
  if (!trade.offsetRecorded && Number.isFinite(o)) { trade.offsetRecorded = true; recordOffset(o); }
  trade.actualWindow = Number.isFinite(o) ? `T+${o}→T+${o + DURATION}` : 'unknown';
  trade.latencyClass = latency(o);
  const path = pathStats(trade.patternMeta, trade);
  patchRow(trade.ledgerId || contractToLedger.get(id), {
    status: String(trade.status || 'sold').toUpperCase(), profit: trade.profit,
    actualWindow: trade.actualWindow, latencyClass: trade.latencyClass,
    entrySpot: trade.entrySpot, exitSpot: trade.exitSpot,
    entryTickTime: trade.entryTickTime, exitTickTime: trade.exitTickTime,
    ...path
  });
  draw();
  this.emit();
};

$('ptLoadAccounts').onclick = async () => {
  clearErr();
  try {
    const appId = $('ptAppId').value.trim(), token = $('ptToken').value.trim();
    if (!appId || !token) throw new Error('App ID and trade token are required.');
    $('ptLoadAccounts').disabled = true;
    const data = await api('accounts', { appId, token });
    accounts = data.accounts || [];
    localStorage.setItem('sani.deriv.appId', appId);
    sessionStorage.setItem('sani.deriv.token', token);
    accountsUI();
  } catch (e) { err(e.message); }
  finally { $('ptLoadAccounts').disabled = false; }
};
$('ptAccount').onchange = () => { localStorage.setItem('sani.deriv.accountId', $('ptAccount').value); lastOtpContext = null; gate(); };
$('ptConnect').onclick = async () => {
  clearErr();
  try { traderConfig(); lastOtpContext = auth(); $('ptConnect').disabled = true; await engine.connect(freshWs); }
  catch (e) { err(e.message); }
  finally { gate(); }
};
$('ptDisconnect').onclick = () => { engine.disconnect(); lastOtpContext = null; };
$('ptStart').onclick = () => {
  clearErr();
  try {
    auth(); traderConfig();
    if (bought() >= +($('ptMaxTrades').value || 100)) throw new Error('v6.5 cohort cap reached.');
    engine.start();
    engine.log('info', 'Master v6.5 armed: live wave → 38.2–61.8 pocket → first micro turn while still inside 34–64% fire window. No chase.');
  } catch (e) { err(e.message); }
};
$('ptPause').onclick = () => engine.pause();
$('ptStop').onclick = () => engine.stop();
$('ptReset').onclick = () => { try { engine.resetSession(); lastSignalEpoch = 0; cooldownUntil = 0; } catch (e) { err(e.message); } };
$('ptClearLedger').onclick = () => {
  if (confirm('Clear fresh v6.5 pocket-lock cohort?')) {
    ledger = []; localStorage.removeItem(LEDGER_KEY);
    strategy.session = 'NEUTRAL'; strategy.candidate = 'NEUTRAL'; strategy.candidateCount = 0; strategy.invalidation = 0;
    renderLedger(); draw();
  }
};
$('ptResetCalibration').onclick = () => { if (confirm('Reset execution calibration?')) { localStorage.removeItem(OFFSET_KEY); renderLedger(); } };
$('ptExportLedger').onclick = exportCsv;
for (const id of ['ptStake','ptTakeProfit','ptStopLoss','ptMaxTrades','ptCooldown']) {
  $(id).addEventListener('change', () => { try { if (!engine.snapshot().running) traderConfig(); } catch (e) { err(e.message); } });
}
window.addEventListener('sani-observatory-analysis', e => trade(e.detail));
window.addEventListener('resize', draw);

engine.subscribe(state => {
  $('ptStatus').textContent = state.safeBlocked ? 'SAFE PAUSE' : state.status === 'reconnecting' ? 'RECONNECTING' : state.connected ? (state.running ? 'TRADING' : 'CONNECTED') : 'DISCONNECTED';
  $('ptPnl').textContent = `${Number(state.sessionPnL || 0) >= 0 ? '+' : ''}$${Number(state.sessionPnL || 0).toFixed(2)}`;
  $('ptPnl').className = Number(state.sessionPnL || 0) >= 0 ? 'positive' : 'negative';
  $('ptWL').textContent = `${state.wins || 0} / ${state.losses || 0}`;
  $('ptOpen').textContent = Number(state.openContracts || 0) + (state.pendingTrade ? 1 : 0);
  $('ptStart').disabled = !state.connected || state.running || state.safeBlocked || !state.portfolioChecked;
  $('ptPause').disabled = !state.running;
  $('ptStop').disabled = !state.connected;
  $('ptReset').disabled = state.running || Number(state.openContracts || 0) > 0;
  $('ptTradeRows').innerHTML = state.trades.length ? state.trades.map(t => {
    const m = t.patternMeta || {}, expected = t.expectedWindow || m.expectedWindow || '—', actual = t.actualWindow || '—';
    const row = ledger.find(r => Number(r.contractId) === Number(t.contractId));
    return `<tr><td>#${t.contractId}</td><td>${esc(`${m.session || '—'} · ${m.phase || 'WAVE'}`)}</td><td>${t.direction}</td><td>${esc(`${m.turnKind || '—'} · ${(Number(m.fibEntryRetrace || 0) * 100).toFixed(0)}% · Q${m.quality ?? '—'}`)}</td><td><span class="result ${t.status}">${t.status}</span></td><td>${t.duration}t</td><td>${expected}</td><td>${actual}</td><td>${t.latencyClass || '—'}</td><td class="${(t.profit ?? 0) >= 0 ? 'positive' : 'negative'}">${t.profit === undefined ? '—' : `${t.profit >= 0 ? '+' : ''}${Number(t.profit).toFixed(2)}`}</td><td>${t.sendToAckMs === undefined ? '—' : Number(t.sendToAckMs).toFixed(0) + 'ms'}</td><td>${t.entrySpot ?? '—'} → ${t.exitSpot ?? '—'}${row && Number.isFinite(+row.mfe) ? ` · MFE ${(+row.mfe).toFixed(1)}/MAE ${(+row.mae).toFixed(1)}` : ''}</td></tr>`;
  }).join('') : '<tr><td colspan="12" class="empty">No v6.5 trades yet.</td></tr>';
  if (state.logs?.[0]) $('ptLogs').innerHTML = state.logs.slice(0, 70).map(l => `<div class="log ${l.level}"><time>${new Date(l.at).toLocaleTimeString()}</time><span>${esc(l.message === 'Engine armed. Waiting for fresh BOS.' ? 'Master v6.5 execution engine armed.' : l.message)}</span></div>`).join('');
  renderLedger(); draw();
});

window.addEventListener('DOMContentLoaded', () => {
  document.querySelector('.topbar h1')?.replaceChildren(document.createTextNode('Master Regime Trader v6.5'));
  const title = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Master Trader v6'));
  if (title) title.textContent = 'Master Trader v6.5 · Pocket-Lock Sniper';
  const rules = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('Frozen v6'));
  if (rules) rules.textContent = 'Frozen v6.5 pocket-lock rules';
  if ($('ptStart')) $('ptStart').textContent = 'Start Master Trader v6.5';
  if ($('ptCooldown')) $('ptCooldown').value = '1';
  const fixedText = [...document.querySelectorAll('.muted')].find(x => x.textContent.includes('Fixed internals:'));
  if (fixedText) fixedText.textContent = 'v6.5: 200 macro context, 80/FAST direction authority, live rolling impulse, 38.2–61.8 Fib pocket, hard 34–64% execution window, first micro turn, no chasing, one trade per wave origin, fixed 3-tick Demo contract. Exit telemetry records MFE/MAE and whether the prior wave target was touched.';
  const stateTitle = [...document.querySelectorAll('.sectionTitle span')].find(x => x.textContent.includes('v6 master state machine'));
  if (stateTitle) stateTitle.textContent = 'v6.5 pocket-lock state machine';
  $('ptAppId').value = localStorage.getItem('sani.deriv.appId') || '';
  $('ptToken').value = sessionStorage.getItem('sani.deriv.token') || '';
  renderLedger(); draw();
  if ($('ptAppId').value && $('ptToken').value) $('ptLoadAccounts').click();
  const snap = window.SaniObservatory?.getSnapshot?.();
  if (snap) { lastDiagnostics = evaluate(snap); renderState(lastDiagnostics); draw(); }
});
