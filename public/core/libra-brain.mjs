const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const sign = value => Number(value) > 0 ? 1 : Number(value) < 0 ? -1 : 0;
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -18, 18)));

export const LIBRA_VERSION = 'Libra v1 · Adaptive Tick Intelligence';
export const LIBRA_FEATURES = Object.freeze([
  'slope3','slope5','slope8','slope13','slope21','slope34',
  'acceleration','curvature','efficiency8','efficiency21',
  'pressure8','pressure21','volatilityRatio','reversal'
]);

function median(values = []) {
  const rows = values.map(Number).filter(Number.isFinite).sort((a,b) => a-b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function regressionSlope(values = []) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + Number(value), 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += (i - xMean) * (Number(values[i]) - yMean);
    denominator += (i - xMean) ** 2;
  }
  return denominator ? numerator / denominator : 0;
}

function takeLast(values, n) {
  return values.slice(Math.max(0, values.length - Math.max(2, n)));
}

function pathEfficiency(values = []) {
  if (values.length < 2) return 0;
  const net = Math.abs(Number(values.at(-1)) - Number(values[0]));
  let travelled = 0;
  for (let i = 1; i < values.length; i += 1) travelled += Math.abs(Number(values[i]) - Number(values[i - 1]));
  return travelled ? clamp(net / travelled, 0, 1) : 0;
}

function pressure(values = []) {
  if (values.length < 2) return 0;
  let up = 0, down = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = Number(values[i]) - Number(values[i - 1]);
    if (delta > 0) up += 1;
    else if (delta < 0) down += 1;
  }
  const decided = up + down;
  return decided ? (up - down) / decided : 0;
}

function meanAbsDiff(values = []) {
  if (values.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < values.length; i += 1) total += Math.abs(Number(values[i]) - Number(values[i - 1]));
  return total / (values.length - 1);
}

function normalizeSlope(quotes, horizon, scale) {
  const slope = regressionSlope(takeLast(quotes, horizon));
  return clamp(slope / Math.max(scale, 1e-9), -4, 4) / 4;
}

function horizonForecast(physics, horizon) {
  const horizonSlope = physics[`slope${horizon}`] ?? (
    horizon <= 3 ? physics.slope3 : horizon <= 5 ? physics.slope5 : horizon <= 8 ? physics.slope8 : horizon <= 13 ? physics.slope13 : physics.slope21
  );
  const persistence = 0.48 * horizonSlope + 0.18 * physics.pressure8 + 0.12 * physics.pressure21;
  const bend = 0.14 * physics.acceleration + 0.08 * physics.curvature;
  const chopPenalty = (1 - physics.efficiency21) * 0.22;
  const raw = persistence + bend - sign(persistence) * chopPenalty;
  return {
    horizon,
    score:raw,
    direction:raw > 0.05 ? 'UP' : raw < -0.05 ? 'DOWN' : 'NONE',
    confidence:clamp(Math.abs(raw) * 115, 0, 99)
  };
}

function classifyRegime(p) {
  const long = 0.55 * p.slope21 + 0.45 * p.slope34;
  const short = 0.55 * p.slope3 + 0.45 * p.slope5;
  if (p.efficiency21 < 0.24 && Math.abs(p.pressure21) < 0.34) return 'CHOP';
  if (long > 0.10 && short < -0.05 && p.acceleration < -0.08) return 'UP EXHAUSTION';
  if (long < -0.10 && short > 0.05 && p.acceleration > 0.08) return 'DOWN EXHAUSTION';
  if (long <= 0 && short > 0.11 && p.acceleration > 0.04) return 'TRANSITION UP';
  if (long >= 0 && short < -0.11 && p.acceleration < -0.04) return 'TRANSITION DOWN';
  if (long > 0.11 && p.efficiency21 > 0.38 && p.pressure21 > 0.05) return 'DRIVE UP';
  if (long < -0.11 && p.efficiency21 > 0.38 && p.pressure21 < -0.05) return 'DRIVE DOWN';
  if (Math.abs(long) < 0.07 && Math.abs(short) < 0.08) return 'BALANCE';
  return long >= 0 ? 'UP BUILD' : 'DOWN BUILD';
}

