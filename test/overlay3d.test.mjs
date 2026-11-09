// The 3D people on top of the painted room: assets, calibration, roster-driven cast, and the wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { CALIB } from '../concept-calib.js';
import { assignSlots, SEATS, SLOTS } from '../concept.js';

const read = f => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const roster = JSON.parse(read('roster.json'));
const stage = read('stage3d.js'), concept = read('concept.js'), css = read('concept.css'), main = read('main.js');

test('assets: one rigged glb with the clips the scenes need, loader files vendored, small', () => {
  const glb = new URL('../assets/models/agent.glb', import.meta.url);
  assert.ok(existsSync(glb));
  const buf = readFileSync(glb);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glTF binary magic');
  const json = JSON.parse(buf.slice(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
  const clips = json.animations.map(a => a.name);
  for (const c of ['Idle_Loop', 'Idle_Talking_Loop', 'Walk_Loop', 'Sitting_Enter', 'Sitting_Exit', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop']) assert.ok(clips.includes(c), c);
  assert.equal(json.skins.length, 1, 'one skeleton');
  assert.ok(json.skins[0].joints.length >= 60, 'a full humanoid rig');
  assert.ok(buf.length < 2.8 * 1024 * 1024, 'glb under the blob limit: ' + buf.length);
  for (const f of ['vendor/GLTFLoader.js', 'vendor/SkeletonUtils.js', 'vendor/BufferGeometryUtils.js', 'assets/models/LICENSE-quaternius-cc0.txt']) assert.ok(existsSync(new URL('../' + f, import.meta.url)), f);
  assert.match(read('assets/models/LICENSE-quaternius-cc0.txt'), /CC0/);
  let total = 0; for (const f of ['assets/models/agent.glb', 'vendor/GLTFLoader.js', 'vendor/SkeletonUtils.js', 'vendor/BufferGeometryUtils.js', 'stage3d.js', 'concept-calib.js']) total += statSync(new URL('../' + f, import.meta.url)).size;
  assert.ok(total < 8 * 1024 * 1024, 'new assets under 8 MB');
});

test('the painted sprites are gone: people are 3D now', () => {
  assert.ok(!existsSync(new URL('../assets/sprites', import.meta.url)));
  assert.doesNotMatch(concept, /sprites\//);
  assert.doesNotMatch(css, /cv-actor/);
});

test('calibration: a camera that matches the plate, six desks, seats behind the desks, floor footprints', () => {
  assert.ok(CALIB.fov > 8 && CALIB.fov < 60 && Math.abs(CALIB.aspect - 1344 / 1280) < 1e-6);
  assert.equal(CALIB.camQuat.length, 4); assert.ok(Math.abs(Math.hypot(...CALIB.camQuat) - 1) < 1e-6, 'unit quaternion');
  assert.equal(CALIB.desks.length, 6); assert.equal(CALIB.seat.length, 6); assert.equal(CALIB.foot.length, 6);
  for (const d of CALIB.desks) { assert.ok(d.L > 1 && d.L < 2.4 && d.S > 0.6 && d.S < 1.4, 'desk of a plausible size (metres)'); }
  CALIB.seat.forEach((s, i) => { assert.ok(s[0] > 0 && s[0] < 1 && s[1] > 0 && s[1] < 1); assert.ok(CALIB.seatLocal[i][1] < -CALIB.desks[i].S / 2, 'the person sits behind the desk'); });
});

test('the cast follows the roster: demo names in demo, the live roster (<= 6) in live, never hard-coded', () => {
  assert.deepEqual(roster.agents.map(a => a.name), ['hermessi', 'Claudi', 'Gepeta', 'Grocki', 'Gemino', 'Deepsi']);
  for (const a of roster.agents) { assert.ok(!stage.includes(a.name) && !concept.includes(a.name), `no hard-coded ${a.name}`); }
  // one 3D person per agent in the cast, capped at the six desks, one seat each
  for (const n of [1, 3, 6, 9]) {
    const cast = Array.from({ length: n }, (_, i) => ({ id: 'agent' + i, name: 'N' + i }));
    const seats = assignSlots(cast);
    assert.equal(seats.size, Math.min(n, 6));
    assert.equal(new Set(seats.values()).size, seats.size);
  }
  assert.match(concept, /cast = list\.slice\(0, SLOTS\.length\)/);
  assert.match(concept, /if \(stage\) stage\.setCast\(cast, seats\)/);
  assert.match(stage, /for \(const \[id, p\] of chars\) if \(!list\.some\(a => a\.id === id/, 'people of agents that left are removed');
  assert.match(main, /function castNow\(\) \{ return mode === 'live' \? LIVE : AGENTS; \}/);
  // outfits come from the agent's own colours (skin, hair, accent), with fallbacks for live agents without them
  assert.match(stage, /agent\.color/); assert.match(stage, /agent\.skin/); assert.match(stage, /agent\.hair/);
});

test('the overlay is a transparent canvas over the plate, with performance caps', () => {
  assert.match(stage, /alpha: true/); assert.match(stage, /Math\.min\(window\.devicePixelRatio \|\| 1, box\.w < 700 \? 1\.5 : maxDpr\)/);
  assert.match(stage, /colorWrite: false/, 'invisible desks hide legs by depth');
  assert.match(stage, /powerPreference: 'low-power'/);
  assert.match(concept, /document\.hidden/, 'no rendering in a hidden tab');
  assert.match(concept, /~30 fps/, 'phones are capped');
});

test('motion is skeletal: walk, sit down, stand up, talk, typing and pyjamas', () => {
  for (const k of ['walk', 'sitEnter', 'sitExit', 'sitTalk', 'talk']) assert.match(stage, new RegExp(`${k}:`));
  assert.match(stage, /solveArm/, 'hands are placed on the keyboard');
  assert.match(stage, /uNight/, 'pyjama colours at night');
  assert.match(concept, /ac\.state = 'exit'/, 'people stand up before they walk');
});
