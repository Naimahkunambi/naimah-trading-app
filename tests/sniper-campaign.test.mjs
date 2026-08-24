import test from 'node:test';
import assert from 'node:assert/strict';
import { SniperCampaignPolicy, bayesianRate, lengthModifier, shapeSignature } from '../public/core/sniper-campaign.mjs';

const pattern = (overrides = {}) => ({
  ok: true,
  direction: 'UP',
  familyId: '12T-U1-F0-U1-U1-UP',
  length: 12,
  edge: 58,
  ...overrides
});
const structure = { tag: 'HL', phase: 'LOW_ZONE' };

test('shape signatures are stable and human-readable', () => {
  const signature = shapeSignature([0, 0.2, 0.4, 0.3, 0.5, 0.8, 1]);
  assert.match(signature, /^(U|D|F)/);
  assert.equal(signature.split('-').length, 4);
});

test('12T is prioritized while 8T pays an evidence penalty', () => {
  assert.equal(lengthModifier(12), 3);
  assert.equal(lengthModifier(20), 0);
  assert.equal(lengthModifier(8), -4);
});

test('seed does not fire and an immediate repeat does', () => {
  const policy = new SniperCampaignPolicy();
  const seed = policy.evaluate({ pattern: pattern(), structure, epoch: 1 });
  const fire = policy.evaluate({ pattern: pattern(), structure, epoch: 2 });
  assert.equal(seed.event, 'SEED');
  assert.equal(seed.sniperApproved, false);
  assert.equal(fire.event, 'FIRE');
  assert.equal(fire.sniperApproved, true);
  assert.equal(fire.repeatCount, 2);
});

test('a lone opposing family cannot flip a locked campaign', () => {
  const policy = new SniperCampaignPolicy();
  policy.evaluate({ pattern: pattern(), structure, epoch: 1 });
  policy.evaluate({ pattern: pattern(), structure, epoch: 2 });
  const down = pattern({ direction: 'DOWN', familyId: '12T-D1-F0-D1-D1-DOWN' });
  const hold = policy.evaluate({ pattern: down, structure, epoch: 3 });
  assert.equal(hold.event, 'HOLD');
  assert.equal(hold.sniperApproved, false);
  const flip = policy.evaluate({ pattern: down, structure, epoch: 4 });
  assert.equal(flip.event, 'FLIP');
  assert.equal(flip.sniperApproved, true);
  assert.equal(flip.campaign.direction, 'DOWN');
});

test('family and structure memory modify score without becoming hard gates', () => {
  const positive = new SniperCampaignPolicy();
  positive.evaluate({ pattern: pattern(), structure, familyMemory: { wins: 8, losses: 2 }, addressMemory: { wins: 6, losses: 1 }, epoch: 1 });
  const good = positive.evaluate({ pattern: pattern(), structure, familyMemory: { wins: 8, losses: 2 }, addressMemory: { wins: 6, losses: 1 }, epoch: 2 });
  const negative = new SniperCampaignPolicy();
  negative.evaluate({ pattern: pattern(), structure, familyMemory: { wins: 2, losses: 8 }, addressMemory: { wins: 1, losses: 6 }, epoch: 1 });
  const bad = negative.evaluate({ pattern: pattern(), structure, familyMemory: { wins: 2, losses: 8 }, addressMemory: { wins: 1, losses: 6 }, epoch: 2 });
  assert.ok(good.score > bad.score);
  assert.equal(good.variants.structure, true);
  assert.equal(bad.variants.structure, false);
});

test('second contract is earned only by an A-grade repeated signal', () => {
  const policy = new SniperCampaignPolicy();
  policy.evaluate({ pattern: pattern({ edge: 56 }), structure, epoch: 1 });
  const one = policy.evaluate({ pattern: pattern({ edge: 56 }), structure, epoch: 2 });
  assert.equal(one.batch, 1);
  const elite = new SniperCampaignPolicy();
  elite.evaluate({ pattern: pattern({ edge: 64 }), structure, epoch: 1 });
  const two = elite.evaluate({ pattern: pattern({ edge: 64 }), structure, epoch: 2 });
  assert.equal(two.grade, 'A');
  assert.equal(two.batch, 2);
});

test('bayesian memory does not overreact to tiny samples', () => {
  assert.ok(bayesianRate(1, 0) < 0.60);
  assert.ok(bayesianRate(20, 5) > 0.70);
});
