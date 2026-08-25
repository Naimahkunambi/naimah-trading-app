const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const sign = value => Number(value) > 0 ? 1 : Number(value) < 0 ? -1 : 0;
const sigmoid = value => 1 / (1 + Math.exp(-clamp(value, -18, 18)));
const PAYOUT = 0.92;

export const LIBRA_VERSION = 'Libra v2 · Adaptive Action Intelligence';
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
    q(p.volatilityRatio, [-0.35,-0.05,0.2,0.55])
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
    slope3:normalizeSlope(quotes,3,scale), slope5:normalizeSlope(quotes,5,scale),
    slope8:normalizeSlope(quotes,8,scale), slope13:normalizeSlope(quotes,13,scale),
    slope21:normalizeSlope(quotes,21,scale), slope34:normalizeSlope(quotes,34,scale),
    efficiency8:pathEfficiency(takeLast(quotes,8)), efficiency21:pathEfficiency(takeLast(quotes,21)),
    pressure8:pressure(takeLast(quotes,8)), pressure21:pressure(takeLast(quotes,21))
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
    0.15 * physics.slope3 + 0.14 * physics.slope5 + 0.13 * physics.slope8 +
    0.10 * physics.slope13 + 0.08 * physics.slope21 + 0.06 * physics.slope34 +
    0.12 * physics.acceleration + 0.06 * physics.curvature +
    0.07 * physics.pressure8 + 0.05 * physics.pressure21 +
    0.04 * (physics.efficiency21 * sign(physics.slope13));
  const baseProbabilityUp = sigmoid(baseScore * 3.2);
  return {
    ...physics,
    ready:quotes.length >= 55,
    tickCount:quotes.length,
    quote:quotes.at(-1), epoch:rows.at(-1)?.epoch,
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
    weights:Array(LIBRA_FEATURES.length).fill(0), bias:0,
    updates:0, mistakes:0, correct:0, skippedFlats:0,
    generation:1, promotions:0,
    stateMemory:{}, actionMemory:{}, regimeMemory:{}, horizonMemory:{},
    recent:[], shadowRecent:[], shadowLessons:0, shadowMistakes:0, actionWins:0, actionLosses:0,
    lastLesson:'I am collecting the first clean tick states.',
    lastInsight:'I am still mapping which decisions deserve money.',
    lastLearnMs:0, lastUpdateAt:0, lastPromotionAt:0
  };
}

function trimObject(source = {}, limit = 1000) {
  return Object.fromEntries(Object.entries(source)
    .sort((a,b) => Number(b[1]?.lastAt || 0) - Number(a[1]?.lastAt || 0))
    .slice(0, limit));
}

export class LibraBrain {
  constructor(saved = null, config = {}) {
    this.config = {
      baseLearningRate:0.075,
      mistakeBoost:1.9,
      l2:0.0008,
      minTicks:55,
      minPaidEdge:0.025,
      minExactActionSamples:3,
      promotionWindow:30,
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
      for (const key of ['bias','updates','mistakes','correct','skippedFlats','generation','promotions','shadowLessons','shadowMistakes','actionWins','actionLosses','lastLearnMs','lastUpdateAt','lastPromotionAt']) {
        if (Number.isFinite(Number(source?.[key]))) this.state[key] = Number(source[key]);
      }
      for (const key of ['stateMemory','actionMemory','regimeMemory','horizonMemory']) {
        if (source?.[key] && typeof source[key] === 'object') this.state[key] = source[key];
      }
      this.state.recent = Array.isArray(source?.recent) ? source.recent.slice(-160).map(Boolean) : [];
      this.state.shadowRecent = Array.isArray(source?.shadowRecent) ? source.shadowRecent.slice(-120) : [];
      if (typeof source?.lastLesson === 'string') this.state.lastLesson = source.lastLesson;
      if (typeof source?.lastInsight === 'string') this.state.lastInsight = source.lastInsight;
    } catch {}
    return this.snapshot();
  }

