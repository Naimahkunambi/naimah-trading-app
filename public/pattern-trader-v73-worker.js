import { SniperCampaignPolicy, lengthModifier, shapeSignature } from './core/sniper-campaign.mjs';

const CFG = {
  VERSION: 'v8.1-sniper-campaign', MAX_TICKS: 10000, PATTERN_LENGTHS: [8, 12, 20], MAX_MATCHES: 80,
  MIN_MATCHES: 24, SIM_FLOOR: 0.80, MIN_AVG_SIMILARITY: 84, MIN_EDGE: 56, TOP10_MIN_AGREE: 6,
  FIXED_DURATION: 1, executionOffset: 1
};

let ticks = [];
let lastAnalysis = null;
let policy = new SniperCampaignPolicy();
const pendingShadows = new Map();
const familyMemory = new Map();
const addressMemory = new Map();

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const perfNow = () => globalThis.performance?.now?.() ?? Date.now();
const emit = (type, payload = {}) => postMessage({ type, ...payload });
const addressKeyFor = (familyId, structure) => `${familyId}|${structure?.tag || 'MIXED'}|${structure?.phase || 'MID'}`;

function bumpMemory(map, key, won) {
  if (!key) return;
  const row = map.get(key) || { wins: 0, losses: 0 };
  if (won) row.wins += 1;
  else row.losses += 1;
  map.set(key, row);
}

function hydrateMemory(rows = []) {
  familyMemory.clear();
  addressMemory.clear();
  for (const row of rows) {
    if (!row?.familyId || !['WON', 'LOST'].includes(row?.outcome)) continue;
    const won = row.outcome === 'WON';
    bumpMemory(familyMemory, row.familyId, won);
    bumpMemory(addressMemory, row.addressKey || `${row.familyId}|${row.structureTag || 'MIXED'}|${row.phase || 'MID'}`, won);
  }
}

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
  for (let index = 1; index < rows.length; index += 1) sum += Math.abs(rows[index].quote - rows[index - 1].quote);
  return sum / (rows.length - 1);
}

function linearSlope(rows) {
  const length = rows.length;
  if (length < 2) return 0;
  const xMean = (length - 1) / 2, yMean = mean(rows.map(row => row.quote));
  let numerator = 0, denominator = 0;
  for (let index = 0; index < length; index += 1) {
    const dx = index - xMean;
    numerator += dx * (rows[index].quote - yMean);
    denominator += dx * dx;
  }
  return denominator ? numerator / denominator : 0;
}

function softDirection(rows) {
  if (!rows || rows.length < 4) return 'NEUTRAL';
  const step = avgStep(rows) || 1, slope = linearSlope(rows) / step, net = rows.at(-1).quote - rows[0].quote;
  if (slope > 0.035 && net > 0) return 'BULL';
  if (slope < -0.035 && net < 0) return 'BEAR';
  return 'NEUTRAL';
}

function pivots(rows, radius = 1) {
  const highs = [], lows = [];
  for (let index = radius; index < rows.length - radius; index += 1) {
    const quote = rows[index].quote;
    const left = rows.slice(index - radius, index).map(row => row.quote);
    const right = rows.slice(index + 1, index + radius + 1).map(row => row.quote);
    if (left.every(value => quote >= value) && right.every(value => quote >= value) && [...left, ...right].some(value => quote > value)) highs.push({ index, quote, epoch: rows[index].epoch });
    if (left.every(value => quote <= value) && right.every(value => quote <= value) && [...left, ...right].some(value => quote < value)) lows.push({ index, quote, epoch: rows[index].epoch });
  }
  return { highs, lows };
}

