const CFG = {
  VERSION: 'v8-pattern-first',
  MAX_TICKS: 10000,
  PATTERN_LENGTHS: [8, 12, 20],
  MAX_MATCHES: 80,
  MIN_MATCHES: 24,
  SIM_FLOOR: 0.80,
  MIN_AVG_SIMILARITY: 84,
  MIN_EDGE: 56,
  TOP10_MIN_AGREE: 6,
  FIXED_DURATION: 1,
  executionOffset: 1
};

let ticks = [];
let lastAnalysis = null;
let campaign = { direction: 'NONE', sinceEpoch: 0, pulses: 0 };
const pendingShadows = new Map();

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function perfNow() { return globalThis.performance?.now?.() ?? Date.now(); }
function emit(type, payload = {}) { postMessage({ type, ...payload }); }

function dedupe(rows) {
  const out = [];
  let last = '';
  for (const raw of rows || []) {
    const epoch = Number(raw?.epoch), quote = Number(raw?.quote);
    if (!Number.isFinite(epoch) || !Number.isFinite(quote)) continue;
    const key = `${epoch}:${quote}`;
    if (key === last) continue;
    out.push({ epoch, quote });
    last = key;
  }
  return out.sort((a, b) => a.epoch - b.epoch).slice(-CFG.MAX_TICKS);
}

function avgStep(rows) {
  if (!rows || rows.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < rows.length; i++) sum += Math.abs(rows[i].quote - rows[i - 1].quote);
  return sum / (rows.length - 1);
}

function linearSlope(rows) {
  const n = rows.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(rows.map(x => x.quote));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xm;
    num += dx * (rows[i].quote - ym);
    den += dx * dx;
  }
  return den ? num / den : 0;
}

function softDirection(rows) {
  if (!rows || rows.length < 4) return 'NEUTRAL';
  const step = avgStep(rows) || 1;
  const slope = linearSlope(rows) / step;
  const net = rows.at(-1).quote - rows[0].quote;
  if (slope > .035 && net > 0) return 'BULL';
  if (slope < -.035 && net < 0) return 'BEAR';
  return 'NEUTRAL';
}

function pivots(rows, radius = 1) {
  const highs = [], lows = [];
  for (let i = radius; i < rows.length - radius; i++) {
    const q = rows[i].quote;
    const left = rows.slice(i - radius, i).map(x => x.quote);
    const right = rows.slice(i + 1, i + radius + 1).map(x => x.quote);
    if (left.every(v => q >= v) && right.every(v => q >= v) && [...left, ...right].some(v => q > v)) highs.push({ i, quote: q, epoch: rows[i].epoch });
    if (left.every(v => q <= v) && right.every(v => q <= v) && [...left, ...right].some(v => q < v)) lows.push({ i, quote: q, epoch: rows[i].epoch });
  }
  return { highs, lows };
}

