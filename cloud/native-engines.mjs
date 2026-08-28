import { analyzeMountain, mountainAllows } from './libra-mountain.mjs';

const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
const mean = values => values.length ? values.reduce((s, v) => s + Number(v || 0), 0) / values.length : 0;

function slope(values = []) {
  const n = values.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (values[i] - ym);
    den += (i - xm) ** 2;
  }
  return den ? num / den : 0;
}

function pathEfficiency(values = []) {
  if (values.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < values.length; i++) path += Math.abs(values[i] - values[i - 1]);
  return path ? Math.abs(values.at(-1) - values[0]) / path : 0;
}

function dedupe(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const epoch = Number(row?.epoch);
    const quote = Number(row?.quote);
    if (Number.isFinite(epoch) && Number.isFinite(quote)) map.set(`${epoch}:${quote}`, { epoch, quote });
  }
  return [...map.values()].sort((a, b) => a.epoch - b.epoch);
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

class BaseNativeEngine {
  constructor({ name, maxTicks = 5000, persisted = null, onState = null }) {
    this.name = name;
    this.maxTicks = maxTicks;
    this.ticks = [];
    this.position = persisted?.position || null;
    this.lastCloseEpoch = Number(persisted?.lastCloseEpoch || 0);
    this.usedEntryKeys = Array.isArray(persisted?.usedEntryKeys) ? persisted.usedEntryKeys.slice(-400) : [];
    this.trades = Array.isArray(persisted?.trades) ? persisted.trades.slice(0, 1200) : [];
    this.paperPnl = Number(persisted?.paperPnl || 0);
    this.demoPnl = Number(persisted?.demoPnl || 0);
    this.latestMountain = analyzeMountain([]);
    this.onState = typeof onState === 'function' ? onState : () => {};
  }

  prime(rows = []) {
    this.ticks = dedupe(rows).slice(-this.maxTicks);
    this.latestMountain = analyzeMountain(this.ticks);
  }

  pushTick(epoch, quote) {
    epoch = Number(epoch);
    quote = Number(quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return false;
    const last = this.ticks.at(-1);
    if (last && last.epoch === epoch && last.quote === quote) return false;
    this.ticks.push({ epoch, quote });
    if (this.ticks.length > this.maxTicks) this.ticks.splice(0, this.ticks.length - this.maxTicks);
    this.latestMountain = analyzeMountain(this.ticks);
    return true;
  }

  tickStep() {
    const d = [];
    for (let i = Math.max(1, this.ticks.length - 80); i < this.ticks.length; i++) {
      d.push(Math.abs(this.ticks[i].quote - this.ticks[i - 1].quote));
    }
    d.sort((a, b) => a - b);
    return d.length ? d[Math.floor(d.length / 2)] || 1 : 1;
  }

  hasUsedEntry(key) {
    return Boolean(key && this.usedEntryKeys.includes(key));
  }

  markEntryUsed(key) {
    if (!key) return;
    this.usedEntryKeys = [...new Set([...this.usedEntryKeys, key])].slice(-400);
  }

  unrealized(position = this.position, quote = this.ticks.at(-1)?.quote) {
    if (!position || !Number.isFinite(Number(quote))) return { pnl: 0, r: 0 };
    const delta = position.side === 'LONG' ? Number(quote) - position.entry : position.entry - Number(quote);
    const pnl = delta * position.units;
    return { pnl, r: position.riskDollars ? pnl / position.riskDollars : 0 };
  }

  commitEntry(candidate, demo = {}) {
    this.position = { ...candidate, demo: { ...demo } };
    this.markEntryUsed(candidate.entryKey);
    this.onState();
  }

  commitExit(reason, quote, demo = {}) {
    if (!this.position) return null;
    const p = this.position;
    const q = Number(quote);
    const u = this.unrealized(p, q);
    const trade = {
      ...p,
      exit: q,
      closedAt: Date.now(),
      pnl: Number(u.pnl.toFixed(4)),
      r: Number(u.r.toFixed(4)),
      reason,
      demoPnl: Number(demo.demoPnl || 0),
      demoSoldFor: demo.soldFor != null ? Number(demo.soldFor) : null,
      demoSellAt: demo.sellAt || Date.now(),
      exitContext: slimMountain(this.latestMountain)
    };
    this.trades.unshift(trade);
    this.trades = this.trades.slice(0, 1200);
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
      lastCloseEpoch: this.lastCloseEpoch,
      usedEntryKeys: this.usedEntryKeys,
      trades: this.trades,
      paperPnl: this.paperPnl,
      demoPnl: this.demoPnl,
      wins,
      losses: this.trades.length - wins,
      winRate: this.trades.length ? Number((wins / this.trades.length * 100).toFixed(1)) : 0,
      mountain: slimMountain(this.latestMountain)
    };
  }
}

