// office.js — the Agent Office: a cozy isometric diorama in Three.js. Everything is
// code-generated (no model files, no image assets): geometry, canvas textures, emblems.
// Performance budget: static furniture is merged into a handful of draw calls per material,
// books are instanced, textures stay ≤1024 px on phones, pixel ratio is capped and drops
// further if a phone can't hold ~30 fps.
import * as THREE from './three.module.js';
import { drawEmblem, emblemOf, shade, inkOn } from './emblems.js';

const C = {
  floor: '#d7ae7c', floorDark: '#c49a68', slab: '#5b4331', slabTop: '#8a6446',
  wall: '#f3eadb', wallShade: '#ece0cc', wains: '#8fae9b', wainsDark: '#7c9a87', rail: '#f5b301',
  wood: '#b9875a', woodLight: '#d8b58a', woodDark: '#6f4c33', white: '#f7f4ee', metal: '#3b3a40',
  fabric: '#3d4a5c', fabricLight: '#566a82', rug: '#c86f4f', rugCream: '#f1e1c4', rugTeal: '#3f7d78',
  leaf: '#5fae6e', leafDark: '#3f8a52', leafLight: '#86c77e', pot: '#efe7da', potTerra: '#c9744f',
  screenOff: '#0d1016', ink: '#1a1407',
};

