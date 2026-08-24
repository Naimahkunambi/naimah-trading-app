const CFG = {
  LONG: 200,
  AUTH: 80,
  FAST: 20,
  PATTERN: 20,
  MAX_TICKS: 10000,
  MAX_MATCHES: 80,
  MIN_MATCHES: 40,
  SIM_FLOOR: 0.82,
  MIN_AVG_SIMILARITY: 88,
  MIN_EDGE: 58,
  TOP10_MIN_AGREE: 7,
  FIXED_DURATION: 5,
  PAYOUT_NET_WIN: 0.92,
  MIN_EV: 0.05,
  MAX_BREAK_EXTENSION_STEPS: 1.10,
  EARLY_ARM_STEPS: 0.50,
  CHOP_BLOCK: 0.82,
  executionOffset: 1
};

const STATES = Object.freeze({
  WARMING: 'WARMING',
  WAIT_CONTEXT: 'WAIT_CONTEXT',
  WAIT_STRUCTURE: 'WAIT_STRUCTURE',
  ARMED: 'ARMED',
  PRIME_BOS: 'PRIME_BOS',
  CHASE_BLOCK: 'CHASE_BLOCK',
  PATTERN_AUDIT: 'PATTERN_AUDIT',
  APPROVED: 'APPROVED',
  PATTERN_BLOCK: 'PATTERN_BLOCK',
  INVALIDATED: 'INVALIDATED'
});

let ticks = [];
let activeSetup = null;
let state = STATES.WARMING;
let lastAnalysis = null;
const pendingShadow = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;

function dedupe(rows) {
  const out = [];
  let lastKey = '';
  for (const raw of rows || []) {
    const epoch = Number(raw?.epoch), quote = Number(raw?.quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) continue;
    const key = `${epoch}:${quote}`;
    if (key === lastKey) continue;
    out.push({ epoch, quote });
    lastKey = key;
  }
  return out.sort((a, b) => a.epoch - b.epoch).slice(-CFG.MAX_TICKS);
}

function avgStep(p) {
  if (p.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < p.length; i++) sum += Math.abs(p[i] - p[i - 1]);
  return sum / (p.length - 1);
}

function efficiency(p) {
  if (p.length < 2) return 0;
  let path = 0;
  for (let i = 1; i < p.length; i++) path += Math.abs(p[i] - p[i - 1]);
  return path ? Math.abs(p.at(-1) - p[0]) / path : 0;
}

function turnRate(p) {
  const signs = [];
  for (let i = 1; i < p.length; i++) {
    const d = p[i] - p[i - 1];
    if (d) signs.push(Math.sign(d));
  }
  if (signs.length < 2) return 0;
  let turns = 0;
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) turns++;
  return turns / (signs.length - 1);
}

