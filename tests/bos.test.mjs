import test from 'node:test';
import assert from 'node:assert/strict';
import { StatefulBosStrategy } from '../public/core/bos.mjs';
import { ShadowTimingLab } from '../public/core/shadow-lab.mjs';
import { directBuyRequest, proposalRequest } from '../public/core/protocol.mjs';

const feed = (s, prices, start = 1) => prices.flatMap((quote, i) => s.push({ epoch: start + i, quote })?.signals || []);

test('deduplicates same epoch', () => {
  const s = new StatefulBosStrategy();
  assert.ok(s.push({ epoch: 1, quote: 10 }));
  assert.equal(s.push({ epoch: 1, quote: 11 }), null);
});

test('bull BOS', () => {
  const s = new StatefulBosStrategy();
  const signals = feed(s, [10, 8, 9, 12, 10, 11, 13]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'CALL');
  assert.equal(signals[0].level, 12);
});

test('bear BOS', () => {
  const s = new StatefulBosStrategy();
  const signals = feed(s, [10, 12, 11, 8, 10, 9, 7]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'PUT');
  assert.equal(signals[0].level, 8);
});

test('armed bull keeps BOS boundary frozen while newer HL rolls', () => {
  const s = new StatefulBosStrategy();
  // Directly exercise the exact state rule that previously regressed.
  s.bull = { state: 3, low: 8, high: 12, hl: 10 };
  s.onPivotHigh(13);
  assert.equal(s.bull.high, 12, 'armed BOS high must not roll');
  s.onPivotLow(11);
  assert.equal(s.bull.hl, 11, 'newer higher low may roll');
});

test('armed bear keeps BOS boundary frozen while newer LH rolls', () => {
  const s = new StatefulBosStrategy();
  s.bear = { state: 3, high: 12, low: 8, lh: 10 };
  s.onPivotLow(7);
  assert.equal(s.bear.low, 8, 'armed BOS low must not roll');
  s.onPivotHigh(9);
  assert.equal(s.bear.lh, 9, 'newer lower high may roll');
});

test('shadow scores T+1/T+2/T+3 from BOS price with ties as losses', () => {
  const lab = new ShadowTimingLab([1, 2, 3]);
  lab.onTick({ quote: 100 });
  lab.addSignal({ direction: 'CALL' }, 100);
  lab.onTick({ quote: 101 });
  lab.onTick({ quote: 100 });
  lab.onTick({ quote: 102 });
  const rows = lab.snapshot();
  assert.deepEqual(rows.map(x => [x.horizon, x.wins, x.losses]), [[1,1,0],[2,0,1],[3,1,0]]);
});

test('direct buy request matches parameter-buy shape', () => {
  const config = { stake: 1, currency: 'USD', duration: 1, durationUnit: 't', symbol: '1HZ25V' };
  assert.deepEqual(directBuyRequest('CALL', config, 7), {
    buy: '1', price: 1,
    parameters: { amount: 1, basis: 'stake', contract_type: 'CALL', currency: 'USD', duration: 1, duration_unit: 't', underlying_symbol: '1HZ25V' },
    req_id: 7
  });
});

test('proposal diagnostic request remains available', () => {
  const r = proposalRequest('PUT', { stake: 1, currency: 'USD', duration: 2, durationUnit: 't', symbol: '1HZ25V' }, 9);
  assert.equal(r.proposal, 1);
  assert.equal(r.contract_type, 'PUT');
  assert.equal(r.duration, 2);
});
