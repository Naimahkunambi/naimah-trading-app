import test from 'node:test';
import assert from 'node:assert/strict';
import { routeAt, routeSegments, tradeAuditPoint, visibleTickWindow } from '../public/core/smfn-map-history.mjs';

const ticks = Array.from({ length:500 }, (_, index) => ({ epoch:1000 + index, quote:790000 + index }));

test('history window can move backward and return to the latest ticks', () => {
  const live = visibleTickWindow(ticks, 120, 0);
  assert.equal(live.start, 1380);
  assert.equal(live.end, 1499);
  const past = visibleTickWindow(ticks, 120, 78);
  assert.equal(past.start, 1302);
  assert.equal(past.end, 1421);
  assert.equal(past.offset, 78);
  const oldest = visibleTickWindow(ticks, 120, 9999);
  assert.equal(oldest.start, 1000);
  assert.equal(oldest.end, 1119);
});

test('entry and exit positions are reconstructed from the saved T window', () => {
  const signal = { signalEpoch:1200, signalQuote:790200 };
  const audit = tradeAuditPoint(signal, { window:'T+4→T+5', outcome:'WON' }, ticks);
  assert.deepEqual(audit, { entryEpoch:1204, exitEpoch:1205, entrySpot:790204, exitSpot:790205 });
});

test('route audit returns the historical bot and collapses repeated rows', () => {
  const history = [{ epoch:1000, lane:'CALL' }, { epoch:1100, lane:'PUT' }];
  assert.equal(routeAt(history,1050),'CALL');
  assert.equal(routeAt(history,1150),'PUT');
  const segments = routeSegments([
    { signalEpoch:1001, smfn:{ allowedDirection:'CALL' } },
    { signalEpoch:1002, smfn:{ allowedDirection:'CALL' } },
    { signalEpoch:1003, smfn:{ allowedDirection:'PUT' } }
  ],1000,1010);
  assert.deepEqual(segments,[
    { lane:'CALL', start:1001, end:1002 },
    { lane:'PUT', start:1003, end:1003 }
  ]);
});
