import test from 'node:test';
import assert from 'node:assert/strict';
import { TrendBudget, HarvestBrake, applyMilkingPolicy } from '../public/core/trend-budget.mjs';

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

test('original v8 fires its full selected batch before Harvest', () => {
  const base = { approved:true, requestedBatch:2 };
  const aligned = applyMilkingPolicy({ ...base, tradeDirection:'CALL' }, { state:'DRIVE', direction:'UP' });
  const counter = applyMilkingPolicy({ ...base, tradeDirection:'PUT' }, { state:'DRIVE', direction:'UP' });
  assert.equal(aligned.approved, true);
  assert.equal(counter.approved, true);
  assert.equal(aligned.batch, 2);
  assert.equal(counter.batch, 2);
  assert.equal(aligned.alignment, 'ALIGNED');
  assert.equal(counter.alignment, 'COUNTER_TREND');
  assert.equal(counter.role, 'ORIGINAL_V8');
});

test('active Harvest is the only trend mechanism that stops a v8 entry', () => {
  const policy = applyMilkingPolicy(
    { approved:true, requestedBatch:2, tradeDirection:'CALL' },
    { state:'HARVEST', direction:'UP' },
    { blocked:true, reason:'Projected end buffer is active.' }
  );
  assert.equal(policy.approved, false);
  assert.equal(policy.batch, 0);
  assert.equal(policy.role, 'ACTIVE_HARVEST');
  assert.equal(policy.alignment, 'HARVEST_STOP');
});

test('the original sniper decision remains the only no-entry decision', () => {
  const policy = applyMilkingPolicy({ approved:false, requestedBatch:2, tradeDirection:'CALL' }, { state:'DRIVE', direction:'UP' });
  assert.equal(policy.approved, false);
  assert.equal(policy.batch, 0);
  assert.equal(policy.alignment, 'NO_ENTRY');
});

const lateTrend = {
  state:'MATURE',
  direction:'UP',
  health:35,
  maturity:82,
  exhaustion:78,
  decelerating:true,
  remaining:{ median:2 },
  remainingDistance:{ median:1.5 }
};

test('Harvest enters two pulse opportunities before the projected end', () => {
  const brake = new HarvestBrake({ pulseLead:2 });
  const result = brake.evaluate({ trend:lateTrend, epoch:100, quote:123.4, pulseGapSeconds:1 });
  assert.equal(result.action, 'HARVEST_ENTER');
  assert.equal(result.blocked, true);
  assert.equal(result.bufferSeconds, 2);
});

test('Harvest holds, then releases after two healthy continuation ticks', () => {
  const brake = new HarvestBrake({ pulseLead:2 });
  brake.evaluate({ trend:lateTrend, epoch:100, quote:123.4, pulseGapSeconds:1 });
  const held = brake.evaluate({ trend:lateTrend, epoch:101, quote:123.5, pulseGapSeconds:1 });
  assert.equal(held.action, 'HARVEST_STOP');
  const recovered = { ...lateTrend, state:'DRIVE', health:72, exhaustion:40, decelerating:false, remaining:{median:30}, remainingDistance:{median:20} };
  const first = brake.evaluate({ trend:recovered, epoch:102, quote:123.7, pulseGapSeconds:1 });
  const second = brake.evaluate({ trend:recovered, epoch:103, quote:124.0, pulseGapSeconds:1 });
  assert.equal(first.blocked, true);
  assert.equal(second.action, 'CONTINUE_RELEASE');
  assert.equal(second.blocked, false);
});

test('Harvest releases immediately when a newly locked side replaces the old drive', () => {
  const brake = new HarvestBrake({ pulseLead:2 });
  brake.evaluate({ trend:lateTrend, epoch:100, quote:123.4, pulseGapSeconds:1 });
  const result = brake.evaluate({ trend:{ ...lateTrend, direction:'DOWN', state:'DRIVE' }, epoch:101, quote:122.9, pulseGapSeconds:1 });
  assert.equal(result.action, 'FLIP_RELEASE');
  assert.equal(result.blocked, false);
  assert.equal(result.direction, 'DOWN');
});