/* ---------------- small geometry helpers ---------------- */
function roundedBoxGeo(w, h, d, r = 0.04, s = 2) {
  r = Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3);
  const seg = s * 2 + 1;
  const g = new THREE.BoxGeometry(1, 1, 1, seg, seg, seg);
  const pos = g.attributes.position, nor = g.attributes.normal;
  const half = 0.5 / seg, ix = w / 2 - r, iy = h / 2 - r, iz = d / 2 - r;
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    n.set(x - Math.sign(x) * half, y - Math.sign(y) * half, z - Math.sign(z) * half).normalize();
    pos.setXYZ(i, Math.sign(x) * ix + n.x * r, Math.sign(y) * iy + n.y * r, Math.sign(z) * iz + n.z * r);
    nor.setXYZ(i, n.x, n.y, n.z);
  }
  return g;
}
/** Merge meshes that share a material into one geometry each (static scenery only). */
function mergeStatic(group, scene) {
  group.updateMatrixWorld(true);
  const buckets = new Map();
  group.traverse(o => {
    if (!o.isMesh || o.userData.keep) return;
    const k = o.material.uuid + (o.castShadow ? 'c' : '') + (o.receiveShadow ? 'r' : '');
    if (!buckets.has(k)) buckets.set(k, { mat: o.material, cast: o.castShadow, recv: o.receiveShadow, list: [] });
    buckets.get(k).list.push(o);
  });
  const out = new THREE.Group();
  for (const b of buckets.values()) {
    const parts = b.list.map(m => {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(m.matrixWorld);
      return g;
    });
    let count = 0; for (const g of parts) count += g.attributes.position.count;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3), uv = new Float32Array(count * 2);
    let o3 = 0, o2 = 0;
    for (const g of parts) {
      pos.set(g.attributes.position.array, o3);
      if (g.attributes.normal) nor.set(g.attributes.normal.array, o3);
      if (g.attributes.uv) uv.set(g.attributes.uv.array, o2);
      o3 += g.attributes.position.count * 3; o2 += g.attributes.position.count * 2;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, b.mat);
    mesh.castShadow = b.cast; mesh.receiveShadow = b.recv; mesh.matrixAutoUpdate = false;
    out.add(mesh);
  }
  // keep non-mergeable children (sprites, unique-material meshes flagged keep)
  const keep = [];
  group.traverse(o => { if (o !== group && (o.userData.keep || o.isSprite || o.isPoints || o.isInstancedMesh)) keep.push(o); });
  for (const o of keep) { o.updateMatrixWorld(true); o.matrix.copy(o.matrixWorld); o.matrix.decompose(o.position, o.quaternion, o.scale); o.parent?.remove(o); out.add(o); }
  scene.remove(group);
  scene.add(out);
  return out;
}
function canvasTex(w, h, draw, { repeat = null, srgb = true } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  draw(c, w, h);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.anisotropy = 4;
  return t;
}
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, r); }
function ellipsize(c, text, max) {
  text = String(text || '');
  if (c.measureText(text).width <= max) return text;
  while (text.length > 1 && c.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}
function seeded(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function createOffice(canvas, agentsMeta, hooks = {}, opts = {}) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const small = Math.min(innerWidth, innerHeight) < 700;
  const mobile = coarse || small;
  const reduced = opts.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;
  const showcase = !!opts.showcase;
  const capture = !!opts.capture;
  const TEX = mobile ? 512 : 1024;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: capture });
  let maxDpr = mobile ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, maxDpr));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.14;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const ROOM = { w: 15, d: 11, h: 3.8 };
  const HW = ROOM.w / 2, HD = ROOM.d / 2;

  /* ---------------- camera: isometric ortho with eased zoom / orbit / pan ---------------- */
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
  const BASE_AZ = Math.PI / 4, BASE_EL = 0.62;
  const LIM = { az: 0.6, elMin: 0.38, elMax: 1.08, zMin: 3.2, zMax: 30 };
  const goal = { az: BASE_AZ, el: BASE_EL, zoom: 14, t: new THREE.Vector3(0, 0.8, 0) };
  const cur = { az: BASE_AZ, el: BASE_EL, zoom: 14, t: new THREE.Vector3(0, 0.8, 0) };
  let home = { zoom: 14, t: new THREE.Vector3(0, 0.8, 0), el: BASE_EL };
  let atHome = true; // follow the home framing on resize until the user moves the camera
  const tmpV = new THREE.Vector3();
  function aspect() { return canvas.clientWidth / Math.max(1, canvas.clientHeight); }
  function placeCam(state, camera = cam) {
    const { az, el, zoom, t } = state, dist = 40;
    camera.position.set(t.x + dist * Math.cos(el) * Math.cos(az), t.y + dist * Math.sin(el), t.z + dist * Math.cos(el) * Math.sin(az));
    camera.lookAt(t);
    const a = aspect();
    camera.left = -zoom * a / 2; camera.right = zoom * a / 2; camera.top = zoom / 2; camera.bottom = -zoom / 2;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  /** Frustum height that fits a world box at the default angle. */
  function fitZoom(minX, maxX, minZ, maxZ, maxY = ROOM.h, widthShare = 1) {
    const probe = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
    const c = new THREE.Vector3((minX + maxX) / 2, maxY * 0.35, (minZ + maxZ) / 2);
    placeCam({ az: BASE_AZ, el: homeEl(), zoom: 10, t: c }, probe);
    const inv = probe.matrixWorldInverse;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const x of [minX, maxX]) for (const y of [-0.5, maxY]) for (const z of [minZ, maxZ]) {
      tmpV.set(x, y, z).applyMatrix4(inv);
      x0 = Math.min(x0, tmpV.x); x1 = Math.max(x1, tmpV.x); y0 = Math.min(y0, tmpV.y); y1 = Math.max(y1, tmpV.y);
    }
    const cView = c.clone().applyMatrix4(inv);
    const center = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, cView.z).applyMatrix4(probe.matrixWorld);
    return { zoom: Math.max(y1 - y0, (x1 - x0) * widthShare / aspect()), center };
  }
  function homeEl() { return aspect() < 0.8 ? 0.8 : BASE_EL; } // portrait: a higher camera fills the tall screen
  function computeHome() {
    const a = aspect();
    const all = fitZoom(-HW - 0.3, HW + 0.3, -HD - 0.3, HD + 0.4);
    LIM.zMax = all.zoom * 1.3;
    if (a < 0.8) { // phone portrait: the whole room, letting the empty floor corners crop; a pinch shows the rest
      const f = fitZoom(-HW, HW, -HD, HD, ROOM.h, 0.7);
      home = { zoom: f.zoom, t: f.center, el: homeEl() };
    } else {
      home = { zoom: all.zoom * 1.02, t: all.center, el: homeEl() };
    }
    LIM.zMax = Math.max(LIM.zMax, home.zoom * 1.15);
  }
  function clampGoal() {
    goal.az = Math.min(BASE_AZ + LIM.az, Math.max(BASE_AZ - LIM.az, goal.az));
    goal.el = Math.min(LIM.elMax, Math.max(LIM.elMin, goal.el));
    goal.zoom = Math.min(LIM.zMax, Math.max(LIM.zMin, goal.zoom));
    goal.t.x = Math.min(HW, Math.max(-HW, goal.t.x));
    goal.t.z = Math.min(HD + 1, Math.max(-HD, goal.t.z));
    goal.t.y = Math.min(6, Math.max(-3, goal.t.y));
  }
  function ease(dt) {
    const k = reduced ? 1 : 1 - Math.exp(-dt * 9);
    cur.az += (goal.az - cur.az) * k; cur.el += (goal.el - cur.el) * k;
    cur.zoom += (goal.zoom - cur.zoom) * k; cur.t.lerp(goal.t, k);
  }

  /* ---------------- lights: soft daylight from the windows + warm interior fill ---------------- */
  const hemi = new THREE.HemisphereLight(0xfff3e0, 0x9a7b5c, 1.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
  sun.position.set(-14, 11, 3.5);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 9, bottom: -9, near: 1, far: 45 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xc9dcff, 0.55);
  fill.position.set(8, 9, 10);
  scene.add(fill);

  /* ---------------- materials (shared by colour so merged scenery stays few draw calls) ---------------- */
  const mats = new Map();
  function M(color, o = {}) {
    const key = color + JSON.stringify(o);
    if (!mats.has(key)) mats.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, ...o }));
    return mats.get(key);
  }
  const stat = new THREE.Group(); // static scenery, merged after build
  scene.add(stat);
  function add(parent, geo, mat, x = 0, y = 0, z = 0, { cast = true, recv = true, ry = 0, rx = 0, rz = 0 } = {}) {
    const m = new THREE.Mesh(geo, typeof mat === 'string' ? M(mat) : mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = cast; m.receiveShadow = recv;
    parent.add(m); return m;
  }
  const box = (p, w, h, d, mat, x, y, z, o) => add(p, new THREE.BoxGeometry(w, h, d), mat, x, y, z, o);
  const rbox = (p, w, h, d, r, mat, x, y, z, o) => add(p, roundedBoxGeo(w, h, d, r), mat, x, y, z, o);
  const cyl = (p, rt, rb, h, seg, mat, x, y, z, o) => add(p, new THREE.CylinderGeometry(rt, rb, h, seg), mat, x, y, z, o);

  /* ---------------- textures ---------------- */
  const floorTex = canvasTex(512, 512, (c, w, h) => {
    const rnd = seeded(7);
    const rows = 8, ph = h / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rnd() * 200;
      while (x < w) {
        const len = 140 + rnd() * 180;
        const l = 0.9 + rnd() * 0.16;
        const base = [215, 174, 124].map(v => Math.min(255, Math.round(v * l)));
        c.fillStyle = `rgb(${base})`; c.fillRect(x, r * ph, len, ph);
        // grain
        c.globalAlpha = 0.09;
        for (let i = 0; i < 7; i++) {
          c.strokeStyle = rnd() < 0.5 ? '#8a5a32' : '#fff2dc'; c.lineWidth = 1 + rnd() * 1.5;
          const yy = r * ph + 5 + rnd() * (ph - 10);
          c.beginPath(); c.moveTo(x, yy); c.bezierCurveTo(x + len * 0.3, yy + (rnd() - 0.5) * 6, x + len * 0.7, yy + (rnd() - 0.5) * 6, x + len, yy); c.stroke();
        }
        c.globalAlpha = 1;
        c.fillStyle = 'rgba(70,40,20,.35)'; c.fillRect(x, r * ph, 2, ph);
        x += len;
      }
      c.fillStyle = 'rgba(70,40,20,.32)'; c.fillRect(0, r * ph, w, 2);
    }
  }, { repeat: [3.2, 2.4] });
  const rugTex = canvasTex(512, 512, (c, w, h) => {
    const cx = w / 2;
    c.fillStyle = C.rug; c.beginPath(); c.arc(cx, cx, cx, 0, 7); c.fill();
    c.strokeStyle = C.rugCream; c.lineWidth = 14; c.beginPath(); c.arc(cx, cx, cx - 26, 0, 7); c.stroke();
    c.lineWidth = 5; c.beginPath(); c.arc(cx, cx, cx - 48, 0, 7); c.stroke();
    c.fillStyle = C.rugTeal; c.beginPath(); c.arc(cx, cx, cx - 70, 0, 7); c.fill();
    c.fillStyle = C.rugCream;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      c.save(); c.translate(cx + Math.cos(a) * 135, cx + Math.sin(a) * 135); c.rotate(a + Math.PI / 4);
      c.fillRect(-11, -11, 22, 22); c.restore();
    }
    c.fillStyle = '#e8b04f'; c.beginPath(); c.arc(cx, cx, 70, 0, 7); c.fill();
    c.fillStyle = C.rug; c.beginPath(); c.arc(cx, cx, 40, 0, 7); c.fill();
  });
  const skyTex = canvasTex(512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#8cc8f0'); g.addColorStop(0.6, '#cfe8f5'); g.addColorStop(1, '#fbe7c6');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const rnd = seeded(3);
    for (let i = 0; i < 9; i++) { // soft clouds (tile horizontally)
      const x = rnd() * w, y = 30 + rnd() * 110, s = 30 + rnd() * 40;
      for (const dx of [-w, 0, w]) {
        c.fillStyle = 'rgba(255,255,255,.85)';
        for (let k = 0; k < 5; k++) { c.beginPath(); c.ellipse(x + dx + (k - 2) * s * 0.55, y + Math.sin(k) * 6, s * 0.6, s * 0.36, 0, 0, 7); c.fill(); }
      }
    }
    // distant hills / city
    c.fillStyle = '#9fc2b5';
    c.beginPath(); c.moveTo(0, h);
    for (let x = 0; x <= w; x += 16) c.lineTo(x, h - 40 - Math.sin(x * 0.02) * 14 - Math.sin(x * 0.051) * 8);
    c.lineTo(w, h); c.fill();
    c.fillStyle = '#86ad9f';
    const r2 = seeded(11);
    for (let x = 0; x < w; x += 22) { const bh = 20 + r2() * 46; c.fillRect(x, h - bh, 16, bh); }
  });
  skyTex.wrapS = THREE.RepeatWrapping;
  const glowTex = canvasTex(128, 128, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  });
  const shaftTex = canvasTex(64, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,240,210,.85)'); g.addColorStop(1, 'rgba(255,240,210,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    const s = c.createLinearGradient(0, 0, w, 0);
    s.addColorStop(0, 'rgba(0,0,0,1)'); s.addColorStop(0.2, 'rgba(0,0,0,0)'); s.addColorStop(0.8, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out'; c.fillStyle = s; c.fillRect(0, 0, w, h);
  });

  /* ---------------- the room: a diorama slab with two walls ---------------- */
  // slab
  rbox(stat, ROOM.w + 0.5, 0.55, ROOM.d + 0.5, 0.08, C.slab, 0, -0.3, 0, { cast: false });
  rbox(stat, ROOM.w + 0.36, 0.06, ROOM.d + 0.36, 0.02, C.slabTop, 0, -0.03, 0, { cast: false });
  const floor = add(scene, new THREE.PlaneGeometry(ROOM.w, ROOM.d), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.62, metalness: 0 }), 0, 0.001, 0, { cast: false, rx: -Math.PI / 2 });
  floor.userData.keep = true;
  const T = 0.3; // wall thickness
  // back wall (z-) : wainscot + upper wall + rail
  box(stat, ROOM.w + T, 1.05, T, C.wains, 0.0 - T / 2 + T / 2, 0.525, -HD - T / 2, { cast: false });
  box(stat, ROOM.w + T, ROOM.h - 1.05, T, C.wall, 0, 1.05 + (ROOM.h - 1.05) / 2, -HD - T / 2, { cast: true });
  box(stat, ROOM.w + T, 0.07, 0.07, C.rail, 0, 1.08, -HD + 0.02, { cast: false });
  box(stat, ROOM.w + T, 0.12, T + 0.06, C.wallShade, 0, ROOM.h + 0.06, -HD - T / 2, { cast: false });
  // left wall (x-) with two window openings
  const WIN = [{ z: -2.7, w: 2.3 }, { z: 1.7, w: 2.3 }], WY0 = 1.05, WY1 = 3.05;
  const LX = -HW - T / 2;
  box(stat, T, 1.05, ROOM.d, C.wainsDark, LX, 0.525, 0, { cast: true });
  box(stat, T, ROOM.h - WY1, ROOM.d, C.wallShade, LX, WY1 + (ROOM.h - WY1) / 2, 0, { cast: true });
  { // vertical pieces between/around windows
    const edges = [-HD]; WIN.forEach(w => edges.push(w.z - w.w / 2, w.z + w.w / 2)); edges.push(HD);
    for (let i = 0; i < edges.length; i += 2) {
      const a = edges[i], b = edges[i + 1];
      box(stat, T, WY1 - 1.05, b - a, C.wallShade, LX, 1.05 + (WY1 - 1.05) / 2, (a + b) / 2, { cast: true });
    }
  }
  box(stat, 0.07, 0.07, ROOM.d, C.rail, -HW + 0.02, 1.08, 0, { cast: false });
  box(stat, T + 0.06, 0.12, ROOM.d + T, C.wallShade, LX, ROOM.h + 0.06, -T / 2, { cast: false });
  // windows: frame, mullions, sill, glass with drifting sky
  const skyMat = new THREE.MeshBasicMaterial({ map: skyTex, toneMapped: false, color: 0xf2f2f2 });
  for (const w of WIN) {
    const fz = w.z, fw = w.w, fh = WY1 - WY0, fy = (WY0 + WY1) / 2;
    const glass = add(scene, new THREE.PlaneGeometry(fw, fh), skyMat, LX - 0.02, fy, fz, { cast: false, recv: false, ry: Math.PI / 2 });
    glass.userData.keep = true;
    for (const dz of [-1, 1]) box(stat, T + 0.08, fh + 0.12, 0.08, C.white, LX, fy, fz + dz * fw / 2);
    for (const dy of [-1, 1]) box(stat, T + 0.08, 0.08, fw + 0.12, C.white, LX, fy + dy * fh / 2, fz);
    box(stat, 0.06, fh, 0.05, C.white, LX + 0.02, fy, fz, { cast: true });
    box(stat, 0.06, 0.05, fw, C.white, LX + 0.02, fy + 0.2, fz, { cast: true });
    rbox(stat, 0.42, 0.07, fw + 0.36, 0.02, C.white, LX + 0.18, WY0 - 0.02, fz);
  }
  // light shafts through the windows (additive, very soft)
  const shaftMat = new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const shafts = [];
  for (const w of WIN) {
    const g = new THREE.BufferGeometry();
    const z0 = w.z - w.w / 2 + 0.15, z1 = w.z + w.w / 2 - 0.15;
    const sx = -sun.position.x / sun.position.y, sz = -sun.position.z / sun.position.y; // travel per unit of drop
    const top = WY1 - 0.1, bot = WY0 + 0.1;
    const v = [
      -HW, top, z0, -HW, top, z1, -HW + top * sx, 0.02, z1 + top * sz, -HW + top * sx, 0.02, z0 + top * sz,
      -HW, bot, z0, -HW, bot, z1, -HW + bot * sx, 0.02, z1 + bot * sz, -HW + bot * sx, 0.02, z0 + bot * sz,
    ];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0], 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const m = new THREE.Mesh(g, shaftMat); m.renderOrder = 5; scene.add(m); shafts.push(m);
  }

  /* ---------------- plants ---------------- */
  function plant(x, z, s = 1, kind = 0) {
    const g = new THREE.Group();
    const potC = kind === 1 ? C.potTerra : C.pot;
    cyl(g, 0.3 * s, 0.22 * s, 0.5 * s, 18, potC, 0, 0.25 * s, 0);
    cyl(g, 0.31 * s, 0.31 * s, 0.05 * s, 18, shade(potC, -0.12), 0, 0.5 * s, 0);
    const rnd = seeded(Math.round(x * 100 + z * 7));
    if (kind === 2) { // tall snake plant
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2, r = rnd() * 0.12 * s, hh = (0.9 + rnd() * 0.8) * s;
        const leaf = add(g, new THREE.ConeGeometry(0.07 * s, hh, 4), i % 2 ? C.leafDark : C.leaf, Math.cos(a) * r, 0.5 * s + hh / 2, Math.sin(a) * r, { rz: (rnd() - 0.5) * 0.35, rx: (rnd() - 0.5) * 0.35 });
        leaf.material = M(i % 3 ? C.leafDark : C.leaf, { flatShading: true });
      }
    } else {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rnd(), r = (0.12 + rnd() * 0.16) * s;
        add(g, new THREE.IcosahedronGeometry((0.26 + rnd() * 0.14) * s, 0), M([C.leaf, C.leafDark, C.leafLight][i % 3], { flatShading: true }),
          Math.cos(a) * r, (0.75 + rnd() * 0.45) * s, Math.sin(a) * r);
      }
    }
    g.position.set(x, 0, z);
    stat.add(g);
    return g;
  }

  /* ---------------- desks (pods facing each other), chairs, monitors ---------------- */
  const deskSpots = [];
  const ROWS = [{ z: -2.05, face: 1 }, { z: 1.35, face: -1 }]; // face = direction the sitter looks (+z = towards camera)
  const COLS = [-4.0, 0.0, 4.0];
  const screenCode = canvasTex(256, 256, (c, w, h) => {
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    const rnd = seeded(5);
    for (let y = 8; y < h; y += 14) {
      let x = 10 + Math.floor(rnd() * 3) * 14;
      const n = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < n && x < w - 20; k++) {
        const len = 18 + rnd() * 60;
        c.fillStyle = ['#6b7280', '#9ca3af', '#d1d5db', '#4b5563'][Math.floor(rnd() * 4)];
        rr(c, x, y, Math.min(len, w - 10 - x), 7, 3); c.fill();
        x += len + 8;
      }
    }
  }, { srgb: true });
  screenCode.wrapS = screenCode.wrapT = THREE.RepeatWrapping;
  ROWS.forEach((row, ri) => COLS.forEach((x, ci) => {
    const g = new THREE.Group();
    // desk (local: sitter at -z looking +z; rotated for the front row)
    rbox(g, 2.1, 0.09, 1.05, 0.03, C.woodLight, 0, 0.78, 0);
    rbox(g, 2.0, 0.42, 0.05, 0.02, C.white, 0, 0.52, 0.45, { cast: true });       // modesty panel
    for (const sx of [-1, 1]) rbox(g, 0.06, 0.74, 0.9, 0.02, C.metal, sx * 0.96, 0.37, 0);
    // keyboard + mouse + papers + mug
    rbox(g, 0.62, 0.025, 0.2, 0.01, '#e7e5e0', 0, 0.84, -0.22, { cast: false });
    rbox(g, 0.08, 0.025, 0.12, 0.02, '#e7e5e0', 0.48, 0.84, -0.2, { cast: false });
    box(g, 0.36, 0.012, 0.27, '#fffdf6', -0.72, 0.832, -0.05, { cast: false, ry: 0.2 });
    // monitor stand
    cyl(g, 0.14, 0.16, 0.02, 16, C.metal, 0, 0.835, 0.24);
    box(g, 0.05, 0.3, 0.04, C.metal, 0, 0.99, 0.26);
    // chair
    const ch = new THREE.Group();
    cyl(ch, 0.26, 0.26, 0.03, 5, C.metal, 0, 0.06, 0, { cast: false });
    cyl(ch, 0.035, 0.035, 0.36, 8, C.metal, 0, 0.26, 0);
    rbox(ch, 0.56, 0.1, 0.52, 0.04, C.fabric, 0, 0.47, 0);
    rbox(ch, 0.54, 0.6, 0.09, 0.04, C.fabric, 0, 0.84, -0.27, { rx: -0.08 });
    ch.position.set(0, 0, -0.92);
    g.add(ch);
    const rotY = row.face === 1 ? 0 : Math.PI;
    g.position.set(x, 0, row.z); g.rotation.y = rotY;
    stat.add(g);
    // seat position in world space
    const seat = new THREE.Vector3(0, 0, -0.9).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY).add(new THREE.Vector3(x, 0, row.z));
    deskSpots.push({ x, z: row.z, rotY, seat, row: ri });
  }));
  // order: back row first (faces visible), then front row
  // potted desk plants on two desks
  plant(-4.85, -2.25, 0.32); plant(4.85, 1.55, 0.32, 1);

  /* ---------------- bookcase (skills shelves) — back-left ---------------- */
  const SHELF = { x0: -7.25, x1: -3.25, z: -HD + 0.24, rows: 6, y0: 0.16, rowH: 0.44 };
  const shelfW = SHELF.x1 - SHELF.x0, shelfCx = (SHELF.x0 + SHELF.x1) / 2;
  const shelfTop = SHELF.y0 + SHELF.rows * SHELF.rowH;
  rbox(stat, shelfW + 0.12, 0.12, 0.5, 0.03, C.woodDark, shelfCx, 0.06, SHELF.z);
  for (const sx of [-1, 1]) rbox(stat, 0.08, shelfTop + 0.06, 0.5, 0.02, C.wood, shelfCx + sx * (shelfW / 2 + 0.02), (shelfTop + 0.06) / 2, SHELF.z);
  box(stat, shelfW, shelfTop, 0.04, shade(C.wood, -0.25), shelfCx, shelfTop / 2, SHELF.z - 0.23, { cast: false });
  for (let r = 0; r <= SHELF.rows; r++) rbox(stat, shelfW + 0.04, 0.05, 0.48, 0.015, C.wood, shelfCx, SHELF.y0 + r * SHELF.rowH, SHELF.z);
  // the shelf's own signage
  const shelfSign = add(scene, new THREE.PlaneGeometry(1.6, 0.34), new THREE.MeshStandardMaterial({
    map: canvasTex(512, 108, (c, w, h) => {
      c.fillStyle = '#2b2118'; rr(c, 0, 0, w, h, 26); c.fill();
      c.fillStyle = '#f5b301'; c.font = '800 54px Heebo, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.direction = 'rtl';
      c.fillText('מדף הסקילים', w / 2, h / 2 + 3);
    }), roughness: 0.6, transparent: true,
  }), shelfCx, shelfTop + 0.36, -HD + 0.02, { cast: false });
  shelfSign.userData.keep = true;
  const shelfHit = new THREE.Mesh(new THREE.BoxGeometry(shelfW + 0.2, shelfTop + 0.7, 0.6), new THREE.MeshBasicMaterial({ visible: false }));
  shelfHit.position.set(shelfCx, (shelfTop + 0.7) / 2, SHELF.z); shelfHit.userData.pick = 'shelf';
  scene.add(shelfHit);

  /* ---------------- kanban board — centre of the back wall ---------------- */
  const BOARD = { cx: -0.3, cy: 2.18, w: 4.9, h: 2.62, z: -HD + 0.07 };
  rbox(stat, BOARD.w + 0.22, BOARD.h + 0.22, 0.08, 0.04, C.woodDark, BOARD.cx, BOARD.cy, BOARD.z);
  rbox(stat, BOARD.w + 0.1, 0.07, 0.16, 0.02, C.woodDark, BOARD.cx, BOARD.cy - BOARD.h / 2 - 0.13, BOARD.z + 0.07); // marker tray
  for (const [dx, col] of [[-0.9, '#ef4444'], [-0.7, '#2563eb'], [-0.5, '#16a34a']]) {
    add(stat, new THREE.CylinderGeometry(0.025, 0.025, 0.16, 8), col, BOARD.cx + dx, BOARD.cy - BOARD.h / 2 - 0.08, BOARD.z + 0.09, { rz: Math.PI / 2 });
  }
  const BW = mobile ? 1024 : 1536, BH = Math.round(BW * BOARD.h / BOARD.w);
  const boardCanvas = document.createElement('canvas'); boardCanvas.width = BW; boardCanvas.height = BH;
  const boardTex = new THREE.CanvasTexture(boardCanvas); boardTex.colorSpace = THREE.SRGBColorSpace; boardTex.anisotropy = 8;
  const boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(BOARD.w, BOARD.h),
    new THREE.MeshStandardMaterial({ map: boardTex, emissiveMap: boardTex, emissive: 0xffffff, emissiveIntensity: 0.32, roughness: 0.9 }));
  boardMesh.position.set(BOARD.cx, BOARD.cy, BOARD.z + 0.045); boardMesh.receiveShadow = true;
  boardMesh.userData.pick = 'board';
  scene.add(boardMesh);

  /* ---------------- coffee corner — back-right ---------------- */
  const CO = { x0: 2.75, x1: 7.3, z: -HD + 0.36 };
  const coW = CO.x1 - CO.x0, coCx = (CO.x0 + CO.x1) / 2;
  rbox(stat, coW, 0.88, 0.72, 0.03, C.white, coCx, 0.44, CO.z);
  rbox(stat, coW + 0.06, 0.07, 0.78, 0.02, C.woodDark, coCx, 0.915, CO.z + 0.02);
  for (let i = 0; i < 4; i++) box(stat, 0.02, 0.7, 0.01, '#d9d4ca', CO.x0 + (i + 1) * coW / 5, 0.44, CO.z + 0.365, { cast: false });
  // espresso machine
  const mX = coCx + 1.15;
  rbox(stat, 0.62, 0.62, 0.45, 0.06, '#c0392b', mX, 1.26, CO.z - 0.08);
  rbox(stat, 0.66, 0.08, 0.5, 0.03, '#e9e6e1', mX, 1.6, CO.z - 0.08);
  box(stat, 0.36, 0.06, 0.1, '#2b2b2b', mX, 1.08, CO.z + 0.16);
  cyl(stat, 0.05, 0.05, 0.08, 10, '#f7f4ee', mX - 0.06, 1.0, CO.z + 0.17);
  const machineLed = add(scene, new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: 0x8dfc9e, toneMapped: false }), mX + 0.2, 1.42, CO.z + 0.15, { cast: false });
  machineLed.userData.keep = true;
  // mugs + a jar + a small plant
  [[-1.6, '#7aa2f7'], [-1.38, '#ef87a8'], [-1.16, '#f7b84d']].forEach(([dx, col]) => {
    cyl(stat, 0.07, 0.06, 0.14, 12, col, coCx + dx, 1.02, CO.z + 0.1);
  });
  cyl(stat, 0.14, 0.14, 0.32, 14, '#e8ddc8', coCx - 0.5, 1.11, CO.z - 0.12);
  cyl(stat, 0.15, 0.15, 0.05, 14, C.woodDark, coCx - 0.5, 1.29, CO.z - 0.12);
  plant(coCx + 0.2, CO.z - 0.08, 0.36, 1).position.y = 0.95;
  // open shelf + TV above the counter
  rbox(stat, 2.1, 0.06, 0.32, 0.02, C.wood, coCx - 1.05, 2.0, -HD + 0.16);
  [['#f7b84d', 0.18], ['#7aa2f7', 0.26], ['#57c98a', 0.2], ['#ef87a8', 0.24]].forEach(([col, hh], i) => {
    rbox(stat, 0.12, hh, 0.22, 0.02, col, coCx - 1.8 + i * 0.15, 2.03 + hh / 2, -HD + 0.16);
  });
  plant(coCx - 0.4, -HD + 0.17, 0.26, 0).position.y = 2.03;
  const coffeeSpot = new THREE.Vector3(coCx + 0.6, 0, CO.z + 0.9);

  // TV with the live bar chart (kept from v1, restyled)
  const scrCanvas = document.createElement('canvas'); scrCanvas.width = 512; scrCanvas.height = 288;
  const scrCtx = scrCanvas.getContext('2d');
  const scrTex = new THREE.CanvasTexture(scrCanvas); scrTex.colorSpace = THREE.SRGBColorSpace;
  rbox(stat, 2.02, 1.18, 0.07, 0.04, '#1b1c20', coCx + 0.95, 2.62, -HD + 0.05);
  const wallScr = add(scene, new THREE.PlaneGeometry(1.9, 1.07), new THREE.MeshBasicMaterial({ map: scrTex, toneMapped: false }), coCx + 0.95, 2.62, -HD + 0.09, { cast: false, recv: false });
  wallScr.userData.keep = true;
  function drawWallScreen(counts, total) {
    const c = scrCtx, W = 512, H = 288;
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#1d1a14'); g.addColorStop(1, '#0f0d0a');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.direction = 'rtl'; c.textAlign = 'right';
    c.fillStyle = '#f5b301'; c.font = '800 26px Heebo, sans-serif'; c.fillText('אירועים היום', W - 26, 44);
    c.fillStyle = '#f5efe4'; c.font = '900 46px Heebo, sans-serif'; c.fillText(String(total), W - 26, 96);
    const max = Math.max(4, ...counts.map(x => x.v));
    const n = Math.max(1, counts.length), bw = Math.min(46, (W - 70) / n - 10), gap = n > 1 ? (W - 60 - n * bw) / (n - 1) : 0;
    counts.forEach((a, i) => {
      const h = 8 + (a.v / max) * 130, x = W - 30 - bw - i * (bw + gap), y = H - 30 - h;
      const gg = c.createLinearGradient(0, y, 0, y + h); gg.addColorStop(0, shade(a.color, 0.25)); gg.addColorStop(1, a.color);
      c.fillStyle = gg; rr(c, x, y, bw, h, 8); c.fill();
    });
    scrTex.needsUpdate = true;
  }
  drawWallScreen([], 0);

  /* ---------------- wall clock (between the windows) ---------------- */
  const clockG = new THREE.Group();
  add(clockG, new THREE.CylinderGeometry(0.46, 0.46, 0.07, 40).rotateX(Math.PI / 2), C.woodDark, 0, 0, 0, { cast: false });
  add(clockG, new THREE.CylinderGeometry(0.4, 0.4, 0.075, 40).rotateX(Math.PI / 2), '#fbf6ea', 0, 0, 0.005, { cast: false });
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    add(clockG, new THREE.BoxGeometry(0.025, i % 3 ? 0.05 : 0.09, 0.01), '#3a332a', Math.sin(a) * 0.33, Math.cos(a) * 0.33, 0.045, { cast: false, rz: -a });
  }
  const hourHand = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.012).translate(0, 0.08, 0), M('#2b2620'));
  const minHand = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.3, 0.012).translate(0, 0.12, 0), M('#2b2620'));
  const secHand = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.32, 0.01).translate(0, 0.1, 0), new THREE.MeshBasicMaterial({ color: 0xe0533d }));
  hourHand.position.z = 0.05; minHand.position.z = 0.058; secHand.position.z = 0.066;
  clockG.add(hourHand, minHand, secHand);
  clockG.rotation.y = Math.PI / 2;
  clockG.position.set(-HW + 0.04, 2.25, (WIN[0].z + WIN[0].w / 2 + WIN[1].z - WIN[1].w / 2) / 2);
  scene.add(clockG);
  clockG.traverse(o => { o.userData.keep = true; });
  function tickClock(t) {
    const d = new Date();
    const s = d.getSeconds() + d.getMilliseconds() / 1000;
    hourHand.rotation.z = -((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2;
    minHand.rotation.z = -(d.getMinutes() + s / 60) / 60 * Math.PI * 2;
    secHand.rotation.z = -(capture ? t : s) / 60 * Math.PI * 2;
  }

  /* ---------------- lounge: sofa, floor lamp, rug, big plants ---------------- */
  const MEET = new THREE.Vector3(0.6, 0, 4.05);
  const rug = add(scene, new THREE.CircleGeometry(1.75, 48), new THREE.MeshStandardMaterial({ map: rugTex, roughness: 1 }), MEET.x, 0.012, MEET.z, { cast: false, rx: -Math.PI / 2 });
  rug.userData.keep = true;
  {
    const s = new THREE.Group();
    rbox(s, 0.9, 0.36, 2.4, 0.1, C.fabricLight, 0, 0.3, 0);
    rbox(s, 0.28, 0.62, 2.4, 0.1, C.fabricLight, -0.33, 0.62, 0);
    for (const dz of [-1, 1]) rbox(s, 0.9, 0.5, 0.22, 0.08, C.fabricLight, 0, 0.42, dz * 1.12);
    for (const dz of [-0.55, 0.55]) rbox(s, 0.6, 0.14, 1.0, 0.06, '#6c84a0', 0.08, 0.53, dz);
    rbox(s, 0.16, 0.36, 0.42, 0.08, '#f5b301', -0.12, 0.72, -0.6, { rz: -0.2 });
    rbox(s, 0.16, 0.34, 0.4, 0.08, C.rugCream, -0.12, 0.72, 0.62, { rz: -0.15 });
    for (const dz of [-1.1, 1.1]) for (const dx of [-0.35, 0.35]) cyl(s, 0.03, 0.03, 0.12, 6, C.woodDark, dx, 0.06, dz);
    s.position.set(-HW + 0.62, 0, 3.95);
    stat.add(s);
    // low side table with a laptop and a book
    cyl(stat, 0.42, 0.42, 0.05, 28, C.woodLight, -HW + 2.0, 0.46, 3.3);
    cyl(stat, 0.05, 0.08, 0.44, 10, C.metal, -HW + 2.0, 0.22, 3.3);
    cyl(stat, 0.24, 0.26, 0.02, 18, C.metal, -HW + 2.0, 0.01, 3.3);
    { // laptop: base + hinged screen, turned towards the sofa
      const lap = new THREE.Group();
      rbox(lap, 0.44, 0.022, 0.3, 0.01, '#c9ccd3', 0, 0.01, 0);
      const scr = new THREE.Group(); scr.position.set(0, 0.02, -0.15); scr.rotation.x = -0.28; lap.add(scr);
      rbox(scr, 0.44, 0.29, 0.018, 0.01, '#c9ccd3', 0, 0.145, 0);
      box(scr, 0.4, 0.25, 0.004, '#2b3a55', 0, 0.145, 0.011, { cast: false });
      lap.position.set(-HW + 2.0, 0.485, 3.25); lap.rotation.y = -1.1;
      stat.add(lap);
    }
    rbox(stat, 0.2, 0.04, 0.28, 0.01, '#3f7d78', -HW + 2.18, 0.505, 3.55, { ry: -0.3 });
    // bean bag near the plant (right side of the lounge)
    const bean = add(stat, new THREE.SphereGeometry(0.42, 20, 14), '#f2a65a', HW - 1.9, 0.3, 4.6);
    bean.scale.set(1.15, 0.68, 1.1);
    // floor lamp
    cyl(stat, 0.2, 0.2, 0.03, 18, C.metal, -HW + 0.55, 0.015, 5.0);
    cyl(stat, 0.02, 0.02, 1.7, 8, C.metal, -HW + 0.55, 0.86, 5.0);
  }
  const lampShade = add(scene, new THREE.CylinderGeometry(0.16, 0.26, 0.3, 20, 1, true), new THREE.MeshStandardMaterial({ color: '#fff1d0', emissive: '#ffd58a', emissiveIntensity: 1.2, side: THREE.DoubleSide }), -HW + 0.55, 1.78, 5.0, { cast: false });
  lampShade.userData.keep = true;
  const lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffcf80, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  lampGlow.scale.set(2.2, 2.2, 1); lampGlow.position.set(-HW + 0.55, 1.7, 5.0); scene.add(lampGlow);
  plant(-HW + 0.6, -0.45, 0.85, 0);
  plant(HW - 0.6, HD - 0.65, 1.2, 1);
  plant(HW - 0.55, -0.6, 0.8, 2);

  /* ---------------- per-desk monitor (screen glows in the occupant's colour) ---------------- */
  const UP = new THREE.Vector3(0, 1, 0);
  function deskLocal(spot, x, y, z) { return new THREE.Vector3(x, y, z).applyAxisAngle(UP, spot.rotY).add(new THREE.Vector3(spot.x, 0, spot.z)); }
  deskSpots.forEach(spot => {
    const g = new THREE.Group();
    g.position.copy(deskLocal(spot, 0, 0, 0.26)); g.rotation.y = spot.rotY;
    const body = new THREE.Mesh(roundedBoxGeo(1.0, 0.62, 0.06, 0.03), M('#22252c', { roughness: 0.5 }));
    body.position.y = 1.36; body.castShadow = true; g.add(body);
    const tex = screenCode.clone(); tex.repeat.set(1, 0.55);
    const screenMat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.35 });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.46), screenMat);
    scr.position.set(0, 1.335, -0.032); scr.rotation.y = Math.PI; g.add(scr);
    const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.07), barMat);
    bar.position.set(0, 1.6, -0.033); bar.rotation.y = Math.PI; g.add(bar);
    const backMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), backMat);
    back.position.set(0, 1.38, 0.032); g.add(back);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(1.9, 1.3, 1); glow.position.set(0, 1.34, spot.rotY === 0 ? -0.25 : -0.25); g.add(glow);
    scene.add(g);
    spot.monitor = { g, tex, screenMat, barMat, backMat, glow, scrolling: 0 };
  });
  function setMonitor(spot, ch) {
    const m = spot.monitor;
    if (!ch) { m.screenMat.color.set(C.screenOff); m.screenMat.emissiveIntensity = 0; m.barMat.color.set('#111'); m.backMat.opacity = 0; m.glow.material.opacity = 0; m.mode = 'off'; return; }
    const col = new THREE.Color(ch.meta.color);
    m.color = col;
    m.barMat.color.copy(col);
    m.backMat.map = ch.emblemTex; m.backMat.opacity = 1; m.backMat.needsUpdate = true;
    m.glow.material.color.copy(col);
    m.owner = ch;
    applyMonitorMode(spot);
  }
  function applyMonitorMode(spot) {
    const m = spot.monitor, ch = m.owner; if (!ch) return;
    const st = ch.status;
    const tint = m.color.clone().lerp(new THREE.Color(0xffffff), 0.55);
    if (st === 'offline') { m.screenMat.color.set(C.screenOff); m.screenMat.emissive.set(0x000000); m.screenMat.emissiveIntensity = 0; m.barMat.color.set('#1b1d22'); m.backMat.opacity = 0.35; m.glow.material.opacity = 0; }
    else {
      m.screenMat.color.copy(tint); m.screenMat.emissive.copy(tint);
      m.screenMat.emissiveIntensity = st === 'working' ? 0.95 : 0.4;
      m.barMat.color.copy(m.color); m.backMat.opacity = 1;
      m.glow.material.opacity = st === 'working' ? 0.38 : 0.14;
    }
  }

  /* ---------------- shared sprites: name tags, status bubbles, sparkles ---------------- */
  const STATUS_LABEL = { working: 'עובד/ת', idle: 'הפסקת קפה', blocked: 'ממתין/ה', offline: 'לא מחובר/ת' };
  const STATUS_DOT = { working: '#4ade80', idle: '#f5b301', blocked: '#f97316', offline: '#8b8577' };
  function emblemTexture(meta) {
    return canvasTex(128, 128, (c) => drawEmblem(c, 4, 4, 120, meta));
  }
  function drawTag(ch) {
    const cv = ch.tagCanvas, c = cv.getContext('2d'), W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.font = '800 46px Heebo, sans-serif';
    const name = ellipsize(c, ch.meta.name, 250);
    const nameW = c.measureText(name).width;
    const sub = ch.alert ? '⚠ ' + ch.alert.label
      : ch.meetingLabel ? '👥 ' + ch.meetingLabel
      : ch.activity && ch.status === 'working' ? '▸ ' + ch.activity
      : (STATUS_LABEL[ch.status] || '');
    c.font = '600 28px Heebo, sans-serif';
    const subText = ellipsize(c, sub, 300);
    const subW = ch.showStatus ? c.measureText(subText).width + 26 : 0;
    const inner = Math.max(nameW, subW);
    const w = Math.min(W - 8, inner + 128), x = (W - w) / 2;
    c.fillStyle = ch.alert ? 'rgba(58,14,14,.94)' : ch.status === 'offline' ? 'rgba(30,27,22,.78)' : 'rgba(22,17,10,.9)';
    rr(c, x, 10, w, H - 20, (H - 20) / 2); c.fill();
    c.strokeStyle = ch.alert ? '#ef4444' : ch.meta.color; c.globalAlpha = ch.status === 'offline' && !ch.alert ? 0.45 : 1; c.lineWidth = ch.alert ? 6 : 4; c.stroke(); c.globalAlpha = 1;
    drawEmblem(c, x + w - 100, 18, H - 36, ch.meta);
    c.direction = 'rtl'; c.textAlign = 'right'; c.textBaseline = 'middle';
    c.fillStyle = ch.status === 'offline' ? '#b9b2a4' : '#f7f1e6';
    c.font = '800 46px Heebo, sans-serif';
    const tx = x + w - 112;
    c.fillText(name, tx, ch.showStatus ? H / 2 - 13 : H / 2 + 2);
    if (ch.showStatus) {
      c.font = (ch.alert ? '800' : '600') + ' 28px Heebo, sans-serif'; c.fillStyle = ch.alert ? '#fecaca' : '#cfc6b4';
      c.fillText(subText, tx - 22, H / 2 + 26);
      c.fillStyle = ch.alert ? '#ef4444' : STATUS_DOT[ch.status]; c.beginPath(); c.arc(tx - 8, H / 2 + 25, 7, 0, 7); c.fill();
    }
    ch.tagTex.needsUpdate = true;
  }
  function glyphTex(text, color = '#1a1407', bg = '#ffffff') {
    return canvasTex(128, 128, (c, w) => {
      c.fillStyle = bg; c.beginPath(); c.arc(w / 2, w / 2 - 6, 50, 0, 7); c.fill();
      c.beginPath(); c.moveTo(w / 2 - 14, w / 2 + 36); c.lineTo(w / 2 - 26, w - 4); c.lineTo(w / 2 + 6, w / 2 + 40); c.fill();
      c.fillStyle = color; c.font = '900 60px Heebo, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text, w / 2, w / 2 - 2);
    });
  }
  const zzzTex = glyphTex('z', '#5b6b8c', '#eef2ff');
  const askTex = glyphTex('?', '#9a3412', '#fff1e6');
  // stuck / silent alert: a red warning sign that floats beside the agent
  const warnTex = canvasTex(128, 128, (c, w) => {
    c.fillStyle = '#ef4444'; c.strokeStyle = '#fff'; c.lineWidth = 7; c.lineJoin = 'round';
    c.beginPath(); c.moveTo(w / 2, 12); c.lineTo(w - 10, w - 18); c.lineTo(10, w - 18); c.closePath(); c.fill(); c.stroke();
    c.fillStyle = '#fff'; c.font = '900 64px Heebo, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('!', w / 2, w / 2 + 14);
  });
  const steamTex = canvasTex(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, w);
  });
  const sparkTex = canvasTex(64, 64, (c, w) => {
    c.fillStyle = '#fff'; c.beginPath();
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2, r = i % 2 ? 9 : 30; c.lineTo(w / 2 + Math.cos(a) * r, w / 2 + Math.sin(a) * r); }
    c.fill();
  });

  /* ---------------- characters ---------------- */
  const GREY = new THREE.Color('#9a958c');
  function makeCharacter(meta) {
    const g = new THREE.Group();
    const own = [];
    const mat = (color, o = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...o }); m.userData.base = new THREE.Color(color); own.push(m); return m; };
    const shirt = mat(meta.color), skin = mat(meta.skin || '#f2c9a4'), hairM = mat(meta.hair || '#2c2320'), pants = mat('#3f4656'), shoe = mat('#26272b');
    const mesh = (geo, m, x, y, z, parent = g) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); o.castShadow = true; parent.add(o); return o; };
    // hips + legs (pivots so the character can sit)
    const legs = [];
    for (const s of [-1, 1]) {
      const p = new THREE.Group(); p.position.set(s * 0.115, 0.44, 0); g.add(p);
      mesh(new THREE.CapsuleGeometry(0.088, 0.22, 4, 10), pants, 0, -0.19, 0, p);
      const sh = mesh(roundedBoxGeo(0.15, 0.09, 0.24, 0.04), shoe, 0, -0.39, 0.04, p);
      sh.castShadow = false;
      legs.push(p);
    }
    const torso = new THREE.Group(); torso.position.y = 0.46; g.add(torso);
    mesh(new THREE.CapsuleGeometry(0.255, 0.3, 6, 16), shirt, 0, 0.27, 0, torso);
    mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.08, 16), mat(shade(meta.color, -0.18)), 0, 0.02, 0, torso);
    // chest emblem
    const emblemTex = emblemTexture(meta);
    const chest = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.17), new THREE.MeshBasicMaterial({ map: emblemTex, transparent: true, toneMapped: false }));
    chest.position.set(0.09, 0.36, 0.252); torso.add(chest);
    // head group
    const head = new THREE.Group(); head.position.y = 0.88; torso.add(head);
    mesh(new THREE.SphereGeometry(0.36, 28, 20), skin, 0, 0.0, 0, head);
    const hairCap = mesh(new THREE.SphereGeometry(0.378, 28, 16, 0, Math.PI * 2, 0, Math.PI * 0.42), hairM, 0, 0.06, -0.035, head);
    hairCap.rotation.x = -0.18;
    if (meta.longHair) { const b = mesh(new THREE.SphereGeometry(0.3, 18, 14), hairM, 0, -0.12, -0.17, head); b.scale.set(1.05, 1.3, 0.72); }
    else { mesh(new THREE.SphereGeometry(0.16, 12, 10), hairM, 0.16, 0.2, 0.18, head).scale.set(1.2, 0.55, 0.8); }
    const eyes = [];
    for (const s of [-1, 1]) {
      const e = mesh(new THREE.CapsuleGeometry(0.032, 0.03, 4, 8), mat('#241d16', { roughness: 0.3 }), s * 0.13, 0.02, 0.335, head);
      e.castShadow = false; eyes.push(e);
      const blush = mesh(new THREE.CircleGeometry(0.055, 14), mat('#f29a8a', { transparent: true, opacity: 0.55 }), s * 0.21, -0.07, 0.31, head);
      blush.rotation.y = s * 0.45; blush.castShadow = false;
    }
    const smile = mesh(new THREE.TorusGeometry(0.06, 0.013, 6, 14, Math.PI), mat('#8a5a44'), 0, -0.1, 0.335, head);
    smile.rotation.z = Math.PI; smile.castShadow = false;
    // arms
    const arms = [];
    for (const s of [-1, 1]) {
      const p = new THREE.Group(); p.position.set(s * 0.31, 0.47, 0); torso.add(p);
      mesh(new THREE.CapsuleGeometry(0.075, 0.27, 4, 10), shirt, 0, -0.17, 0, p);
      mesh(new THREE.SphereGeometry(0.078, 12, 10), skin, 0, -0.36, 0, p);
      p.rotation.z = s * 0.18;
      arms.push(p);
    }
    // coffee mug (visible on a coffee break)
    const mug = new THREE.Group();
    mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.14, 12), mat('#fbf7ef'), 0, 0, 0, mug);
    mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.03, 12), mat(meta.color), 0, 0.02, 0, mug);
    mug.position.set(0, -0.44, 0.06); mug.visible = false; arms[1].add(mug);
    // name tag (constant on-screen size, redrawn when status changes)
    const tagCanvas = document.createElement('canvas'); tagCanvas.width = 512; tagCanvas.height = 132;
    const tagTex = new THREE.CanvasTexture(tagCanvas); tagTex.colorSpace = THREE.SRGBColorSpace; tagTex.anisotropy = 4;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, transparent: true, depthTest: false, depthWrite: false }));
    tag.center.set(0.5, 0); tag.position.y = 2.02; tag.renderOrder = 20; g.add(tag);
    // status bubble (z / ?)
    const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: zzzTex, transparent: true, depthWrite: false }));
    bubble.scale.set(0.34, 0.34, 1); bubble.position.set(0.38, 1.7, 0); bubble.visible = false; bubble.renderOrder = 15; g.add(bubble);
    // alert: warning sign + pulsing red floor ring (hidden until setAlert)
    const warn = new THREE.Sprite(new THREE.SpriteMaterial({ map: warnTex, transparent: true, depthTest: false, depthWrite: false }));
    warn.scale.set(0.46, 0.46, 1); warn.position.set(-0.5, 1.62, 0); warn.visible = false; warn.renderOrder = 18; g.add(warn);
    const alarm = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.05, 8, 48).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
    alarm.position.y = 0.04; alarm.visible = false; g.add(alarm);
    // focus ring + hit cylinder
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.035, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: meta.color, transparent: true, opacity: 0, toneMapped: false }));
    ring.position.y = 0.03; g.add(ring);
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 2.1, 8), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 1.0; hit.userData.agentId = meta.id; g.add(hit);
    return { g, meta, own, legs, torso, head, arms, eyes, mug, tag, tagCanvas, tagTex, bubble, warn, alarm, ring, hit, emblemTex, blinkT: Math.random() * 4, alert: null };
  }

  /* ---------------- handoff arcs: a glowing arc + a travelling dot from one desk to another ---------------- */
  const arcs = [];
  function handoffArc(from, to) {
    const a = from.g.position.clone().setY(1.25), b = to.g.position.clone().setY(1.25);
    const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += 1.4 + a.distanceTo(b) * 0.18;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const col = new THREE.Color(from.meta.color);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.035, 6, false),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
    tube.renderOrder = 12; scene.add(tube);
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: col, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    dot.scale.set(0.55, 0.55, 1); dot.renderOrder = 13; scene.add(dot);
    arcs.push({ tube, dot, curve, t0: clockT, life: 3.2 });
  }
  function updateArcs() {
    for (let i = arcs.length - 1; i >= 0; i--) {
      const A = arcs[i], k = (clockT - A.t0) / A.life;
      if (k >= 1) { scene.remove(A.tube); scene.remove(A.dot); A.tube.geometry.dispose(); A.tube.material.dispose(); A.dot.material.dispose(); arcs.splice(i, 1); continue; }
      A.tube.material.opacity = Math.min(1, k * 6) * (k > 0.75 ? (1 - k) / 0.25 : 1) * 0.85;
      const p = Math.min(1, k / 0.7);
      A.dot.position.copy(A.curve.getPoint(p * p * (3 - 2 * p)));
      A.dot.material.opacity = k > 0.85 ? (1 - k) / 0.15 : 1;
    }
  }

  const agents = new Map();
  const usedSpots = new Set();
  let standingCount = 0;
  const SEAT_Y = 0.1;
  function addCharacter(meta) {
    if (agents.has(meta.id)) return agents.get(meta.id);
    const ch = makeCharacter(meta);
    const shared = Number.isInteger(meta.seatIndex) && meta.seatIndex < deskSpots.length;
    const freeIdx = shared ? meta.seatIndex : deskSpots.findIndex((_, i) => !usedSpots.has(i));
    if (freeIdx >= 0) {
      usedSpots.add(freeIdx);
      ch.spot = deskSpots[freeIdx];
      ch.seat = ch.spot.seat.clone(); ch.seat.y = SEAT_Y;
      ch.homeRot = ch.spot.rotY; ch.standing = false;
    } else { // extra agents stand around the rug
      const a = standingCount * 0.9 + 3.6;
      ch.seat = new THREE.Vector3(MEET.x + Math.cos(a) * 2.2, 0, MEET.z + Math.sin(a) * 1.3);
      ch.homeRot = Math.atan2(MEET.x - ch.seat.x, MEET.z - ch.seat.z); ch.standing = true; standingCount++;
    }
    ch.g.position.copy(ch.seat); ch.g.rotation.y = ch.homeRot;
    ch.status = 'working'; ch.action = ch.standing ? 'stand' : 'sit';
    ch.route = []; ch.stateT = Math.random() * 10; ch.showStatus = false; ch.focused = false; ch.desat = 0;
    drawTag(ch);
    scene.add(ch.g);
    agents.set(meta.id, ch);
    refreshMonitors();
    return ch;
  }
  function refreshMonitors() {
    for (const spot of deskSpots) {
      let owner = null;
      for (const ch of agents.values()) if (ch.spot === spot && ch.g.visible) owner = ch;
      if (spot.monitor.owner !== owner || !owner) setMonitor(spot, owner);
    }
  }
  agentsMeta.forEach(meta => addCharacter(meta));
  // walking: go via the aisles between desk columns so nobody walks through furniture
  const AISLES = [-6.1, -2.0, 2.0, 6.1];
  function routeTo(from, to) {
    const ax = AISLES.reduce((b, a) => Math.abs(a - from.x) + Math.abs(a - to.x) * 0.35 < Math.abs(b - from.x) + Math.abs(b - to.x) * 0.35 ? a : b, AISLES[0]);
    const pts = [new THREE.Vector3(ax, 0, from.z), new THREE.Vector3(ax, 0, to.z), new THREE.Vector3(to.x, 0, to.z)];
    return pts.filter((p, i) => i === pts.length - 1 || p.distanceTo(i ? pts[i - 1] : from) > 0.05);
  }
  function walk(ch, target, then, onArrive) {
    ch.route = routeTo(ch.g.position, target);
    ch.action = 'walk'; ch.after = then; ch.onArrive = onArrive || null;
    ch.mug.visible = false;
  }
  function applyDesat(ch, k) {
    if (Math.abs(ch.desat - k) < 0.002) return;
    ch.desat = k;
    for (const m of ch.own) { if (m.userData.base) m.color.copy(m.userData.base).lerp(GREY, k * 0.75); }
  }
  function setStatus(ch, status) {
    if (!['working', 'idle', 'blocked', 'offline'].includes(status)) status = 'working';
    if (ch.status === status) return;
    ch.status = status; ch.stateT = 0;
    drawTag(ch);
    if (ch.spot && ch.spot.monitor.owner === ch) applyMonitorMode(ch.spot);
  }

  /* ---------------- ambient particles: dust in the window light, coffee steam, sparkles ---------------- */
  let dust = null;
  if (!reduced) {
    const N = mobile ? 70 : 140, pos = new Float32Array(N * 3), seeds = new Float32Array(N);
    const rnd = seeded(42);
    for (let i = 0; i < N; i++) { pos[i * 3] = -HW + 0.3 + rnd() * 4.6; pos[i * 3 + 1] = 0.3 + rnd() * 2.8; pos[i * 3 + 2] = -4.2 + rnd() * 7.5; seeds[i] = rnd() * 100; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dust = new THREE.Points(g, new THREE.PointsMaterial({ map: glowTex, size: 0.09, transparent: true, opacity: 0.7, color: 0xfff1cf, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
    dust.userData.seeds = seeds; dust.userData.base = pos.slice();
    scene.add(dust);
  }
  const steam = [];
  for (let i = 0; i < 4; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: steamTex, transparent: true, opacity: 0, depthWrite: false }));
    s.position.set(mX - 0.06, 1.1, CO.z + 0.17); s.userData.phase = i / 4; scene.add(s); steam.push(s);
  }
  const sparks = [];
  for (let i = 0; i < 24; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: sparkTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    s.scale.setScalar(0.18); s.visible = false; s.userData.life = 0; scene.add(s); sparks.push(s);
  }
  function burst(pos, color, n = 10) {
    for (let i = 0, k = 0; i < sparks.length && k < n; i++) {
      const s = sparks[i]; if (s.userData.life > 0) continue;
      s.visible = true; s.userData.life = 1; s.position.copy(pos);
      const a = Math.random() * Math.PI * 2, sp = 0.6 + Math.random() * 0.9;
      s.userData.v = new THREE.Vector3(Math.cos(a) * sp, 1.4 + Math.random() * 1.2, Math.sin(a) * sp);
      s.material.color.set(color); k++;
    }
  }
  // tiny "work" pips that float up from a busy monitor
  const pips = [];
  for (let i = 0; i < 18; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    s.scale.setScalar(0.14); s.visible = false; s.userData.life = 0; scene.add(s); pips.push(s);
  }

  /* ---------------- shelves content (rebuilt from data) ---------------- */
  let shelfContent = null;
  const ATLAS = mobile ? 512 : 1024, TILE_W = ATLAS / 5, TILE_H = Math.round(TILE_W * 0.66);
  function buildShelves(rows) {
    if (shelfContent) { shelfContent.traverse(o => { o.geometry?.dispose(); if (o.material?.map && o.material.map !== glowTex) o.material.map.dispose(); }); scene.remove(shelfContent); }
    shelfContent = new THREE.Group();
    const atlas = document.createElement('canvas'); atlas.width = ATLAS; atlas.height = ATLAS;
    const ac = atlas.getContext('2d');
    let tile = 0;
    const tileUV = (draw) => {
      const col = tile % 5, row = Math.floor(tile / 5); tile++;
      const x = col * TILE_W, y = row * TILE_H;
      ac.save(); ac.translate(x, y); draw(ac, TILE_W, TILE_H); ac.restore();
      return [x / ATLAS, 1 - (y + TILE_H) / ATLAS, (x + TILE_W) / ATLAS, 1 - y / ATLAS];
    };
    const labelGeos = [];
    const boxes = [];   // {x,y,w,h,d,color}
    const books = [];   // {x,y,w,h,color,tilt}
    const rnd = seeded(99);
    const innerW = shelfW - 0.12, rowTopPad = 0.06;
    for (let r = 0; r < SHELF.rows; r++) {
      const info = rows[r]; // top row first
      const yBase = SHELF.y0 + (SHELF.rows - 1 - r) * SHELF.rowH + 0.025;
      let x = SHELF.x1 - 0.06; // RTL: fill from the right
      const fillBooks = (until, palette) => {
        while (x - 0.06 > until) {
          const w = 0.05 + rnd() * 0.05, h = 0.22 + rnd() * 0.12;
          books.push({ x: x - w / 2, y: yBase + h / 2, w, h, color: palette[Math.floor(rnd() * palette.length)], tilt: rnd() < 0.08 ? 0.18 : 0 });
          x -= w + 0.008;
        }
      };
      if (!info) { // decor row: books, a trophy, a little plant
        fillBooks(SHELF.x0 + innerW * 0.55, ['#c9b79c', '#8d7b68', '#e0d4c0', '#6f8f86', '#b35c44']);
        cyl(shelfContent, 0.06, 0.08, 0.06, 12, '#d4a537', x - 0.25, yBase + 0.03, SHELF.z + 0.02);
        cyl(shelfContent, 0.02, 0.02, 0.12, 8, '#d4a537', x - 0.25, yBase + 0.12, SHELF.z + 0.02);
        add(shelfContent, new THREE.SphereGeometry(0.07, 12, 8), '#e8c04f', x - 0.25, yBase + 0.22, SHELF.z + 0.02);
        x -= 0.55;
        fillBooks(SHELF.x0 + 0.5, ['#c9b79c', '#8d7b68', '#e0d4c0', '#6f8f86']);
        continue;
      }
      const meta = info.meta;
      // emblem plate
      const ePlate = 0.28;
      boxes.push({ x: x - (ePlate + 0.04) / 2, y: yBase + (ePlate + 0.04) / 2, w: ePlate + 0.04, h: ePlate + 0.04, d: 0.32, color: '#2b2118' });
      const uvE = tileUV((c, w, h) => { drawEmblem(c, (w - h) / 2 + 3, 3, h - 6, meta); });
      labelGeos.push(labelPlane(x - (ePlate + 0.04) / 2, yBase + (ePlate + 0.04) / 2, SHELF.z + 0.194, ePlate * (TILE_W / TILE_H), ePlate, uvE, true));
      x -= ePlate + 0.04 + 0.07;
      const items = info.nodata ? ['אין נתונים'] : info.skills.slice();
      const maxBoxes = 5;
      let shown = items.slice(0, maxBoxes);
      if (items.length > maxBoxes) { shown = items.slice(0, maxBoxes - 1); shown.push('+' + (items.length - maxBoxes + 1)); }
      const bw = Math.min(0.62, (x - SHELF.x0 - 0.2) / Math.max(shown.length, 3) - 0.05), bh = 0.3, bd = 0.32;
      shown.forEach((label, i) => {
        const col = info.nodata ? '#8b8577' : shade(meta.color, (i % 2 ? -0.1 : 0.05));
        boxes.push({ x: x - bw / 2, y: yBase + bh / 2, w: bw, h: bh, d: bd, color: col });
        const uv = tileUV((c, w, h) => {
          c.fillStyle = '#fbf7ee'; rr(c, 6, h * 0.16, w - 12, h * 0.68, 12); c.fill();
          c.fillStyle = info.nodata ? '#6b6559' : '#1f1a12';
          c.direction = 'rtl'; c.textAlign = 'center'; c.textBaseline = 'middle';
          let fs = Math.round(h * 0.34);
          c.font = `800 ${fs}px Heebo, sans-serif`;
          while (c.measureText(label).width > w - 26 && fs > 10) { fs -= 1; c.font = `800 ${fs}px Heebo, sans-serif`; }
          c.fillText(label, w / 2, h / 2 + 2);
        });
        labelGeos.push(labelPlane(x - bw / 2, yBase + bh / 2, SHELF.z + 0.03 + bd / 2 + 0.004, bw, bw * TILE_H / TILE_W, uv, false));
        x -= bw + 0.05;
      });
      fillBooks(SHELF.x0 + 0.06, [shade(meta.color, -0.3), shade(meta.color, 0.3), '#e9e2d3', '#cbbfa9']);
    }
    function labelPlane(cx, cy, cz, w, h, uv, isEmblem) {
      const g = new THREE.PlaneGeometry(w, h);
      const a = g.attributes.uv;
      a.setXY(0, uv[0], uv[3]); a.setXY(1, uv[2], uv[3]); a.setXY(2, uv[0], uv[1]); a.setXY(3, uv[2], uv[1]);
      g.translate(cx, cy, cz);
      return g;
    }
    // boxes (instanced) + books (instanced)
    const dummy = new THREE.Object3D();
    if (boxes.length) {
      const im = new THREE.InstancedMesh(roundedBoxGeo(1, 1, 1, 0.06), new THREE.MeshStandardMaterial({ roughness: 0.6 }), boxes.length);
      boxes.forEach((b, i) => { dummy.position.set(b.x, b.y, SHELF.z + 0.03); dummy.scale.set(b.w, b.h, b.d); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, new THREE.Color(b.color)); });
      im.castShadow = true; im.receiveShadow = true; shelfContent.add(im);
    }
    if (books.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.75 }), books.length);
      books.forEach((b, i) => { dummy.position.set(b.x, b.y, SHELF.z + 0.02); dummy.scale.set(b.w, b.h, 0.3); dummy.rotation.set(0, 0, b.tilt); dummy.updateMatrix(); im.setMatrixAt(i, dummy.matrix); im.setColorAt(i, new THREE.Color(b.color)); });
      im.castShadow = true; im.receiveShadow = true; shelfContent.add(im);
    }
    if (labelGeos.length) {
      const merged = mergeGeos(labelGeos);
      const tex = new THREE.CanvasTexture(atlas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
      const lm = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.25 }));
      shelfContent.add(lm);
    }
    scene.add(shelfContent);
  }
  function mergeGeos(list) {
    const parts = list.map(g => g.index ? g.toNonIndexed() : g);
    let n = 0; for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
    let o = 0;
    for (const g of parts) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2); o += g.attributes.position.count; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return geo;
  }

  /* ---------------- kanban board drawing ---------------- */
  const COLS_HE = [['todo', 'לביצוע', '#94a3b8'], ['doing', 'בעבודה', '#f5b301'], ['done', 'הושלם', '#22c55e']];
  function drawBoard(data = {}) {
    const c = boardCanvas.getContext('2d'), W = BW, H = BH, k = W / 1536;
    const S = v => v * k;
    // whiteboard
    const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#fdfbf6'); g.addColorStop(1, '#f1ece2');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.direction = 'rtl'; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.fillStyle = '#1f1a12'; c.font = `900 ${S(58)}px Heebo, sans-serif`;
    c.fillText('לוח משימות', W - S(44), S(84));
    const tagTxt = data.demo ? 'דמו · משימות לדוגמה' : 'חי · מה שהסוכנים דיווחו';
    c.font = `700 ${S(28)}px Heebo, sans-serif`;
    const tw = c.measureText(tagTxt).width + S(36);
    c.fillStyle = data.demo ? '#fde68a' : '#bbf7d0'; rr(c, W - S(44) - S(330) - tw, S(44), tw, S(50), S(25)); c.fill();
    c.fillStyle = data.demo ? '#78350f' : '#14532d'; c.fillText(tagTxt, W - S(44) - S(330) - S(18), S(79));
    c.textAlign = 'left'; c.fillStyle = '#8a8172'; c.font = `600 ${S(26)}px Heebo, sans-serif`;
    if (data.updated) c.fillText(new Date(data.updated).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false }), S(44), S(80));
    const cols = data.columns || {};
    const top = S(122), colGap = S(26), colW = (W - S(88) - colGap * 2) / 3, colH = H - top - S(36);
    COLS_HE.forEach(([key, title, accent], i) => {
      const x = W - S(44) - (i + 1) * colW - i * colGap; // RTL: first column on the right
      c.fillStyle = 'rgba(31,26,18,.05)'; rr(c, x, top, colW, colH, S(22)); c.fill();
      const list = cols[key] || [];
      c.textAlign = 'right'; c.fillStyle = '#2a241a'; c.font = `800 ${S(34)}px Heebo, sans-serif`;
      c.fillText(title, x + colW - S(48), top + S(50));
      const titleW = c.measureText(title).width;
      c.fillStyle = accent; c.beginPath(); c.arc(x + colW - S(26), top + S(39), S(9), 0, 7); c.fill();
      // count pill right after the title (RTL: to its left)
      c.font = `800 ${S(24)}px Heebo, sans-serif`;
      const cnt = String(list.length), cw = Math.max(S(36), c.measureText(cnt).width + S(22));
      const px = x + colW - S(48) - titleW - S(12) - cw;
      c.fillStyle = 'rgba(31,26,18,.1)'; rr(c, px, top + S(20), cw, S(38), S(19)); c.fill();
      c.fillStyle = '#4a4336'; c.textAlign = 'center'; c.fillText(cnt, px + cw / 2, top + S(47));
      const cardH = S(118), gap = S(14), maxCards = Math.floor((colH - S(80)) / (cardH + gap));
      const shown = list.length > maxCards ? list.slice(0, maxCards - 1) : list;
      shown.forEach((card, j) => {
        const y = top + S(72) + j * (cardH + gap);
        c.save();
        c.shadowColor = 'rgba(60,40,10,.16)'; c.shadowBlur = S(10); c.shadowOffsetY = S(4);
        c.fillStyle = '#ffffff'; rr(c, x + S(14), y, colW - S(28), cardH, S(16)); c.fill();
        c.restore();
        const col = card.agent?.color || '#999';
        c.fillStyle = col; rr(c, x + colW - S(24), y + S(14), S(7), cardH - S(28), S(4)); c.fill();
        if (card.agent) drawEmblem(c, x + colW - S(108), y + S(16), S(70), card.agent);
        c.textAlign = 'right'; c.direction = 'rtl';
        c.fillStyle = '#1f1a12'; c.font = `800 ${S(30)}px Heebo, sans-serif`;
        const maxT = colW - S(150);
        c.fillText(ellipsize(c, card.title, maxT), x + colW - S(124), y + S(50));
        c.fillStyle = '#7b7365'; c.font = `600 ${S(24)}px Heebo, sans-serif`;
        let sub = card.agent?.name || '';
        if (card.status === 'failed') sub += ' · נכשל';
        else if (card.status === 'blocked') sub += ' · ממתין';
        if (card.when) sub += ' · ' + card.when;
        c.fillText(ellipsize(c, sub, maxT), x + colW - S(124), y + S(90));
        if (card.status === 'failed') { c.fillStyle = '#ef4444'; c.beginPath(); c.arc(x + S(40), y + S(40), S(9), 0, 7); c.fill(); }
        if (key === 'doing' && !reduced) { // tiny progress shimmer marker
          c.fillStyle = '#f5b301'; c.beginPath(); c.arc(x + S(40), y + S(40), S(8), 0, 7); c.fill();
        }
      });
      if (list.length > shown.length) {
        const y = top + S(72) + shown.length * (cardH + gap);
        c.textAlign = 'center'; c.fillStyle = '#7b7365'; c.font = `700 ${S(28)}px Heebo, sans-serif`;
        c.fillText(`+${list.length - shown.length} נוספות`, x + colW / 2, y + S(44));
      }
      if (!list.length) {
        c.textAlign = 'center'; c.fillStyle = '#a49b8b'; c.font = `600 ${S(26)}px Heebo, sans-serif`;
        c.fillText(data.empty?.[key] || '—', x + colW / 2, top + S(130));
      }
    });
    boardTex.needsUpdate = true;
  }
  drawBoard({ demo: true, columns: {} });

  /* ---------------- merge the static scenery (big draw-call saver) ---------------- */
  const staticGroup = mergeStatic(stat, scene);

  /* ---------------- interaction: drag orbit · right/2-finger pan · wheel/pinch zoom · tap ---------------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ptrs = new Map();
  let gesture = null; // {type, ...}
  let lastInteract = -1e9;
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.8);
  function screenToNdc(x, y) { const r = canvas.getBoundingClientRect(); ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1); return ndc; }
  function worldAt(x, y, state = goal) {
    const probe = cam.clone(); placeCam(state, probe);
    ray.setFromCamera(screenToNdc(x, y), probe);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(groundPlane, p) ? p : null;
  }
  function zoomAt(factor, x, y) {
    const before = goal.zoom;
    goal.zoom = Math.min(LIM.zMax, Math.max(LIM.zMin, goal.zoom * factor));
    const k = goal.zoom / before;
    if (x !== undefined && k !== 1) {
      // keep the point under the cursor fixed: centre' = p - k (p - centre)
      const r = canvas.getBoundingClientRect();
      const probe = { ...goal, zoom: before, t: goal.t.clone() };
      const p = worldAt(x, y, probe), c0 = worldAt(r.left + r.width / 2, r.top + r.height / 2, probe);
      if (p && c0) {
        const c1 = p.clone().sub(p.clone().sub(c0).multiplyScalar(k));
        goal.t.x += c1.x - c0.x; goal.t.z += c1.z - c0.z;
      }
    }
    clampGoal(); lastInteract = clockT; atHome = false;
  }
  function panBy(dx, dy) {
    // move the target in the ground plane by a screen delta
    const h = canvas.clientHeight || 1, unit = goal.zoom / h;
    const right = new THREE.Vector3(Math.sin(goal.az), 0, -Math.cos(goal.az));
    const fwd = new THREE.Vector3(-Math.cos(goal.az), 0, -Math.sin(goal.az));
    goal.t.addScaledVector(right, -dx * unit).addScaledVector(fwd, dy * unit / Math.sin(goal.el));
    clampGoal(); lastInteract = clockT; atHome = false;
  }
  function pick(x, y) {
    ray.setFromCamera(screenToNdc(x, y), cam);
    const list = [...agents.values()].filter(a => a.g.visible).map(a => a.hit);
    list.push(boardMesh, shelfHit);
    const hits = ray.intersectObjects(list, false);
    return hits[0]?.object || null;
  }
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture?.(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (ptrs.size === 1) gesture = { type: (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit', moved: 0 };
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      gesture = { type: 'pinch', moved: 99, d0: Math.hypot(a.x - b.x, a.y - b.y), z0: goal.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    lastInteract = clockT;
  });
  canvas.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId);
    if (!p) { hover(e); return; }
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;
    gesture.moved += Math.abs(dx) + Math.abs(dy);
    if (gesture.type === 'orbit' && gesture.moved > 4) {
      goal.az -= dx * 0.005; goal.el += dy * 0.004; clampGoal(); lastInteract = clockT; atHome = false;
    } else if (gesture.type === 'pan') panBy(dx, dy);
    else if (gesture.type === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const target = gesture.z0 * gesture.d0 / Math.max(20, d);
      zoomAt(target / goal.zoom, mx, my);
      panBy(mx - gesture.mx, my - gesture.my);
      gesture.mx = mx; gesture.my = my;
    }
  });
  function endPtr(e) {
    const p = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!p) return;
    if (gesture && gesture.type !== 'pinch' && gesture.moved < 8 && performance.now() - p.t < 650 && ptrs.size === 0) {
      const o = pick(e.clientX, e.clientY);
      if (o?.userData.agentId) hooks.onSelect?.(o.userData.agentId);
      else if (o?.userData.pick === 'board') hooks.onBoard?.();
      else if (o?.userData.pick === 'shelf') hooks.onShelf?.();
    }
    if (ptrs.size === 0) gesture = null;
    else if (ptrs.size === 1) gesture = { type: 'orbit', moved: 99 };
  }
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0016)), e.clientX, e.clientY);
  }, { passive: false });
  let hoverT = 0;
  function hover(e) {
    if (coarse || clockT - hoverT < 0.08) return;
    hoverT = clockT;
    const o = pick(e.clientX, e.clientY);
    canvas.style.cursor = o ? 'pointer' : 'grab';
  }
  canvas.style.cursor = 'grab';

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    computeHome();
    if (atHome || !resize.done) { goal.zoom = home.zoom; goal.t.copy(home.t); goal.el = home.el; if (!resize.done) { cur.zoom = goal.zoom; cur.t.copy(goal.t); cur.el = goal.el; } }
    resize.done = true;
    clampGoal();
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* ---------------- animation ---------------- */
  let clockT = 0, running = true, frames = 0, perfAcc = 0, perfN = 0, lowered = 0;
  const P = opts.loopSeconds || 12; // showcase camera loop length (seamless)
  const tmpA = new THREE.Vector3();
  function updateCharacter(ch, dt, t) {
    ch.stateT += dt;
    const st = ch.status;
    // blink / sleep eyes
    ch.blinkT -= dt;
    if (ch.blinkT < 0) { ch.blinkT = 2.2 + Math.random() * 3.2; ch.blink = 0.13; }
    if (ch.blink > 0) ch.blink -= dt;
    const eyeY = (st === 'offline' && ch.action === 'sit') || ch.blink > 0 ? 0.18 : 1;
    ch.eyes[0].scale.y = ch.eyes[1].scale.y = eyeY;
    applyDesat(ch, ch.desat + ((st === 'offline' ? 1 : 0) - ch.desat) * Math.min(1, dt * 3));
    const p = ch.g.position, legs = ch.legs, arms = ch.arms, torso = ch.torso, head = ch.head;
    let bubble = null;
    const breathe = Math.sin(t * 1.9 + ch.stateT * 0.3) * 0.012;
    if (ch.action === 'walk') {
      const target = ch.route[0];
      if (!target) { arrive(ch); return; }
      tmpA.subVectors(target, p); tmpA.y = 0;
      const d = tmpA.length(), step = dt * 1.9;
      if (d <= step) { p.x = target.x; p.z = target.z; ch.route.shift(); if (!ch.route.length) { arrive(ch); return; } }
      else { tmpA.normalize(); p.addScaledVector(tmpA, step); const want = Math.atan2(tmpA.x, tmpA.z); ch.g.rotation.y += angDiff(want, ch.g.rotation.y) * Math.min(1, dt * 10); }
      const w = t * 10.5;
      p.y = Math.abs(Math.sin(w)) * 0.06;
      legs[0].rotation.x = Math.sin(w) * 0.6; legs[1].rotation.x = -Math.sin(w) * 0.6;
      arms[0].rotation.x = -Math.sin(w) * 0.5; arms[1].rotation.x = Math.sin(w) * 0.5;
      torso.rotation.x = 0.04; head.rotation.set(0, 0, 0);
    } else if (ch.action === 'celebrate') {
      p.y = (ch.standing || ch.wasStanding ? 0 : SEAT_Y) + Math.abs(Math.sin(t * 8)) * 0.35;
      standPose(ch); arms[0].rotation.x = 0; arms[1].rotation.x = 0;
      arms[0].rotation.z = -2.5 + Math.sin(t * 16) * 0.2; arms[1].rotation.z = 2.5 - Math.sin(t * 16) * 0.2;
      if (ch.stateT > 1.7) { arms[0].rotation.z = -0.18; arms[1].rotation.z = 0.18; ch.action = ch.standing ? 'stand' : 'sit'; ch.stateT = 0; }
    } else if (ch.action === 'meeting' || ch.action === 'stand' || ch.action === 'coffee') {
      standPose(ch); p.y = 0;
      head.position.y = 0.88 + breathe;
      if (ch.action === 'meeting') {
        arms[0].rotation.x = Math.sin(t * 2.4 + ch.stateT) * 0.35; arms[1].rotation.x = Math.cos(t * 2.1) * 0.35;
        head.rotation.y = Math.sin(t * 1.2 + ch.stateT) * 0.35;
      } else if (ch.action === 'coffee') {
        ch.mug.visible = true;
        const sip = (Math.sin(t * 1.3) + 1) / 2;
        arms[1].rotation.x = -1.2 - sip * 0.9; arms[0].rotation.x = -0.1;
        head.rotation.x = -sip * 0.15;
        if (ch.returnAt && clockT > ch.returnAt) { ch.returnAt = 0; goHome(ch); }
      } else {
        arms[0].rotation.x = -0.1; arms[1].rotation.x = -0.1;
        if (st === 'blocked') bubble = askTex; else if (st === 'offline') bubble = zzzTex;
      }
    } else { // seated at the desk
      p.y = SEAT_Y;
      legs[0].rotation.x = legs[1].rotation.x = -1.45;
      head.position.y = 0.88 + breathe;
      ch.mug.visible = st === 'idle';
      if (st === 'working') {
        torso.rotation.x = 0.06;
        arms[0].rotation.x = -1.12 + Math.sin(t * 13 + ch.stateT) * 0.12;
        arms[1].rotation.x = -1.12 + Math.sin(t * 11.5 + 1.7) * 0.12;
        arms[0].rotation.z = -0.12; arms[1].rotation.z = 0.12;
        head.rotation.x = 0.1 + Math.sin(t * 2.2 + ch.stateT) * 0.04; head.rotation.y = Math.sin(t * 0.7 + ch.stateT) * 0.12;
      } else if (st === 'idle') { // coffee break, leaning back
        torso.rotation.x = -0.14;
        const sip = Math.max(0, Math.sin(t * 0.9 + ch.stateT));
        arms[1].rotation.x = -1.0 - sip * 1.1; arms[1].rotation.z = 0.15;
        arms[0].rotation.x = -0.35; arms[0].rotation.z = -0.2;
        head.rotation.x = -0.08 - sip * 0.12; head.rotation.y = Math.sin(t * 0.5 + ch.stateT) * 0.3;
      } else if (st === 'blocked') {
        torso.rotation.x = 0.0;
        arms[0].rotation.x = -2.7; arms[0].rotation.z = -0.5 + Math.sin(t * 6) * 0.08;
        arms[1].rotation.x = -0.9; arms[1].rotation.z = 0.15;
        head.rotation.x = 0; head.rotation.z = Math.sin(t * 1.4) * 0.12; head.rotation.y = 0;
        bubble = askTex;
      } else { // offline: asleep on the desk
        torso.rotation.x = 0.5 + Math.sin(t * 1.2) * 0.015;
        arms[0].rotation.x = arms[1].rotation.x = -1.35; arms[0].rotation.z = -0.35; arms[1].rotation.z = 0.35;
        head.rotation.x = 0.35; head.rotation.y = 0; head.rotation.z = 0.25;
        bubble = zzzTex;
      }
      ch.g.rotation.y += angDiff(ch.homeRot, ch.g.rotation.y) * Math.min(1, dt * 8);
    }
    // status bubble bobbing
    if (bubble && !reduced) {
      ch.bubble.visible = true; ch.bubble.material.map = bubble;
      const ph = (t * 0.45 + ch.stateT * 0.01) % 1;
      ch.bubble.position.set(0.35 + ph * 0.15, 1.65 + ph * 0.45, 0);
      ch.bubble.material.opacity = Math.sin(ph * Math.PI);
    } else if (bubble) { ch.bubble.visible = true; ch.bubble.material.map = bubble; ch.bubble.material.opacity = 0.95; ch.bubble.position.set(0.4, 1.8, 0); }
    else ch.bubble.visible = false;
    // focus ring
    const target = ch.focused ? 0.95 : 0;
    ch.ring.material.opacity += (target - ch.ring.material.opacity) * Math.min(1, dt * 8);
    ch.ring.visible = ch.ring.material.opacity > 0.01;
    if (ch.focused) ch.ring.scale.setScalar(1 + Math.sin(t * 4) * 0.05);
    ch.ring.position.y = 0.03 - p.y;
    // stuck / silent alert
    ch.warn.visible = ch.alarm.visible = !!ch.alert;
    if (ch.alert) {
      const pulse = reduced ? 0.5 : (Math.sin(t * 5) + 1) / 2;
      ch.warn.scale.setScalar(0.42 + pulse * 0.08);
      ch.warn.position.y = 1.62 - p.y + (reduced ? 0 : Math.sin(t * 2.2) * 0.04);
      ch.alarm.material.opacity = 0.35 + pulse * 0.5;
      ch.alarm.scale.setScalar(1 + pulse * 0.12);
      ch.alarm.position.y = 0.04 - p.y;
    }
  }
  function standPose(ch) {
    ch.legs[0].rotation.x = ch.legs[1].rotation.x = 0;
    ch.torso.rotation.x = 0; ch.head.rotation.set(0, ch.head.rotation.y * 0.9, 0);
  }
  function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
  function arrive(ch) {
    const next = ch.after || (ch.standing ? 'stand' : 'sit');
    ch.after = null; ch.action = next; ch.stateT = 0;
    if (next === 'sit') { ch.g.position.copy(ch.seat); }
    if (next === 'coffee') ch.g.rotation.y = Math.PI; // face the machine
    const cb = ch.onArrive; ch.onArrive = null; cb?.(ch);
  }
  function goHome(ch) {
    walk(ch, ch.seat, ch.standing ? 'stand' : 'sit', () => { ch.g.rotation.y = ch.homeRot; });
  }

  function frame(dt) {
    clockT += dt;
    const t = clockT;
    if (showcase && !reduced) {
      const a = (t / P) * Math.PI * 2;
      goal.az = BASE_AZ + Math.sin(a) * 0.36;
      goal.el = home.el + Math.sin(a * 2) * 0.035 + 0.02;
      goal.zoom = home.zoom * (0.97 + 0.05 * (1 - Math.cos(a)) / 2);
      goal.t.copy(home.t).add(tmpA.set(Math.sin(a) * 0.3, 0, (Math.cos(a) - 1) * 0.2));
      cur.az = goal.az; cur.el = goal.el; cur.zoom = goal.zoom; cur.t.copy(goal.t);
    } else ease(dt);
    placeCam(cur);
    if (!reduced) skyTex.offset.x = (t * 0.006) % 1;
    tickClock(t);
    // dust motes drift in the light
    if (dust) {
      const pos = dust.geometry.attributes.position, base = dust.userData.base, seeds = dust.userData.seeds;
      for (let i = 0; i < seeds.length; i++) {
        const s = seeds[i];
        pos.array[i * 3] = base[i * 3] + Math.sin(t * 0.21 + s) * 0.25;
        pos.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.17 + s * 1.7) * 0.22;
        pos.array[i * 3 + 2] = base[i * 3 + 2] + Math.cos(t * 0.13 + s) * 0.25;
      }
      pos.needsUpdate = true;
      dust.material.opacity = 0.55 + Math.sin(t * 0.5) * 0.15;
    }
    shafts.forEach((m, i) => { m.material.opacity = reduced ? 0.2 : 0.17 + Math.sin(t * 0.4 + i) * 0.04; });
    // steam from the espresso machine
    for (const s of steam) {
      const ph = ((t * 0.35 + s.userData.phase) % 1);
      s.position.set(mX - 0.06 + Math.sin(ph * 6 + s.userData.phase * 9) * 0.04, 1.12 + ph * 0.7, CO.z + 0.17);
      s.scale.setScalar(0.12 + ph * 0.3);
      s.material.opacity = reduced ? 0 : Math.sin(ph * Math.PI) * 0.35;
    }
    machineLed.material.color.setHSL(0.36, 0.9, 0.55 + Math.sin(t * 3) * 0.12);
    lampGlow.material.opacity = 0.5 + Math.sin(t * 0.8) * 0.04;
    // characters + tags
    const tagH = Math.min(0.78, (mobile ? 30 : 34) / Math.max(200, canvas.clientHeight) * cur.zoom);
    for (const ch of agents.values()) {
      if (!ch.g.visible) continue;
      updateCharacter(ch, dt, t);
      ch.tag.scale.set(tagH * (512 / 132), tagH, 1);
      ch.tag.position.y = 2.02 - ch.g.position.y;
    }
    updateArcs();
    // monitors: scroll code while working, emit little pips
    for (const spot of deskSpots) {
      const m = spot.monitor, ch = m.owner;
      if (!ch || !ch.g.visible) continue;
      const busy = ch.status === 'working' && ch.action === 'sit';
      if (busy && !reduced) m.tex.offset.y = (m.tex.offset.y + dt * 0.09) % 1;
      if (busy && !reduced && Math.random() < dt * 0.9) {
        const s = pips.find(x => x.userData.life <= 0);
        if (s) { s.visible = true; s.userData.life = 1; s.position.copy(deskLocal(spot, (Math.random() - 0.5) * 0.7, 1.7, 0.26)); s.material.color.copy(m.color); }
      }
    }
    for (const s of pips) {
      if (s.userData.life <= 0) continue;
      s.userData.life -= dt * 0.7; s.position.y += dt * 0.45;
      s.material.opacity = Math.max(0, Math.sin(s.userData.life * Math.PI)) * 0.9;
      if (s.userData.life <= 0) s.visible = false;
    }
    for (const s of sparks) {
      if (s.userData.life <= 0) continue;
      s.userData.life -= dt * 1.1; s.userData.v.y -= dt * 3.2;
      s.position.addScaledVector(s.userData.v, dt);
      s.material.opacity = Math.max(0, s.userData.life);
      s.material.rotation += dt * 4;
      if (s.userData.life <= 0) s.visible = false;
    }
    hooks.onFrame?.(dt, t);
    renderer.render(scene, cam);
    frames++;
  }

  const clock = new THREE.Clock();
  function loop() {
    if (!running) return;
    requestAnimationFrame(loop);
    if (document.hidden) { clock.getDelta(); return; }
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);
    frame(dt);
    // adaptive quality: phones that can't hold ~30 fps drop resolution, then soft shadows
    perfAcc += raw; perfN++;
    if (perfAcc > 2.5) {
      const avg = perfAcc / perfN; perfAcc = 0; perfN = 0;
      if (opts.adaptive !== false && avg > 1 / 32 && clockT > 3) {
        const pr = renderer.getPixelRatio();
        if (pr > 1.01) { renderer.setPixelRatio(Math.max(1, pr - 0.25)); resize(); lowered++; }
        else if (renderer.shadowMap.type !== THREE.BasicShadowMap) { renderer.shadowMap.type = THREE.BasicShadowMap; sun.shadow.mapSize.set(1024, 1024); sun.shadow.map?.dispose(); sun.shadow.map = null; lowered++; }
      }
      api.fps = Math.round(1 / avg);
    }
  }
  /* ---------------- public API ---------------- */
  const legacyState = { typing: 'working', idle: 'idle', walk: null, celebrate: null, meeting: null };
  const api = {
    fps: 0,
    spots: { coffee: coffeeSpot, meet: MEET },
    addAgent(meta) { const ch = addCharacter(meta); ch.showStatus = !!meta.live; drawTag(ch); return ch; },
    hasAgent(id) { return agents.has(id); },
    setVisible(id, visible) {
      const ch = agents.get(id); if (!ch) return;
      ch.g.visible = !!visible;
      if (!visible) ch.focused = false;
      refreshMonitors();
    },
    setStatus(id, status) { const ch = agents.get(id); if (ch) setStatus(ch, status); },
    setActivity(id, text) {
      const ch = agents.get(id); if (!ch) return;
      const t = text ? String(text) : '';
      if ((ch.activity || '') === t) return;
      ch.activity = t; drawTag(ch);
    },
    handoff(fromId, toId) {
      const a = agents.get(fromId), b = agents.get(toId);
      if (!a || !b || !a.g.visible || !b.g.visible || a === b) return false;
      handoffArc(a, b); return true;
    },
    /** Meeting room: agents working on the same PR sit together on the rug; [{key, label, ids}] */
    meetGroups(groups) {
      const want = new Map();
      (groups || []).forEach((g, gi) => g.ids.forEach((id, i) => want.set(id, { g, gi, i, n: g.ids.length })));
      for (const ch of agents.values()) {
        const w = want.get(ch.meta.id);
        const key = w ? w.g.key : null;
        if (key === (ch.meetKey || null) || !ch.g.visible) continue;
        ch.meetKey = key; ch.meetingLabel = w ? w.g.label : '';
        drawTag(ch);
        if (w) {
          // each group gets its own arc of the round table; members face its centre
          const span = Math.PI * 2 / Math.max(1, groups.length);
          const ang = w.gi * span + (w.i + 0.5) / w.n * span * 0.8 + 0.4;
          const spot = new THREE.Vector3(MEET.x + Math.cos(ang) * 1.25, 0, MEET.z + Math.sin(ang) * 1.05);
          walk(ch, spot, 'meeting', () => { ch.g.rotation.y = Math.atan2(MEET.x - ch.g.position.x, MEET.z - ch.g.position.z); });
        } else goHome(ch);
      }
    },
    setAlert(id, alert) { // {kind:'stuck'|'silent', label} or null
      const ch = agents.get(id); if (!ch) return;
      const next = alert ? { kind: alert.kind, label: String(alert.label || '') } : null;
      if (JSON.stringify(next) === JSON.stringify(ch.alert)) return;
      ch.alert = next; drawTag(ch);
    },
    setState(id, state) { // v1 API, kept for the demo simulation
      const ch = agents.get(id); if (!ch) return;
      if (legacyState[state]) setStatus(ch, legacyState[state]);
    },
    celebrate(id) {
      const ch = agents.get(id); if (!ch || !ch.g.visible) return;
      if (ch.action === 'walk' || ch.action === 'meeting' || ch.action === 'coffee') return;
      ch.action = 'celebrate'; ch.stateT = 0;
      burst(tmpA.copy(ch.g.position).add(new THREE.Vector3(0, 1.7, 0)), ch.meta.color, reduced ? 0 : 12);
    },
    walkTo(id, v, nextState = 'stand', onArrive = null) {
      const ch = agents.get(id); if (!ch) return;
      walk(ch, new THREE.Vector3(v.x, 0, v.z), nextState === 'idle' ? 'stand' : nextState, onArrive);
    },
    coffeeBreak(id, seconds = 6) {
      const ch = agents.get(id); if (!ch || ch.action === 'walk' || ch.action === 'coffee') return false;
      const spot = coffeeSpot.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0, Math.random() * 0.3));
      walk(ch, spot, 'coffee', () => { ch.returnAt = clockT + seconds; });
      return true;
    },
    goHome(id) { const ch = agents.get(id); if (ch) goHome(ch); },
    gatherAll() {
      const vis = [...agents.values()].filter(c => c.g.visible);
      vis.forEach((ch, i) => {
        const ang = (i / Math.max(vis.length, 1)) * Math.PI * 2 + 0.3;
        const spot = new THREE.Vector3(MEET.x + Math.cos(ang) * 1.25, 0, MEET.z + Math.sin(ang) * 1.05);
        walk(ch, spot, 'meeting', () => { ch.g.rotation.y = Math.atan2(MEET.x - ch.g.position.x, MEET.z - ch.g.position.z); });
      });
    },
    disperseAll() { for (const ch of agents.values()) goHome(ch); },
    focus(id) { atHome = false;
      for (const ch of agents.values()) ch.focused = ch.meta.id === id;
      const ch = agents.get(id);
      if (ch) { goal.t.set(ch.g.position.x, 1.0, ch.g.position.z); goal.zoom = Math.min(goal.zoom, 6.5); clampGoal(); }
    },
    unfocus() { for (const ch of agents.values()) ch.focused = false; },
    focusBoard() { atHome = false; goal.az = BASE_AZ + 0.32; goal.el = 0.5; goal.t.set(BOARD.cx, BOARD.cy, BOARD.z + 1); goal.zoom = Math.max(LIM.zMin, BOARD.h * 1.5, (BOARD.w + 0.5) / aspect()); clampGoal(); },
    focusShelf() { atHome = false; goal.az = BASE_AZ + 0.3; goal.el = 0.5; goal.t.set(shelfCx, 1.4, SHELF.z + 1); goal.zoom = Math.max(LIM.zMin, shelfTop + 0.9, (shelfW + 0.5) / aspect()); clampGoal(); },
    zoomBy(f) { const r = canvas.getBoundingClientRect(); zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); },
    resetCam() { atHome = true; goal.az = BASE_AZ; goal.el = home.el; goal.zoom = home.zoom; goal.t.copy(home.t); for (const ch of agents.values()) ch.focused = false; },
    updateScreen: drawWallScreen,
    updateBoard: drawBoard,
    updateShelves: buildShelves,
    step(dt = 1 / 30) { frame(dt); },
    /** Client (CSS px) position of a world anchor — used by tests to tap things in the scene. */
    project(what) {
      let v;
      if (what === 'board') v = new THREE.Vector3(BOARD.cx + BOARD.w * 0.3, BOARD.cy + BOARD.h * 0.36, BOARD.z);
      else if (what === 'shelf') v = new THREE.Vector3(shelfCx, shelfTop * 0.55, SHELF.z + 0.2);
      else { const ch = agents.get(what); if (!ch) return null; v = ch.g.position.clone().add(new THREE.Vector3(0, 1.0, 0)); }
      v.project(cam);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    },
    hitTest(x, y) { const o = pick(x, y); return o ? (o.userData.agentId || o.userData.pick) : null; },
    camera() { return { t: clockT.toFixed(2), home: [home.zoom.toFixed(2), home.t.x.toFixed(2), home.t.z.toFixed(2)], cw: canvas.clientWidth, ch: canvas.clientHeight, zoom: +cur.zoom.toFixed(3), goalZoom: +goal.zoom.toFixed(3), az: +cur.az.toFixed(3), el: +cur.el.toFixed(3), min: LIM.zMin, max: +LIM.zMax.toFixed(2) }; },
    stats() { const i = renderer.info; return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries, pixelRatio: renderer.getPixelRatio(), fps: api.fps, lowered }; },
    dispose() { running = false; renderer.dispose(); },
  };
  if (!capture) loop();
  return api;
}
