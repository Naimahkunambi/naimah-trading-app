const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export const SMFN_CALIBRATION = Object.freeze({
  label: '25 Aug original v8 two-run audit',
  windows: 2,
  contracts: 1003,
  wins: 548,
  losses: 455,
  winRate: 0.546,
  winRateLow: 0.515,
  winRateHigh: 0.577,
  payoutPerStake: 0.923,
  contractsPerMinute: 53.4,
  contractsPerMinuteLow: 40.0,
  contractsPerMinuteHigh: 56.2
});

export function estimateSmfnPlan(input = {}, calibration = SMFN_CALIBRATION) {
  const minutes = clamp(input.minutes ?? 30, 1, 720);
  const stake = clamp(input.stake ?? 1, 0.35, 10000);
  const target = Math.max(0, Number(input.target) || 0);
  const batch = clamp(Math.round(input.batch ?? 2), 1, 2);
  const maxTrades = clamp(Math.round(input.maxTrades ?? 5000), 1, 5000);
  const paceScale = batch / 2;
  const lowContracts = Math.min(maxTrades, Math.max(1, Math.floor(minutes * calibration.contractsPerMinuteLow * paceScale)));
  const expectedContracts = Math.min(maxTrades, Math.max(1, Math.round(minutes * calibration.contractsPerMinute * paceScale)));
  const highContracts = Math.min(maxTrades, Math.max(1, Math.round(minutes * calibration.contractsPerMinuteHigh * paceScale)));
  const expectancy = winRate => winRate * calibration.payoutPerStake - (1 - winRate);
  const lowProfit = lowContracts * stake * expectancy(calibration.winRateLow);
  const expectedProfit = expectedContracts * stake * expectancy(calibration.winRate);
  const highProfit = highContracts * stake * expectancy(calibration.winRateHigh);
  const expectedPerDollarStake = expectedContracts * expectancy(calibration.winRate);
  const suggestedStake = target > 0 && expectedPerDollarStake > 0
    ? Math.max(0.35, target / expectedPerDollarStake)
    : stake;
  const breakEvenRate = 1 / (1 + calibration.payoutPerStake);
  return {
    minutes,
    stake,
    batch,
    maxTrades,
    target,
    lowContracts,
    expectedContracts,
    highContracts,
    lowProfit:Number(lowProfit.toFixed(2)),
    expectedProfit:Number(expectedProfit.toFixed(2)),
    highProfit:Number(highProfit.toFixed(2)),
    suggestedStake:Number(suggestedStake.toFixed(2)),
    breakEvenRate:Number((breakEvenRate * 100).toFixed(1)),
    feasible:target <= highProfit,
    evidenceOnly:true
  };
}

export function isSmfnSniperEntry({ milkCandidate = false } = {}) {
  return Boolean(milkCandidate);
}

export class SmfnBrain {
  constructor(config = {}) {
    this.defaults = {
      mode:'AUTO',
      durationMinutes:30,
      landingMinutes:10,
      targetProfit:30,
      hardStop:15,
      recoveryTarget:0,
      maxTrades:200,
      batch:2,
      ...config
    };
    this.reset();
  }

  reset() {
    this.config = { ...this.defaults };
    this.status = 'IDLE';
    this.phase = 'IDLE';
    this.activeLane = 'NONE';
    this.lockCandidate = 'NONE';
    this.lockCount = 0;
    this.startedAt = null;
    this.deadlineAt = null;
    this.landingDeadlineAt = null;
    this.basePnl = 0;
    this.baseTrades = 0;
    this.cooldownUntil = 0;
    this.lossStreak = 0;
    this.routeHistory = [];
    this.lastReason = 'Set a plan, connect Demo, then arm SMFN.';
    this.lastDecision = null;
    return this.snapshot();
  }

  configure(patch = {}) {
    if (this.isRunning()) throw new Error('Pause SMFN before changing its plan.');
    this.config = {
      ...this.config,
      ...patch,
      mode:String(patch.mode || this.config.mode).toUpperCase(),
      durationMinutes:clamp(patch.durationMinutes ?? this.config.durationMinutes, 1, 720),
      landingMinutes:clamp(patch.landingMinutes ?? this.config.landingMinutes, 0, 60),
      targetProfit:Math.max(0, Number(patch.targetProfit ?? this.config.targetProfit) || 0),
      hardStop:Math.max(0.35, Number(patch.hardStop ?? this.config.hardStop) || 0.35),
      recoveryTarget:Number(patch.recoveryTarget ?? this.config.recoveryTarget) || 0,
      maxTrades:clamp(Math.round(patch.maxTrades ?? this.config.maxTrades), 1, 5000),
      batch:clamp(Math.round(patch.batch ?? this.config.batch), 1, 2)
    };
    return this.snapshot();
  }

