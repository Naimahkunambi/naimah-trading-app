import test from 'node:test';
import assert from 'node:assert/strict';
import { TrendBudget, applyMilkingPolicy } from '../public/core/trend-budget.mjs';

function ticks(count, start = 1000, step = 1, epoch = 1000) {
  return Array.from({ length:count }, (_, index) => ({ epoch:epoch + index, quote:start + index * step }));
}

test('locks a sustained upward drive from past-only windows', () => {
  const meter = new TrendBudget();
  const snapshot = meter.hydrate(ticks(130, 1000, 2));
  assert.equal(snapshot.direction, 'UP');
  assert.ok(['DRIVE', 'MATURE', 'HARVEST'].includes(snapshot.state));
  assert.ok(snapshot.health > 50);
});

test('locks a sustained downward drive', () => {
  const meter = new TrendBudget();
  const snapshot = meter.hydrate(ticks(130, 2000, -2));
  assert.equal(snapshot.direction, 'DOWN');
});

test('requires hysteresis before flipping the locked direction', () => {
  const meter = new TrendBudget({ flipVotes:2, flipWindowSeconds:3 });
  meter.hydrate(ticks(140, 1000, 2));
  assert.equal(meter.current.direction, 'UP');
  const last = meter.ticks.at(-1);
  const falling = Array.from({ length:125 }, (_, index) => ({ epoch:last.epoch + index + 1, quote:last.quote - (index + 1) * 4 }));
  let sawTurning = false;
  for (const tick of falling) {
    const snapshot = meter.ingest(tick);
    if (snapshot.state === 'TURNING') sawTurning = true;
    if (snapshot.direction === 'DOWN') break;
  }
  assert.equal(sawTurning, true);
  assert.equal(meter.current.direction, 'DOWN');
});

test('drive policy allows aligned shots and blocks opposing shots', () => {
  const base = { approved:true, requestedBatch:2, sniper:{ grade:'A' } };
  assert.deepEqual(applyMilkingPolicy({ ...base, tradeDirection:'CALL' }, { state:'DRIVE', direction:'UP' }).approved, true);
  assert.equal(applyMilkingPolicy({ ...base, tradeDirection:'PUT' }, { state:'DRIVE', direction:'UP' }).approved, false);
});

test('mature policy earns only one contract and harvest blocks entries', () => {
  const base = { approved:true, requestedBatch:2, tradeDirection:'CALL', sniper:{ grade:'A' } };
  assert.equal(applyMilkingPolicy(base, { state:'MATURE', direction:'UP' }).batch, 1);
  assert.equal(applyMilkingPolicy(base, { state:'HARVEST', direction:'UP' }).approved, false);
});
