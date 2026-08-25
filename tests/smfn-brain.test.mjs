import test from 'node:test';
import assert from 'node:assert/strict';
import { SmfnBrain, estimateSmfnPlan, isSmfnSniperEntry } from '../public/core/smfn-brain.mjs';

const trend = (direction = 'UP', state = 'MATURE', exhaustion = 50) => ({ direction, state, exhaustion });
const source = direction => ({ approved:true, tradeDirection:direction });

test('planner labels estimates as evidence-only and scales target stake', () => {
  const plan = estimateSmfnPlan({ minutes:30, stake:1, target:30, batch:2 });
  assert.equal(plan.evidenceOnly, true);
  assert.ok(plan.lowProfit < plan.expectedProfit);
  assert.ok(plan.suggestedStake >= 0.35);
  assert.equal(plan.breakEvenRate, 52);
});

test('auto mode routes the original v8 signal instead of the slower map direction', () => {
  const brain = new SmfnBrain();
  brain.start({ now:0, basePnl:0, baseTrades:0 });
  const result = brain.evaluate({ now:1000, trend:trend('DOWN','MATURE'), harvest:{blocked:false}, sourceDecision:source('CALL'), totalPnl:0, totalTrades:0 });
  assert.equal(result.approved, true);
  assert.equal(result.allowedDirection, 'CALL');
  assert.equal(brain.snapshot().activeLane, 'UP');
});

test('SMFN accepts every original v8 entry length without retrospective 20T filtering', () => {
  assert.equal(isSmfnSniperEntry({ milkCandidate:true, patternLength:8 }), true);
  assert.equal(isSmfnSniperEntry({ milkCandidate:true, patternLength:12 }), true);
  assert.equal(isSmfnSniperEntry({ milkCandidate:true, patternLength:20 }), true);
  assert.equal(isSmfnSniperEntry({ milkCandidate:false, patternLength:20 }), false);
});

test('live trend sync cannot overwrite the bot selected by an entry signal', () => {
  const brain = new SmfnBrain();
  brain.start({ now:0, trend:{ ...trend('UP','DRIVE'), epoch:100 } });
  brain.evaluate({ now:1, trend:trend('UP','DRIVE'), sourceDecision:{ ...source('CALL'), signalEpoch:101 } });
  assert.equal(brain.snapshot().allowedDirection, 'CALL');
  brain.syncTrend(trend('DOWN','MATURE'), 140);
  const snapshot = brain.snapshot();
  assert.equal(snapshot.allowedDirection, 'CALL');
  assert.deepEqual(snapshot.routeHistory.map(row => row.lane), ['CALL']);
});

test('terminal completion clears stale route and records BOT OFF', () => {
  const brain = new SmfnBrain({ maxTrades:2 });
  brain.start({ now:0, maxTrades:2, trend:{ ...trend('UP','DRIVE'), epoch:100 } });
  const result = brain.evaluate({ now:1, trend:trend('UP','DRIVE'), sourceDecision:source('CALL'), totalTrades:2 });
  const snapshot = brain.snapshot();
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.allowedDirection, 'NONE');
  assert.equal(snapshot.routeHistory.at(-1).lane, 'NONE');
});

test('a new source signal switches the one active bot without coexistence', () => {
  const brain = new SmfnBrain();
  brain.start({ now:0 });
  brain.evaluate({ now:1, trend:trend('DOWN'), harvest:{blocked:false}, sourceDecision:source('PUT') });
  const switched = brain.evaluate({ now:4, trend:trend('DOWN'), harvest:{blocked:false}, sourceDecision:source('CALL') });
  assert.equal(switched.approved, true);
  assert.equal(switched.allowedDirection, 'CALL');
  assert.equal(brain.snapshot().activeLane, 'UP');
});

test('drive, mature, turning and harvest do not block a qualified source signal', () => {
  for (const state of ['DRIVE','MATURE','TURNING','HARVEST']) {
    const brain = new SmfnBrain(); brain.start({ now:0 });
    const result = brain.evaluate({ now:1, trend:trend('UP',state,99), harvest:{blocked:true}, sourceDecision:source('CALL') });
    assert.equal(result.approved, true);
    assert.equal(result.allowedDirection, 'CALL');
  }
});

test('no source entry switches both bots off between signals', () => {
  const brain = new SmfnBrain(); brain.start({ now:0 });
  brain.evaluate({ now:1, trend:trend('UP','DRIVE'), sourceDecision:source('CALL') });
  const waiting = brain.evaluate({ now:2, trend:{ direction:'NONE', state:'OBSERVE' }, sourceDecision:{ approved:false, tradeDirection:'CALL' } });
  assert.equal(waiting.allowedDirection, 'NONE');
  assert.equal(waiting.approved, false);
  assert.equal(brain.snapshot().activeLane, 'NONE');
});

test('losses do not pause the next qualified source signal', () => {
  const brain = new SmfnBrain(); brain.start({ now:0 });
  brain.evaluate({ now:1, trend:trend('DOWN','DRIVE'), sourceDecision:source('PUT') });
  brain.registerResult(-1, 2);
  brain.registerResult(-1, 3);
  const next = brain.evaluate({ now:4, trend:trend('DOWN','HARVEST'), harvest:{blocked:true}, sourceDecision:source('PUT') });
  assert.equal(next.status, 'ACTIVE');
  assert.equal(next.allowedDirection, 'PUT');
  assert.equal(next.approved, true);
});

test('negative timed run enters a time-boxed single-contract landing', () => {
  const brain = new SmfnBrain({ durationMinutes:1, landingMinutes:2 });
  brain.start({ now:0, durationMinutes:1, landingMinutes:2 });
  for (let i=0;i<3;i+=1) brain.evaluate({ now:i, trend:trend(), harvest:{blocked:false}, sourceDecision:source('CALL'), totalPnl:-2 });
  const result = brain.evaluate({ now:60_001, trend:trend(), harvest:{blocked:false}, sourceDecision:source('CALL'), grade:'A', totalPnl:-2 });
  assert.equal(result.phase, 'LANDING');
  assert.equal(result.batch, 1);
  assert.equal(result.approved, true);
});

test('hard stop ends the run instead of chasing recovery', () => {
  const brain = new SmfnBrain({ hardStop:5 });
  brain.start({ now:0, hardStop:5 });
  const result = brain.evaluate({ now:1, trend:trend(), harvest:{blocked:false}, sourceDecision:source('CALL'), totalPnl:-5 });
  assert.equal(result.status, 'HARD_STOP');
  assert.equal(result.approved, false);
});

test('manual mode preserves the underlying Milking decision', () => {
  const brain = new SmfnBrain();
  brain.start({ now:0, mode:'MANUAL' });
  const result = brain.evaluate({ now:1, trend:trend('DOWN','TURNING',99), harvest:{blocked:false}, sourceDecision:source('CALL') });
  assert.equal(result.approved, true);
  assert.equal(result.allowedDirection, 'CALL');
});