export class CometNativeEngine extends BaseNativeEngine {
  constructor(opts = {}) {
    super({ ...opts, name: 'COMET' });
    this.riskDollars = Number(opts.riskDollars || 1);
    this.targetR = Number(opts.targetR || 2);
  }

  entryKey(m, side) {
    const structural = Number(m?.entryAnchor?.epoch || m?.important?.epoch || m?.extreme?.epoch || 0);
    return structural ? `${side}|${m.direction}|${m.entryMode}|${structural}` : '';
  }

  candidate(m = this.latestMountain) {
    if (this.position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
    const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
    const permission = mountainAllows(m, direction);
    if (!permission.allowed) return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote);
    const epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch) return null;

    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const key = this.entryKey(m, side);
    if (this.hasUsedEntry(key)) return null;

    const riskDollars = Math.max(.1, Number(this.riskDollars || 1));
    const targetR = clamp(this.targetR || 2, 1, 8);
    const step = this.tickStep();
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
    const target = side === 'LONG' ? quote + riskDistance * targetR : quote - riskDistance * targetR;
    const units = riskDollars / riskDistance;

    return {
      side,
      entry: quote,
      stop,
      trailStop: stop,
      target,
      units,
      riskDollars,
      targetR,
      openedAt: Date.now(),
      openedEpoch: epoch,
      entryKey: key,
      bestR: 0,
      reversalVotes: 0,
      entryContext: slimMountain(m),
      plannedRiskDistance: riskDistance
    };
  }

  manage(m = this.latestMountain) {
    if (!this.position) return null;
    const q = Number(this.ticks.at(-1)?.quote);
    if (!Number.isFinite(q)) return null;
    const p = this.position;
    const u = this.unrealized(p, q);
    p.bestR = Math.max(p.bestR || 0, u.r);

    if (p.side === 'LONG' && q <= p.trailStop) return { action: 'EXIT', reason: 'STOP / INVALIDATION', quote: p.trailStop };
    if (p.side === 'SHORT' && q >= p.trailStop) return { action: 'EXIT', reason: 'STOP / INVALIDATION', quote: p.trailStop };
    if (p.side === 'LONG' && q >= p.target) return { action: 'EXIT', reason: 'TARGET', quote: p.target };
    if (p.side === 'SHORT' && q <= p.target) return { action: 'EXIT', reason: 'TARGET', quote: p.target };

    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
    p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
    if (p.reversalVotes >= 2) return { action: 'EXIT', reason: 'CONFIRMED MOUNTAIN REVERSAL', quote: q };

    if (u.r >= 1) {
      const risk = Math.abs(p.entry - p.stop);
      const protect = p.side === 'LONG' ? p.entry + risk * .10 : p.entry - risk * .10;
      p.trailStop = p.side === 'LONG' ? Math.max(p.trailStop, protect) : Math.min(p.trailStop, protect);
    }
    if (u.r >= 1.5 && Number.isFinite(Number(m.important?.quote))) {
      const s = Number(m.important.quote);
      if (p.side === 'LONG' && s > p.trailStop && s < q) p.trailStop = s;
      if (p.side === 'SHORT' && s < p.trailStop && s > q) p.trailStop = s;
    }
    this.onState();
    return null;
  }

  onTick(epoch, quote) {
    if (!this.pushTick(epoch, quote)) return null;
    const hadPosition = Boolean(this.position);
    const exit = this.manage(this.latestMountain);
    if (exit) return exit;
    if (!this.position && !hadPosition) {
      const candidate = this.candidate(this.latestMountain);
      if (candidate) return { action: 'ENTRY', candidate };
    }
    return null;
  }
}

const LMS_MODES = {
  GRAB: { label: 'GRAB', minPower: 45, riskFraction: .40, targetR: .80, protectAt: .35, lockR: .05, trailAt: .60 },
  CRUISE: { label: 'CRUISE', minPower: 60, riskFraction: .70, targetR: 1.60, protectAt: .65, lockR: .08, trailAt: 1.05 },
  LAST_MAN: { label: 'LAST MAN', minPower: 75, riskFraction: 1.00, targetR: 3.00, protectAt: 1.00, lockR: .10, trailAt: 1.75 }
};

export class LastManGrabNativeEngine extends BaseNativeEngine {
  constructor(opts = {}) {
    super({ ...opts, name: 'LAST_MAN_GRAB' });
    this.riskCap = Number(opts.riskCap || 1);
    this.latestPower = 0;
    this.latestRecommendedMode = 'STAND_DOWN';
  }

