const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));

function percentile(values, ratio, fallback = 0) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const position = (sorted.length - 1) * clamp(ratio, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function movementStats(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { count: rows?.length || 0, slope: 0, slopeNorm: 0, efficiency: 0, avgMove: 0, net: 0, direction: 'NONE', position: .5 };
  }
  const quotes = rows.map(row => Number(row.quote));
  const n = quotes.length;
  const xMean = (n - 1) / 2;
  const yMean = quotes.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  let travelled = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (index - xMean) * (quotes[index] - yMean);
    denominator += (index - xMean) ** 2;
    if (index) travelled += Math.abs(quotes[index] - quotes[index - 1]);
  }
  const slope = denominator ? numerator / denominator : 0;
  const net = quotes.at(-1) - quotes[0];
  const avgMove = travelled / Math.max(1, n - 1);
  const slopeNorm = avgMove ? slope / avgMove : 0;
  const efficiency = travelled ? Math.abs(net) / travelled : 0;
  const low = Math.min(...quotes);
  const high = Math.max(...quotes);
  const position = high === low ? .5 : (quotes.at(-1) - low) / (high - low);
  return {
    count: n,
    slope,
    slopeNorm,
    efficiency,
    avgMove,
    net,
    direction: slope > 0 ? 'UP' : slope < 0 ? 'DOWN' : 'NONE',
    position
  };
}

function normalizeTick(tick) {
  const epoch = Number(tick?.epoch);
  const quote = Number(tick?.quote);
  return Number.isFinite(epoch) && Number.isFinite(quote) ? { epoch, quote } : null;
}

export class TrendBudget {
  constructor(config = {}) {
    this.config = {
      shortSeconds: 20,
      primarySeconds: 60,
      confirmSeconds: 120,
      flipVotes: 2,
      flipWindowSeconds: 3,
      minEfficiency: .08,
      minSlopeNorm: .05,
      ...config
    };
    this.reset();
  }

  reset() {
    this.ticks = [];
    this.lastKey = '';
    this.direction = 'NONE';
    this.directionStartedAt = 0;
    this.directionStartedQuote = 0;
    this.turnVotes = [];
    this.completedDurations = [];
    this.completedDistances = [];
    this.current = this.emptySnapshot();
    return this.current;
  }

  emptySnapshot() {
    return {
      state: 'OBSERVE',
      direction: 'NONE',
      health: 0,
      maturity: 0,
      exhaustion: 0,
      ageSeconds: 0,
      distanceUnits: 0,
      remaining: { low: null, median: null, high: null },
      remainingDistance: { low: null, median: null, high: null },
      targetQuote: { low: null, median: null, high: null },
      efficiency: 0,
      slope60: 0,
      slope120: 0,
      decelerating: false,
      turnVotes: 0,
      reason: 'Collecting enough ticks to draw the first trend line.'
    };
  }

  hydrate(ticks = []) {
    this.reset();
    const clean = ticks.map(normalizeTick).filter(Boolean).sort((a, b) => a.epoch - b.epoch).slice(-2000);
    for (const tick of clean) this.ingest(tick);
    return this.current;
  }

  rowsFor(seconds) {
    const last = this.ticks.at(-1);
    if (!last) return [];
    const cutoff = last.epoch - seconds;
    return this.ticks.filter(row => row.epoch >= cutoff);
  }

  closeDirection(epoch, quote, avgMove) {
    if (this.direction === 'NONE' || !this.directionStartedAt) return;
    const duration = Math.max(1, epoch - this.directionStartedAt);
    const distance = Math.abs(quote - this.directionStartedQuote) / Math.max(avgMove || 0, Number.EPSILON);
    if (duration >= 20) this.completedDurations.push(duration);
    if (Number.isFinite(distance) && distance >= 5) this.completedDistances.push(distance);
    this.completedDurations = this.completedDurations.slice(-80);
    this.completedDistances = this.completedDistances.slice(-80);
  }