  start({ now = Date.now(), basePnl = 0, baseTrades = 0, trend = null, ...patch } = {}) {
    this.configure(patch);
    this.startedAt = Number(now);
    this.deadlineAt = this.startedAt + this.config.durationMinutes * 60_000;
    this.landingDeadlineAt = this.deadlineAt + this.config.landingMinutes * 60_000;
    this.basePnl = Number(basePnl) || 0;
    this.baseTrades = Math.max(0, Number(baseTrades) || 0);
    this.activeLane = 'NONE';
    this.lockCandidate = 'NONE';
    this.lockCount = 0;
    this.cooldownUntil = 0;
    this.lossStreak = 0;
    this.routeHistory = [];
    this.phase = this.config.mode === 'MANUAL' ? 'MANUAL' : 'ACTIVE';
    this.status = this.phase;
    this.lastReason = this.config.mode === 'MANUAL'
      ? 'Manual Milking behavior is active; SMFN direction gates are bypassed.'
      : 'SMFN is armed. The original v8 signal chooses one bot for each entry; the wider footprint is advisory and never holds a stale side.';
    return this.snapshot({ now, pnl:this.basePnl, trades:this.baseTrades });
  }

  pause(reason = 'SMFN paused by Naimah.') {
    if (!['COMPLETE','HARD_STOP','STOPPED'].includes(this.status)) this.status = 'PAUSED';
    this.phase = 'PAUSED';
    this.clearLane();
    this.recordRoute(Math.floor(Date.now() / 1000));
    this.lastReason = reason;
    return this.snapshot();
  }

  stop(reason = 'SMFN stopped.') {
    this.status = 'STOPPED';
    this.phase = 'STOPPED';
    this.clearLane();
    this.recordRoute(Math.floor(Date.now() / 1000));
    this.lastReason = reason;
    return this.snapshot();
  }

  isRunning() {
    return ['SCANNING','ACTIVE','LANDING','MANUAL'].includes(this.status);
  }

  runPnl(totalPnl = 0) { return Number(totalPnl || 0) - this.basePnl; }
  runTrades(totalTrades = 0) { return Math.max(0, Number(totalTrades || 0) - this.baseTrades); }

  clearLane() {
    this.activeLane = 'NONE';
    this.lockCandidate = 'NONE';
    this.lockCount = 0;
  }

  recordRoute(epoch = 0) {
    const lane = this.activeLane === 'UP' ? 'CALL' : this.activeLane === 'DOWN' ? 'PUT' : 'NONE';
    if (this.routeHistory.at(-1)?.lane === lane) return;
    this.routeHistory.push({ epoch:Number(epoch) || 0, lane, direction:this.activeLane, at:Date.now() });
    this.routeHistory = this.routeHistory.slice(-500);
  }

  syncTrend(trend, epoch = 0) {
    if (this.config.mode === 'MANUAL' || !this.isRunning()) return this.snapshot();
    // The footprint is intentionally visual/advisory. A multi-second map must
    // not hold a CALL or PUT gate over millisecond, one-tick entry decisions.
    return this.snapshot();
  }

  registerResult(profit, now = Date.now()) {
    if (!(Number(profit) < 0)) {
      this.lossStreak = 0;
      return this.snapshot({ now });
    }
    this.lossStreak += 1;
    return this.snapshot({ now });
  }

  sessionGate({ now, totalPnl, totalTrades }) {
    const runPnl = this.runPnl(totalPnl);
    const runTrades = this.runTrades(totalTrades);
    if (this.config.mode === 'MANUAL') return { stop:false, phase:'MANUAL', runPnl, runTrades };
    if (this.startedAt == null || !this.isRunning()) return { stop:true, phase:this.phase, runPnl, runTrades };
    if (runPnl <= -Math.abs(this.config.hardStop)) {
      this.status = 'HARD_STOP'; this.phase = 'HARD_STOP';
      this.clearLane(); this.recordRoute(Math.floor(Number(now) / 1000));
      this.lastReason = `Hard stop reached at ${runPnl.toFixed(2)}. SMFN will not chase the loss.`;
      return { stop:true, phase:this.phase, runPnl, runTrades };
    }
    if (runPnl >= this.config.targetProfit && this.config.targetProfit > 0) {
      this.status = 'COMPLETE'; this.phase = 'COMPLETE';
      this.clearLane(); this.recordRoute(Math.floor(Number(now) / 1000));
      this.lastReason = `Target reached at +$${runPnl.toFixed(2)}. New purchases are closed.`;
      return { stop:true, phase:this.phase, runPnl, runTrades };
    }
    if (runTrades >= this.config.maxTrades) {
      this.status = 'COMPLETE'; this.phase = 'COMPLETE';
      this.clearLane(); this.recordRoute(Math.floor(Number(now) / 1000));
      this.lastReason = `The ${this.config.maxTrades}-contract run cap was reached.`;
      return { stop:true, phase:this.phase, runPnl, runTrades };
    }
    if (now >= this.deadlineAt) {
      if (runPnl < this.config.recoveryTarget && this.config.landingMinutes > 0 && now < this.landingDeadlineAt) {
        this.phase = 'LANDING'; this.status = 'LANDING';
        this.lastReason = `Timed run ended at ${runPnl.toFixed(2)}. Safety Landing is active, time-boxed and single-contract only.`;
        return { stop:false, phase:this.phase, runPnl, runTrades };
      }
      this.status = 'COMPLETE'; this.phase = 'COMPLETE';
      this.clearLane(); this.recordRoute(Math.floor(Number(now) / 1000));
      this.lastReason = runPnl < this.config.recoveryTarget
        ? `Safety Landing expired at ${runPnl.toFixed(2)}. SMFN stopped instead of chasing.`
        : `The timed run finished at ${runPnl >= 0 ? '+' : ''}$${runPnl.toFixed(2)}.`;
      return { stop:true, phase:this.phase, runPnl, runTrades };
    }
    return { stop:false, phase:this.phase, runPnl, runTrades };
  }