  trendPower(m = this.latestMountain, rows = this.ticks) {
    if (!m?.ready || !['UP', 'DOWN'].includes(m.direction) || rows.length < 34) return 0;
    const q = rows.map(r => Number(r.quote)).filter(Number.isFinite);
    const step = this.tickStep() || 1;
    const sign = m.direction === 'UP' ? 1 : -1;
    const s5 = slope(q.slice(-5)) / step * sign;
    const s13 = slope(q.slice(-13)) / step * sign;
    const s34 = slope(q.slice(-34)) / step * sign;
    const eff13 = pathEfficiency(q.slice(-13));
    const eff34 = pathEfficiency(q.slice(-34));
    const confirmation = clamp(Number(m.confirmation || 0) / 6, 0, 1);
    const coherence = [s5 > 0, s13 > 0, s34 > 0].filter(Boolean).length / 3;
    const acceleration = clamp((s5 - s13 + 1) / 2, 0, 1);
    const slopeEnergy = clamp((Math.max(0, s5) * .45 + Math.max(0, s13) * .35 + Math.max(0, s34) * .20) / .55, 0, 1);
    let moment = 0;
    if (m.entryMode === 'EARLY_MOMENTUM') moment = 1;
    else if (m.entryMode === 'PULLBACK_END') moment = .88;
    else if (m.entryMode === 'WAIT_PULLBACK_END') moment = .58;
    else if (m.entryMode === 'LATE_OR_WAIT') moment = .28;
    else if (m.entryMode === 'EXHAUSTION') moment = .08;
    const raw = 100 * (coherence * .22 + slopeEnergy * .22 + eff13 * .13 + eff34 * .15 + confirmation * .11 + acceleration * .07 + moment * .10);
    return Math.round(clamp(raw, 0, 100));
  }

  autoMode(power, m = this.latestMountain) {
    if (!m?.ready || !['UP', 'DOWN'].includes(m.direction)) return 'STAND_DOWN';
    if (m.entryMode === 'EXHAUSTION' || m.entryMode === 'LATE_OR_WAIT') return 'STAND_DOWN';
    if (power >= LMS_MODES.LAST_MAN.minPower) return 'LAST_MAN';
    if (power >= LMS_MODES.CRUISE.minPower) return 'CRUISE';
    if (power >= LMS_MODES.GRAB.minPower) return 'GRAB';
    return 'STAND_DOWN';
  }

  selectedMode(power, m = this.latestMountain) {
    const recommended = this.autoMode(power, m);
    if (recommended === 'STAND_DOWN') return 'STAND_DOWN';
    return power >= LMS_MODES.GRAB.minPower ? 'GRAB' : 'STAND_DOWN';
  }

  entryKey(m, side) {
    const structural = Number(m?.entryAnchor?.epoch || m?.important?.epoch || m?.extreme?.epoch || 0);
    return structural ? `${side}|${m.direction}|${m.entryMode}|GRAB|${structural}` : '';
  }

