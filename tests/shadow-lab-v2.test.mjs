import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowTimingLab } from '../public/core/shadow-lab.mjs';

function by(lab, horizon) {
  return lab.snapshot().find(x => x.horizon === horizon);
}

test('Timing Lab v2 scores true consecutive one-tick windows', () => {
  const lab = new ShadowTimingLab([1,2,3]);
  lab.onTick({ quote: 100 });
  lab.addSignal({ direction: 'CALL' }, 100);
  lab.onTick({ quote: 110 }); // T0→T1 win
  lab.onTick({ quote: 105 }); // T1→T2 loss
  lab.onTick({ quote: 120 }); // T2→T3 win
  lab.onTick({ quote: 119 }); // T3→T4 loss

  assert.deepEqual([by(lab,'0→1').wins, by(lab,'0→1').losses], [1,0]);
  assert.deepEqual([by(lab,'1→2').wins, by(lab,'1→2').losses], [0,1]);
  assert.deepEqual([by(lab,'2→3').wins, by(lab,'2→3').losses], [1,0]);
  assert.deepEqual([by(lab,'3→4').wins, by(lab,'3→4').losses], [0,1]);
});

test('Timing Lab v2 keeps CALL and PUT scores separate', () => {
  const lab = new ShadowTimingLab();
  lab.onTick({ quote: 100 });
  lab.addSignal({ direction: 'PUT' }, 100);
  lab.onTick({ quote: 90 });
  lab.onTick({ quote: 95 });

  assert.deepEqual([by(lab,'0→1 PUT').wins, by(lab,'0→1 PUT').losses], [1,0]);
  assert.deepEqual([by(lab,'0→1 CALL').wins, by(lab,'0→1 CALL').losses], [0,0]);
  assert.deepEqual([by(lab,'1→2 PUT').wins, by(lab,'1→2 PUT').losses], [0,1]);
});

test('ties are conservatively counted as losses', () => {
  const lab = new ShadowTimingLab();
  lab.onTick({ quote: 100 });
  lab.addSignal({ direction: 'CALL' }, 100);
  lab.onTick({ quote: 100 });
  const score = by(lab, '0→1 CALL');
  assert.equal(score.ties, 1);
  assert.equal(score.losses, 1);
});
