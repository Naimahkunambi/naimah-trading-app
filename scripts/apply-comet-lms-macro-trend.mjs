import fs from 'node:fs';

const macroTrendFn = `let macroRegimeState = { direction: 'WARMING', pending: '', pendingCount: 0, lastEpoch: 0 };
function macroTrend(rows = ticks) {
  const clean = (rows || []).filter(r => Number.isFinite(Number(r?.quote)));
  const q = clean.map(r => Number(r.quote));
  if (q.length < 180) return { direction: 'WARMING', rawDirection: 'WARMING', strength: 0, pendingCount: 0 };
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
      if (macroRegimeState.pendingCount >= 3) {
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
      if (macroRegimeState.pendingCount >= 18) {
        macroRegimeState.direction = rawDirection;
        macroRegimeState.pending = '';
        macroRegimeState.pendingCount = 0;
      }
    } else if (rawDirection === 'CHOP') {
      macroRegimeState.pendingCount = Math.max(0, macroRegimeState.pendingCount - 1);
      if (!macroRegimeState.pendingCount) macroRegimeState.pending = '';
    }
  }

  return {
    direction: macroRegimeState.direction,
    rawDirection,
    strength,
    votes: upVotes,
    pending: macroRegimeState.pending,
    pendingCount: macroRegimeState.pendingCount,
    fast,
    mid,
    slow,
    displacement
  };
}`;

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`${label}: expected source marker not found`);
  return source.replace(before, after);
}

