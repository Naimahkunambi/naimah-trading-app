export const SNIPER_DEFAULTS = Object.freeze({
  repeatWindow: 3,
  flipWindow: 3,
  flipVotes: 2,
  fireScore: 10,
  secondContractScore: 16,
  memoryMin: 6,
  memoryFloor: 0.54,
  addressMin: 5,
  addressFloor: 0.53
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function bayesianRate(wins = 0, losses = 0, priorRate = 0.5, priorWeight = 8) {
  const total = Math.max(0, Number(wins) || 0) + Math.max(0, Number(losses) || 0);
  return (Math.max(0, Number(wins) || 0) + priorRate * priorWeight) / (total + priorWeight);
}

export function shapeSignature(shape = [], segmentCount = 4) {
  if (!Array.isArray(shape) || shape.length < 2) return 'FLAT';
  const segments = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const from = Math.floor(segment * (shape.length - 1) / segmentCount);
    const to = Math.max(from + 1, Math.floor((segment + 1) * (shape.length - 1) / segmentCount));
    const delta = Number(shape[Math.min(shape.length - 1, to)]) - Number(shape[from]);
    const bucket = clamp(Math.round(delta * 1.75), -2, 2);
    segments.push(bucket > 0 ? `U${bucket}` : bucket < 0 ? `D${Math.abs(bucket)}` : 'F0');
  }
  return segments.join('-');
}

export function lengthModifier(length) {
  if (Number(length) === 12) return 3;
  if (Number(length) === 8) return -4;
  return 0;
}

export function memoryView(memory = {}) {
  const wins = Number(memory.wins) || 0;
  const losses = Number(memory.losses) || 0;
  const total = wins + losses;
  const rate = bayesianRate(wins, losses);
  return { wins, losses, total, rate, proven: total >= SNIPER_DEFAULTS.memoryMin };
}

export class SniperCampaignPolicy {
  constructor(config = {}) {
    this.config = { ...SNIPER_DEFAULTS, ...config };
    this.reset();
  }

  reset() {
    this.tickNumber = 0;
    this.seeds = new Map();
    this.campaign = { direction: 'NONE', sinceEpoch: 0, fires: 0, flips: 0 };
    this.opposition = [];
  }

  evaluate({ pattern, structure, familyMemory = {}, addressMemory = {}, epoch = 0 } = {}) {
    this.tickNumber += 1;
    const baseOk = Boolean(pattern?.ok && ['UP', 'DOWN'].includes(pattern?.direction));
    const direction = pattern?.direction || 'EVEN';
    const familyId = pattern?.familyId || 'NONE';
    const previous = this.seeds.get(familyId);
    const insideRepeatWindow = Boolean(previous && this.tickNumber - previous.lastTick <= this.config.repeatWindow && previous.direction === direction);
    const repeatCount = insideRepeatWindow ? previous.repeatCount + 1 : 1;
    this.seeds.set(familyId, { direction, repeatCount, lastTick: this.tickNumber, epoch });
    for (const [id, seed] of this.seeds.entries()) {
      if (this.tickNumber - seed.lastTick > this.config.repeatWindow) this.seeds.delete(id);
    }

    const family = memoryView(familyMemory);
    const address = memoryView(addressMemory);
    const repeatReady = baseOk && repeatCount >= 2;
    const lengthScore = lengthModifier(pattern?.length);
    const familyScore = family.proven ? clamp((family.rate - 0.5) * 30, -5, 5) : 0;
    const structureScore = address.total >= this.config.addressMin ? clamp((address.rate - 0.5) * 24, -4, 4) : 0;
    const score = (Number(pattern?.edge) || 50) - 50 + lengthScore + (repeatReady ? 6 : 0) + familyScore + structureScore;

    const opposing = this.campaign.direction !== 'NONE' && direction !== 'EVEN' && direction !== this.campaign.direction;
    this.opposition = this.opposition.filter(x => this.tickNumber - x.tick <= this.config.flipWindow);
    if (baseOk && opposing) this.opposition.push({ tick: this.tickNumber, direction, familyId });
    const opposingVotes = opposing ? this.opposition.filter(x => x.direction === direction).length : 0;
    const flipReady = opposing && opposingVotes >= this.config.flipVotes;
    const hysteresisPass = !opposing || flipReady;
    const sniperApproved = Boolean(repeatReady && score >= this.config.fireScore && hysteresisPass);

    let event = repeatReady ? 'REPEAT' : baseOk ? 'SEED' : 'WATCH';
    if (baseOk && opposing && !flipReady) event = 'HOLD';
    if (sniperApproved) {
      const flip = this.campaign.direction !== 'NONE' && this.campaign.direction !== direction;
      if (flip) {
        this.campaign = { direction, sinceEpoch: epoch, fires: 0, flips: this.campaign.flips + 1 };
        this.opposition = [];
        event = 'FLIP';
      } else if (this.campaign.direction === 'NONE') {
        this.campaign = { direction, sinceEpoch: epoch, fires: 0, flips: 0 };
      }
      this.campaign.fires += 1;
      if (event !== 'FLIP') event = 'FIRE';
    }

    const familyPass = !family.proven || family.rate >= this.config.memoryFloor;
    const addressPass = address.total < this.config.addressMin || address.rate >= this.config.addressFloor;
    const variants = {
      control: baseOk,
      repeat: repeatReady,
      length: baseOk && lengthScore >= 0,
      memory: baseOk && family.proven && familyPass,
      hysteresis: baseOk && hysteresisPass,
      structure: baseOk && addressPass,
      sniper: sniperApproved
    };
    const batch = sniperApproved && score >= this.config.secondContractScore && repeatCount >= 2 ? 2 : sniperApproved ? 1 : 0;
    const grade = score >= this.config.secondContractScore ? 'A' : score >= this.config.fireScore ? 'B' : 'C';
    const location = `${structure?.tag || 'MIXED'}:${structure?.phase || 'MID'}`;

    return {
      baseOk,
      sniperApproved,
      event,
      direction,
      familyId,
      location,
      repeatCount,
      repeatWindow: this.config.repeatWindow,
      score,
      grade,
      batch,
      lengthScore,
      familyScore,
      structureScore,
      familyMemory: family,
      addressMemory: address,
      opposingVotes,
      flipReady,
      hysteresisPass,
      variants,
      campaign: { ...this.campaign }
    };
  }
}
