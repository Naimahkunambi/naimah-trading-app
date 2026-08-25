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

test('Trend Map is advisory and never vetoes an original v8.1 entry', () => {
  const base = { approved:true, requestedBatch:2, sniper:{ grade:'A' } };
  const aligned = applyMilkingPolicy({ ...base, tradeDirection:'CALL' }, { state:'DRIVE', direction:'UP' });
  const counter = applyMilkingPolicy({ ...base, tradeDirection:'PUT' }, { state:'DRIVE', direction:'UP' });
  assert.equal(aligned.approved, true);
  assert.equal(counter.approved, true);
  assert.equal(aligned.batch, 2);
  assert.equal(counter.batch, 2);
  assert.equal(aligned.alignment, 'ALIGNED');
  assert.equal(counter.alignment, 'COUNTER_TREND');
  assert.equal(counter.role, 'GUIDE_ONLY');
});

test('every mapped stage preserves the original entry and batch', () => {
  const base = { approved:true, requestedBatch:2, tradeDirection:'CALL', sniper:{ grade:'A' } };
  for (const state of ['OBSERVE', 'DRIVE', 'MATURE', 'HARVEST', 'TURNING']) {
    const policy = applyMilkingPolicy(base, { state, direction:state === 'OBSERVE' ? 'NONE' : 'UP' });
    assert.equal(policy.approved, true, state);
    assert.equal(policy.batch, 2, state);
  }
});

test('the original sniper decision remains the only no-entry decision', () => {
  const policy = applyMilkingPolicy({ approved:false, requestedBatch:2, tradeDirection:'CALL' }, { state:'DRIVE', direction:'UP' });
  assert.equal(policy.approved, false);
  assert.equal(policy.batch, 0);
  assert.equal(policy.alignment, 'NO_ENTRY');
});
