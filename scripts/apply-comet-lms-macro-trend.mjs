import fs from 'node:fs';

const macroTrendFn = `function macroTrend(rows = ticks) {
  const q = (rows || []).map(r => Number(r.quote)).filter(Number.isFinite);
  if (q.length < 90) return { direction: 'WARMING', strength: 0, votes: 0 };
  const averageTail = n => {
    const a = q.slice(-Math.min(n, q.length));
    return a.reduce((sum, value) => sum + value, 0) / Math.max(1, a.length);
  };
  const fast = averageTail(24);
  const mid = averageTail(72);
  const slow = averageTail(180);
  const last = q.at(-1);
  const q60 = q[Math.max(0, q.length - 60)];
  const q180 = q[Math.max(0, q.length - 180)];
  const upVotes = [fast > mid, mid > slow, last > mid, last > q60, last > q180].filter(Boolean).length;
  const direction = upVotes >= 4 ? 'UP' : upVotes <= 1 ? 'DOWN' : 'CHOP';
  const step = tickStep(rows) || 1;
  const displacement = Math.abs(last - q180) / step;
  const strength = Math.round(clamp((Math.abs(upVotes - 2.5) / 2.5) * 65 + Math.min(35, displacement * 1.5), 0, 100));
  return { direction, strength, votes: upVotes, fast, mid, slow, displacement };
}`;

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`${label}: expected source marker not found`);
  return source.replace(before, after);
}

function patchComet() {
  const file = 'public/comet.js';
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('getMacroTrend: () => structuredClone(macroTrend(ticks))')) {
    console.log('COMET macro trend patch already present.');
    return;
  }

  const allowedSide = `function allowedSide(m) {
  return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE';
}`;
  source = replaceOnce(source, allowedSide, `${macroTrendFn}\n${allowedSide}`, 'COMET macro trend function');

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
  if (macro.direction !== m.direction) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`, 'COMET entry gate');

  source = replaceOnce(source,
`    entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`    entryContext: slimMountain(m), macroContext: macro, plannedRiskDistance: riskDistance`, 'COMET macro context');

  source = replaceOnce(source,
`  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  position.reversalVotes = opposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (position.side === 'LONG' && m.direction === 'DOWN') || (position.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (position.side === 'LONG' && macro.direction === 'DOWN') || (position.side === 'SHORT' && macro.direction === 'UP');
  // Local opposite structure is a pullback while the macro trend still supports the position.
  position.reversalVotes = opposite && macroOpposite ? Number(position.reversalVotes || 0) + 1 : 0;
  if (position.reversalVotes >= cometReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'COMET reversal gate');

  source = replaceOnce(source,
`  $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`  $('mapPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${macroTrend(ticks).direction}'}\`;`, 'COMET trend UI');

  source = replaceOnce(source,
`getMountain: () => structuredClone(latestMountain), getDemoExecution:`,
`getMountain: () => structuredClone(latestMountain), getMacroTrend: () => structuredClone(macroTrend(ticks)), getDemoExecution:`, 'COMET runtime');

  fs.writeFileSync(file, source);
  console.log('COMET macro trend boss applied.');
}

function patchLastMan() {
  const file = 'public/last-man-standing.js';
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes('getMacroTrend:()=>structuredClone(macroTrend(ticks))')) {
    console.log('Last Man macro trend patch already present.');
    return;
  }

  const allowedSide = `function allowedSide(m) { return m?.allowedDirection === 'CALL' ? 'LONG' : m?.allowedDirection === 'PUT' ? 'SHORT' : 'NONE'; }`;
  source = replaceOnce(source, allowedSide, `${macroTrendFn}\n${allowedSide}`, 'LMS macro trend function');

  source = replaceOnce(source,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`,
`function candidate(m) {
  if (!auto || position || !m?.ready || !['UP', 'DOWN'].includes(m.direction)) return null;
  const macro = macroTrend(ticks);
  if (!['UP', 'DOWN'].includes(macro.direction)) return null;
  if (macro.direction !== m.direction) return null;
  const direction = m.direction === 'UP' ? 'CALL' : 'PUT';`, 'LMS entry gate');

  source = replaceOnce(source,
`entryContext: slimMountain(m), plannedRiskDistance: riskDistance`,
`entryContext: slimMountain(m), macroContext: macro, plannedRiskDistance: riskDistance`, 'LMS macro context');

  source = replaceOnce(source,
`  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  p.reversalVotes = opposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MOUNTAIN REVERSAL', q);`,
`  const macro = macroTrend(ticks);
  const opposite = (p.side === 'LONG' && m.direction === 'DOWN') || (p.side === 'SHORT' && m.direction === 'UP');
  const macroOpposite = (p.side === 'LONG' && macro.direction === 'DOWN') || (p.side === 'SHORT' && macro.direction === 'UP');
  // Local counter-mountains are pullbacks. Reversal exit needs macro agreement too.
  p.reversalVotes = opposite && macroOpposite ? Number(p.reversalVotes || 0) + 1 : 0;
  if (p.reversalVotes >= lmsReversalVotesNeeded()) return closePaperPosition('CONFIRMED MACRO + MOUNTAIN REVERSAL', q);`, 'LMS reversal gate');

  source = replaceOnce(source,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} ONLY\`;`,
`$('trendMountain').textContent = latestMountain.direction || 'WARMING'; $('trendPermission').textContent = \`${'${allowedSide(latestMountain)}'} LOCAL · BIG ${'${macroTrend(ticks).direction}'}\`;`, 'LMS trend UI');

  source = replaceOnce(source,
`getMountain:()=>structuredClone(latestMountain),getTrendPower:`,
`getMountain:()=>structuredClone(latestMountain),getMacroTrend:()=>structuredClone(macroTrend(ticks)),getTrendPower:`, 'LMS runtime');

  fs.writeFileSync(file, source);
  console.log('LAST MAN macro trend boss applied. POWER FADE cash-out logic left untouched.');
}

patchComet();
patchLastMan();