  ingest(rawTick, patternDirection = 'NONE') {
    const tick = normalizeTick(rawTick);
    if (!tick) return this.current;
    const key = `${tick.epoch}:${tick.quote}`;
    if (key === this.lastKey) return this.current;
    this.lastKey = key;
    this.ticks.push(tick);
    this.ticks = this.ticks.slice(-2000);

    const short = movementStats(this.rowsFor(this.config.shortSeconds));
    const primary = movementStats(this.rowsFor(this.config.primarySeconds));
    const confirm = movementStats(this.rowsFor(this.config.confirmSeconds));
    const enoughPrimary = primary.count >= Math.max(20, Math.floor(this.config.primarySeconds * .7));
    const enoughConfirm = confirm.count >= Math.max(40, Math.floor(this.config.confirmSeconds * .7));
    const primaryStrong = enoughPrimary && primary.efficiency >= this.config.minEfficiency && Math.abs(primary.slopeNorm) >= this.config.minSlopeNorm;
    const confirmDirection = enoughConfirm ? confirm.direction : primary.direction;
    const candidate = primaryStrong && (confirmDirection === primary.direction || !enoughConfirm) ? primary.direction : 'NONE';

    if (candidate !== 'NONE' && this.direction === 'NONE') {
      this.direction = candidate;
      this.directionStartedAt = tick.epoch;
      this.directionStartedQuote = tick.quote;
      this.turnVotes = [];
    } else if (candidate !== 'NONE' && candidate !== this.direction) {
      this.turnVotes = this.turnVotes.filter(vote => tick.epoch - vote.epoch <= this.config.flipWindowSeconds);
      this.turnVotes.push({ epoch: tick.epoch, direction: candidate });
      const agreeingVotes = this.turnVotes.filter(vote => vote.direction === candidate).length;
      if (agreeingVotes >= this.config.flipVotes) {
        this.closeDirection(tick.epoch, tick.quote, primary.avgMove);
        this.direction = candidate;
        this.directionStartedAt = tick.epoch;
        this.directionStartedQuote = tick.quote;
        this.turnVotes = [];
      }
    } else if (candidate === this.direction) {
      this.turnVotes = [];
    } else {
      this.turnVotes = this.turnVotes.filter(vote => tick.epoch - vote.epoch <= this.config.flipWindowSeconds);
    }

    const ageSeconds = this.directionStartedAt ? Math.max(0, tick.epoch - this.directionStartedAt) : 0;
    const expectedDuration = percentile(this.completedDurations, .5, 150);
    const durationLow = percentile(this.completedDurations, .25, 90);
    const durationHigh = percentile(this.completedDurations, .75, 260);
    const distanceUnits = this.direction === 'NONE' ? 0 : Math.abs(tick.quote - this.directionStartedQuote) / Math.max(primary.avgMove || 0, Number.EPSILON);
    const expectedDistance = percentile(this.completedDistances, .5, 55);
    const distanceLow = percentile(this.completedDistances, .25, 34);
    const distanceHigh = percentile(this.completedDistances, .75, 89);
    const ageProgress = clamp(ageSeconds / Math.max(1, expectedDuration) * 100);
    const distanceProgress = clamp(distanceUnits / Math.max(1, expectedDistance) * 100);
    const extensionProgress = this.direction === 'UP' ? primary.position * 100 : this.direction === 'DOWN' ? (1 - primary.position) * 100 : 50;
    const maturity = clamp(ageProgress * .45 + distanceProgress * .40 + extensionProgress * .15);

    const shortAligned = short.direction === this.direction;
    const primaryAligned = primary.direction === this.direction;
    const confirmAligned = confirm.direction === this.direction || !enoughConfirm;
    const momentumRatio = Math.abs(short.slopeNorm) / Math.max(.01, Math.abs(primary.slopeNorm));
    const decelerating = this.direction !== 'NONE' && (!shortAligned || momentumRatio < .55);
    const health = this.direction === 'NONE' ? 0 : clamp(
      (primaryAligned ? 20 : 0) +
      (confirmAligned ? 20 : 0) +
      Math.min(30, primary.efficiency / .35 * 30) +
      Math.min(20, Math.abs(primary.slopeNorm) / .30 * 20) +
      (shortAligned ? Math.min(10, momentumRatio * 8) : 0) -
      (decelerating ? 18 : 0)
    );

    const normalizedPattern = patternDirection === 'CALL' ? 'UP' : patternDirection === 'PUT' ? 'DOWN' : patternDirection;
    const patternOpposes = ['UP', 'DOWN'].includes(normalizedPattern) && normalizedPattern !== this.direction;
    const exhaustion = this.direction === 'NONE' ? 0 : clamp(
      maturity * .55 +
      (decelerating ? 22 : 0) +
      (health < 45 ? 18 : 0) +
      (patternOpposes ? 10 : 0)
    );

    const remainingDistance = {
      low: Math.max(0, distanceLow - distanceUnits),
      median: Math.max(0, expectedDistance - distanceUnits),
      high: Math.max(0, distanceHigh - distanceUnits)
    };
    const directionSign = this.direction === 'UP' ? 1 : this.direction === 'DOWN' ? -1 : 0;
    const targetQuotes = directionSign
      ? [distanceLow, expectedDistance, distanceHigh].map(distance => this.directionStartedQuote + directionSign * distance * primary.avgMove)
      : [];

    let state = 'OBSERVE';
    let reason = 'Direction is not stable enough to lock.';
    if (this.turnVotes.length) {
      state = 'TURNING';
      reason = `${this.turnVotes.length}/${this.config.flipVotes} opposing trend votes inside ${this.config.flipWindowSeconds}s.`;
    } else if (this.direction !== 'NONE' && exhaustion >= 74 && maturity >= 60) {
      state = 'HARVEST';
      reason = 'The campaign is extended and losing speed. Stop adding; wait for continuation or a confirmed turn.';
    } else if (this.direction !== 'NONE' && (maturity >= 64 || health < 55)) {
      state = 'MATURE';
      reason = 'Direction remains valid, but the historical trend budget is being consumed.';
    } else if (this.direction !== 'NONE') {
      state = 'DRIVE';
      reason = 'Direction, efficiency and short-term momentum still support the campaign.';
    }

    this.current = {
      state,
      direction: this.direction,
      health: Math.round(health),
      maturity: Math.round(maturity),
      exhaustion: Math.round(exhaustion),
      ageSeconds,
      distanceUnits:Number(distanceUnits.toFixed(1)),
      remaining: {
        low: Math.max(0, Math.round(durationLow - ageSeconds)),
        median: Math.max(0, Math.round(expectedDuration - ageSeconds)),
        high: Math.max(0, Math.round(durationHigh - ageSeconds))
      },
      remainingDistance: {
        low:Number(remainingDistance.low.toFixed(1)),
        median:Number(remainingDistance.median.toFixed(1)),
        high:Number(remainingDistance.high.toFixed(1))
      },
      targetQuote: targetQuotes.length ? {
        low:Number(Math.min(...targetQuotes).toFixed(2)),
        median:Number(targetQuotes[1].toFixed(2)),
        high:Number(Math.max(...targetQuotes).toFixed(2))
      } : { low:null, median:null, high:null },
      efficiency:Number((primary.efficiency * 100).toFixed(1)),
      slope60:Number(primary.slopeNorm.toFixed(3)),
      slope120:Number(confirm.slopeNorm.toFixed(3)),
      decelerating,
      turnVotes:this.turnVotes.length,
      reason
    };
    return this.current;
  }
}

