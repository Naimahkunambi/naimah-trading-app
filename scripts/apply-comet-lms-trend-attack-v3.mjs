import fs from 'node:fs';

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`${label}: source marker not found`);
  return source.replace(before, after);
}

const sharedBrain = `let macroRegimeState = { direction: 'WARMING', pending: '', pendingCount: 0, lastEpoch: 0 };
function macroTrend(rows = ticks) {
  const clean = (rows || []).filter(r => Number.isFinite(Number(r?.quote)));
  const q = clean.map(r => Number(r.quote));
  if (q.length < 180) return { direction: 'WARMING', rawDirection: 'WARMING', strength: 0, pending: '', pendingCount: 0 };
  const averageTail = n => {
    const a = q.slice(-Math.min(n, q.length));
    return a.reduce((sum, value) => sum + value, 0) / Math.max(1, a.length);
  };
  const fast = averageTail(60);
  const mid = averageTail(180);
  const slow = averageTail(480);
  const last = q.at(-1);
  const q90 = q[Math.max(0, q.length - 90)];
  const q240 = q[Math.max(0, q.length - 240)];
  const q480 = q[Math.max(0, q.length - 480)];
  const upVotes = [fast > mid, mid > slow, last > fast, last > q90, last > q240, last > q480].filter(Boolean).length;
  const rawDirection = upVotes >= 5 ? 'UP' : upVotes <= 1 ? 'DOWN' : 'CHOP';
  const step = tickStep(rows) || 1;
  const displacement = Math.abs(last - q480) / step;
  const strength = Math.round(clamp((Math.abs(upVotes - 3) / 3) * 70 + Math.min(30, displacement), 0, 100));
  const epoch = Number(clean.at(-1)?.epoch || 0);

  if (epoch && epoch !== macroRegimeState.lastEpoch) {
    macroRegimeState.lastEpoch = epoch;
    const current = macroRegimeState.direction;
    const rawIsTrend = rawDirection === 'UP' || rawDirection === 'DOWN';
    if (rawIsTrend && !['UP', 'DOWN'].includes(current)) {
      if (macroRegimeState.pending === rawDirection) macroRegimeState.pendingCount += 1;
      else { macroRegimeState.pending = rawDirection; macroRegimeState.pendingCount = 1; }
      if (macroRegimeState.pendingCount >= 2) {
        macroRegimeState.direction = rawDirection;
        macroRegimeState.pending = '';
        macroRegimeState.pendingCount = 0;
      }
    } else if (rawIsTrend && rawDirection === current) {
      macroRegimeState.pending = '';
      macroRegimeState.pendingCount = 0;
    } else if (rawIsTrend && ['UP', 'DOWN'].includes(current) && rawDirection !== current) {
      if (macroRegimeState.pending === rawDirection) macroRegimeState.pendingCount += 1;
      else { macroRegimeState.pending = rawDirection; macroRegimeState.pendingCount = 1; }
      if (macroRegimeState.pendingCount >= 12) {
        macroRegimeState.direction = rawDirection;
        macroRegimeState.pending = '';
        macroRegimeState.pendingCount = 0;
      }
    } else if (rawDirection === 'CHOP') {
      macroRegimeState.pendingCount = Math.max(0, macroRegimeState.pendingCount - 1);
      if (!macroRegimeState.pendingCount) macroRegimeState.pending = '';
    }
  }

  return { direction: macroRegimeState.direction, rawDirection, strength, votes: upVotes, pending: macroRegimeState.pending, pendingCount: macroRegimeState.pendingCount, fast, mid, slow, displacement };
}
function macroConflict(macro) {
  return Boolean(macro?.pending && macro.pending !== macro.direction && Number(macro.pendingCount || 0) >= 8);
}
function continuationSignal(rows = ticks, direction = 'UP') {
  const q = (rows || []).map(r => Number(r?.quote)).filter(Number.isFinite);
  if (q.length < 14 || !['UP', 'DOWN'].includes(direction)) return { ready: false, score: 0 };
  const sign = direction === 'UP' ? 1 : -1;
  const step = tickStep(rows) || 1;
  const last = q.at(-1);
  const d3 = sign * (last - q.at(-4)) / step;
  const d7 = sign * (last - q.at(-8)) / step;
  let aligned = 0;
  for (let i = q.length - 6; i < q.length; i++) if (i > 0 && sign * (q[i] - q[i - 1]) > 0) aligned += 1;
  const prior = q.slice(-7, -1);
  const breakout = direction === 'UP' ? last >= Math.max(...prior) : last <= Math.min(...prior);
  const lastStep = sign * (q.at(-1) - q.at(-2)) > 0;
  const score = [d3 > 0.45, d7 > 0.75, aligned >= 4, breakout, lastStep].filter(Boolean).length;
  return { ready: score >= 3, score, d3, d7, aligned, breakout };
}`;