function structureTagAt(index) {
  const start = Math.max(0, index - 34);
  const rows = ticks.slice(start, index + 1);
  if (rows.length < 8) return { tag: 'MIXED', pivotType: '—', pivotQuote: NaN, pivotEpoch: NaN, phase: 'UNKNOWN' };
  const { highs, lows } = pivots(rows, 1);
  const lh = highs.slice(-3), ll = lows.slice(-3);
  const lastH = lh.at(-1), prevH = lh.at(-2), prev2H = lh.at(-3);
  const lastL = ll.at(-1), prevL = ll.at(-2), prev2L = ll.at(-3);

  const hType = lastH && prevH ? (lastH.quote > prevH.quote ? 'HH' : 'LH') : 'H';
  const lType = lastL && prevL ? (lastL.quote > prevL.quote ? 'HL' : 'LL') : 'L';
  let pivotType = '—', pivotQuote = NaN, pivotEpoch = NaN;
  if (lastH && lastL) {
    if (lastH.epoch > lastL.epoch) { pivotType = hType; pivotQuote = lastH.quote; pivotEpoch = lastH.epoch; }
    else { pivotType = lType; pivotQuote = lastL.quote; pivotEpoch = lastL.epoch; }
  } else if (lastH) { pivotType = hType; pivotQuote = lastH.quote; pivotEpoch = lastH.epoch; }
  else if (lastL) { pivotType = lType; pivotQuote = lastL.quote; pivotEpoch = lastL.epoch; }

  let tag = pivotType;
  if (pivotType === 'LL' && prev2L && prevL && lastL && prev2L.quote > prevL.quote && prevL.quote > lastL.quote) tag = 'LL2';
  if (pivotType === 'HH' && prev2H && prevH && lastH && prev2H.quote < prevH.quote && prevH.quote < lastH.quote) tag = 'HH2';

  const current = rows.at(-1).quote;
  const step = avgStep(rows.slice(-20)) || 1;
  let phase = 'MID';
  if (lastL && Math.abs(current - lastL.quote) <= step * 1.5) phase = 'NEAR_LOW';
  if (lastH && Math.abs(current - lastH.quote) <= step * 1.5) phase = 'NEAR_HIGH';
  if (lastL && lastH) {
    const span = Math.abs(lastH.quote - lastL.quote) || step;
    const pos = (current - Math.min(lastL.quote, lastH.quote)) / span;
    if (pos <= .20) phase = 'LOW_ZONE';
    else if (pos >= .80) phase = 'HIGH_ZONE';
  }
  return { tag, pivotType, pivotQuote, pivotEpoch, phase, highType: hType, lowType: lType };
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
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function auditLength(signalIndex, n, structure) {
  const currentStart = signalIndex - n + 1;
  if (currentStart < 2) return null;
  const currentShape = normalizeShape(ticks.slice(currentStart, signalIndex + 1).map(t => t.quote));
  const lookahead = CFG.executionOffset + CFG.FIXED_DURATION;
  const candidates = [];

  for (let start = 0; start + n - 1 + lookahead < currentStart; start++) {
    const end = start + n - 1;
    const shape = normalizeShape(ticks.slice(start, start + n).map(t => t.quote));
    const similarity = cosine(currentShape, shape);
    if (similarity < CFG.SIM_FLOOR) continue;
    const entry = ticks[end + CFG.executionOffset]?.quote;
    const exit = ticks[end + CFG.executionOffset + CFG.FIXED_DURATION]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === exit) continue;
    const histStructure = structureTagAt(end);
    const sameTag = histStructure.tag === structure.tag;
    const samePhase = histStructure.phase === structure.phase;
    const weighted = similarity + (sameTag ? .025 : 0) + (samePhase ? .010 : 0);
    candidates.push({ end, similarity, weighted, outcome: exit > entry ? 'UP' : 'DOWN', epoch: ticks[end].epoch, tag: histStructure.tag, phase: histStructure.phase });
  }

  candidates.sort((a, b) => b.weighted - a.weighted);
  const matches = [];
  for (const c of candidates) {
    if (matches.some(x => Math.abs(x.end - c.end) < Math.max(3, Math.floor(n / 3)))) continue;
    matches.push(c);
    if (matches.length >= CFG.MAX_MATCHES) break;
  }
  if (!matches.length) return null;

  const up = matches.filter(x => x.outcome === 'UP').length;
  const down = matches.filter(x => x.outcome === 'DOWN').length;
  const decided = up + down;
  const direction = up === down ? 'EVEN' : up > down ? 'UP' : 'DOWN';
  const directionCount = Math.max(up, down);
  const edge = decided ? directionCount / decided * 100 : 0;
  const avgSimilarity = mean(matches.map(x => x.similarity)) * 100;
  const top10 = matches.slice(0, 10);
  const top10Agree = direction === 'UP' ? top10.filter(x => x.outcome === 'UP').length : direction === 'DOWN' ? top10.filter(x => x.outcome === 'DOWN').length : 0;
  const sameTagCount = matches.filter(x => x.tag === structure.tag).length;
  const samePhaseCount = matches.filter(x => x.phase === structure.phase).length;
  const quality = edge + Math.min(4, sameTagCount * .15) + Math.min(2, samePhaseCount * .08) + Math.max(0, avgSimilarity - 84) * .08;
  const ok = decided >= CFG.MIN_MATCHES && avgSimilarity >= CFG.MIN_AVG_SIMILARITY && edge >= CFG.MIN_EDGE && top10.length >= 10 && top10Agree >= CFG.TOP10_MIN_AGREE && direction !== 'EVEN';

  return {
    length: n,
    ok,
    direction,
    edge,
    up,
    down,
    matchCount: decided,
    avgSimilarity,
    top10Agree,
    top10Total: top10.length,
    sameTagCount,
    samePhaseCount,
    quality,
    nearest: top10.map(x => ({ similarity: x.similarity * 100, outcome: x.outcome, epoch: x.epoch, tag: x.tag, phase: x.phase }))
  };
}

