// stage3d.js — real, rigged 3D people on top of the painted room picture.
// A transparent three.js canvas sits exactly over the room plate. Its camera is the plate's own camera
// (fitted in concept-calib.js), so a person standing at a point of the painted floor has the right size and
// perspective; invisible depth-only boxes where the painted desks are let the desks hide legs and chairs.
// The people are one CC0 rigged mannequin (Quaternius "Universal Animation Library") with skeletal clips
// (idle, walk, sit down, sit + talk, stand up), dressed per agent with vertex colours + hair, so each agent
// has their own skin, hair and clothes. No other assets: ~0.27 MB glb (meshopt-compressed).
// This file is the readable source; the page loads the minified, tree-shaken bundle built from it
// (stage3d.min.js, `npm run build`), so three.js is not parsed until the room picture is on screen.
import * as THREE from './three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { clone as skClone } from './vendor/SkeletonUtils.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';
import { CALIB } from '../concept-calib.js';

// Time of day changes the room, not whether an active agent works.
export function seatedOverlay(t) {
  if (t.mode !== 'sit' || t.speaking) return null;
  if (t.typing) return 'typing';
  return t.night > 0.55 ? 'sleep' : null;
}

export const MODEL_URL = './assets/models/agent.glb?v=2';
export const CLIPS = { idle: 'Idle_Loop', talk: 'Idle_Talking_Loop', walk: 'Walk_Loop', sitEnter: 'Sitting_Enter', sitExit: 'Sitting_Exit', sit: 'Sitting_Idle_Loop', sitTalk: 'Sitting_Talking_Loop' };
const PANTS = ['#6f86a8', '#c9b79c', '#56627a', '#9aab94', '#b3a6c9', '#46526a'];
const SKINS = ['#f2c9a4', '#e8b48c', '#d9a077', '#c98e63'];
const HAIRS = ['#5a3d28', '#2c2320', '#8a5a2b', '#24201c', '#3a2a1c', '#1f1a16'];

const lerp = (a, b, t) => a + (b - a) * t;
const col = h => new THREE.Color(h);
const mix = (a, b, t) => col(a).lerp(col(b), t);
function ang(a, b) { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }

/** colours for one person, by region of the T-posed body (x across, y up) */
export function outfitFor(agent, idx) {
  const base = agent.color || '#8b7cf6';
  const skin = agent.skin || SKINS[idx % SKINS.length];
  const hair = agent.hair || HAIRS[idx % HAIRS.length];
  return {
    skin: col(skin), hair: col(hair), longHair: agent.longHair ?? (idx % 2 === 0),
    top: mix(base, '#ffffff', 0.5), topN: mix(base, '#dfe8ff', 0.6),
    pants: col(PANTS[idx % PANTS.length]), pantsN: mix(PANTS[idx % PANTS.length], '#dfe6f7', 0.55),
    shoes: col(idx % 2 ? '#f4f1ea' : '#e7e2d8'),
  };
}
/** the T-posed body position of every vertex, so the shader can colour regions (shirt, trousers, skin, hair) with crisp edges */
function addRest(geo) {
  const p = geo.attributes.position, a = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { a[i * 3] = p.getX(i); a[i * 3 + 1] = p.getY(i); a[i * 3 + 2] = p.getZ(i); }
  geo.setAttribute('rest', new THREE.BufferAttribute(a, 3));
}
function outfitMaterial(o) {
  const u = { uTop: { value: o.top }, uTopN: { value: o.topN }, uPants: { value: o.pants }, uPantsN: { value: o.pantsN }, uSkin: { value: o.skin }, uHair: { value: o.hair }, uShoes: { value: o.shoes }, uNight: { value: 0 }, uLong: { value: o.longHair ? 1 : 0 } };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 rest; varying vec3 vRest;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = rest;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vRest; uniform vec3 uTop, uTopN, uPants, uPantsN, uSkin, uHair, uShoes; uniform float uNight, uLong;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
        float ax = abs(vRest.x), y = vRest.y, z = vRest.z, e = 0.012;
        vec3 shirt = mix(uTop, uTopN, uNight), pants = mix(uPants, uPantsN, uNight);
        float sleeve = 1.0 - smoothstep(0.40 - e, 0.40 + e, ax);               // short sleeves
        float torso = (1.0 - smoothstep(0.19 - e, 0.19 + e, ax));
        float topY = 1.455 + smoothstep(0.05, 0.11, ax) * 0.08;
        float shirtM = smoothstep(0.915 - e, 0.915 + e, y) * (1.0 - smoothstep(topY - e, topY + e, y)) * max(torso, sleeve * step(0.19, ax));
        
        float pantsM = 1.0 - smoothstep(0.915 - e, 0.915 + e, y);
        float shoeM = 1.0 - smoothstep(0.075 - e, 0.075 + e, y);
        float headM = smoothstep(1.555, 1.565, y) * (1.0 - smoothstep(0.13, 0.15, ax));
        float hairM = headM * max(smoothstep(1.765, 1.78, y), (1.0 - smoothstep(-0.03, -0.01, z)) * smoothstep(1.61, 1.62, y));
        hairM = max(hairM, uLong * headM * (1.0 - smoothstep(-0.005, 0.015, z)) * (1.0 - smoothstep(0.10, 0.12, ax)));
        vec3 c = uSkin;
        float eyeM = headM * step(0.085, z) * (1.0 - smoothstep(0.011, 0.016, length(vec2(ax - 0.043, y - 1.70) * vec2(1.0, 1.15))));
        c = mix(c, shirt, shirtM);
        c = mix(c, pants, pantsM);
        c = mix(c, uShoes, shoeM);
        c = mix(c, uHair, hairM);
        c = mix(c, vec3(0.16, 0.13, 0.12), eyeM);
        float cheek = headM * step(0.07, z) * (1.0 - smoothstep(0.014, 0.03, length(vec2(ax - 0.062, y - 1.665)))); c = mix(c, c * vec3(1.0, 0.86, 0.84), cheek * 0.6);
        diffuseColor.rgb = c;
        
      }`);
  };
  m.customProgramCacheKey = () => 'outfit-v1';
  m.userData.u = u;
  return m;
}

const S = Array.from({ length: 12 }, () => new THREE.Vector3()), _q = [0, 1, 2, 3].map(() => new THREE.Quaternion());
// scratch objects shared by every per-frame routine: the render loop allocates nothing
const _oq = new THREE.Quaternion(), _oe = new THREE.Euler(), _tgt = new THREE.Vector3(), _pole = new THREE.Vector3(), _fa = new THREE.Vector3(), _fb = new THREE.Vector3();
/** rotate `bone` (in world space) so that direction fromV points along toV, blended by w */
function rotBone(bone, fromV, toV, w) {
  const q = _q[0].setFromUnitVectors(fromV.normalize(), toV.normalize()); if (w < 1) q.slerp(_q[1].identity(), 1 - w);
  const wq = bone.getWorldQuaternion(_q[2]), pq = bone.parent.getWorldQuaternion(_q[3]);
  bone.quaternion.copy(pq.invert().multiply(q).multiply(wq)); bone.updateMatrixWorld(true);
}
/** two-bone IK: put `hand` on world point `target`, elbow bent towards `pole` (world direction) */
function solveArm(upper, lower, hand, target, pole, w) {
  const sh = upper.getWorldPosition(S[0]), el = lower.getWorldPosition(S[1]), hd = hand.getWorldPosition(S[2]);
  const L1 = sh.distanceTo(el), L2 = el.distanceTo(hd);
  const toT = S[3].copy(target).sub(sh); let d = toT.length(); if (d < 1e-4) return;
  const dir = S[4].copy(toT).divideScalar(d); d = Math.min(d, L1 + L2 - 1e-3);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const perp = S[5].copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize();
  const elT = S[6].copy(sh).addScaledVector(dir, a).addScaledVector(perp, h);
  const hdT = S[7].copy(sh).addScaledVector(dir, d);
  rotBone(upper, S[8].copy(el).sub(sh), S[9].copy(elT).sub(sh), w);
  const el2 = lower.getWorldPosition(S[10]), hd2 = hand.getWorldPosition(S[11]);
  rotBone(lower, S[8].copy(hd2).sub(el2), S[9].copy(hdT).sub(el2), w);
}

function blobTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, 'rgba(70,58,44,.55)'); gr.addColorStop(0.55, 'rgba(70,58,44,.22)'); gr.addColorStop(1, 'rgba(70,58,44,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function createStage(host, { maxDpr = 1.5, modelUrl = MODEL_URL } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const cvs = renderer.domElement; cvs.className = 'cv-3d'; cvs.setAttribute('aria-hidden', 'true');
  cvs.style.cssText = 'position:absolute;pointer-events:none;display:block';
  host.appendChild(cvs);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CALIB.fov, CALIB.aspect, 1, 120);
  camera.position.fromArray(CALIB.camPos); camera.quaternion.fromArray(CALIB.camQuat); camera.updateMatrixWorld(true);
  // light: soft daylight from the big windows (upper left, far side) + warm floor bounce
  const hemi = new THREE.HemisphereLight(0xffffff, 0xf3e8d8, 2.1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff6ea, 0.8); sun.position.set(-7, 11, -6); scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.35); fill.position.set(6, 5, 9); scene.add(fill);
  // invisible desks: depth only
  const occl = new THREE.MeshBasicMaterial({ colorWrite: false });
  CALIB.desks.forEach(d => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(d.L + 0.04, 0.74, d.S + 0.02), occl);
    m.position.set(d.cx, 0.37, d.cz); m.rotation.y = d.yaw; m.renderOrder = -10; scene.add(m);
  });
  const blobTex = blobTexture();
  const ray = new THREE.Raycaster(), v2 = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), tmp = new THREE.Vector3();
  function floorAt(fx, fy, out = new THREE.Vector3()) { v2.set(fx * 2 - 1, -(fy * 2 - 1)); ray.setFromCamera(v2, camera); return ray.ray.intersectPlane(plane, out) || out.set(0, 0, 0); }
  function toPic(v, out = {}) { tmp.copy(v).project(camera); out.x = (tmp.x + 1) / 2; out.y = (1 - tmp.y) / 2; return out; }
  const deskLocal = (k, lx, lz, out) => { const d = CALIB.desks[k], c = Math.cos(d.yaw), s = Math.sin(d.yaw); return out.set(d.cx + lx * c + lz * s, 0, d.cz - lx * s + lz * c); };
  const blobGeo = new THREE.PlaneGeometry(1, 1);
  let hairGeo = null; // one hair-back mesh geometry for every long-haired person

  let gltf = null, ready = false; const chars = new Map(); let pending = null;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const loaded = new Promise((res, rej) => loader.load(modelUrl, g => { gltf = g; ready = true; res(g); }, undefined, rej));
  loaded.then(() => { if (pending) setCast(pending.list, pending.seats); }).catch(e => console.warn('3D people failed to load', e));

  class Person {
    constructor(agent, seat, idx) {
      this.id = agent.id; this.seat = seat; this.b = {}; this.o = outfitFor(agent, idx);
      this.root = new THREE.Group(); this.root.scale.setScalar(1.14); this.model = skClone(gltf.scene); this.root.add(this.model);
      this.mats = [];
      const mat = outfitMaterial(this.o); this.mat = mat;
      this.model.traverse(o => {
        if (o.isSkinnedMesh) { if (!o.geometry.attributes.rest) addRest(o.geometry); /* one geometry and one skeleton layout for all six clones */ o.material = mat; o.frustumCulled = false; this.mesh = this.mesh || o; (this.meshes ||= []).push(o); }
        if (o.isBone) this.b[o.name] = o;
      });
      this.model.updateMatrixWorld(true);
      this.addHead();
      this.blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })); this.blob.rotation.x = -Math.PI / 2; this.blob.position.y = 0.004; this.blob.renderOrder = -5;
      scene.add(this.blob); scene.add(this.root);
      this.mixer = new THREE.AnimationMixer(this.model); this.act = {};
      for (const [k, name] of Object.entries(CLIPS)) { const clip = gltf.animations.find(a => a.name === name); if (clip) this.act[k] = this.mixer.clipAction(clip); }
      for (const k of ['sitEnter', 'sitExit']) if (this.act[k]) { this.act[k].setLoop(THREE.LoopOnce, 1); this.act[k].clampWhenFinished = true; }
      this.mixer.addEventListener('finished', e => { if (e.action === this.act.sitEnter) this.afterEnter = true; });
      this.cur = null; this.mode = 'sit'; this.yaw = 0; this.pos = new THREE.Vector3(); this.speed = 0; this.nightT = 0; this.prev = null;
      this.timeOffset = Math.random() * 2; this.hopT = 0;
      this.head = new THREE.Vector3(); this.visible = false; this.root.visible = false; this.blob.visible = false;
      // rest rotations of the arm bones (typing overlay is added on top)
      this.rest = {}; for (const n of ['upperarm_l', 'upperarm_r', 'lowerarm_l', 'lowerarm_r', 'hand_l', 'hand_r', 'neck_01', 'Head', 'spine_03']) if (this.b[n]) this.rest[n] = this.b[n].quaternion.clone();
    }
    addHead() {
      const h = this.b.Head; if (!h || !this.o.longHair) return;
      const hairMat = new THREE.MeshLambertMaterial({ color: this.o.hair });
      const back = new THREE.Mesh(hairGeo ||= new THREE.SphereGeometry(0.13, 20, 14), hairMat); back.scale.set(1.0, 1.55, 0.62); back.position.set(0, 1.60, -0.085);
      back.frustumCulled = false; const g = new THREE.Group(); g.add(back); h.attach(g); this.hairParts = g;
    }
    play(key, { fade = 0.25, once = false, timeScale = 1, offset = 0 } = {}) {
      const a = this.act[key]; if (!a) return;
      if (this.cur === a) { a.timeScale = timeScale; return; }
      a.reset(); a.enabled = true; a.timeScale = timeScale; a.setEffectiveWeight(1); if (offset) a.time = offset;
      if (this.cur) { a.crossFadeFrom(this.cur, fade, false); } a.play(); this.cur = a; this.curKey = key;
    }
    /** t = {fx, fy, mode:'sit'|'stand'|'walk'|'exit', lookX, lookY, speaking, night, typing, hop} */
    update(dt, t, time) {
      this.visible = true; this.root.visible = true; this.blob.visible = true;
      const sd = CALIB.desks[this.seat];
      const wasMode = this.mode; this.mode = t.mode;
      const target = this._target ||= new THREE.Vector3();
      if (t.mode === 'sit') deskLocal(this.seat, CALIB.seatLocal[this.seat][0], CALIB.seatLocal[this.seat][1], target); else floorAt(t.fx, t.fy, target);
      if (!this.prev) { this.pos.copy(target); this.prev = target.clone(); }
      // world speed from the planner's motion
      const mv = target.distanceTo(this.prev) / Math.max(dt, 1e-3); this.prev.copy(target);
      this.speed = lerp(this.speed, mv, Math.min(1, dt * 8));
      this.pos.copy(target);
      // heading
      let want;
      if (t.mode === 'sit') want = Math.atan2(Math.sin(sd.yaw), Math.cos(sd.yaw)); // facing +z of the desk (towards the viewer)
      else if (t.mode === 'walk' && t.dirX !== undefined && (t.dirX || t.dirY)) { const a = floorAt(t.fx, t.fy, _fa), b = floorAt(t.fx + t.dirX, t.fy + t.dirY, _fb); want = Math.atan2(b.x - a.x, b.z - a.z); }
      else if (t.lookX !== undefined) { const b = floorAt(t.lookX, t.lookY, _fb); want = Math.atan2(b.x - target.x, b.z - target.z); }
      else want = this.yaw;
      if (wasMode !== t.mode && t.mode === 'sit') this.yaw = want; // seat is always entered facing the desk
      const turn = ang(this.yaw, want); this.yaw += Math.sign(turn) * Math.min(Math.abs(turn), dt * (t.mode === 'walk' ? 7 : 4.5));
      this.root.position.copy(this.pos); this.root.rotation.y = this.yaw;
      // clips
      const moving = t.mode === 'walk' && this.speed > 0.12;
      if (t.mode === 'sit') {
        if (wasMode !== 'sit' && wasMode !== 'exit') { this.afterEnter = false; this.play('sitEnter', { fade: 0.2 }); }
        else if (wasMode === 'exit') { this.play('sit', { fade: 0.3 }); }
        else if (!this.cur) this.play('sit', { fade: 0, offset: this.timeOffset });
        else if (this.curKey === 'sitEnter' && this.afterEnter) this.play(t.speaking ? 'sitTalk' : 'sit', { fade: 0.25 });
        else if (this.curKey === 'sit' && t.speaking) this.play('sitTalk', { fade: 0.25 });
        else if (this.curKey === 'sitTalk' && !t.speaking) this.play('sit', { fade: 0.35 });
      } else if (t.mode === 'exit') { if (this.curKey !== 'sitExit') this.play('sitExit', { fade: 0.15 }); }
      else if (moving) { this.play('walk', { fade: 0.22, timeScale: Math.max(0.7, Math.min(1.6, this.speed / 1.35)) }); }
      else { const k = t.speaking ? 'talk' : 'idle'; if (this.curKey === 'sitExit' && this.cur && this.cur.time < this.cur.getClip().duration * 0.95) { /* let the stand-up finish */ } else this.play(k, { fade: 0.3, offset: this.timeOffset }); }
      this.mixer.update(dt); this.sitT = (t.mode === 'sit' && this.curKey === 'sit') ? (this.sitT || 0) + dt : 0;
      this.applyOverlay(t, time);
      // night: pyjamas colour, dimmer light handled by the stage
      const nt = t.night > 0.55 ? 1 : 0; this.nightT = lerp(this.nightT, nt, Math.min(1, dt * 2.5));
      this.mat.userData.u.uNight.value = this.nightT;
      // hop (celebrate): a little jump
      if (t.hop > 0) this.root.position.y += Math.sin((1 - t.hop) * Math.PI) * 0.35;
      // blob shadow
      const big = t.mode === 'sit' ? 1.25 : 0.95;
      this.blob.position.set(this.pos.x + (t.mode === 'sit' ? 0.05 : 0), 0.004, this.pos.z + (t.mode === 'sit' ? 0.15 : 0.02)); this.blob.scale.set(big, big * 0.8, 1);
      this.blob.material.opacity = (1 - 0.25 * t.night) * (t.hop > 0 ? 0.6 : 1);
      // head position (for pills / bubbles), in picture fractions
      this.root.updateMatrixWorld(true);
      if (this.b.Head) { this.b.Head.getWorldPosition(this.head); this.head.y += 0.62; toPic(this.head, this.headPic ||= {}); }
    }
    applyOverlay(t, time) {
      const sit = this.mode === 'sit';
      const q = _oq, e = _oe;
      const twist = (name, x, y, z) => { const b = this.b[name]; if (!b || !this.rest[name]) return; e.set(x, y, z); q.setFromEuler(e); b.quaternion.copy(this.rest[name]).multiply(q); };
      if (seatedOverlay(t) === 'sleep') { // asleep: head down on the chest, arms still
        const k = this.nightT; const nod = Math.sin(time * 1.1 + this.timeOffset) * 0.015;
        const bq = this.b.neck_01; if (bq) { e.set(0.62 * k + nod, 0, 0.12 * k); q.setFromEuler(e); bq.quaternion.multiply(q); }
        const hq = this.b.Head; if (hq) { e.set(0.25 * k, 0, 0); q.setFromEuler(e); hq.quaternion.multiply(q); }
        const sp = this.b.spine_03; if (sp) { e.set(0.16 * k, 0, 0); q.setFromEuler(e); sp.quaternion.multiply(q); }
      } else if (seatedOverlay(t) === 'typing' && this.curKey === 'sit') { // typing: both hands on the keyboard, fingers tapping
        this.root.updateMatrixWorld(true);
        const b = this.b, sd = CALIB.desks[this.seat], c = Math.cos(sd.yaw), s_ = Math.sin(sd.yaw);
        const sl = CALIB.seatLocal[this.seat], w = Math.min(1, this.sitT / 0.5);
        for (const [side, up, lo, hd] of [[-1, 'upperarm_r', 'lowerarm_r', 'hand_r'], [1, 'upperarm_l', 'lowerarm_l', 'hand_l']]) {
          if (!b[up] || !b[lo] || !b[hd]) continue;
          const lx = sl[0] + 0.0 + side * 0.15, lz = sl[1] + 0.2, tap = Math.max(0, Math.sin(time * (side < 0 ? 14 : 11.5) + this.timeOffset)) * 0.012;
          const tgt = _tgt.set(sd.cx + lx * c + lz * s_, 0.77 + tap, sd.cz - lx * s_ + lz * c);
          const pole = _pole.set(side * 0.7 * c, -0.7, -side * 0.7 * -s_ - 0.25);
          solveArm(b[up], b[lo], b[hd], tgt, pole, w);
        }
        const hq = b.Head; if (hq) { e.set(0.12 + Math.sin(time * 0.7 + this.timeOffset) * 0.02, 0, 0); q.setFromEuler(e); hq.quaternion.multiply(q); }
      }
    }
    dispose() { scene.remove(this.root); scene.remove(this.blob); this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); this.mat.dispose(); this.blob.material.dispose(); }
  }

  function setCast(list, seats) {
    if (!ready) { pending = { list, seats }; return; }
    pending = null;
    for (const [id, p] of chars) if (!list.some(a => a.id === id && seats.get(a.id) === p.seat)) { p.dispose(); chars.delete(id); }
    list.forEach((a, i) => { if (!chars.has(a.id)) chars.set(a.id, new Person(a, seats.get(a.id), i)); });
  }
  let W = 0, H = 0, dpr = 0, geo = '';
  const dprWanted = box => Math.min(window.devicePixelRatio || 1, maxDpr); // retina screens render the people at 1.5x: sharp enough at their size, ~45% fewer pixels than 2x
  let dprCut = 0; // adaptive quality: pixel-ratio steps given back when frames run long
  /** place and size the canvas over the picture; touches the DOM only when something really changed */
  function resize(box) {
    const want = Math.max(1, dprWanted(box) - dprCut);
    if (box.w !== W || box.h !== H || want !== dpr) { W = box.w; H = box.h; dpr = want; renderer.setPixelRatio(dpr); renderer.setSize(Math.max(1, Math.round(box.w)), Math.max(1, Math.round(box.h)), false); }
    const g = box.x.toFixed(1) + ',' + box.y.toFixed(1) + ',' + box.w.toFixed(1) + ',' + box.h.toFixed(1);
    if (g !== geo) { geo = g; cvs.style.left = box.x + 'px'; cvs.style.top = box.y + 'px'; cvs.style.width = box.w + 'px'; cvs.style.height = box.h + 'px'; }
  }
  /** give back a quarter of the pixel ratio (down to 1); false when there is nothing left to give */
  function lowerQuality() { if (dpr <= 1.01) return false; dprCut += 0.25; return true; }
  let clock = 0, lightN = 0;
  const daySky = col(0xffffff), nightSky = col(0xffe6c8), dayGround = col(0xf3e8d8), nightGround = col(0x8d8190);
  function frame(dt, poses, night, time) {
    clock += dt; lightN = lerp(lightN, night, Math.min(1, dt * 2));
    hemi.color.copy(daySky).lerp(nightSky, lightN); hemi.groundColor.copy(dayGround).lerp(nightGround, lightN); hemi.intensity = lerp(2.1, 1.55, lightN);
    sun.intensity = lerp(0.8, 0.35, lightN); fill.intensity = lerp(0.35, 0.5, lightN);
    for (const [id, p] of chars) { const t = poses.get(id); if (t) p.update(dt, t, time); }
    renderer.render(scene, camera);
  }
  const headOf = id => { const p = chars.get(id); return p && p.visible ? p.headPic : null; };
  /** metres on the real floor per picture-fraction at a point (for a constant walking speed) */
  function metresPerFraction(fx, fy) { floorAt(fx, fy, _fa); floorAt(fx + 0.02, fy + 0.02, _fb); return Math.max(1, _fa.distanceTo(_fb) / Math.hypot(0.02, 0.02)); }
  return { setCast, resize, lowerQuality, metresPerFraction, get pixelRatio() { return dpr; }, frame, headOf, floorAt, get ready() { return ready; }, loaded, chars, canvas: cvs, camera, renderer, scene, dispose() { chars.forEach(c => c.dispose()); renderer.dispose(); cvs.remove(); } };
}