function stateSignature(p) {
  const q = (value, edges) => {
    let bucket = 0;
    for (const edge of edges) if (value > edge) bucket += 1;
    return bucket;
  };
  return [
    classifyRegime(p),
    q(p.slope5, [-0.25,-0.08,0.08,0.25]),
    q(p.slope21, [-0.2,-0.06,0.06,0.2]),
    q(p.acceleration, [-0.18,-0.05,0.05,0.18]),
    q(p.efficiency21, [0.2,0.35,0.55,0.75]),
    q(p.volatilityRatio, [0.75,0.95,1.15,1.45])
  ].join('|');
}

export function extractLibraPhysics(ticks = []) {
  const rows = ticks
    .map(row => ({ epoch:Number(row?.epoch), quote:Number(row?.quote) }))
    .filter(row => Number.isFinite(row.epoch) && Number.isFinite(row.quote))
    .sort((a,b) => a.epoch - b.epoch)
    .slice(-160);
  const quotes = rows.map(row => row.quote);
  if (quotes.length < 3) {
    return {
      ready:false, tickCount:quotes.length, quote:quotes.at(-1), epoch:rows.at(-1)?.epoch,
      regime:'BOOTING', direction:'NONE', confidence:0, signature:'BOOTING',
      horizons:[1,3,5,8,13].map(horizon => ({horizon,direction:'NONE',confidence:0,score:0})),
      features:LIBRA_FEATURES.map(() => 0)
    };
  }
  const diffs = quotes.slice(1).map((quote,index) => quote - quotes[index]);
  const absDiffs = diffs.map(Math.abs).filter(value => value > 0);
  const scale = Math.max(median(absDiffs.slice(-34)), meanAbsDiff(takeLast(quotes, 34)) * 0.7, 1e-9);
  const physics = {
    slope3:normalizeSlope(quotes,3,scale),
    slope5:normalizeSlope(quotes,5,scale),
    slope8:normalizeSlope(quotes,8,scale),
    slope13:normalizeSlope(quotes,13,scale),
    slope21:normalizeSlope(quotes,21,scale),
    slope34:normalizeSlope(quotes,34,scale),
    efficiency8:pathEfficiency(takeLast(quotes,8)),
    efficiency21:pathEfficiency(takeLast(quotes,21)),
    pressure8:pressure(takeLast(quotes,8)),
    pressure21:pressure(takeLast(quotes,21))
  };
  physics.acceleration = clamp((physics.slope3 + physics.slope5) / 2 - (physics.slope13 + physics.slope21) / 2, -1, 1);
  physics.curvature = clamp(physics.slope3 - 2 * physics.slope8 + physics.slope21, -1, 1);
  const vol8 = meanAbsDiff(takeLast(quotes,8));
  const vol34 = meanAbsDiff(takeLast(quotes,34));
  physics.volatilityRatio = clamp(vol8 / Math.max(vol34, 1e-9), 0, 3) / 1.5 - 1;
  physics.reversal = clamp((sign(physics.slope21) && sign(physics.slope3) && sign(physics.slope21) !== sign(physics.slope3)) ? Math.abs(physics.slope3 - physics.slope21) : 0, 0, 1);
  const regime = classifyRegime(physics);
  const horizons = [1,3,5,8,13].map(horizon => horizonForecast(physics, horizon));
  const strongest = [...horizons].sort((a,b) => b.confidence - a.confidence)[0];
  const baseScore =
    0.15 * physics.slope3 +
    0.14 * physics.slope5 +
    0.13 * physics.slope8 +
    0.10 * physics.slope13 +
    0.08 * physics.slope21 +
    0.06 * physics.slope34 +
    0.12 * physics.acceleration +
    0.06 * physics.curvature +
    0.07 * physics.pressure8 +
    0.05 * physics.pressure21 +
    0.04 * (physics.efficiency21 * sign(physics.slope13));
  const baseProbabilityUp = sigmoid(baseScore * 3.2);
  return {
    ...physics,
    ready:quotes.length >= 55,
    tickCount:quotes.length,
    quote:quotes.at(-1),
    epoch:rows.at(-1)?.epoch,
    regime,
    direction:baseProbabilityUp >= 0.55 ? 'UP' : baseProbabilityUp <= 0.45 ? 'DOWN' : 'NONE',
    confidence:Math.abs(baseProbabilityUp - 0.5) * 200,
    baseProbabilityUp,
    bestHorizon:strongest?.horizon || 1,
    horizons,
    signature:stateSignature(physics),
    features:LIBRA_FEATURES.map(key => clamp(physics[key] ?? 0, -1, 1))
  };
}