function patternDecision(signalIndex, structure) {
  const audits = CFG.PATTERN_LENGTHS.map(n => auditLength(signalIndex, n, structure)).filter(Boolean);
  if (!audits.length) return { ok: false, reason: 'No historical pattern family yet', audits: [] };
  audits.sort((a, b) => Number(b.ok) - Number(a.ok) || b.quality - a.quality || b.edge - a.edge);
  const best = audits[0];
  const familyId = best ? `${best.length}T-${structure.tag}-${structure.phase}-${best.direction}` : 'NONE';
  return {
    ...best,
    familyId,
    audits,
    reason: best.ok
      ? `${familyId} · ${best.edge.toFixed(1)}% · ${best.matchCount} relatives · top10 ${best.top10Agree}/${best.top10Total}`
      : `${familyId} weak · ${best.edge.toFixed(1)}% · ${best.matchCount} relatives · top10 ${best.top10Agree}/${best.top10Total}`
  };
}

function resolveShadows() {
  for (const [id, row] of pendingShadows.entries()) {
    const start = row.signalIndex + row.executionOffset;
    const end = start + row.duration;
    if (end >= ticks.length) continue;
    const entry = ticks[start]?.quote, exit = ticks[end]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    const won = row.tradeDirection === 'CALL' ? exit > entry : exit < entry;
    emit('SHADOW_RESULT', { signalId: id, shadow: { outcome: entry === exit ? 'FLAT' : won ? 'WON' : 'LOST', entry, exit, entryEpoch: ticks[start]?.epoch, exitEpoch: ticks[end]?.epoch, duration: row.duration, executionOffset: row.executionOffset } });
    pendingShadows.delete(id);
  }
}

function evaluateTick() {
  const started = perfNow();
  resolveShadows();
  const signalIndex = ticks.length - 1;
  const last = ticks.at(-1);
  if (!last) return;
  if (ticks.length < 80) {
    lastAnalysis = { version: CFG.VERSION, state: 'WARMING', reason: `Need 80 ticks (${ticks.length}/80)`, tick: last, decisionMs: perfNow() - started, config: CFG };
    emit('ANALYSIS', { analysis: lastAnalysis });
    return;
  }

  const structure = structureTagAt(signalIndex);
  const pattern = patternDecision(signalIndex, structure);
  const context80 = softDirection(ticks.slice(-80));
  const context200 = ticks.length >= 200 ? softDirection(ticks.slice(-200)) : 'WARMING';
  const approved = Boolean(pattern.ok);
  const predicted = pattern.direction;
  const tradeDirection = predicted === 'UP' ? 'CALL' : predicted === 'DOWN' ? 'PUT' : 'NONE';

  if (approved) {
    if (campaign.direction !== tradeDirection) campaign = { direction: tradeDirection, sinceEpoch: last.epoch, pulses: 0 };
    campaign.pulses += 1;
  }

  const signalId = `v8-${last.epoch}-${pattern.familyId || 'none'}`;
  const decisionMs = perfNow() - started;
  const decision = {
    signalId,
    approved,
    state: approved ? 'ENTER' : 'WATCH',
    tradeDirection,
    predicted,
    signalEpoch: last.epoch,
    signalQuote: last.quote,
    duration: CFG.FIXED_DURATION,
    executionOffset: CFG.executionOffset,
    structure,
    pattern,
    context80,
    context200,
    campaign: { ...campaign },
    decisionMs,
    why: pattern.reason
  };

  lastAnalysis = { version: CFG.VERSION, state: decision.state, reason: decision.why, tick: last, structure, pattern, context80, context200, campaign: { ...campaign }, decisionMs, config: CFG };
  emit('ANALYSIS', { analysis: lastAnalysis });
  emit('DECISION', { decision });

  if (tradeDirection !== 'NONE') {
    pendingShadows.set(signalId, { signalIndex, executionOffset: CFG.executionOffset, duration: CFG.FIXED_DURATION, tradeDirection });
  }
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
    campaign = { direction: 'NONE', sinceEpoch: 0, pulses: 0 };
    evaluateTick();
  } else if (msg.type === 'TICK') {
    addTick(msg.tick);
  } else if (msg.type === 'CONFIG') {
    if (Number.isFinite(+msg.executionOffset)) CFG.executionOffset = clamp(Math.round(+msg.executionOffset), 1, 10);
  } else if (msg.type === 'RESET') {
    campaign = { direction: 'NONE', sinceEpoch: 0, pulses: 0 };
    pendingShadows.clear();
    evaluateTick();
  }
};