function patchComet() {
  const file = 'public/comet.js';
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('COMET_RESULT_TIGHTENING_V2')) {
    console.log('COMET result-tightening v2 already present.');
    return;
  }

  source = replaceOnce(source,
`  targetR: 2,
  trailStartR: 1,
  structureTrailR: 1.5,
  trailLockR: 0.10,`,
`  targetR: 2,
  trailStartR: 0.85,
  structureTrailR: 1.20,
  trailLockR: 0.35,`, 'COMET stronger default protection');

  const allowedSide = `function allowedSide(m) {
  return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE';
}`;
  source = replaceOnce(source, allowedSide, `${macroTrendFn}\n${allowedSide}`, 'COMET sticky macro trend');

  source = replaceOnce(source,
`function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`,
`function candidate(m) {
  if (!auto || position || !m?.ready) return null;
  if (!['UP', 'DOWN'].includes(m.direction)) return null;
  const macro = macroTrend(ticks);
  if (!['UP', 'DOWN'].includes(macro.direction)) return null;
  if (macro.rawDirection !== macro.direction || macro.strength < 55) return null;
  if (macro.direction !== m.direction) return null;
  if (Number(m.confirmation || 0) < 6) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`, 'COMET confirmation-6 + sticky entry gate');

  source = replaceOnce(source,
`    entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`    entryContext: slimMountain(m), macroContext: macro, plannedRiskDistance: riskDistance`, 'COMET macro entry context');

  source = replaceOnce(source,
`  addTape('ENTRY', \`${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · ${'${c.entryContext.entryMode}'} · stop ${'${c.stop.toFixed(2)}'} · target ${'${c.target.toFixed(2)}'}\`, { side: c.side });`,
`  addTape('ENTRY', \`${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · BIG ${'${c.macroContext?.direction || "?"}'} ${'${c.macroContext?.strength || 0}'}/100 · CONF ${'${c.entryContext.confirmation}'} · ${'${c.entryContext.entryMode}'} · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side });`, 'COMET entry tape');

  source = replaceOnce(source,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitContext: slimMountain(latestMountain)`,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitContext: slimMountain(latestMountain), exitMacro: macroTrend(ticks)`, 'COMET exit macro context');

  source = replaceOnce(source,
`  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  position.reversalVotes = opposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (position.side === 'LONG' && macro.direction === 'DOWN') || (position.side === 'SHORT' && macro.direction === 'UP');
  // COMET_RESULT_TIGHTENING_V2: local counter-mountains are pullbacks until the sticky macro regime really flips.
  position.reversalVotes = opposite && macroOpposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'COMET sticky reversal exit');

  source = replaceOnce(source,
`  // Editable profit protection: first lock, then structural trail.
  if (u.r >= tuning.trailStartR) {
    const risk = Math.abs(position.entry - position.stop);
    const protect = position.side === 'LONG' ? position.entry + risk * tuning.trailLockR : position.entry - risk * tuning.trailLockR;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  }`,
`  // Profit firewall: winners may breathe, but a 1R+ winner is no longer allowed to collapse back to +0.10R.
  const risk = Math.abs(position.entry - position.stop);
  const lockAt = lockedR => {
    const protect = position.side === 'LONG' ? position.entry + risk * lockedR : position.entry - risk * lockedR;
    position.trailStop = position.side === 'LONG' ? Math.max(position.trailStop, protect) : Math.min(position.trailStop, protect);
  };
  if (u.r >= tuning.trailStartR) lockAt(tuning.trailLockR);
  if (u.r >= 1.10) lockAt(Math.max(tuning.trailLockR, 0.60));
  if (u.r >= 1.35) lockAt(Math.max(tuning.trailLockR, 0.90));`, 'COMET progressive profit floor');

  source = replaceOnce(source,
`  $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`  { const big = macroTrend(ticks); $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · RAW ${'${big.rawDirection}'}\`; }`, 'COMET macro UI');

  source = replaceOnce(source,
`  const headers = ['row_type','closed_at','side','entry','initial_stop','target','exit','exit_reason','r','pnl','risk_dollars','target_r','opened_at','opened_epoch','entry_mountain','entry_moment','entry_confirmation','entry_important','exit_mountain','exit_moment'];
  const rows = [[ 'SUMMARY', new Date().toISOString(), '', '', '', '', '', '', '', session.pnl, '', '', '', '', '', '', '', '', '', '' ]];`,
`  const headers = ['row_type','closed_at','side','entry','initial_stop','target','exit','exit_reason','r','pnl','risk_dollars','target_r','opened_at','opened_epoch','entry_mountain','entry_moment','entry_confirmation','entry_important','entry_macro','entry_macro_strength','entry_macro_raw','exit_mountain','exit_moment','exit_macro','exit_macro_strength'];
  const rows = [[ 'SUMMARY', new Date().toISOString(), '', '', '', '', '', '', '', session.pnl, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '' ]];`, 'COMET CSV headers');

  source = replaceOnce(source,
`    rows.push(['TRADE', new Date(t.closedAt).toISOString(), t.side, t.entry, t.stop, t.target, t.exit, t.reason, t.r, t.pnl, t.riskDollars, t.targetR, new Date(t.openedAt).toISOString(), t.openedEpoch, t.entryContext?.direction, t.entryContext?.entryMode, t.entryContext?.confirmation, t.entryContext?.important?.quote, t.exitContext?.direction, t.exitContext?.entryMode]);`,
`    rows.push(['TRADE', new Date(t.closedAt).toISOString(), t.side, t.entry, t.stop, t.target, t.exit, t.reason, t.r, t.pnl, t.riskDollars, t.targetR, new Date(t.openedAt).toISOString(), t.openedEpoch, t.entryContext?.direction, t.entryContext?.entryMode, t.entryContext?.confirmation, t.entryContext?.important?.quote, t.macroContext?.direction, t.macroContext?.strength, t.macroContext?.rawDirection, t.exitContext?.direction, t.exitContext?.entryMode, t.exitMacro?.direction, t.exitMacro?.strength]);`, 'COMET CSV macro rows');

  source = replaceOnce(source,
`getMountain: () => structuredClone(latestMountain), getDemoExecution:`,
`getMountain: () => structuredClone(latestMountain), getMacroTrend: () => structuredClone(macroTrend(ticks)), getDemoExecution:`, 'COMET runtime macro');

  fs.writeFileSync(file, source);
  console.log('COMET v2: sticky macro + confirmation 6 + progressive winner floor applied.');
}