function structureTagAt(index) {
  const rows = ticks.slice(Math.max(0, index - 34), index + 1);
  if (rows.length < 8) return { tag: 'MIXED', pivotType: '—', pivotQuote: NaN, pivotEpoch: NaN, phase: 'UNKNOWN' };
  const { highs, lows } = pivots(rows, 1);
  const recentHighs = highs.slice(-3), recentLows = lows.slice(-3);
  const lastHigh = recentHighs.at(-1), previousHigh = recentHighs.at(-2), thirdHigh = recentHighs.at(-3);
  const lastLow = recentLows.at(-1), previousLow = recentLows.at(-2), thirdLow = recentLows.at(-3);
  const highType = lastHigh && previousHigh ? (lastHigh.quote > previousHigh.quote ? 'HH' : 'LH') : 'H';
  const lowType = lastLow && previousLow ? (lastLow.quote > previousLow.quote ? 'HL' : 'LL') : 'L';
  let pivotType = '—', pivotQuote = NaN, pivotEpoch = NaN;
  if (lastHigh && lastLow) {
    const pivot = lastHigh.epoch > lastLow.epoch ? { ...lastHigh, type: highType } : { ...lastLow, type: lowType };
    pivotType = pivot.type; pivotQuote = pivot.quote; pivotEpoch = pivot.epoch;
  } else if (lastHigh) {
    pivotType = highType; pivotQuote = lastHigh.quote; pivotEpoch = lastHigh.epoch;
  } else if (lastLow) {
    pivotType = lowType; pivotQuote = lastLow.quote; pivotEpoch = lastLow.epoch;
  }
  let tag = pivotType;
  if (pivotType === 'LL' && thirdLow && previousLow && lastLow && thirdLow.quote > previousLow.quote && previousLow.quote > lastLow.quote) tag = 'LL2';
  if (pivotType === 'HH' && thirdHigh && previousHigh && lastHigh && thirdHigh.quote < previousHigh.quote && previousHigh.quote < lastHigh.quote) tag = 'HH2';
  const current = rows.at(-1).quote, step = avgStep(rows.slice(-20)) || 1;
  let phase = 'MID';
  if (lastLow && Math.abs(current - lastLow.quote) <= step * 1.5) phase = 'NEAR_LOW';
  if (lastHigh && Math.abs(current - lastHigh.quote) <= step * 1.5) phase = 'NEAR_HIGH';
  if (lastLow && lastHigh) {
    const span = Math.abs(lastHigh.quote - lastLow.quote) || step;
    const position = (current - Math.min(lastLow.quote, lastHigh.quote)) / span;
    if (position <= 0.20) phase = 'LOW_ZONE';
    else if (position >= 0.80) phase = 'HIGH_ZONE';
  }
  return { tag, pivotType, pivotQuote, pivotEpoch, phase, highType, lowType };
}

function normalizeShape(quotes) {
  if (!quotes.length) return [];
  const base = quotes[0], path = quotes.map(quote => quote - base);
  const rms = Math.sqrt(path.reduce((sum, value) => sum + value * value, 0) / Math.max(1, path.length));
  if (!Number.isFinite(rms) || rms === 0) return path.map(() => 0);
  return path.map(value => value / rms);
}

function cosine(left, right) {
  let dot = 0, leftMagnitude = 0, rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  return leftMagnitude && rightMagnitude ? dot / Math.sqrt(leftMagnitude * rightMagnitude) : 0;
}