function patchComet() {
  const file = 'public/comet.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(s,
`  targetR: 2,
  trailStartR: 1,
  structureTrailR: 1.5,
  trailLockR: 0.10,`,
`  targetR: 2,
  trailStartR: 0.85,
  structureTrailR: 1.20,
  trailLockR: 0.35,`, 'COMET protection defaults');

  const allowed = `function allowedSide(m) {
  return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE';
}`;
  s = replaceOnce(s, allowed, `${sharedBrain}\n${allowed}`, 'COMET shared trend brain');

  s = replaceOnce(s,
`function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (!permission.allowed || !cometEntryAllowed(m)) return null;`,
`function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  const macro = macroTrend(ticks);
  if (!['UP', 'DOWN'].includes(macro.direction)) return null;
  if (macro.direction !== m.direction || macroConflict(macro)) return null;
  if (['EXHAUSTION', 'LATE_OR_WAIT'].includes(m.entryMode)) return null;

  const continuation = continuationSignal(ticks, macro.direction);
  const confirmation = Number(m.confirmation || 0);
  const classic = ['PULLBACK_END', 'EARLY_MOMENTUM'].includes(m.entryMode) && confirmation >= 5 && cometEntryAllowed(m);
  const resume = m.entryMode === 'WAIT_PULLBACK_END' && confirmation >= 3 && continuation.ready && tuning.entryStrategy !== 'MOMENTUM_ONLY';
  if (!classic && !resume) return null;

  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (classic && !permission.allowed) return null;
  const attackKind = resume ? 'CONTINUATION_ATTACK' : 'CLASSIC_ENTRY';`, 'COMET attack candidate');

  s = replaceOnce(s,
`    openedAt: Date.now(), openedEpoch: epoch, entryKey: key, bestR: 0, reversalVotes: 0,
    entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`    openedAt: Date.now(), openedEpoch: epoch, entryKey: key, bestR: 0, reversalVotes: 0,
    entryContext: slimMountain(m), macroContext: macro, attackKind, continuationScore: continuation.score, plannedRiskDistance: riskDistance`, 'COMET entry metadata');

  s = replaceOnce(s,
`  addTape('ENTRY', \`${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · ${'${c.entryContext.entryMode}'} · stop ${'${c.stop.toFixed(2)}'} · target ${'${c.target.toFixed(2)}'}\`, { side: c.side });`,
`  addTape('ENTRY', \`${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · ${'${c.attackKind}'} · BIG ${'${c.macroContext?.direction || "?"}'} ${'${c.macroContext?.strength || 0}'}/100 · CONF ${'${c.entryContext.confirmation}'} · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side });`, 'COMET entry tape');

  s = replaceOnce(s,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitContext: slimMountain(latestMountain)`,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitContext: slimMountain(latestMountain), exitMacro: macroTrend(ticks)`, 'COMET exit macro');

  s = replaceOnce(s,
`  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  position.reversalVotes = opposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (position.side === 'LONG' && macro.direction === 'DOWN') || (position.side === 'SHORT' && macro.direction === 'UP');
  position.reversalVotes = opposite && macroOpposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'COMET reversal gate');

  s = replaceOnce(s,
`  // Editable profit protection: first lock, then structural trail.
  if (u.r >= tuning.trailStartR) {
    const risk = Math.abs(position.entry - position.stop);
    const protect = position.side === 'LONG' ? position.entry + risk * tuning.trailLockR : position.entry - risk * tuning.trailLockR;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  }`,
`  // Progressive winner floor. Let the trend breathe, but do not give a real winner back to crumbs.
  const risk = Math.abs(position.entry - position.stop);
  const lockAt = lockedR => {
    const protect = position.side === 'LONG' ? position.entry + risk * lockedR : position.entry - risk * lockedR;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  };
  if (u.r >= tuning.trailStartR) lockAt(tuning.trailLockR);
  if (u.r >= 1.10) lockAt(Math.max(tuning.trailLockR, 0.60));
  if (u.r >= 1.35) lockAt(Math.max(tuning.trailLockR, 0.90));`, 'COMET winner floor');

  s = replaceOnce(s,
`  $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`  { const big = macroTrend(ticks), attack = continuationSignal(ticks, big.direction); $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · ${'${attack.ready ? "ATTACK READY" : "WAIT"}'}\`; }`, 'COMET map status');

  s = replaceOnce(s,
`  ctx.fillText(\`LIBRA MOUNTAIN: ${'${m.direction}'} · ${'${m.entryMode}'} · ${'${allowedSide(m)}'} · ${'${chartFrozen ? \'FROZEN\' : \'LIVE\'}'}\`, pad.l, 18);`,
`  { const big=macroTrend(rows), attack=continuationSignal(rows,big.direction); ctx.fillText(\`LIBRA: ${'${m.direction}'} · ${'${m.entryMode}'} · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · ${'${attack.ready ? "ATTACK READY" : "WAIT"}'} · ${'${chartFrozen ? \'FROZEN\' : \'LIVE\'}'}\`, pad.l, 18); }`, 'COMET chart status');

  s = replaceOnce(s,
`getMountain: () => structuredClone(latestMountain), getDemoExecution:`,
`getMountain: () => structuredClone(latestMountain), getMacroTrend: () => structuredClone(macroTrend(ticks)), getContinuation: () => structuredClone(continuationSignal(ticks, macroTrend(ticks).direction)), getDemoExecution:`, 'COMET runtime debug');

  fs.writeFileSync(file, s);
  console.log('COMET v3 applied: sticky trend + continuation attack + 5-confirm classic entry.');
}