export class HarvestBrake {
  constructor(config = {}) {
    this.config = {
      pulseLead:2,
      minMaturity:68,
      minExhaustion:66,
      resumeHealth:58,
      resumeExhaustion:62,
      resumeVotes:2,
      ...config
    };
    this.reset();
  }

  reset() {
    this.active = null;
    this.resumeVotes = 0;
    return this.snapshot('READY');
  }

  snapshot(action = 'READY', extra = {}) {
    return {
      active:Boolean(this.active),
      action,
      direction:this.active?.direction || 'NONE',
      startedAt:this.active?.startedAt || null,
      bufferSeconds:this.active?.bufferSeconds || null,
      resumeVotes:this.resumeVotes,
      ...extra
    };
  }

  evaluate({ trend, epoch, quote, pulseGapSeconds = 1 } = {}) {
    const direction = trend?.direction || 'NONE';
    const state = trend?.state || 'OBSERVE';
    const safeGap = Math.max(1, Number(pulseGapSeconds) || 1);
    const bufferSeconds = Math.max(2, Math.round(safeGap * this.config.pulseLead));
    const timeClose = Number.isFinite(Number(trend?.remaining?.median)) && Number(trend.remaining.median) <= bufferSeconds;
    const distanceClose = Number.isFinite(Number(trend?.remainingDistance?.median)) && Number(trend.remainingDistance.median) <= bufferSeconds;
    const lateEvidence = direction !== 'NONE' && (
      (state === 'HARVEST' && (timeClose || distanceClose)) ||
      (Number(trend?.maturity || 0) >= this.config.minMaturity &&
        Number(trend?.exhaustion || 0) >= this.config.minExhaustion &&
        Boolean(trend?.decelerating) &&
        (timeClose || distanceClose))
    );

    if (!this.active && lateEvidence) {
      this.active = { direction, startedAt:Number(epoch) || 0, startedQuote:Number(quote), bufferSeconds };
      this.resumeVotes = 0;
      return this.snapshot('HARVEST_ENTER', { blocked:true, reason:`Projected trend end is inside the next ${this.config.pulseLead} entry opportunities.` });
    }

    if (!this.active) return this.snapshot('MILK', { blocked:false, reason:'Drive remains open for repeated entries.' });

    if (direction !== 'NONE' && direction !== this.active.direction) {
      const previousDirection = this.active.direction;
      this.active = null;
      this.resumeVotes = 0;
      return this.snapshot('FLIP_RELEASE', { blocked:false, previousDirection, direction, reason:`The new ${direction} direction is locked; Milk may enter the new side.` });
    }

    const recovered = direction === this.active.direction && state === 'DRIVE' &&
      Number(trend?.health || 0) >= this.config.resumeHealth &&
      Number(trend?.exhaustion || 0) < this.config.resumeExhaustion;
    this.resumeVotes = recovered ? this.resumeVotes + 1 : 0;
    if (this.resumeVotes >= this.config.resumeVotes) {
      const previousDirection = this.active.direction;
      this.active = null;
      this.resumeVotes = 0;
      return this.snapshot('CONTINUE_RELEASE', { blocked:false, previousDirection, direction, reason:`The ${direction} drive recovered for ${this.config.resumeVotes} ticks; repeated entries resume.` });
    }

    return this.snapshot('HARVEST_STOP', {
      blocked:true,
      reason:recovered
        ? `Continuation check ${this.resumeVotes}/${this.config.resumeVotes}; entries remain stopped.`
        : 'Harvest buffer is active; stop adding until continuation or a new direction locks.'
    });
  }
}