  exportState() {
    return {
      weights:[...this.state.weights], bias:this.state.bias,
      updates:this.state.updates, mistakes:this.state.mistakes, correct:this.state.correct, skippedFlats:this.state.skippedFlats,
      generation:this.state.generation, promotions:this.state.promotions,
      stateMemory:trimObject(this.state.stateMemory,700),
      actionMemory:trimObject(this.state.actionMemory,1400),
      regimeMemory:trimObject(this.state.regimeMemory,80),
      horizonMemory:trimObject(this.state.horizonMemory,20),
      recent:[...this.state.recent], shadowRecent:[...this.state.shadowRecent],
      shadowLessons:this.state.shadowLessons, shadowMistakes:this.state.shadowMistakes,
      actionWins:this.state.actionWins, actionLosses:this.state.actionLosses,
      lastLesson:this.state.lastLesson, lastInsight:this.state.lastInsight,
      lastLearnMs:this.state.lastLearnMs, lastUpdateAt:this.state.lastUpdateAt, lastPromotionAt:this.state.lastPromotionAt
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
    const experienceWeight = clamp(this.state.updates / 120, 0, 0.68);
    let pUp = (physics.baseProbabilityUp ?? 0.5) * (1 - experienceWeight) + learned * experienceWeight;
    if (memory != null) {
      const memoryWeight = clamp((this.state.stateMemory[physics.signature]?.total || 0) / 24, 0.10, 0.48);
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

  actionKey(signature, sourceApproved, sourceDirection, action, tradeDirection) {
    return `${signature}|SRC:${sourceApproved ? sourceDirection : 'QUIET'}|ACT:${action}|DIR:${tradeDirection || 'NONE'}`;
  }

  coarseActionKey(regime, sourceApproved, sourceDirection, action, tradeDirection) {
    return `REG:${regime}|SRC:${sourceApproved ? sourceDirection : 'QUIET'}|ACT:${action}|DIR:${tradeDirection || 'NONE'}`;
  }

  actionStats(prediction, sourceApproved, sourceDirection, action, tradeDirection) {
    const exact = this.state.actionMemory[this.actionKey(prediction.signature, sourceApproved, sourceDirection, action, tradeDirection)] || null;
    const coarse = this.state.actionMemory[this.coarseActionKey(prediction.regime, sourceApproved, sourceDirection, action, tradeDirection)] || null;
    const exactN = Number(exact?.attempts || 0), coarseN = Number(coarse?.attempts || 0);
    const exactAvg = exactN ? Number(exact.utility || 0) / exactN : 0;
    const coarseAvg = coarseN ? Number(coarse.utility || 0) / coarseN : 0;
    const memoryWeight = clamp(exactN / 8, 0, 0.72);
    const avgUtility = exactAvg * memoryWeight + coarseAvg * (1 - memoryWeight) * clamp(coarseN / 16, 0, 1);
    return { exactN, coarseN, avgUtility, exact, coarse };
  }

  directionExpectedValue(direction, probabilityUp) {
    if (!['CALL','PUT'].includes(direction)) return 0;
    const pWin = direction === 'CALL' ? probabilityUp : 1 - probabilityUp;
    return pWin * PAYOUT - (1 - pWin);
  }

  choosePolicy(prediction, sourceApproved, sourceDirection, mode = 'PAID') {
    const libraDirection = prediction.direction === 'UP' ? 'CALL' : prediction.direction === 'DOWN' ? 'PUT' : 'NONE';
    const candidates = [];
    const add = (action, tradeDirection, baseScore) => {
      const stats = this.actionStats(prediction, sourceApproved, sourceDirection, action, tradeDirection);
      const exploration = mode === 'SHADOW' ? 0.055 / Math.sqrt(1 + stats.exactN) : 0;
      const memoryBonus = clamp(stats.avgUtility, -1, 1) * 0.58;
      const chopBonus = ['CHOP','BALANCE'].includes(prediction.regime) && !['CALL','PUT'].includes(tradeDirection) ? 0.045 : 0;
      candidates.push({action, tradeDirection, score:baseScore + memoryBonus + exploration + chopBonus, stats});
    };

    if (sourceApproved) {
      add('YIELD', sourceDirection, this.directionExpectedValue(sourceDirection, prediction.probabilityUp));
      add('BLOCK', 'NONE', 0);
      if (libraDirection !== 'NONE') {
        if (libraDirection === sourceDirection) add('AGREE', sourceDirection, this.directionExpectedValue(sourceDirection, prediction.probabilityUp) + 0.012);
        else add('REPLACE', libraDirection, this.directionExpectedValue(libraDirection, prediction.probabilityUp) + 0.018);
      }
    } else {
      add('STAND DOWN', 'NONE', 0);
      if (libraDirection !== 'NONE') add('LEAD', libraDirection, this.directionExpectedValue(libraDirection, prediction.probabilityUp));
    }

    candidates.sort((a,b) => b.score - a.score);
    let chosen = candidates[0] || {action:'STAND DOWN',tradeDirection:'NONE',score:0,stats:{exactN:0,coarseN:0,avgUtility:0}};
    if (mode !== 'SHADOW' && ['LEAD','REPLACE'].includes(chosen.action) && chosen.score < this.config.minPaidEdge) {
      chosen = candidates.find(row => sourceApproved ? ['YIELD','AGREE','BLOCK'].includes(row.action) : row.action === 'STAND DOWN') || chosen;
    }
    return {...chosen, candidates};
  }

  decide({ ticks = [], sourceDecision = {}, openContracts = 0, runPnl = 0, mode = 'PAID' } = {}) {
    const prediction = this.predict(ticks);
    const sourceApproved = Boolean(sourceDecision?.approved);
    const sourceDirection = ['CALL','PUT'].includes(sourceDecision?.tradeDirection) ? sourceDecision.tradeDirection : 'NONE';

    if (!prediction.ready) {
      return {
        action:sourceApproved ? 'YIELD' : 'LISTEN', approved:sourceApproved,
        tradeDirection:sourceApproved ? sourceDirection : 'NONE', sourceDirection, sourceApproved,
        runPnl:Number(runPnl)||0, openContracts:Number(openContracts)||0,
        ...prediction,
        reason:`I need ${Math.max(0, this.config.minTicks - prediction.tickCount)} more clean ticks before I compare policies.`,
        policyMode:mode, policyScore:0, policySamples:0,
        modelGeneration:this.state.generation,
        retainedStates:Object.keys(this.state.stateMemory).length,
        updates:this.state.updates, lastLearnMs:this.state.lastLearnMs, lastLesson:this.state.lastLesson
      };
    }

    const policy = this.choosePolicy(prediction, sourceApproved, sourceDirection, mode);
    const approved = ['CALL','PUT'].includes(policy.tradeDirection);
    const tradeDirection = approved ? policy.tradeDirection : 'NONE';
    const sampleText = policy.stats.exactN
      ? `${policy.stats.exactN} exact-state lessons`
      : policy.stats.coarseN ? `${policy.stats.coarseN} regime lessons` : 'no matching action memory yet';
    const scoreText = `${policy.score >= 0 ? '+' : ''}${policy.score.toFixed(3)} utility`;
    const reason = mode === 'SHADOW'
      ? `${prediction.regime}. I choose ${policy.action}${approved ? ` ${tradeDirection}` : ''} in shadow. ${sampleText}; ${scoreText}. I will score this against SANI on the next settled tick.`
      : `${prediction.regime}. ${policy.action}${approved ? ` ${tradeDirection}` : ''} has the best retained decision utility here. ${sampleText}; ${scoreText}.`;

    return {
      action:policy.action, approved, tradeDirection, sourceDirection, sourceApproved,
      runPnl:Number(runPnl)||0, openContracts:Number(openContracts)||0,
      ...prediction,
      reason,
      policyMode:mode,
      policyScore:policy.score,
      policySamples:policy.stats.exactN + policy.stats.coarseN,
      policyCandidates:policy.candidates.map(row=>({action:row.action,direction:row.tradeDirection,score:row.score,samples:row.stats.exactN+row.stats.coarseN})),
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
    const lr = this.config.baseLearningRate * boost / Math.sqrt(1 + this.state.updates / 180);
    for (let i = 0; i < this.state.weights.length; i += 1) {
      const x = clamp(features[i] ?? 0, -1, 1);
      this.state.weights[i] = clamp(this.state.weights[i] * (1 - this.config.l2) + lr * error * x, -4, 4);
    }
    this.state.bias = clamp(this.state.bias + lr * error * 0.55, -3, 3);
    this.state.updates += 1;
    if (correct) this.state.correct += 1; else this.state.mistakes += 1;
    this.state.recent.push(correct);
    this.state.recent = this.state.recent.slice(-160);
    const row = this.state.stateMemory[signature] || { up:0, down:0, total:0, mistakes:0, lastAt:0 };
    if (actualUp) row.up += 1; else row.down += 1;
    row.total += 1; if (!correct) row.mistakes += 1; row.lastAt = Date.now();
    this.state.stateMemory[signature] = row;
    this.state.lastLesson = correct
      ? `${regime}: the directional read held. I kept the state.`
      : `${regime}: my directional read was wrong at ${Number(confidence||0).toFixed(0)}%. I corrected the weights immediately.`;
    this.state.lastUpdateAt = Date.now();
    this.state.lastLearnMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - start);
    return this.snapshot();
  }

  updateActionRow(key, {utility, libraPnl, saniPnl, won, mistake}) {
    const row = this.state.actionMemory[key] || {attempts:0,wins:0,losses:0,utility:0,libraPnl:0,saniPnl:0,mistakes:0,lastAt:0};
    row.attempts += 1;
    if (won === true) row.wins += 1; else if (won === false) row.losses += 1;
    row.utility += Number(utility||0);
    row.libraPnl += Number(libraPnl||0);
    row.saniPnl += Number(saniPnl||0);
    if (mistake) row.mistakes += 1;
    row.lastAt = Date.now();
    this.state.actionMemory[key] = row;
  }

  maybePromote() {
    const n = this.config.promotionWindow;
    const rows = this.state.shadowRecent;
    if (rows.length < n * 2) return false;
    const recent = rows.slice(-n), previous = rows.slice(-n*2,-n);
    const avg = (arr,key) => arr.reduce((sum,row)=>sum+Number(row[key]||0),0) / Math.max(1,arr.length);
    const recentLibra = avg(recent,'libraPnl'), previousLibra = avg(previous,'libraPnl');
    const recentSani = avg(recent,'saniPnl');
    const recentUtility = avg(recent,'utility');
    if (recentLibra > 0 && recentLibra > recentSani + 0.02 && recentUtility > 0 && recentLibra > previousLibra + 0.015 && Date.now()-this.state.lastPromotionAt>10_000) {
      this.state.generation += 1;
      this.state.promotions += 1;
      this.state.lastPromotionAt = Date.now();
      this.state.lastInsight = `Generation ${this.state.generation} earned: the newest ${n} shadow decisions beat both SANI and my previous ${n}.`;
      return true;
    }
    return false;
  }

  learnShadow({
    signature='UNKNOWN', regime='UNKNOWN', action='STAND DOWN', tradeDirection='NONE',
    sourceApproved=false, sourceDirection='NONE', actualDirection='NONE',
    confidence=0, horizons=[]
  } = {}) {
    if (!['CALL','PUT'].includes(actualDirection)) return this.snapshot();
    const start = globalThis.performance?.now?.() ?? Date.now();
    const libraTraded = ['CALL','PUT'].includes(tradeDirection);
    const saniTraded = Boolean(sourceApproved) && ['CALL','PUT'].includes(sourceDirection);
    const libraWon = libraTraded ? tradeDirection === actualDirection : null;
    const saniWon = saniTraded ? sourceDirection === actualDirection : null;
    const libraPnl = libraTraded ? (libraWon ? PAYOUT : -1) : 0;
    const saniPnl = saniTraded ? (saniWon ? PAYOUT : -1) : 0;
    const relative = libraPnl - saniPnl;
    let utility = libraPnl + 0.28 * relative;
    if (!libraTraded && saniTraded) utility = 0.55 * (-saniPnl);
    if (!libraTraded && !saniTraded) utility = 0;

    const mistake = libraTraded ? !libraWon : (saniTraded ? saniWon : false);
    this.state.shadowLessons += 1;
    if (mistake) this.state.shadowMistakes += 1;
    if (libraTraded) {
      if (libraWon) this.state.actionWins += 1; else this.state.actionLosses += 1;
    }

    const exactKey = this.actionKey(signature,sourceApproved,sourceDirection,action,tradeDirection);
    const coarseKey = this.coarseActionKey(regime,sourceApproved,sourceDirection,action,tradeDirection);
    this.updateActionRow(exactKey,{utility,libraPnl,saniPnl,won:libraWon,mistake});
    this.updateActionRow(coarseKey,{utility,libraPnl,saniPnl,won:libraWon,mistake});

    const regimeRow = this.state.regimeMemory[regime] || {attempts:0,libraPnl:0,saniPnl:0,mistakes:0,actions:{},lastAt:0};
    regimeRow.attempts += 1; regimeRow.libraPnl += libraPnl; regimeRow.saniPnl += saniPnl;
    if (mistake) regimeRow.mistakes += 1;
    regimeRow.actions[action] = Number(regimeRow.actions[action]||0) + 1;
    regimeRow.lastAt = Date.now(); this.state.regimeMemory[regime] = regimeRow;

    for (const horizon of horizons || []) {
      if (!['UP','DOWN'].includes(horizon?.direction)) continue;
      const key = String(horizon.horizon || 1);
      const row = this.state.horizonMemory[key] || {attempts:0,correct:0,lastAt:0};
      row.attempts += 1;
      const predicted = horizon.direction === 'UP' ? 'CALL' : 'PUT';
      if (predicted === actualDirection) row.correct += 1;
      row.lastAt = Date.now(); this.state.horizonMemory[key] = row;
    }

    this.state.shadowRecent.push({libraPnl,saniPnl,utility,mistake:mistake?1:0,at:Date.now()});
    this.state.shadowRecent = this.state.shadowRecent.slice(-120);
    const outcome = libraTraded ? `${tradeDirection} ${libraWon?'WON':'LOST'} ${libraPnl>=0?'+':''}${libraPnl.toFixed(2)}` : saniTraded ? (saniWon ? `I skipped a SANI winner` : `I avoided a SANI loser`) : 'both of us stood down';
    const correction = mistake ? 'That decision was wrong, so I lowered its utility for this state.' : 'That decision paid, so I strengthened it for this state.';
    this.state.lastLesson = `${regime}: ${action}. ${outcome}. ${correction}`;
    this.state.lastInsight = mistake
      ? `${action} hurt me in ${regime}. I retained the exact state and the broader regime lesson.`
      : `${action} worked in ${regime}. I retained why, not just the direction.`;
    this.state.lastUpdateAt = Date.now();
    this.maybePromote();
    this.state.lastLearnMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - start);
    return this.snapshot();
  }

  snapshot() {
    const total = this.state.correct + this.state.mistakes;
    const recent = this.state.recent;
    const last20 = recent.slice(-20), previous20 = recent.slice(-40,-20);
    const accuracy = total ? this.state.correct / total * 100 : 0;
    const recentAccuracy = last20.length ? last20.filter(Boolean).length / last20.length * 100 : 0;
    const previousAccuracy = previous20.length ? previous20.filter(Boolean).length / previous20.length * 100 : recentAccuracy;
    const actionTotal = this.state.actionWins + this.state.actionLosses;
    const horizonScores = Object.fromEntries(Object.entries(this.state.horizonMemory).map(([key,row])=>[key,row.attempts ? row.correct/row.attempts*100 : 0]));
    return {
      version:LIBRA_VERSION,
      generation:this.state.generation,
      promotions:this.state.promotions,
      updates:this.state.updates,
      mistakes:this.state.mistakes,
      correct:this.state.correct,
      accuracy,
      recentAccuracy,
      improvement:recentAccuracy - previousAccuracy,
      retainedStates:Object.keys(this.state.stateMemory).length,
      actionStates:Object.keys(this.state.actionMemory).length,
      shadowLessons:this.state.shadowLessons,
      shadowMistakes:this.state.shadowMistakes,
      actionAccuracy:actionTotal ? this.state.actionWins/actionTotal*100 : 0,
      horizonScores,
      lastLesson:this.state.lastLesson,
      lastInsight:this.state.lastInsight,
      lastLearnMs:this.state.lastLearnMs,
      lastUpdateAt:this.state.lastUpdateAt
    };
  }
}