function patchLastMan() {
  const file = 'public/last-man-standing.js';
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('LMS_RESULT_TIGHTENING_V2')) {
    console.log('LAST MAN result-tightening v2 already present.');
    return;
  }

  const allowedSide = `function allowedSide(m) { return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE'; }`;
  source = replaceOnce(source, allowedSide, `${macroTrendFn}\n${allowedSide}`, 'LMS sticky macro trend');

  source = replaceOnce(source,
`function selectedMode(power, m = latestMountain) {
  const recommended = autoMode(power, m);
  if (requestedMode === 'AUTO') return recommended;`,
`function selectedMode(power, m = latestMountain) {
  const recommended = autoMode(power, m);
  // LMS_RESULT_TIGHTENING_V2: latest results showed GRAB was the losing AUTO bucket. Manual GRAB remains available for testing.
  if (requestedMode === 'AUTO') return recommended === 'GRAB' ? 'STAND_DOWN' : recommended;`, 'LMS disable GRAB in AUTO');

  source = replaceOnce(source,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const macro = macroTrend(ticks);
  if (!['UP', 'DOWN'].includes(macro.direction)) return null;
  if (macro.rawDirection !== macro.direction || macro.strength < 50) return null;
  if (macro.direction !== m.direction) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`, 'LMS sticky entry gate');

  source = replaceOnce(source,
`entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`entryContext: slimMountain(m), macroContext: macro, plannedRiskDistance: riskDistance`, 'LMS macro entry context');

  source = replaceOnce(source,
`  addTape('ENTRY', \`${'${c.mode}'} ${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · power ${'${c.entryPower}'}/100 · stake ${'${money(c.stakeDollars)}'} · SL ${'${money(c.riskDollars)}'} · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side, mode: c.mode });`,
`  addTape('ENTRY', \`${'${c.mode}'} ${'${c.side}'} @ ${'${c.entry.toFixed(2)}'} · BIG ${'${c.macroContext?.direction || "?"}'} ${'${c.macroContext?.strength || 0}'}/100 · power ${'${c.entryPower}'}/100 · target ${'${c.targetR.toFixed(2)}'}R\`, { side: c.side, mode: c.mode });`, 'LMS entry tape');

  source = replaceOnce(source,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitPower: latestPower, exitRecommendedMode: latestRecommendedMode, exitContext: slimMountain(latestMountain)`,
`    ...p, exit: q, closedAt: Date.now(), pnl: Number(u.pnl.toFixed(4)), r: Number(u.r.toFixed(4)), reason,
    exitPower: latestPower, exitRecommendedMode: latestRecommendedMode, exitContext: slimMountain(latestMountain), exitMacro: macroTrend(ticks)`, 'LMS exit macro context');

  source = replaceOnce(source,
`  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (p.side === 'LONG' && macro.direction === 'DOWN') || (p.side === 'SHORT' && macro.direction === 'UP');
  // Local counter-mountains are pullbacks. Reversal exit needs the sticky macro regime to flip too.
  p.reversalVotes = opposite && macroOpposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'LMS sticky reversal exit');

  source = replaceOnce(source,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; { const big=macroTrend(ticks); $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${big.direction}'} ${'${big.strength}'}/100 · RAW ${'${big.rawDirection}'}\`; }`, 'LMS macro UI');

  source = replaceOnce(source,
`function exportCsv(){const headers=['closed_at','entry_mode','final_mode','side','entry_power','exit_power','risk','entry','initial_stop','final_stop','target_r','exit','reason','r','pnl','entry_mountain','entry_moment','entry_confirmation','exit_mountain','exit_moment'];const esc=v=>\`"${'${String(v??\'\').replaceAll(\'"\',\'""\')}'}"\`;const rows=(session.trades||[]).slice().reverse().map(t=>[new Date(t.closedAt).toISOString(),t.mode,t.currentMode,t.side,t.entryPower,t.exitPower,t.riskDollars,t.entry,t.stop,t.trailStop,t.targetR,t.exit,t.reason,t.r,t.pnl,t.entryContext?.direction,t.entryContext?.entryMode,t.entryContext?.confirmation,t.exitContext?.direction,t.exitContext?.entryMode]);`,
`function exportCsv(){const headers=['closed_at','entry_mode','final_mode','side','entry_power','exit_power','risk','entry','initial_stop','final_stop','target_r','exit','reason','r','pnl','entry_mountain','entry_moment','entry_confirmation','entry_macro','entry_macro_strength','entry_macro_raw','exit_mountain','exit_moment','exit_macro','exit_macro_strength'];const esc=v=>\`"${'${String(v??\'\').replaceAll(\'"\',\'""\')}'}"\`;const rows=(session.trades||[]).slice().reverse().map(t=>[new Date(t.closedAt).toISOString(),t.mode,t.currentMode,t.side,t.entryPower,t.exitPower,t.riskDollars,t.entry,t.stop,t.trailStop,t.targetR,t.exit,t.reason,t.r,t.pnl,t.entryContext?.direction,t.entryContext?.entryMode,t.entryContext?.confirmation,t.macroContext?.direction,t.macroContext?.strength,t.macroContext?.rawDirection,t.exitContext?.direction,t.exitContext?.entryMode,t.exitMacro?.direction,t.exitMacro?.strength]);`, 'LMS CSV macro fields');

  source = replaceOnce(source,
`getMountain:()=>structuredClone(latestMountain),getTrendPower:`,
`getMountain:()=>structuredClone(latestMountain),getMacroTrend:()=>structuredClone(macroTrend(ticks)),getTrendPower:`, 'LMS runtime macro');

  fs.writeFileSync(file, source);
  console.log('LAST MAN v2: sticky macro + AUTO CRUISE/LAST MAN only applied. POWER FADE cash-out untouched.');
}

patchComet();
patchLastMan();