function auditLength(signalIndex, length, structure) {
  const currentStart = signalIndex - length + 1;
  if (currentStart < 2) return null;
  const currentShape = normalizeShape(ticks.slice(currentStart, signalIndex + 1).map(tick => tick.quote));
  const lookahead = CFG.executionOffset + CFG.FIXED_DURATION, candidates = [];
  for (let start = 0; start + length - 1 + lookahead < currentStart; start += 1) {
    const end = start + length - 1;
    const historicalShape = normalizeShape(ticks.slice(start, start + length).map(tick => tick.quote));
    const similarity = cosine(currentShape, historicalShape);
    if (similarity < CFG.SIM_FLOOR) continue;
    const entry = ticks[end + CFG.executionOffset]?.quote, exit = ticks[end + CFG.executionOffset + CFG.FIXED_DURATION]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === exit) continue;
    const historicalStructure = structureTagAt(end);
    const sameTag = historicalStructure.tag === structure.tag, samePhase = historicalStructure.phase === structure.phase;
    candidates.push({ end, similarity, weighted: similarity + (sameTag ? 0.025 : 0) + (samePhase ? 0.010 : 0), outcome: exit > entry ? 'UP' : 'DOWN', epoch: ticks[end].epoch, tag: historicalStructure.tag, phase: historicalStructure.phase });
  }
  candidates.sort((left, right) => right.weighted - left.weighted);
  const matches = [];
  for (const candidate of candidates) {
    if (matches.some(match => Math.abs(match.end - candidate.end) < Math.max(3, Math.floor(length / 3)))) continue;
    matches.push(candidate);
    if (matches.length >= CFG.MAX_MATCHES) break;
  }
  if (!matches.length) return null;
  const up = matches.filter(match => match.outcome === 'UP').length, down = matches.filter(match => match.outcome === 'DOWN').length;
  const matchCount = up + down, direction = up === down ? 'EVEN' : up > down ? 'UP' : 'DOWN';
  const edge = matchCount ? Math.max(up, down) / matchCount * 100 : 0, avgSimilarity = mean(matches.map(match => match.similarity)) * 100;
  const top10 = matches.slice(0, 10);
  const top10Agree = direction === 'UP' ? top10.filter(match => match.outcome === 'UP').length : direction === 'DOWN' ? top10.filter(match => match.outcome === 'DOWN').length : 0;
  const sameTagCount = matches.filter(match => match.tag === structure.tag).length, samePhaseCount = matches.filter(match => match.phase === structure.phase).length;
  const quality = edge + Math.min(4, sameTagCount * 0.15) + Math.min(2, samePhaseCount * 0.08) + Math.max(0, avgSimilarity - 84) * 0.08;
  const ok = matchCount >= CFG.MIN_MATCHES && avgSimilarity >= CFG.MIN_AVG_SIMILARITY && edge >= CFG.MIN_EDGE && top10.length >= 10 && top10Agree >= CFG.TOP10_MIN_AGREE && direction !== 'EVEN';
  const signature = shapeSignature(currentShape), familyId = `${length}T-${signature}-${direction}`;
  return { length, signature, familyId, ok, direction, edge, up, down, matchCount, avgSimilarity, top10Agree, top10Total: top10.length, sameTagCount, samePhaseCount, quality, weightedQuality: quality + lengthModifier(length), nearest: top10.map(match => ({ similarity: match.similarity * 100, outcome: match.outcome, epoch: match.epoch, tag: match.tag, phase: match.phase })) };
}

function patternDecision(signalIndex, structure) {
  const audits = CFG.PATTERN_LENGTHS.map(length => auditLength(signalIndex, length, structure)).filter(Boolean);
  if (!audits.length) return { ok: false, direction: 'EVEN', familyId: 'NONE', reason: 'No historical pattern family yet', audits: [] };
  const baseline = [...audits].sort((left, right) => Number(right.ok) - Number(left.ok) || right.quality - left.quality || right.edge - left.edge)[0];
  const best = [...audits].sort((left, right) => Number(right.ok) - Number(left.ok) || right.weightedQuality - left.weightedQuality || right.edge - left.edge)[0];
  return { ...best, audits, baseline: baseline ? { familyId: baseline.familyId, length: baseline.length, direction: baseline.direction, edge: baseline.edge, ok: baseline.ok } : null, reason: best.ok ? `${best.familyId} · ${best.edge.toFixed(1)}% · ${best.matchCount} relatives · top10 ${best.top10Agree}/${best.top10Total}` : `${best.familyId} weak · ${best.edge.toFixed(1)}% · ${best.matchCount} relatives · top10 ${best.top10Agree}/${best.top10Total}` };
}

function resolveShadows() {
  for (const [signalId, row] of pendingShadows.entries()) {
    const start = row.signalIndex + row.executionOffset, end = start + row.duration;
    if (end >= ticks.length) continue;
    const entry = ticks[start]?.quote, exit = ticks[end]?.quote;
    if (!Number.isFinite(entry) || !Number.isFinite(exit)) continue;
    const won = row.tradeDirection === 'CALL' ? exit > entry : exit < entry;
    if (entry !== exit) {
      bumpMemory(familyMemory, row.familyId, won);
      bumpMemory(addressMemory, row.addressKey, won);
    }
    const outcomeFor = direction => entry === exit ? 'FLAT' : direction === 'CALL' ? (exit > entry ? 'WON' : 'LOST') : (exit < entry ? 'WON' : 'LOST');
    const variantOutcomes = Object.fromEntries(Object.entries(row.variants || {}).map(([key, active]) => [key, active ? outcomeFor(row.variantDirections?.[key] || row.tradeDirection) : null]));
    const shadow = { outcome: entry === exit ? 'FLAT' : won ? 'WON' : 'LOST', entry, exit, entryEpoch: ticks[start]?.epoch, exitEpoch: ticks[end]?.epoch, duration: row.duration, executionOffset: row.executionOffset };
    emit('SHADOW_RESULT', { signalId, shadow, variants: row.variants, variantOutcomes, familyId: row.familyId, addressKey: row.addressKey });
    pendingShadows.delete(signalId);
  }
}

