// Emblems are data-driven (roster.json) with a fallback for agents we have never seen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ICONS, emblemOf, emblemSVG, inkOn } from '../emblems.js';

const roster = JSON.parse(readFileSync(new URL('../roster.json', import.meta.url), 'utf8'));

test('every roster agent has an emblem with a known icon; Tab / Instinct / Hermes have their own marks', () => {
  for (const a of [...roster.agents, ...roster.live]) {
    assert.ok(a.emblem && a.emblem.mono, a.id);
    assert.ok(ICONS[a.emblem.icon], `${a.id}: icon ${a.emblem.icon}`);
  }
  const live = Object.fromEntries(roster.live.map(a => [a.id, a.emblem]));
  assert.equal(live.tab.mono, 'Tab');
  assert.equal(live.hermes.icon, 'wing'); // winged messenger, ready for when Hermes joins
  assert.notEqual(live.instinct.icon, live.tab.icon);
});

test('an unknown agent gets a fallback monogram and a deterministic icon', () => {
  const e1 = emblemOf({ id: 'zephyr', name: 'Zephyr', color: '#123456' });
  const e2 = emblemOf({ id: 'zephyr', name: 'Zephyr', color: '#123456' });
  assert.equal(e1.mono, 'Z');
  assert.ok(ICONS[e1.icon]);
  assert.deepEqual(e1, e2);
  assert.equal(emblemOf({ id: 'x', name: 'אורי' }).mono, 'א');
});

test('SVG emblem: accessible label, escaped text, unique gradient ids', () => {
  const a = emblemSVG({ id: 'evil', name: '<b>"x"</b>', color: '#f7b84d' }, 40);
  const b = emblemSVG({ id: 'evil', name: '<b>"x"</b>', color: '#f7b84d' }, 40);
  assert.match(a, /role="img"/);
  assert.doesNotMatch(a, /<b>/);
  const id = s => /linearGradient id="([^"]+)"/.exec(s)[1];
  assert.notEqual(id(a), id(b));
});

test('monogram ink contrasts with the badge colour', () => {
  assert.equal(inkOn('#f7b84d'), '#1a1407'); // light colour -> dark ink
  assert.equal(inkOn('#1e3a8a'), '#ffffff'); // dark colour -> white ink
});

test('no third-party trademarks in emblem data', () => {
  const txt = readFileSync(new URL('../emblems.js', import.meta.url), 'utf8') + JSON.stringify(roster);
  assert.doesNotMatch(txt, /openai|anthropic|claude|chatgpt|gemini|google|microsoft|github/i);
});