function freshState() {
  return {
    weights:Array(LIBRA_FEATURES.length).fill(0),
    bias:0,
    updates:0,
    mistakes:0,
    correct:0,
    skippedFlats:0,
    generation:1,
    stateMemory:{},
    recent:[],
    lastLesson:'I am collecting the first clean tick states.',
    lastLearnMs:0,
    lastUpdateAt:0
  };
}

export class LibraBrain {
  constructor(saved = null, config = {}) {
    this.config = {
      baseLearningRate:0.075,
      mistakeBoost:1.9,
      l2:0.0008,
      leadConfidence:78,
      replaceConfidence:70,
      blockConfidence:53,
      minTicks:55,
      minMemoryForHardBlock:8,
      ...config
    };
    this.state = freshState();
    if (saved) this.importState(saved);
  }

  importState(saved) {
    try {
      const source = typeof saved === 'string' ? JSON.parse(saved) : saved;
      const weights = Array.isArray(source?.weights) ? source.weights.map(Number).slice(0, LIBRA_FEATURES.length) : [];
      if (weights.length === LIBRA_FEATURES.length && weights.every(Number.isFinite)) this.state.weights = weights;
      for (const key of ['bias','updates','mistakes','correct','skippedFlats','generation','lastLearnMs','lastUpdateAt']) {
        if (Number.isFinite(Number(source?.[key]))) this.state[key] = Number(source[key]);
      }
      this.state.stateMemory = source?.stateMemory && typeof source.stateMemory === 'object' ? source.stateMemory : {};
      this.state.recent = Array.isArray(source?.recent) ? source.recent.slice(-120).map(Boolean) : [];
      if (typeof source?.lastLesson === 'string') this.state.lastLesson = source.lastLesson;
    } catch {}
    return this.snapshot();
  }

  exportState() {
    const memoryEntries = Object.entries(this.state.stateMemory)
      .sort((a,b) => Number(b[1]?.lastAt || 0) - Number(a[1]?.lastAt || 0))
      .slice(0, 600);
    return {
      weights:[...this.state.weights], bias:this.state.bias, updates:this.state.updates,
      mistakes:this.state.mistakes, correct:this.state.correct, skippedFlats:this.state.skippedFlats,
      generation:this.state.generation, stateMemory:Object.fromEntries(memoryEntries), recent:[...this.state.recent],
      lastLesson:this.state.lastLesson, lastLearnMs:this.state.lastLearnMs, lastUpdateAt:this.state.lastUpdateAt
    };
  }

  learnedProbability(features = []) {
    let z = this.state.bias;
    for (let i = 0; i < this.state.weights.length; i += 1) z += this.state.weights[i] * clamp(features[i] ?? 0, -1, 1);
    return sigmoid(z);
  }

  memoryProbability(signature) {
    const row = this.state.stateMemory[signature];
    if (!row || Number(row.total || 0) < 2) return null;
    return (Number(row.up || 0) + 1.5) / (Number(row.total || 0) + 3);
  }

