import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLibraPhysics, LibraBrain } from '../public/core/libra-brain.mjs';

function ticksFrom(values) {
  return values.map((quote,index)=>({epoch:1700000000+index,quote}));
}

test('Libra recognizes a clean rising drive after enough ticks', () => {
  const values=Array.from({length:80},(_,i)=>1000+i*2+(i%7===0?-0.3:0.2));
  const physics=extractLibraPhysics(ticksFrom(values));
  assert.equal(physics.ready,true);
  assert.match(physics.regime,/UP|DRIVE/);
  assert.ok(physics.baseProbabilityUp>0.5);
});

test('Libra learns from a wrong prediction and retains the state', () => {
  const brain=new LibraBrain();
  const before=brain.snapshot();
  brain.learn({features:Array(14).fill(.3),signature:'TEST|STATE',predictedUp:.9,actualUp:false,regime:'DRIVE UP',confidence:80});
  const after=brain.snapshot();
  assert.equal(after.updates,before.updates+1);
  assert.equal(after.mistakes,before.mistakes+1);
  assert.equal(after.retainedStates,1);
  assert.match(after.lastLesson,/wrong/i);
});

test('Libra export and import preserve learning', () => {
  const brain=new LibraBrain();
  for(let i=0;i<8;i++) brain.learn({features:Array(14).fill(i%2?.2:-.2),signature:`STATE${i%2}`,predictedUp:i%2?.6:.4,actualUp:i%2===1,regime:'TEST',confidence:60});
  const copy=new LibraBrain(brain.exportState());
  assert.equal(copy.snapshot().updates,brain.snapshot().updates);
  assert.equal(copy.snapshot().retainedStates,brain.snapshot().retainedStates);
  assert.equal(copy.snapshot().correct,brain.snapshot().correct);
});

test('Libra can replace an opposite source decision when confidence threshold is earned', () => {
  const values=Array.from({length:90},(_,i)=>500+i*3);
  const brain=new LibraBrain(null,{replaceConfidence:5,minTicks:55});
  const decision=brain.decide({ticks:ticksFrom(values),sourceDecision:{approved:true,tradeDirection:'PUT'},openContracts:0,runPnl:0});
  assert.equal(decision.action,'REPLACE');
  assert.equal(decision.tradeDirection,'CALL');
});