export function applyMilkingPolicy(decision, trend, harvest = {}) {
  if (!decision?.approved) return {
    approved:false,
    batch:0,
    role:'ORIGINAL_V8',
    alignment:'NO_ENTRY',
    timing:trend?.state || 'OBSERVE',
    reason:'The original v8 pattern did not qualify on this tick.'
  };
  const wantedDirection = decision.tradeDirection === 'CALL' ? 'UP' : 'DOWN';
  const batch = Math.max(1, Math.min(2, Number(decision.requestedBatch || 1)));
  if (harvest?.blocked) {
    return {
      approved:false,
      batch:0,
      role:'ACTIVE_HARVEST',
      alignment:'HARVEST_STOP',
      timing:trend?.state || 'HARVEST',
      reason:harvest.reason || 'Harvest buffer stopped this new entry near the projected trend end.'
    };
  }
  if (!trend || trend.direction === 'NONE' || trend.state === 'OBSERVE') {
    return {
      approved:true,
      batch,
      role:'ORIGINAL_V8',
      alignment:'UNMAPPED',
      timing:'OBSERVE',
      reason:`Original v8 ${decision.tradeDirection} ×${batch} fires. The Trend Map is still observing.`
    };
  }
  const aligned = trend.direction === wantedDirection;
  const alignment = aligned ? 'ALIGNED' : 'COUNTER_TREND';
  const stageCopy = {
    DRIVE:'healthy drive',
    MATURE:'mature drive',
    HARVEST:'late/exhaustion zone',
    TURNING:'turning transition'
  }[trend.state] || String(trend.state || 'mapped market').toLowerCase();
  return {
    approved:true,
    batch,
    role:'ORIGINAL_V8',
    alignment,
    timing:trend.state,
    reason:`Original v8 ${decision.tradeDirection} ×${batch} fires. It is ${alignment === 'ALIGNED' ? 'aligned with' : `counter to`} the ${trend.direction} ${stageCopy}.`
  };
}

export const __trendBudgetTest = { movementStats, percentile };