  predict(ticks = []) {
    const physics = extractLibraPhysics(ticks);
    const learned = this.learnedProbability(physics.features || []);
    const memory = this.memoryProbability(physics.signature);
    const experienceWeight = clamp(this.state.updates / 90, 0, 0.62);
    let pUp = (physics.baseProbabilityUp ?? 0.5) * (1 - experienceWeight) + learned * experienceWeight;
    if (memory != null) {
      const memoryWeight = clamp((this.state.stateMemory[physics.signature]?.total || 0) / 18, 0.12, 0.42);
      pUp = pUp * (1 - memoryWeight) + memory * memoryWeight;
    }
    pUp = clamp(pUp, 0.02, 0.98);
    const direction = pUp >= 0.55 ? 'UP' : pUp <= 0.45 ? 'DOWN' : 'NONE';
    const confidence = Math.abs(pUp - 0.5) * 200;
    return {
      ...physics,
      probabilityUp:pUp,
      learnedProbabilityUp:learned,
      memoryProbabilityUp:memory,
      direction,
      confidence,
      ready:physics.tickCount >= this.config.minTicks,
      experienceWeight
    };
  }

  decide({ ticks = [], sourceDecision = {}, openContracts = 0, runPnl = 0 } = {}) {
    const prediction = this.predict(ticks);
    const sourceApproved = Boolean(sourceDecision?.approved);
    const sourceDirection = ['CALL','PUT'].includes(sourceDecision?.tradeDirection) ? sourceDecision.tradeDirection : 'NONE';
    const libraDirection = prediction.direction === 'UP' ? 'CALL' : prediction.direction === 'DOWN' ? 'PUT' : 'NONE';
    const memoryCount = Number(this.state.stateMemory[prediction.signature]?.total || 0);
    const cleanRegime = !['CHOP','BALANCE'].includes(prediction.regime);
    let action = 'YIELD';
    let approved = sourceApproved;
    let tradeDirection = sourceDirection;
    let reason = 'I am letting SMFN keep the wheel while I gather cleaner evidence.';

    if (!prediction.ready) {
      action = sourceApproved ? 'YIELD' : 'LISTEN';
      reason = `I need ${Math.max(0, this.config.minTicks - prediction.tickCount)} more clean ticks before I take authority.`;
    } else if (prediction.regime === 'CHOP' && prediction.confidence < this.config.blockConfidence) {
      if (sourceApproved && (memoryCount >= this.config.minMemoryForHardBlock || this.state.updates >= 25)) {
        action = 'BLOCK'; approved = false; tradeDirection = 'NONE';
        reason = `No. This is CHOP with only ${prediction.confidence.toFixed(0)}% directional conviction. I am not paying for noise.`;
      } else {
        action = sourceApproved ? 'YIELD' : 'STAND DOWN'; approved = sourceApproved; tradeDirection = sourceDirection;
        reason = 'The market is inefficient and noisy. I do not have enough retained evidence to overrule SMFN yet.';
      }
    } else if (sourceApproved && libraDirection !== 'NONE' && sourceDirection === libraDirection) {
      action = 'AGREE'; approved = true; tradeDirection = sourceDirection;
      reason = `SMFN and I agree on ${tradeDirection}. ${prediction.regime}, ${prediction.confidence.toFixed(0)}% conviction, best read ${prediction.bestHorizon}T.`;
    } else if (sourceApproved && libraDirection !== 'NONE' && sourceDirection !== libraDirection && prediction.confidence >= this.config.replaceConfidence && cleanRegime) {
      action = 'REPLACE'; approved = true; tradeDirection = libraDirection;
      reason = `SMFN wants ${sourceDirection}. I do not. ${prediction.regime} gives me ${prediction.confidence.toFixed(0)}% for ${libraDirection}, so I am replacing the entry.`;
    } else if (!sourceApproved && libraDirection !== 'NONE' && prediction.confidence >= this.config.leadConfidence && cleanRegime && openContracts <= 1) {
      action = 'LEAD'; approved = true; tradeDirection = libraDirection;
      reason = `SMFN is quiet. I am taking ${libraDirection}: ${prediction.regime}, ${prediction.confidence.toFixed(0)}% conviction, ${prediction.bestHorizon}T is the cleanest horizon.`;
    } else if (sourceApproved) {
      action = 'YIELD'; approved = true; tradeDirection = sourceDirection;
      reason = `I am not convinced enough to overrule ${sourceDirection}. SMFN may continue.`;
    } else {
      action = 'STAND DOWN'; approved = false; tradeDirection = 'NONE';
      reason = `No clean paid edge. ${prediction.regime}, ${prediction.confidence.toFixed(0)}% conviction. We wait.`;
    }

    return {
      action, approved, tradeDirection, sourceDirection, sourceApproved,
      runPnl:Number(runPnl) || 0, openContracts:Number(openContracts) || 0,
      ...prediction,
      reason,
      modelGeneration:this.state.generation,
      retainedStates:Object.keys(this.state.stateMemory).length,
      updates:this.state.updates,
      lastLearnMs:this.state.lastLearnMs,
      lastLesson:this.state.lastLesson
    };
  }

