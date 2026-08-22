export function directionResult(direction, startQuote, endQuote) {
  const start = Number(startQuote);
  const end = Number(endQuote);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (direction === 'PUT') return end < start ? 'won' : 'lost';
  return end > start ? 'won' : 'lost';
}

export function matchTraceToTrade(trace, trade) {
  if (!trace || !trade) return undefined;
  const windows = (trace.windows || []).filter(Boolean);
  if (!windows.length) return undefined;

  const signalEpoch = Number(trace.signalEpoch);
  const entryTime = Number(trade.entryTickTime);
  const exitTime = Number(trade.exitTickTime);
  const entrySpot = Number(trade.entrySpot);
  const exitSpot = Number(trade.exitSpot);
  const actualResult = Number(trade.profit) > 0 ? 'won' : Number(trade.profit) < 0 ? 'lost' : 'sold';

  const hasTimes = Number.isFinite(signalEpoch) && Number.isFinite(entryTime) && Number.isFinite(exitTime);
  const entryOffset = hasTimes ? entryTime - signalEpoch : undefined;
  const exitOffset = hasTimes ? exitTime - signalEpoch : undefined;

  let chosen;
  let quality;
  let method;
  let timeDistanceSec;
  let priceDistance;

  if (hasTimes) {
    method = 'tick-time';
    chosen = windows.find(w => Number(w.startEpoch) === entryTime && Number(w.endEpoch) === exitTime);
    if (chosen) {
      quality = 'exact';
      timeDistanceSec = 0;
    } else {
      const outsideLab = entryOffset < 0 || entryOffset > 3 || exitOffset < 1 || exitOffset > 4;
      const ranked = windows.map(w => ({
        w,
        d: Math.abs(Number(w.startEpoch) - entryTime) + Math.abs(Number(w.endEpoch) - exitTime)
      })).sort((a, b) => a.d - b.d);
      chosen = ranked[0]?.w;
      timeDistanceSec = ranked[0]?.d;
      quality = outsideLab ? 'outside-lab' : 'nearest-time';
    }
  } else if (Number.isFinite(entrySpot) && Number.isFinite(exitSpot)) {
    method = 'price-fallback';
    const ranked = windows.map(w => ({
      w,
      d: Math.abs(Number(w.startQuote) - entrySpot) + Math.abs(Number(w.endQuote) - exitSpot)
    })).sort((a, b) => a.d - b.d);
    chosen = ranked[0]?.w;
    priceDistance = ranked[0]?.d;
    quality = 'nearest-price';
  }

  if (!chosen) return undefined;
  const shadowResult = chosen.result || directionResult(trace.direction, chosen.startQuote, chosen.endQuote);
  return {
    matchedWindow: chosen.label,
    quality,
    method,
    exact: quality === 'exact',
    timeDistanceSec,
    priceDistance,
    entryOffset,
    exitOffset,
    shadowResult,
    actualResult,
    agreement: shadowResult === actualResult,
    startEpoch: chosen.startEpoch,
    endEpoch: chosen.endEpoch,
    startQuote: chosen.startQuote,
    endQuote: chosen.endQuote
  };
}