  candidate(m = this.latestMountain) {
    if (this.position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
    const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
    const permission = mountainAllows(m, direction);
    if (!permission.allowed) return null;

    const current = this.ticks.at(-1);
    const quote = Number(current?.quote);
    const epoch = Number(current?.epoch || 0);
    if (!Number.isFinite(quote) || !epoch || epoch <= this.lastCloseEpoch) return null;

    const power = this.trendPower(m, this.ticks);
    const mode = this.selectedMode(power, m);
    if (mode !== 'GRAB') return null;
    const cfg = LMS_MODES.GRAB;

    const side = m.direction === 'UP' ? 'LONG' : 'SHORT';
    const key = this.entryKey(m, side);
    if (this.hasUsedEntry(key)) return null;

    const riskCap = Math.max(.1, Number(this.riskCap || 1));
    const riskDollars = Number((riskCap * cfg.riskFraction).toFixed(4));
    const step = this.tickStep();
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
    const units = riskDollars / riskDistance;

    return {
      side,
      mode: 'GRAB',
      currentMode: 'GRAB',
      entryPower: power,
      currentPower: power,
      entry: quote,
      stop,
      trailStop: stop,
      target,
      targetR: cfg.targetR,
      originalTargetR: cfg.targetR,
      units,
      riskDollars,
      riskCap,
      openedAt: Date.now(),
      openedEpoch: epoch,
      entryKey: key,
      bestR: 0,
      lockedR: -1,
      reversalVotes: 0,
      targetExtended: false,
      entryContext: slimMountain(m),
      plannedRiskDistance: riskDistance
    };
  }

  lockedRFromStop(p = this.position) {
    if (!p) return 0;
    const d = p.side === 'LONG' ? p.trailStop - p.entry : p.entry - p.trailStop;
    return p.plannedRiskDistance ? d / p.plannedRiskDistance : 0;
  }

  stopForLockedR(p, r) {
    return p.side === 'LONG' ? p.entry + p.plannedRiskDistance * r : p.entry - p.plannedRiskDistance * r;
  }

  advanceStop(p, candidateStop) {
    if (p.side === 'LONG') p.trailStop = Math.max(p.trailStop, candidateStop);
    else p.trailStop = Math.min(p.trailStop, candidateStop);
    p.lockedR = Math.max(p.lockedR, this.lockedRFromStop(p));
  }

  manage(m = this.latestMountain) {
    if (!this.position) return null;
    const q = Number(this.ticks.at(-1)?.quote);
    if (!Number.isFinite(q)) return null;
    const p = this.position;
    const u = this.unrealized(p, q);
    p.bestR = Math.max(p.bestR || 0, u.r);
    p.currentPower = this.trendPower(m, this.ticks);
    const recommended = this.autoMode(p.currentPower, m);
    this.latestPower = p.currentPower;
    this.latestRecommendedMode = recommended;

    if (p.side === 'LONG' && q <= p.trailStop) return { action: 'EXIT', reason: 'PROTECTED STOP', quote: p.trailStop };
    if (p.side === 'SHORT' && q >= p.trailStop) return { action: 'EXIT', reason: 'PROTECTED STOP', quote: p.trailStop };
    if (p.side === 'LONG' && q >= p.target) return { action: 'EXIT', reason: 'DYNAMIC TARGET', quote: p.target };
    if (p.side === 'SHORT' && q <= p.target) return { action: 'EXIT', reason: 'DYNAMIC TARGET', quote: p.target };

    const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
    p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
    if (p.reversalVotes >= 2) return { action: 'EXIT', reason: 'CONFIRMED MOUNTAIN REVERSAL', quote: q };

    const cfg = LMS_MODES.GRAB;
    if (u.r >= cfg.protectAt) this.advanceStop(p, this.stopForLockedR(p, cfg.lockR));
    if (u.r >= .58) this.advanceStop(p, this.stopForLockedR(p, .25));

    if (u.r >= cfg.trailAt && Number.isFinite(Number(m.important?.quote))) {
      const s = Number(m.important.quote);
      if (p.side === 'LONG' && s > p.trailStop && s < q) this.advanceStop(p, s);
      if (p.side === 'SHORT' && s < p.trailStop && s > q) this.advanceStop(p, s);
    }

    if (p.currentPower < 42 && u.r >= .45) return { action: 'EXIT', reason: 'POWER FADE · CASH OUT', quote: q };
    if (p.currentPower < 55 && u.r >= .80) this.advanceStop(p, this.stopForLockedR(p, Math.max(.35, u.r * .45)));
    if (recommended === 'STAND_DOWN' && m.entryMode === 'EXHAUSTION' && u.r >= 1.20) {
      this.advanceStop(p, this.stopForLockedR(p, Math.max(.60, u.r * .55)));
    }

    this.onState();
    return null;
  }

  onTick(epoch, quote) {
    if (!this.pushTick(epoch, quote)) return null;
    this.latestPower = this.trendPower(this.latestMountain, this.ticks);
    this.latestRecommendedMode = this.autoMode(this.latestPower, this.latestMountain);
    const hadPosition = Boolean(this.position);
    const exit = this.manage(this.latestMountain);
    if (exit) return exit;
    if (!this.position && !hadPosition) {
      const candidate = this.candidate(this.latestMountain);
      if (candidate) return { action: 'ENTRY', candidate };
    }
    return null;
  }

  snapshot() {
    return {
      ...super.snapshot(),
      power: this.latestPower,
      recommendedMode: this.latestRecommendedMode,
      fixedMode: 'GRAB'
    };
  }
}

export const NativeEngineMeta = Object.freeze({
  comet: {
    logic: 'COMET extracted from public/comet.js',
    entry: 'mountainAllows => PULLBACK_END or EARLY_MOMENTUM',
    targetR: 2,
    riskDollars: 1
  },
  lastMan: {
    logic: 'LAST MAN extracted from public/last-man-standing.js',
    fixedMode: 'GRAB',
    minPower: LMS_MODES.GRAB.minPower,
    targetR: LMS_MODES.GRAB.targetR,
    riskFraction: LMS_MODES.GRAB.riskFraction
  }
});
