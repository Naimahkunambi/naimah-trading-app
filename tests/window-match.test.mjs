import test from 'node:test';
import assert from 'node:assert/strict';
import { directionResult, matchTraceToTrade } from '../public/core/window-match-core.mjs';

test('direction results preserve conservative tie rule', () => {
  assert.equal(directionResult('CALL', 100, 101), 'won');
  assert.equal(directionResult('PUT', 100, 99), 'won');
  assert.equal(directionResult('CALL', 100, 100), 'lost');
});

test('exact Deriv entry and exit tick times identify T1 to T2', () => {
  const trace = { direction: 'CALL', signalEpoch: 100, windows: [
    { label: '0→1', startEpoch: 100, endEpoch: 101, startQuote: 10, endQuote: 11, result: 'won' },
    { label: '1→2', startEpoch: 101, endEpoch: 102, startQuote: 11, endQuote: 12, result: 'won' }
  ]};
  const match = matchTraceToTrade(trace, {
    profit: 0.92, entryTickTime: 101, exitTickTime: 102, entrySpot: 11, exitSpot: 12
  });
  assert.equal(match.matchedWindow, '1→2');
  assert.equal(match.quality, 'exact');
  assert.equal(match.agreement, true);
});

test('entry beyond Timing Lab v2 is marked outside lab instead of pretending exact', () => {
  const trace = { direction: 'PUT', signalEpoch: 100, windows: [
    { label: '3→4', startEpoch: 103, endEpoch: 104, startQuote: 10, endQuote: 9, result: 'won' }
  ]};
  const match = matchTraceToTrade(trace, {
    profit: -1, entryTickTime: 105, exitTickTime: 106, entrySpot: 8, exitSpot: 9
  });
  assert.equal(match.quality, 'outside-lab');
});