function evaluateTick() {
  const started = perfNow();
  resolveShadows();
  const signalIndex = ticks.length - 1, last = ticks.at(-1);
  if (!last) return;
  if (ticks.length < 80) {
    lastAnalysis = { version: CFG.VERSION, state: 'WARMING', reason: `Need 80 ticks (${ticks.length}/80)`, tick: last, decisionMs: perfNow() - started, config: CFG };
    emit('ANALYSIS', { analysis: lastAnalysis });
    return;
  }
  const structure = structureTagAt(signalIndex), pattern = patternDecision(signalIndex, structure);
  const addressKey = addressKeyFor(pattern.familyId, structure);
  const sniper = policy.evaluate({ pattern, structure, familyMemory: familyMemory.get(pattern.familyId) || {}, addressMemory: addressMemory.get(addressKey) || {}, epoch: last.epoch });
  sniper.variants.control = Boolean(pattern.baseline?.ok);
  const context80 = softDirection(ticks.slice(-80)), context200 = ticks.length >= 200 ? softDirection(ticks.slice(-200)) : 'WARMING';
  const tradeDirection = sniper.direction === 'UP' ? 'CALL' : sniper.direction === 'DOWN' ? 'PUT' : 'NONE';
  const approved = sniper.sniperApproved, signalId = `v81-${last.epoch}-${pattern.familyId || 'none'}`, decisionMs = perfNow() - started;
  const why = approved ? `${sniper.event} ${sniper.grade} · score ${sniper.score.toFixed(1)} · repeat ${sniper.repeatCount} · ${pattern.reason}` : sniper.event === 'SEED' ? `SEED · waiting up to ${sniper.repeatWindow} ticks for the same family to repeat` : sniper.event === 'HOLD' ? `LOCK ${sniper.campaign.direction} · opposing evidence ${sniper.opposingVotes}/${policy.config.flipVotes}` : `${sniper.event} · score ${sniper.score.toFixed(1)} needs ${policy.config.fireScore} · ${pattern.reason}`;
  const decision = { signalId, approved, controlApproved: Boolean(sniper.variants.control), state: approved ? 'ENTER' : sniper.event, tradeDirection, predicted: sniper.direction, signalEpoch: last.epoch, signalQuote: last.quote, duration: CFG.FIXED_DURATION, executionOffset: CFG.executionOffset, structure, pattern, sniper, variants: sniper.variants, context80, context200, campaign: sniper.campaign, requestedBatch: sniper.batch, decisionMs, why };
  lastAnalysis = { version: CFG.VERSION, state: decision.state, reason: why, tick: last, structure, pattern, sniper, variants: sniper.variants, context80, context200, campaign: sniper.campaign, decisionMs, config: CFG };
  emit('ANALYSIS', { analysis: lastAnalysis });
  emit('DECISION', { decision });
  if ((sniper.baseOk || sniper.variants.control) && tradeDirection !== 'NONE') pendingShadows.set(signalId, { signalIndex, executionOffset: CFG.executionOffset, duration: CFG.FIXED_DURATION, tradeDirection, familyId: pattern.familyId, addressKey, variants: sniper.variants, variantDirections:{ control:pattern.baseline?.direction==='UP'?'CALL':pattern.baseline?.direction==='DOWN'?'PUT':tradeDirection } });
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
  const message = event.data || {};
  if (message.type === 'INIT') {
    ticks = dedupe(message.ticks || []);
    if (Number.isFinite(+message.executionOffset)) CFG.executionOffset = clamp(Math.round(+message.executionOffset), 1, 10);
    hydrateMemory(message.memoryRows || []);
    policy = new SniperCampaignPolicy(message.sniperConfig || {});
    evaluateTick();
  } else if (message.type === 'TICK') addTick(message.tick);
  else if (message.type === 'CONFIG' && Number.isFinite(+message.executionOffset)) CFG.executionOffset = clamp(Math.round(+message.executionOffset), 1, 10);
  else if (message.type === 'RESET') { policy.reset(); pendingShadows.clear(); evaluateTick(); }
};
