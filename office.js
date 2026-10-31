// office.js — Three.js isometric toy-office scene. All geometry is code-generated; no external assets.
import * as THREE from './three.module.js';

const PALETTE = {
  floor: 0xe9dcbd, floorAlt: 0xe2d2b0, wall: 0xe7ddca, wallSide: 0xded2ba,
  trim: 0xf5b301, desk: 0xf7f4ee, deskLeg: 0xd8d2c6, chair: 0xffffff,
  laptop: 0x3a3f4a, laptopScreen: 0x101522, paper: 0xfdfaf2, pot: 0xf4efe6,
  leaf: 0x5fae6e, leafDark: 0x4c9459, clockFace: 0xfaf6ec,
};

export function createOffice(canvas, agentsMeta, hooks = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x191510);

  // ---- isometric orthographic camera ----
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const camState = { az: Math.PI / 4, el: Math.atan(1 / Math.sqrt(2)), dist: 26, zoom: 11, target: new THREE.Vector3(0, 0.6, 0.4) };
  function applyCam() {
    const { az, el, dist, zoom, target } = camState;
    cam.position.set(
      target.x + dist * Math.cos(el) * Math.cos(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.sin(az)
    );
    cam.lookAt(target);
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    cam.left = -zoom * aspect / 2; cam.right = zoom * aspect / 2;
    cam.top = zoom / 2; cam.bottom = -zoom / 2;
    cam.updateProjectionMatrix();
  }

  // ---- lights ----
  scene.add(new THREE.HemisphereLight(0xfff6e6, 0x8a7a5c, 1.05));
  const sun = new THREE.DirectionalLight(0xfff1d6, 1.6);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 2, far: 40 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdde8ff, 0.35);
  fill.position.set(-6, 8, -4);
  scene.add(fill);

  const M = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, ...opts });
  function box(w, h, d, color, x = 0, y = 0, z = 0, opts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(color, opts));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  // ---- room ----
  const ROOM = { w: 17, d: 12.5, h: 4.2 };
  const room = new THREE.Group();
  // floor planks
  const plankW = 1.42;
  for (let i = 0; i < 12; i++) {
    const p = box(plankW - 0.05, 0.12, ROOM.d, i % 2 ? PALETTE.floor : PALETTE.floorAlt,
      -ROOM.w / 2 + plankW / 2 + i * plankW, -0.06, 0);
    p.receiveShadow = true; p.castShadow = false;
    room.add(p);
  }
  // back wall (z-) and left wall (x-), slight thickness
  const backWall = box(ROOM.w, ROOM.h, 0.25, PALETTE.wall, 0, ROOM.h / 2, -ROOM.d / 2); backWall.castShadow = false;
  const leftWall = box(0.25, ROOM.h, ROOM.d, PALETTE.wallSide, -ROOM.w / 2, ROOM.h / 2, 0); leftWall.castShadow = false;
  room.add(backWall, leftWall);
  // yellow trim along wall tops (like the reference frame)
  room.add(box(ROOM.w, 0.14, 0.3, PALETTE.trim, 0, ROOM.h - 0.07, -ROOM.d / 2));
  room.add(box(0.3, 0.14, ROOM.d, PALETTE.trim, -ROOM.w / 2, ROOM.h - 0.07, 0));
  scene.add(room);

  // ---- furniture builders ----
  function makeDesk() {
    const g = new THREE.Group();
    g.add(box(2.3, 0.09, 1.15, PALETTE.desk, 0, 0.78, 0));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      g.add(box(0.08, 0.78, 0.08, PALETTE.deskLeg, sx * 1.05, 0.39, sz * 0.48));
    // laptop
    g.add(box(0.55, 0.03, 0.38, PALETTE.laptop, -0.25, 0.845, 0.05));
    const scr = box(0.55, 0.38, 0.03, PALETTE.laptop, -0.25, 1.03, -0.14);
    scr.rotation.x = -0.32; g.add(scr);
    const scrFace = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.31), M(PALETTE.laptopScreen, { emissive: 0x2b3d66, emissiveIntensity: 0.9, roughness: 0.4 }));
    scrFace.position.set(-0.25, 1.04, -0.115); scrFace.rotation.x = -0.32;
    g.add(scrFace);
    // paper + cup
    g.add(box(0.4, 0.015, 0.3, PALETTE.paper, 0.45, 0.83, 0.1));
    return g;
  }
  function makeCup(color) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.11, 12), M(color));
    c.castShadow = true; return c;
  }
  function makeChair() {
    const g = new THREE.Group();
    g.add(box(0.55, 0.07, 0.5, PALETTE.chair, 0, 0.46, 0));
    g.add(box(0.55, 0.62, 0.07, PALETTE.chair, 0, 0.8, -0.25));
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
      g.add(box(0.05, 0.46, 0.05, PALETTE.deskLeg, sx * 0.23, 0.23, sz * 0.2));
    return g;
  }
  function makePlant(x, z) {
    const g = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.22, 0.42, 14), M(PALETTE.pot));
    pot.position.y = 0.21; pot.castShadow = true; g.add(pot);
    const b1 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), M(PALETTE.leaf, { flatShading: true }));
    b1.position.y = 0.95; b1.castShadow = true;
    const b2 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 0), M(PALETTE.leafDark, { flatShading: true }));
    b2.position.set(0.25, 1.25, 0.1); b2.castShadow = true;
    const b3 = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28, 0), M(PALETTE.leaf, { flatShading: true }));
    b3.position.set(-0.24, 1.2, -0.12); b3.castShadow = true;
    g.add(b1, b2, b3); g.position.set(x, 0, z);
    return g;
  }

  // desks: two rows of three
  const deskSpots = [];
  const cupColors = [0x7aa2f7, 0x57c98a, 0xb085e8, 0xf2a65a, 0xef87a8, 0x5ecfd6];
  const rowZ = [-2.6, 0.6], colX = [-4.4, 0, 4.4];
  rowZ.forEach((z, ri) => colX.forEach((x, ci) => {
    const desk = makeDesk(); desk.position.set(x, 0, z); desk.rotation.y = Math.PI; scene.add(desk);
    const chair = makeChair(); chair.position.set(x, 0, z - 0.95); scene.add(chair);
    const cup = makeCup(cupColors[ri * 3 + ci]); cup.position.set(x - 0.85, 0.87, z - 0.25); scene.add(cup);
    deskSpots.push({ desk: new THREE.Vector3(x, 0, z), seat: new THREE.Vector3(x, 0, z - 0.92) });
  }));

  scene.add(makePlant(-7.2, -4.6), makePlant(7.3, -4.9));

  // meeting rug at center-front
  const rug = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.04, 28), M(0xd9c6a2));
  rug.position.set(0, 0.08, 3.6); rug.receiveShadow = true; scene.add(rug);
  const MEET = new THREE.Vector3(0, 0, 3.6);

  // ---- wall clock (real local time) ----
  const clockG = new THREE.Group();
  clockG.add(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.06, 32).rotateX(Math.PI / 2), M(PALETTE.clockFace)));
  const hourHand = box(0.05, 0.26, 0.02, 0x33302a, 0, 0.1, 0.045);
  const minHand = box(0.035, 0.4, 0.02, 0x33302a, 0, 0.16, 0.055);
  for (const h of [hourHand, minHand]) { h.geometry.translate(0, 0, 0); }
  clockG.add(hourHand, minHand);
  clockG.position.set(0, 3.0, -ROOM.d / 2 + 0.2);
  scene.add(clockG);
  function tickClock() {
    const d = new Date();
    hourHand.rotation.z = -((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2;
    minHand.rotation.z = -(d.getMinutes() + d.getSeconds() / 60) / 60 * Math.PI * 2;
  }
  tickClock(); setInterval(tickClock, 1000);

  // ---- wall screen with live bar chart (canvas texture) ----
  const scrCanvas = document.createElement('canvas'); scrCanvas.width = 512; scrCanvas.height = 288;
  const scrCtx = scrCanvas.getContext('2d');
  const scrTex = new THREE.CanvasTexture(scrCanvas);
  const wallScr = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 1.9), new THREE.MeshBasicMaterial({ map: scrTex }));
  wallScr.position.set(5.2, 2.5, -ROOM.d / 2 + 0.15);
  scene.add(wallScr);
  function drawWallScreen(counts, total) {
    const c = scrCtx, W = 512, H = 288;
    c.fillStyle = '#151310'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#f5b301'; c.font = 'bold 26px Heebo, sans-serif'; c.textAlign = 'right';
    c.fillText('אירועים היום', W - 24, 42);
    c.fillStyle = '#f5efe4'; c.font = 'bold 40px Heebo, sans-serif';
    c.fillText(String(total), W - 24, 88);
    const max = Math.max(4, ...counts.map(x => x.v));
    const bw = 44, gap = (W - 60 - counts.length * bw) / (counts.length - 1);
    counts.forEach((a, i) => {
      const h = 8 + (a.v / max) * 130;
      const x = W - 50 - bw - i * (bw + gap), y = H - 40 - h;
      c.fillStyle = a.color; c.beginPath(); c.roundRect(x, y, bw, h, 6); c.fill();
    });
    scrTex.needsUpdate = true;
  }

  // ---- characters ----
  function makeLabel(text, color) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(22,17,10,.92)';
    c.beginPath(); c.roundRect(28, 14, 200, 62, 30); c.fill();
    c.strokeStyle = color; c.lineWidth = 4; c.stroke();
    c.fillStyle = '#f5efe4'; c.font = 'bold 38px Heebo, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.direction = 'rtl';
    c.fillText(text, 128, 48);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sp.scale.set(1.5, 0.56, 1); sp.renderOrder = 10;
    return sp;
  }

  function makeCharacter(meta) {
    const g = new THREE.Group();
    const skin = M(meta.skin);
    // body (capsule shirt)
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.34, 6, 14), M(meta.color));
    body.position.y = 0.62; body.castShadow = true; g.add(body);
    // head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 18), skin);
    head.position.y = 1.22; head.castShadow = true; g.add(head);
    // hair cap
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.355, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.38), M(meta.hair));
    hair.position.set(0, 1.3, -0.045); hair.castShadow = true; g.add(hair);
    if (meta.longHair) {
      const back = new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), M(meta.hair));
      back.scale.set(1, 1.35, 0.75); back.position.set(0, 1.05, -0.14); back.castShadow = true; g.add(back);
    }
    // dot eyes
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), M(0x241d16, { roughness: 0.4 }));
      eye.position.set(s * 0.13, 1.24, 0.315); g.add(eye);
    }
    // smile
    const smile = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 6, 12, Math.PI), M(0x8a5a44));
    smile.position.set(0, 1.12, 0.315); smile.rotation.z = Math.PI; g.add(smile);
    // arms
    const arms = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group(); pivot.position.set(s * 0.3, 0.82, 0);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.3, 4, 10), M(meta.color));
      arm.position.y = -0.18; arm.castShadow = true; pivot.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), skin);
      hand.position.y = -0.38; pivot.add(hand);
      pivot.rotation.z = s * 0.25;
      g.add(pivot); arms.push(pivot);
    }
    // legs
    const legs = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.22, 4, 10), M(0x4a4e5c));
      leg.position.set(s * 0.12, 0.18, 0); leg.castShadow = true; g.add(leg); legs.push(leg);
    }
    // name label
    const label = makeLabel(meta.name, meta.color);
    label.position.y = 1.85; g.add(label);
    // focus ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.035, 8, 32).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xf5b301, transparent: true, opacity: 0 }));
    ring.position.y = 0.06; g.add(ring);
    // click hitbox
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.9, 8),
      new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.95; hit.userData.agentId = meta.id; g.add(hit);

    return { g, arms, legs, head, label, ring, hit, meta };
  }

  const agents = new Map();
  agentsMeta.forEach((meta, i) => {
    const ch = makeCharacter(meta);
    const spot = deskSpots[i];
    ch.g.position.copy(spot.seat);
    ch.g.position.y = 0.28;               // seated on chair
    ch.g.rotation.y = 0;                  // face +z (toward the isometric camera), desk in front
    ch.state = 'typing';
    ch.seat = spot.seat.clone(); ch.seat.y = 0.28;
    ch.walkTarget = null;
    ch.stateT = Math.random() * 10;
    ch.meetOffset = new THREE.Vector3(Math.cos(i / agentsMeta.length * Math.PI * 2) * 1.25, 0, Math.sin(i / agentsMeta.length * Math.PI * 2) * 1.25);
    scene.add(ch.g);
    agents.set(meta.id, ch);
  });

  // ---- interaction: drag rotate / wheel zoom / click select ----
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let dragging = false, moved = 0, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', e => { dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    camState.az -= dx * 0.006;
    camState.el = Math.min(1.2, Math.max(0.35, camState.el + dy * 0.004));
    lastX = e.clientX; lastY = e.clientY; applyCam();
  });
  canvas.addEventListener('pointerup', e => {
    dragging = false;
    if (moved < 6) {  // treat as click
      const r = canvas.getBoundingClientRect();
      ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ptr, cam);
      const hits = ray.intersectObjects([...agents.values()].map(a => a.hit));
      if (hits.length) hooks.onSelect?.(hits[0].object.userData.agentId);
    }
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    camState.zoom = Math.min(18, Math.max(5.5, camState.zoom + e.deltaY * 0.012));
    applyCam();
  }, { passive: false });

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio())
      renderer.setSize(w, h, false);
    applyCam();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- animation ----
  const clock = new THREE.Clock();
  let running = true;
  function animate() {
    if (!running) return;
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    for (const ch of agents.values()) {
      ch.stateT += dt;
      const p = ch.g.position;
      if (ch.state === 'walk' && ch.walkTarget) {
        const dir = ch.walkTarget.clone().sub(p); dir.y = 0;
        const d = dir.length();
        if (d < 0.12) {
          p.copy(ch.walkTarget);
          const cb = ch.onArrive; ch.onArrive = null; ch.walkTarget = null;
          ch.state = ch.nextState || 'idle'; ch.nextState = null;
          cb?.();
        } else {
          dir.normalize();
          p.addScaledVector(dir, dt * 2.1);
          ch.g.rotation.y = Math.atan2(dir.x, dir.z);
          p.y = ch.walkTarget.y + Math.abs(Math.sin(t * 11)) * 0.07;
          ch.legs[0].rotation.x = Math.sin(t * 11) * 0.7;
          ch.legs[1].rotation.x = -Math.sin(t * 11) * 0.7;
        }
      } else if (ch.state === 'typing') {
        ch.legs.forEach(l => l.rotation.x = 0);
        p.y = ch.seat && p.distanceTo(ch.seat) < 0.2 ? ch.seat.y : p.y;
        ch.arms[0].rotation.x = -0.9 + Math.sin(t * 9 + ch.stateT) * 0.18;
        ch.arms[1].rotation.x = -0.9 + Math.cos(t * 8.2) * 0.18;
        ch.head.position.y = 1.22 + Math.sin(t * 2 + ch.stateT) * 0.012; // breathing
      } else if (ch.state === 'celebrate') {
        p.y = (ch.seat?.y ?? 0) + Math.abs(Math.sin(t * 7)) * 0.28;
        ch.arms[0].rotation.z = -2.4; ch.arms[1].rotation.z = 2.4;
        if (ch.stateT > 1.6) { ch.state = 'typing'; ch.stateT = 0; ch.arms[0].rotation.z = -0.25; ch.arms[1].rotation.z = 0.25; }
      } else if (ch.state === 'meeting') {
        p.y = Math.abs(Math.sin(t * 3 + ch.stateT)) * 0.05;
        ch.arms[0].rotation.x = Math.sin(t * 2.4 + ch.stateT) * 0.4;
        ch.arms[1].rotation.x = Math.cos(t * 2.1) * 0.4;
        ch.head.rotation.y = Math.sin(t * 1.3 + ch.stateT) * 0.35; // looking around
      } else { // idle
        ch.head.position.y = 1.22 + Math.sin(t * 1.8 + ch.stateT) * 0.015;
        ch.arms[0].rotation.x = -0.15; ch.arms[1].rotation.x = -0.15;
      }
      // focus ring pulse
      const target = ch.focused ? 0.95 : 0;
      ch.ring.material.opacity += (target - ch.ring.material.opacity) * 0.15;
      if (ch.focused) ch.ring.scale.setScalar(1 + Math.sin(t * 4) * 0.05);
    }
    renderer.render(scene, cam);
  }
  animate();

  // ---- public API ----
  return {
    setState(id, state) {
      const ch = agents.get(id); if (!ch) return;
      ch.state = state; ch.stateT = 0;
    },
    celebrate(id) {
      const ch = agents.get(id); if (!ch) return;
      if (ch.state !== 'walk' && ch.state !== 'meeting') { ch.state = 'celebrate'; ch.stateT = 0; }
    },
    walkTo(id, v, nextState = 'idle', onArrive = null) {
      const ch = agents.get(id); if (!ch) return;
      ch.walkTarget = new THREE.Vector3(v.x, v.y, v.z); ch.state = 'walk'; ch.nextState = nextState; ch.onArrive = onArrive;
    },
    goHome(id) {
      const ch = agents.get(id); if (!ch) return;
      this.walkTo(id, ch.seat, 'typing', () => { ch.g.rotation.y = 0; });
    },
    gatherAll() {
      for (const ch of agents.values())
        this.walkTo(ch.meta.id, MEET.clone().add(ch.meetOffset), 'meeting', () => {
          // face the circle center
          const c = ch.g.position;
          ch.g.rotation.y = Math.atan2(MEET.x - c.x, MEET.z - c.z);
        });
    },
    disperseAll() { for (const id of agents.keys()) this.goHome(id); },
    focus(id) {
      for (const ch of agents.values()) ch.focused = ch.meta.id === id;
      const ch = agents.get(id);
      if (ch) { camState.target.lerp(new THREE.Vector3(ch.g.position.x, 0.7, ch.g.position.z), 0.6); camState.zoom = Math.min(camState.zoom, 9); applyCam(); }
    },
    unfocus() {
      for (const ch of agents.values()) ch.focused = false;
      camState.target.set(0, 0.6, 0.4); camState.zoom = 11; applyCam();
    },
    resetCam() { camState.az = Math.PI / 4; camState.el = Math.atan(1 / Math.sqrt(2)); camState.target.set(0, 0.6, 0.4); camState.zoom = 11; applyCam(); },
    updateScreen: drawWallScreen,
    dispose() { running = false; renderer.dispose(); },
  };
}