  evaluate({ now = Date.now(), trend, harvest, sourceDecision, grade, totalPnl = 0, totalTrades = 0 } = {}) {
    const gate = this.sessionGate({ now:Number(now), totalPnl, totalTrades });
    if (this.config.mode === 'MANUAL') {
      const approved = Boolean(sourceDecision?.approved);
      const result = {
        approved,
        batch:approved ? this.config.batch : 0,
        allowedDirection:sourceDecision?.tradeDirection || 'NONE',
        status:'MANUAL',
        phase:'MANUAL',
        action:approved ? 'MANUAL_FIRE' : 'MANUAL_WATCH',
        reason:'Manual mode keeps the existing Milking Zone decision unchanged.',
        ...gate
      };
      this.lastDecision = result; return result;
    }
    if (gate.stop) {
      const result = { approved:false, batch:0, allowedDirection:'NONE', status:this.status, action:this.status, reason:this.lastReason, ...gate };
      this.lastDecision = result; return result;
    }
    const requestedDirection = ['CALL','PUT'].includes(sourceDecision?.tradeDirection) ? sourceDecision.tradeDirection : 'NONE';
    const landingGrade = gate.phase !== 'LANDING' || ['A','B'].includes(String(grade || '').toUpperCase());
    const approved = Boolean(sourceDecision?.approved && requestedDirection !== 'NONE' && landingGrade);
    const nextLane = approved ? (requestedDirection === 'CALL' ? 'UP' : 'DOWN') : 'NONE';
    if (nextLane !== this.activeLane) {
      this.activeLane = nextLane;
      this.lockCandidate = nextLane;
      this.lockCount = approved ? 1 : 0;
      this.recordRoute(Number(sourceDecision?.signalEpoch || Math.floor(Number(now) / 1000)));
    }
    const allowedDirection = approved ? requestedDirection : 'NONE';
    this.status = gate.phase === 'LANDING' ? 'LANDING' : 'ACTIVE';
    this.phase = gate.phase === 'LANDING' ? 'LANDING' : 'ACTIVE';
    const reason = !sourceDecision?.approved
      ? sourceDecision?.waitReason || 'Waiting for the next original v8 entry. No bot is held on between signals.'
      : !landingGrade
        ? `Safety Landing rejected grade ${grade || '—'}; only A/B evidence may trade.`
        : `${allowedDirection} BOT fired the original v8 entry immediately. The opposite bot is locked for this signal only.`;
    const result = {
      approved,
      batch:approved ? (gate.phase === 'LANDING' ? 1 : this.config.batch) : 0,
      allowedDirection,
      status:this.status,
      action:approved ? `${allowedDirection}_FIRE` : `${allowedDirection}_WAIT`,
      reason,
      ...gate
    };
    this.lastReason = reason;
    this.lastDecision = result;
    return result;
  }

  snapshot({ now = Date.now(), pnl = this.basePnl, trades = this.baseTrades } = {}) {
    const runPnl = this.runPnl(pnl);
    const runTrades = this.runTrades(trades);
    const end = this.phase === 'LANDING' ? this.landingDeadlineAt : this.deadlineAt;
    return {
      status:this.status,
      phase:this.phase,
      activeLane:this.activeLane,
      allowedDirection:this.activeLane === 'UP' ? 'CALL' : this.activeLane === 'DOWN' ? 'PUT' : 'NONE',
      lockCandidate:this.lockCandidate,
      lockCount:this.lockCount,
      lockVotes:1,
      startedAt:this.startedAt,
      deadlineAt:this.deadlineAt,
      landingDeadlineAt:this.landingDeadlineAt,
      remainingMs:end ? Math.max(0, end - Number(now)) : 0,
      runPnl,
      runTrades,
      lossStreak:this.lossStreak,
      cooldownUntil:this.cooldownUntil,
      routeHistory:this.routeHistory.map(row => ({ ...row })),
      reason:this.lastReason,
      config:{ ...this.config },
      lastDecision:this.lastDecision
    };
  }
}
