import test from 'node:test';
import assert from 'node:assert/strict';
import { boardView } from '../board-view.js';
import { readFileSync } from 'node:fs';
test('active board hides history, counts open work and never mutates records', () => {
  const columns = {todo:[{status:'blocked'},{status:'failed'}],doing:[{status:'running'}],done:[{status:'done'}]};
  const before = JSON.stringify(columns);
  assert.deepEqual(boardView(columns), {keys:['todo','doing'],activeCount:3,historyCount:1});
  assert.deepEqual(boardView(columns,true), {keys:['done'],activeCount:3,historyCount:1});
  assert.equal(JSON.stringify(columns),before);
  assert.deepEqual(boardView(columns),boardView(columns,false));
});
test('both board surfaces have controls and failed work remains actionable', () => {
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const id of ['cp-board-controls','board-ov-controls']) assert.ok(html.includes(`id="${id}"`));
 const js=readFileSync(new URL('../main.js',import.meta.url),'utf8');
 assert.match(js,/t.status === 'failed'\) cols.todo.push/);
 assert.match(js,/let showBoardHistory = false/);
 assert.match(js,/aria-pressed/);
});
