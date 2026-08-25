const finite = value => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

export function visibleTickWindow(rows = [], requestedZoom = 120, requestedOffset = 0) {
  const ticks = rows
    .map(row => ({ ...row, epoch:Number(row?.epoch), quote:Number(row?.quote) }))
    .filter(row => finite(row.epoch) && finite(row.quote))
    .sort((a,b) => a.epoch - b.epoch);
  const zoom = Math.max(2, Math.round(Number(requestedZoom) || 120));
  const maxOffset = Math.max(0, ticks.length - Math.min(zoom, ticks.length));
  const offset = Math.round(clamp(requestedOffset, 0, maxOffset));
  const endIndex = Math.max(Math.min(2, ticks.length), ticks.length - offset);
  const startIndex = Math.max(0, endIndex - zoom);
  const visible = ticks.slice(startIndex, endIndex);
  return {
    ticks:visible,
    zoom,
    offset:ticks.length - endIndex,
    maxOffset,
    startIndex,
    endIndex,
    start:Number(visible[0]?.epoch || 0),
    end:Number(visible.at(-1)?.epoch || 0)
  };
}

function windowTicks(window = '') {
  const match = String(window).match(/T\+(\d+)(?:[^\d]+T\+(\d+))?/i);
  if (!match) return null;
  const entry = Number(match[1]);
  const exit = Number(match[2] ?? entry + 1);
  return { entry, exit };
}

function quoteNear(ticks, epoch) {
  if (!finite(epoch) || !ticks.length) return null;
  let best = null;
  for (const row of ticks) {
    const distance = Math.abs(Number(row.epoch) - Number(epoch));
    if (!best || distance < best.distance) best = { distance, quote:Number(row.quote) };
  }
  return best && finite(best.quote) ? best.quote : null;
}

export function tradeAuditPoint(signal = {}, trade = {}, ticks = []) {
  const signalEpoch = Number(signal.signalEpoch);
  const parsed = windowTicks(trade.window);
  const entryEpoch = finite(trade.entryEpoch) && Number(trade.entryEpoch) > 0
    ? Number(trade.entryEpoch)
    : finite(signalEpoch) && parsed ? signalEpoch + parsed.entry : signalEpoch;
  const exitEpoch = finite(trade.exitEpoch) && Number(trade.exitEpoch) > 0
    ? Number(trade.exitEpoch)
    : finite(entryEpoch) ? entryEpoch + Math.max(1, (parsed?.exit ?? 1) - (parsed?.entry ?? 0)) : null;
  const entrySpot = finite(trade.entrySpot) ? Number(trade.entrySpot) : quoteNear(ticks, entryEpoch) ?? (finite(signal.signalQuote) ? Number(signal.signalQuote) : null);
  const exitSpot = finite(trade.exitSpot) ? Number(trade.exitSpot) : quoteNear(ticks, exitEpoch);
  return { entryEpoch, exitEpoch, entrySpot, exitSpot };
}

export function routeAt(routeHistory = [], epoch = Infinity) {
  return routeHistory
    .filter(row => finite(row?.epoch) && Number(row.epoch) <= Number(epoch))
    .sort((a,b) => Number(a.epoch) - Number(b.epoch))
    .at(-1)?.lane || 'NONE';
}

export function routeSegments(signals = [], start = 0, end = Infinity) {
  const ordered = signals
    .map(signal => ({
      epoch:Number(signal?.signalEpoch || 0),
      lane:String(signal?.smfn?.allowedDirection || 'NONE').toUpperCase()
    }))
    .filter(row => finite(row.epoch) && row.epoch <= Number(end) && ['CALL','PUT','NONE'].includes(row.lane))
    .sort((a,b) => a.epoch - b.epoch);
  const prior = ordered.filter(row => row.epoch <= Number(start)).at(-1);
  const rows = ordered.filter(row => row.epoch >= Number(start));
  if (prior && rows[0]?.epoch !== Number(start)) rows.unshift({ ...prior, epoch:Number(start) });
  const segments = [];
  for (const row of rows) {
    if (segments.at(-1)?.lane === row.lane) segments.at(-1).end = row.epoch;
    else segments.push({ lane:row.lane, start:row.epoch, end:row.epoch });
  }
  return segments;
}