  learn({ features = [], signature = 'UNKNOWN', predictedUp = 0.5, actualUp, regime = 'UNKNOWN', confidence = 0 } = {}) {
    if (actualUp !== true && actualUp !== false) {
      this.state.skippedFlats += 1;
      return this.snapshot();
    }
    const start = globalThis.performance?.now?.() ?? Date.now();
    const y = actualUp ? 1 : 0;
    const p = clamp(Number(predictedUp), 0.01, 0.99);
    const predictedLabel = p >= 0.5;
    const correct = predictedLabel === actualUp;
    const error = y - p;
    const boost = correct ? 1 : this.config.mistakeBoost * (1 + Math.min(0.8, Math.abs(p - 0.5)));
    const lr = this.config.baseLearningRate * boost / Math.sqrt(1 + this.state.updates / 160);
    for (let i = 0; i < this.state.weights.length; i += 1) {
      const x = clamp(features[i] ?? 0, -1, 1);
      this.state.weights[i] = clamp(this.state.weights[i] * (1 - this.config.l2) + lr * error * x, -4, 4);
    }
    this.state.bias = clamp(this.state.bias + lr * error * 0.55, -3, 3);
    this.state.updates += 1;
    if (correct) this.state.correct += 1;
    else this.state.mistakes += 1;
    this.state.recent.push(correct);
    this.state.recent = this.state.recent.slice(-120);
    if (this.state.updates % 25 === 0) this.state.generation += 1;
    const row = this.state.stateMemory[signature] || { up:0, down:0, total:0, mistakes:0, lastAt:0 };
    if (actualUp) row.up += 1; else row.down += 1;
    row.total += 1;
    if (!correct) row.mistakes += 1;
    row.lastAt = Date.now();
    this.state.stateMemory[signature] = row;
    this.state.lastLesson = correct
      ? `${regime}: that ${predictedLabel ? 'UP' : 'DOWN'} read held. I strengthened the state memory.`
      : `${regime}: I was wrong at ${Number(confidence || 0).toFixed(0)}% confidence. I corrected the weights and retained this state.`;
    this.state.lastUpdateAt = Date.now();
    const end = globalThis.performance?.now?.() ?? Date.now();
    this.state.lastLearnMs = Math.max(0, end - start);
    return this.snapshot();
  }

  snapshot() {
    const total = this.state.correct + this.state.mistakes;
    const recent = this.state.recent;
    const last20 = recent.slice(-20);
    const previous20 = recent.slice(-40,-20);
    const accuracy = total ? this.state.correct / total * 100 : 0;
    const recentAccuracy = last20.length ? last20.filter(Boolean).length / last20.length * 100 : 0;
    const previousAccuracy = previous20.length ? previous20.filter(Boolean).length / previous20.length * 100 : recentAccuracy;
    return {
      version:LIBRA_VERSION,
      generation:this.state.generation,
      updates:this.state.updates,
      mistakes:this.state.mistakes,
      correct:this.state.correct,
      accuracy,
      recentAccuracy,
      improvement:recentAccuracy - previousAccuracy,
      retainedStates:Object.keys(this.state.stateMemory).length,
      lastLesson:this.state.lastLesson,
      lastLearnMs:this.state.lastLearnMs,
      lastUpdateAt:this.state.lastUpdateAt
    };
  }
}