function patchLms() {
  const file = 'public/last-man-standing.js';
  let s = fs.readFileSync(file, 'utf8');

  const allowed = `function allowedSide(m) { return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE'; }`;
  s = replaceOnce(s, allowed, `${sharedBrain}\n${allowed}`, 'LMS shared trend brain');

  s = replaceOnce(s,
`function selectedMode(power, m = latestMountain) {
  const recommended = autoMode(power, m);
  if (requestedMode === 'AUTO') return recommended;`,
`function selectedMode(power, m = latestMountain) {
  const recommended = autoMode(power, m);
  if (requestedMode === 'AUTO') return recommended === 'GRAB' ? 'STAND_DOWN' : recommended;`, 'LMS no GRAB in auto');

  s = replaceOnce(s,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (!permission.allowed || !lmsEntryAllowed(m)) return null;`,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const macro = macroTrend(ticks);
  if (!['UP', 'DOWN'].includes(macro.direction)) return null;
  if (macro.direction !== m.direction || macroConflict(macro)) return null;
  if (['EXHAUSTION', 'LATE_OR_WAIT'].includes(m.entryMode)) return null;

  const continuation = continuationSignal(ticks, macro.direction);
  const confirmation = Number(m.confirmation || 0);
  const classic = ['PULLBACK_END', 'EARLY_MOMENTUM'].includes(m.entryMode) && confirmation >= 4 && lmsEntryAllowed(m);
  const resume = m.entryMode === 'WAIT_PULLBACK_END' && confirmation >= 3 && continuation.ready && tuning.entryStrategy !== 'MOMENTUM_ONLY';
  if (!classic && !resume) return null;

  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';
  const permission = mountainAllows(m, direction);
  if (classic && !permission.allowed) return null;
  const attackKind = resume ? 'CONTINUATION_ATTACK' : 'CLASSIC_ENTRY';`, 'LMS attack candidate');

  s = replaceOnce(s,
`  const power = trendPower(m, ticks);
  const mode = selectedMode(power, m);
  const cfg = modeConfig(mode);`,
`  const power = trendPower(m, ticks);
  const boosted = requestedMode === 'AUTO' && continuation.ready ? Math.min(69, Math.round(macro.strength * 0.82)) : power;
  const decisionPower = Math.max(power, boosted);
  const mode = selectedMode(decisionPower, m);
  const cfg = modeConfig(mode);`, 'LMS continuation power');

  s = replaceOnce(s,
`    target, targetR: cfg.targetR, originalTargetR: cfg.targetR, units, riskDollars, stakeDollars, riskCap, openedAt: Date.now(), openedEpoch: epoch,
    entryKey: key, bestR: 0, lockedR: -1, reversalVotes: 0, targetExtended: false, entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`    target, targetR: cfg.targetR, originalTargetR: cfg.targetR, units, riskDollars, stakeDollars, riskCap, openedAt: Date.now(), openedEpoch: epoch,
    entryKey: key, bestR: 0, lockedR: -1, reversalVotes: 0, targetExtended: false, entryContext: slimMountain(m), macroContext: macro, attackKind, decisionPower, continuationScore: continuation.score, plannedRiskDistance: riskDistance`, 'LMS entry metadata');

  s = replaceOnce(s,
`  addTape('ENTRY', \`${'${c.mode}'} ${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · power ${'${c.entryPower}'}/100 · stake ${'${money(c.stakeDollars)}'} · SL ${'${money(c.riskDollars)}'} · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side, mode: c.mode });`,
`  addTape('ENTRY', \`${'${c.mode}'} ${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · ${'${c.attackKind}'} · BIG ${'${c.macroContext?.direction || "?"}'} ${'${c.macroContext?.strength || 0}'}/100 · power ${'${c.entryPower}'}→${'${c.decisionPower}'}/100 · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side, mode: c.mode });`, 'LMS entry tape');

  s = replaceOnce(s,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitPower: latestPower, exitRecommendedMode: latestRecommendedMode, exitContext: slimMountain(latestMountain)`,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitPower: latestPower, exitRecommendedMode: latestRecommendedMode, exitContext: slimMountain(latestMountain), exitMacro: macroTrend(ticks)`, 'LMS exit macro');

  s = replaceOnce(s,
`  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (p.side === 'LONG' && macro.direction === 'DOWN') || (p.side === 'SHORT' && macro.direction === 'UP');
  p.reversalVotes = opposite && macroOpposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'LMS reversal gate');

  s = replaceOnce(s,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; { const big=macroTrend(ticks), attack=continuationSignal(ticks,big.direction); $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · ${'${attack.ready ? "ATTACK READY" : "WAIT"}'}\`; }`, 'LMS map status');

  s = replaceOnce(s,
`  ctx.fillStyle='#f1adc9';ctx.font='11px monospace';ctx.fillText(\`LIBRA: ${'${m.direction}'} · ${'${m.entryMode}'} · POWER ${'${trendPower(m,rows)}'}/100 · ${'${chartFrozen?\'FROZEN\':\'LIVE\'}'}\`,pad.l,18);`,
`  ctx.fillStyle='#f1adc9';ctx.font='11px monospace';{const big=macroTrend(rows),attack=continuationSignal(rows,big.direction);ctx.fillText(\`LIBRA: ${'${m.direction}'} · ${'${m.entryMode}'} · POWER ${'${trendPower(m,rows)}'}/100 · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · ${'${attack.ready ? "ATTACK READY" : "WAIT"}'} · ${'${chartFrozen?\'FROZEN\':\'LIVE\'}'}\`,pad.l,18);}`, 'LMS chart status');

  s = replaceOnce(s,
`getMountain:()=>structuredClone(latestMountain),getTrendPower:`,
`getMountain:()=>structuredClone(latestMountain),getMacroTrend:()=>structuredClone(macroTrend(ticks)),getContinuation:()=>structuredClone(continuationSignal(ticks,macroTrend(ticks).direction)),getTrendPower:`, 'LMS runtime debug');

  fs.writeFileSync(file, s);
  console.log('LAST MAN v3 applied: continuation attack + AUTO CRUISE/LAST MAN, power-fade logic untouched.');
}

patchComet();
patchLms();