function linearSlope(p) {
  const n = p.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2, ym = mean(p);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xm;
    num += dx * (p[i] - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}

function pivots(p, radius = 1) {
  const highs = [], lows = [];
  for (let i = radius; i < p.length - radius; i++) {
    const left = p.slice(i - radius, i), right = p.slice(i + 1, i + radius + 1);
    if (left.every(v => p[i] >= v) && right.every(v => p[i] >= v) && [...left, ...right].some(v => p[i] > v)) highs.push({ i, quote: p[i] });
    if (left.every(v => p[i] <= v) && right.every(v => p[i] <= v) && [...left, ...right].some(v => p[i] < v)) lows.push({ i, quote: p[i] });
  }
  return { highs, lows };
}

function swingStructure(p) {
  const { highs, lows } = pivots(p, 2);
  const h = highs.slice(-2), l = lows.slice(-2);
  if (h.length < 2 || l.length < 2) return 'MIXED';
  if (h[1].quote > h[0].quote && l[1].quote > l[0].quote) return 'BULL';
  if (h[1].quote < h[0].quote && l[1].quote < l[0].quote) return 'BEAR';
  return 'MIXED';
}

function metrics(rows) {
  const p = rows.map(x => x.quote);
  const step = avgStep(p);
  return {
    avgStep: step,
    slopeNorm: step ? linearSlope(p) / step : 0,
    efficiency: efficiency(p),
    turnRate: turnRate(p),
    net: p.at(-1) - p[0],
    structure: swingStructure(p)
  };
}

function directionFromMetrics(m, slopeFloor, efficiencyFloor) {
  if (Math.abs(m.slopeNorm) < slopeFloor || m.efficiency < efficiencyFloor) return 'NEUTRAL';
  if (m.slopeNorm > 0 && m.net > 0) return 'BULL';
  if (m.slopeNorm < 0 && m.net < 0) return 'BEAR';
  return 'NEUTRAL';
}

function chopState(m80, m20) {
  const score = (
    clamp((.12 - m80.efficiency) / .12, 0, 1) +
    clamp((m80.turnRate - .58) / .25, 0, 1) +
    clamp((.05 - Math.abs(m80.slopeNorm)) / .05, 0, 1) +
    clamp((m20.turnRate - .78) / .15, 0, 1)
  ) / 4;
  return { score, blocked: score >= CFG.CHOP_BLOCK };
}

function volatilityState(m200, m80, m20) {
  const shortVsMid = m80.avgStep ? m20.avgStep / m80.avgStep : 1;
  const midVsLong = m200.avgStep ? m80.avgStep / m200.avgStep : 1;
  if (shortVsMid < .28 || midVsLong < .38) return 'DEAD';
  if (shortVsMid > 2.8 || m20.turnRate > .96) return 'CHAOTIC';
  return 'HEALTHY';
}

function normalizeShape(quotes) {
  if (!quotes.length) return [];
  const base = quotes[0];
  const path = quotes.map(q => q - base);
  const rms = Math.sqrt(path.reduce((s, v) => s + v * v, 0) / Math.max(1, path.length));
  if (!Number.isFinite(rms) || rms === 0) return path.map(() => 0);
  return path.map(v => v / rms);
}

function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function patternAudit(signalIndex, direction) {
  const n = CFG.PATTERN;
  const currentStart = signalIndex - n + 1;
  const expected = direction === 'BULL' ? 'UP' : 'DOWN';
  if (currentStart < 1) return { ok: false, status: 'WEAK', reason: 'Not enough pattern history', expected };
  const currentShape = normalizeShape(ticks.slice(currentStart, signalIndex + 1).map(t => t.quote));
  const candidates = [];
  const lookahead = CFG.executionOffset + CFG.FIXED_DURATION;

  for (let start = 0; start + n - 1 + lookahead < currentStart; start++) {
    const end = start + n - 1;
    const shape = normalizeShape(ticks.slice(start, start + n).map(t => t.quote));
    const similarity = cosine(currentShape, shape);
    if (similarity < CFG.SIM_FLOOR) continue;
    const entry = ticks[end + CFG.executionOffset]?.quote;
    const exit = ticks[end + CFG.executionOffset + CFG.FIXED_DURATION]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === exit) continue;
    candidates.push({ end, similarity, outcome: exit > entry ? 'UP' : 'DOWN', epoch: ticks[end].epoch });
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  const matches = [];
  for (const c of candidates) {
    if (matches.some(x => Math.abs(x.end - c.end) < Math.max(3, Math.floor(n / 3)))) continue;
    matches.push(c);
    if (matches.length >= CFG.MAX_MATCHES) break;
  }

  const matchCount = matches.length;
  const avgSimilarity = matchCount ? mean(matches.map(x => x.similarity)) * 100 : 0;
  const up = matches.filter(x => x.outcome === 'UP').length;
  const down = matches.filter(x => x.outcome === 'DOWN').length;
  const decided = up + down;
  const bias = !decided ? 'NONE' : up > down ? 'UP' : down > up ? 'DOWN' : 'EVEN';
  const edge = decided ? Math.max(up, down) / decided * 100 : 0;
  const top10 = matches.slice(0, 10);
  const top10Agree = top10.filter(x => x.outcome === expected).length;
  const top10Total = top10.length;
  const expectedCount = expected === 'UP' ? up : down;
  const expectedEdge = decided ? expectedCount / decided * 100 : 0;
  const p = expectedEdge / 100;
  const ev = p * CFG.PAYOUT_NET_WIN - (1 - p);
  const gates = {
    matches: matchCount >= CFG.MIN_MATCHES,
    similarity: avgSimilarity >= CFG.MIN_AVG_SIMILARITY,
    direction: bias === expected,
    edge: expectedEdge >= CFG.MIN_EDGE,
    top10: top10Total >= 10 && top10Agree >= CFG.TOP10_MIN_AGREE,
    ev: ev >= CFG.MIN_EV
  };
  const ok = Object.values(gates).every(Boolean);
  const failed = Object.entries(gates).filter(([, pass]) => !pass).map(([k]) => k.toUpperCase());
  return {
    ok,
    status: ok ? 'AGREE' : bias !== expected && bias !== 'NONE' ? 'DISAGREE' : 'WEAK',
    reason: ok ? `${expected} ${expectedEdge.toFixed(1)}% · top10 ${top10Agree}/10 · EV ${(ev * 100).toFixed(1)}%` : `${failed.join(' + ')} blocked`,
    expected, bias, edge, expectedEdge, matchCount, avgSimilarity, top10Agree, top10Total, ev, gates,
    nearest: matches.slice(0, 10).map(x => ({ similarity: x.similarity * 100, outcome: x.outcome, epoch: x.epoch })),
    duration: CFG.FIXED_DURATION,
    executionOffset: CFG.executionOffset
  };
}

function contextSnapshot() {
  if (ticks.length < CFG.LONG) return null;
  const r200 = ticks.slice(-CFG.LONG), r80 = ticks.slice(-CFG.AUTH), r20 = ticks.slice(-CFG.FAST);
  const m200 = metrics(r200), m80 = metrics(r80), m20 = metrics(r20);
  const regime200 = directionFromMetrics(m200, .045, .06);
  const authority80 = directionFromMetrics(m80, .065, .055);
  const fast20 = directionFromMetrics(m20, .05, .05);
  const direction = regime200 !== 'NEUTRAL' && regime200 === authority80 ? regime200 : 'NEUTRAL';
  const chop = chopState(m80, m20);
  const volatility = volatilityState(m200, m80, m20);
  return { regime200, authority80, fast20, direction, chop, volatility, m200, m80, m20 };
}

function findArmedSetup(ctx) {
  if (!ctx || ctx.direction === 'NEUTRAL' || ctx.chop.blocked || ctx.volatility !== 'HEALTHY') return null;
  const rows20 = ticks.slice(-CFG.FAST);
  if (rows20.length < 14) return null;
  const p = rows20.map(x => x.quote);
  const unit = ctx.m20.avgStep || avgStep(p) || 1;
  const shelf = p.slice(-8, -2);
  const context = p.slice(-14, -2);
  const recentP = p.slice(-16);
  const recentRows = rows20.slice(-16);
  const pp = pivots(recentP, 1);
  const signalEpoch = rows20.at(-1).epoch;

  if (ctx.direction === 'BULL') {
    const level = Math.max(...shelf);
    const lows = pp.lows.slice(-2);
    const lastLow = lows.at(-1), prevLow = lows.length > 1 ? lows.at(-2) : null;
    const pivotQuote = lastLow?.quote ?? Math.min(...context);
    const pivotEpoch = lastLow ? recentRows[lastLow.i]?.epoch : rows20.at(-3)?.epoch;
    const hl = !prevLow || !lastLow || lastLow.quote >= prevLow.quote - unit * .20;
    const pullbackSteps = (Math.max(...context) - Math.min(...context)) / unit;
    if (!hl || pullbackSteps < .65 || !Number.isFinite(level) || !Number.isFinite(pivotQuote)) return null;
    return { id: `B:${pivotEpoch}:${Math.round(level * 100)}:${Math.round(pivotQuote * 100)}`, direction: 'BULL', pivotType: 'HL', pivotQuote, pivotEpoch, bosLevel: level, avgStep: unit, pullbackSteps, createdEpoch: signalEpoch };
  }

  const level = Math.min(...shelf);
  const highs = pp.highs.slice(-2);
  const lastHigh = highs.at(-1), prevHigh = highs.length > 1 ? highs.at(-2) : null;
  const pivotQuote = lastHigh?.quote ?? Math.max(...context);
  const pivotEpoch = lastHigh ? recentRows[lastHigh.i]?.epoch : rows20.at(-3)?.epoch;
  const lh = !prevHigh || !lastHigh || lastHigh.quote <= prevHigh.quote + unit * .20;
  const pullbackSteps = (Math.max(...context) - Math.min(...context)) / unit;
  if (!lh || pullbackSteps < .65 || !Number.isFinite(level) || !Number.isFinite(pivotQuote)) return null;
  return { id: `S:${pivotEpoch}:${Math.round(level * 100)}:${Math.round(pivotQuote * 100)}`, direction: 'BEAR', pivotType: 'LH', pivotQuote, pivotEpoch, bosLevel: level, avgStep: unit, pullbackSteps, createdEpoch: signalEpoch };
}

function emit(type, payload = {}) { postMessage({ type, ...payload }); }
function lifecycleEvent(setup, nextState, reason, extra = {}) {
  emit('SETUP_EVENT', { event: { setupId: setup.id, state: nextState, reason, at: Date.now(), epoch: ticks.at(-1)?.epoch, quote: ticks.at(-1)?.quote, ...extra }, setup: { ...setup } });
}
function scheduleShadow(setup, signalIndex, audit, timingClass, approved) {
  pendingShadow.set(setup.id, { setupId: setup.id, signalIndex, signalEpoch: ticks[signalIndex]?.epoch, direction: setup.direction, duration: CFG.FIXED_DURATION, executionOffset: CFG.executionOffset, audit, timingClass, approved });
}
function resolveShadows() {
  for (const [id, row] of pendingShadow.entries()) {
    const startIndex = row.signalIndex + row.executionOffset;
    const endIndex = startIndex + row.duration;
    if (endIndex >= ticks.length) continue;
    const entry = ticks[startIndex]?.quote, exit = ticks[endIndex]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    const won = row.direction === 'BULL' ? exit > entry : exit < entry;
    emit('SHADOW_RESULT', { setupId: id, shadow: { outcome: entry === exit ? 'FLAT' : won ? 'WON' : 'LOST', entry, exit, entryEpoch: ticks[startIndex]?.epoch, exitEpoch: ticks[endIndex]?.epoch, duration: row.duration, executionOffset: row.executionOffset } });
    pendingShadow.delete(id);
  }
}

function evaluateTick() {
  resolveShadows();
  const last = ticks.at(-1);
  if (!last) return;
  if (ticks.length < CFG.LONG) {
    lastAnalysis = { state: STATES.WARMING, reason: `Need ${CFG.LONG} ticks (${ticks.length}/${CFG.LONG})`, tick: last, config: CFG };
    emit('ANALYSIS', { analysis: lastAnalysis });
    return;
  }

  const ctx = contextSnapshot();
  lastAnalysis = { ...ctx, tick: last, state, config: CFG, activeSetup: activeSetup ? { ...activeSetup } : null };
  const contextOk = ctx.direction !== 'NEUTRAL' && !ctx.chop.blocked && ctx.volatility === 'HEALTHY';
  if (!contextOk) {
    if (activeSetup) { lifecycleEvent(activeSetup, STATES.INVALIDATED, ctx.direction === 'NEUTRAL' ? '200/80 alignment lost' : ctx.chop.blocked ? 'CHOP veto' : `Volatility ${ctx.volatility}`); activeSetup = null; }
    state = STATES.WAIT_CONTEXT;
    emit('ANALYSIS', { analysis: { ...lastAnalysis, state, activeSetup: null, reason: ctx.direction === 'NEUTRAL' ? `Need 200+80 alignment (${ctx.regime200}/${ctx.authority80})` : ctx.chop.blocked ? 'CHOP veto' : `Volatility ${ctx.volatility}` } });
    return;
  }

  if (!activeSetup) {
    const candidate = findArmedSetup(ctx);
    if (!candidate) { state = STATES.WAIT_STRUCTURE; emit('ANALYSIS', { analysis: { ...lastAnalysis, state, reason: `Aligned ${ctx.direction}. Waiting HL/LH anchor.` } }); return; }
    activeSetup = { ...candidate, openedAt: Date.now(), context: { regime200: ctx.regime200, authority80: ctx.authority80, fast20: ctx.fast20, chop: ctx.chop.score, volatility: ctx.volatility, slope200: ctx.m200.slopeNorm, slope80: ctx.m80.slopeNorm }, state: STATES.ARMED };
    lifecycleEvent(activeSetup, STATES.ARMED, `${activeSetup.pivotType} anchor frozen; BOS ${activeSetup.bosLevel}`);
  }

  if (activeSetup.direction !== ctx.direction) {
    lifecycleEvent(activeSetup, STATES.INVALIDATED, `Direction changed ${activeSetup.direction}→${ctx.direction}`);
    activeSetup = null; state = STATES.WAIT_STRUCTURE;
    emit('ANALYSIS', { analysis: { ...lastAnalysis, state, activeSetup: null, reason: 'Direction changed. Waiting fresh setup.' } });
    return;
  }

  const current = ticks.at(-1).quote, previous = ticks.at(-2)?.quote;
  const buffer = activeSetup.avgStep * .02;
  let firstBreak = false, breakDistanceSteps = 0, earlyDistance = Infinity;
  if (activeSetup.direction === 'BULL') {
    const nowAbove = current > activeSetup.bosLevel + buffer;
    const beforeAbove = Number(previous) > activeSetup.bosLevel + buffer;
    firstBreak = nowAbove && !beforeAbove;
    breakDistanceSteps = nowAbove ? Math.max(0, (current - activeSetup.bosLevel) / activeSetup.avgStep) : 0;
    earlyDistance = !nowAbove ? Math.max(0, (activeSetup.bosLevel - current) / activeSetup.avgStep) : 0;
  } else {
    const nowBelow = current < activeSetup.bosLevel - buffer;
    const beforeBelow = Number(previous) < activeSetup.bosLevel - buffer;
    firstBreak = nowBelow && !beforeBelow;
    breakDistanceSteps = nowBelow ? Math.max(0, (activeSetup.bosLevel - current) / activeSetup.avgStep) : 0;
    earlyDistance = !nowBelow ? Math.max(0, (current - activeSetup.bosLevel) / activeSetup.avgStep) : 0;
  }

  if (!firstBreak) {
    state = STATES.ARMED;
    emit('ANALYSIS', { analysis: { ...lastAnalysis, state, activeSetup: { ...activeSetup }, reason: `${activeSetup.pivotType} armed · ${earlyDistance.toFixed(2)}x from BOS` } });
    return;
  }

  const signalIndex = ticks.length - 1;
  const timingClass = breakDistanceSteps <= CFG.MAX_BREAK_EXTENSION_STEPS ? 'PRIME' : 'CHASE';
  lifecycleEvent(activeSetup, timingClass === 'PRIME' ? STATES.PRIME_BOS : STATES.CHASE_BLOCK, `${timingClass} first BOS break`, { timingClass, breakDistanceSteps, signalEpoch: last.epoch, signalQuote: last.quote });
  const audit = patternAudit(signalIndex, activeSetup.direction);
  lifecycleEvent(activeSetup, STATES.PATTERN_AUDIT, 'Pattern audit completed', { timingClass, breakDistanceSteps, pattern: audit });
  const approved = timingClass === 'PRIME' && audit.ok;
  const finalState = approved ? STATES.APPROVED : timingClass === 'CHASE' ? STATES.CHASE_BLOCK : STATES.PATTERN_BLOCK;
  const why = approved ? 'All gates passed' : timingClass === 'CHASE' ? `CHASE ${breakDistanceSteps.toFixed(2)}x > ${CFG.MAX_BREAK_EXTENSION_STEPS.toFixed(2)}x` : audit.reason;
  lifecycleEvent(activeSetup, finalState, why, { timingClass, breakDistanceSteps, pattern: audit, approved, signalEpoch: last.epoch, signalQuote: last.quote, duration: CFG.FIXED_DURATION, executionOffset: CFG.executionOffset });
  emit('DECISION', { decision: { setupId: activeSetup.id, approved, state: finalState, direction: activeSetup.direction, tradeDirection: activeSetup.direction === 'BULL' ? 'CALL' : 'PUT', pivotType: activeSetup.pivotType, pivotQuote: activeSetup.pivotQuote, pivotEpoch: activeSetup.pivotEpoch, bosLevel: activeSetup.bosLevel, timingClass, breakDistanceSteps, signalEpoch: last.epoch, signalQuote: last.quote, duration: CFG.FIXED_DURATION, executionOffset: CFG.executionOffset, context: activeSetup.context, pattern: audit, why } });
  scheduleShadow(activeSetup, signalIndex, audit, timingClass, approved);
  activeSetup = null; state = finalState;
  emit('ANALYSIS', { analysis: { ...lastAnalysis, state, activeSetup: null, reason: why } });
}

function addTick(raw) {
  const epoch = Number(raw?.epoch), quote = Number(raw?.quote);
  if (!Number.isFinite(epoch) || !Number.isFinite(quote)) return;
  const last = ticks.at(-1);
  if (last && last.epoch === epoch && last.quote === quote) return;
  ticks.push({ epoch, quote });
  if (ticks.length > CFG.MAX_TICKS) ticks.splice(0, ticks.length - CFG.MAX_TICKS);
  evaluateTick();
}

onmessage = event => {
  const msg = event.data || {};
  if (msg.type === 'INIT') {
    ticks = dedupe(msg.ticks || []);
    if (Number.isFinite(+msg.executionOffset)) CFG.executionOffset = clamp(Math.round(+msg.executionOffset), 1, 10);
    activeSetup = null; state = ticks.length >= CFG.LONG ? STATES.WAIT_CONTEXT : STATES.WARMING; evaluateTick();
  } else if (msg.type === 'TICK') addTick(msg.tick);
  else if (msg.type === 'CONFIG') { if (Number.isFinite(+msg.executionOffset)) CFG.executionOffset = clamp(Math.round(+msg.executionOffset), 1, 10); }
  else if (msg.type === 'RESET') { activeSetup = null; pendingShadow.clear(); state = ticks.length >= CFG.LONG ? STATES.WAIT_CONTEXT : STATES.WARMING; evaluateTick(); }
};
