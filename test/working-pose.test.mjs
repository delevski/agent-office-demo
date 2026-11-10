import test from 'node:test';
import assert from 'node:assert/strict';
import { seatedOverlay } from '../src3d/stage3d.js';
import { applyReport, publicView } from '../office-state.js';

test('working pose stays typing at noon, dusk and midnight; idle alone can sleep', () => {
  for (const night of [0, 0.54, 0.56, 1]) {
    assert.equal(seatedOverlay({ mode: 'sit', typing: true, night }), 'typing');
    assert.equal(seatedOverlay({ mode: 'sit', typing: false, night }), night > 0.55 ? 'sleep' : null);
    assert.equal(seatedOverlay({ mode: 'sit', typing: true, speaking: true, night }), null);
    assert.equal(seatedOverlay({ mode: 'walk', typing: true, night }), null);
  }
});

test('real task lifecycle and progress update presence and task freshness', () => {
  let a = applyReport(null, { agent: 'instinct', kind: 'task.start', task: { id: 'real-work', title: 'Local work' } }, 1000);
  assert.equal(publicView(a, 1000).status, 'working');
  a = applyReport(a, { agent: 'instinct', kind: 'task.progress', task: { id: 'real-work', title: 'Local work' } }, 2000);
  assert.equal(a.taskUpdated, 2000);
  a = applyReport(a, { agent: 'instinct', kind: 'task.done', task: { id: 'real-work' } }, 3000);
  assert.equal(publicView(a, 3000).status, 'idle');
});
