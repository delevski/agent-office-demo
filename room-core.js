// room-core.js — the room's brain without a second renderer.
// It keeps the three things the old 3D office used to provide besides pictures: the simulation clock (the demo script
// and the office-life timers tick on it), the room's time of day (dawn / day / dusk / night, a fixed or cycling clock for
// the "time in the room" buttons) and the calls the dashboard makes to move people (converse, bell, coffee, meeting).
// All movement is drawn by concept.js, so nothing here touches WebGL or the DOM.

// night factor by hour: the same stops the room has always used (0 = bright day, 1 = deep night)
const TOD = { night: [1, 1], dawn: [0.35, 0.55], morning: [0, 0.08], day: [0, 0], dusk: [0.45, 0.75] }; // [night, lamps]
const TOD_STOPS = [[0, 'night'], [5.1, 'night'], [6.1, 'dawn'], [7.6, 'morning'], [10.5, 'day'], [16.3, 'day'], [17.7, 'dusk'], [18.9, 'night'], [24, 'night']];
const smooth = k => k * k * (3 - 2 * k);

/** night / lamps factors and phase for an hour of the day (0..24), blended between the two neighbouring stops */
export function todAt(h) {
  let i = 0; while (i < TOD_STOPS.length - 2 && h >= TOD_STOPS[i + 1][0]) i++;
  const [h0, n0] = TOD_STOPS[i], [h1, n1] = TOD_STOPS[i + 1];
  const k = h1 > h0 ? smooth((h - h0) / (h1 - h0)) : 0;
  const A = TOD[n0], B = TOD[n1];
  return { night: A[0] + (B[0] - A[0]) * k, lamps: A[1] + (B[1] - A[1]) * k, phase: h < 5.1 || h >= 18.9 ? 'night' : h < 7.6 ? 'dawn' : h < 16.3 ? 'day' : 'dusk' };
}
export function parseHHMM(v) {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(v || '').trim()); if (!m) return null;
  const h = +m[1], mi = +(m[2] || 0); return h < 24 && mi < 60 ? h + mi / 60 : null;
}

/**
 * @param cv     the concept room (concept.js)
 * @param hooks  { onFrame(dt, t), onTimeOfDay(info) }
 * @param opts   { time: 'HH:MM' | 'cycle[:seconds]' | '' }
 */
export function createRoomCore(cv, hooks = {}, opts = {}) {
  let clockT = 0, running = true, lastWall = 0, lastTod = -1e9, force = true;
  const timeCtl = { mode: 'real', offset: 0, cycle: 0, cycleStart: 0, cycleT0: 0 };
  const state = { night: 0, phase: 'day' };
  function virtualNow() {
    if (timeCtl.mode === 'cycle') {
      const hrs = (timeCtl.cycleStart + (clockT - timeCtl.cycleT0) / timeCtl.cycle * 24) % 24;
      const d = new Date(); d.setHours(Math.floor(hrs), Math.floor((hrs % 1) * 60), Math.floor((hrs * 60 % 1) * 60), 0); return d;
    }
    return new Date(Date.now() + (timeCtl.mode === 'fixed' ? timeCtl.offset : 0));
  }
  function setTime(v) {
    if (v === null || v === undefined || v === '' || v === 'real') { timeCtl.mode = 'real'; timeCtl.offset = 0; }
    else if (/^cycle/.test(String(v))) { timeCtl.mode = 'cycle'; timeCtl.cycle = Number(String(v).split(':')[1]) || 60; timeCtl.cycleT0 = clockT; timeCtl.cycleStart = 5; }
    else {
      const h = parseHHMM(v); if (h === null) return false;
      const now = new Date(), cur = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
      timeCtl.mode = 'fixed'; timeCtl.offset = Math.round((h - cur) * 3600_000);
    }
    force = true;
    return true;
  }
  function updateTimeOfDay() {
    if (!force && timeCtl.mode !== 'cycle' && clockT - lastTod < 0.5) return;
    force = false; lastTod = clockT;
    const d = virtualNow(), h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const s = todAt(h); state.night = s.night; state.phase = s.phase;
    hooks.onTimeOfDay?.({ h, phase: s.phase, night: s.night, lamps: s.lamps, date: d, mode: timeCtl.mode });
  }
  // The clock: ten ticks a second are plenty for a script that fires every couple of seconds, and it pauses with the tab.
  function step() {
    if (!running) return;
    const now = performance.now();
    if (document.hidden) { lastWall = now; return; }
    const dt = Math.min(0.25, (now - lastWall) / 1000 || 0.1); lastWall = now;
    clockT += dt;
    updateTimeOfDay();
    hooks.onFrame?.(dt, clockT);
  }
  lastWall = performance.now();
  const timer = setInterval(step, 100);
  if (opts.time) setTime(opts.time);
  updateTimeOfDay();

  const legacy = { typing: 'working', idle: 'idle' };
  const has = id => cv.cast.some(a => a.id === id);
  return {
    // people (the roster and who is in the room live in concept.js; these are the calls the dashboard makes)
    hasAgent: has,
    converse: spec => cv.converse(spec || {}),
    talking: () => cv.talking(),
    setStatus: (id, st) => cv.setStatus(id, st),
    setState: (id, st) => { if (legacy[st]) cv.setStatus(id, legacy[st]); },
    // the gong: if that person is busy (walking to a coffee, in a chat) the ring waits for them, up to 15 seconds
    ringBell(id, label) {
      if (cv.bell(id, label)) return true;
      if (!cv.actorState(id)) return false;
      let tries = 0; const retry = () => { if (cv.bell(id, label) || ++tries >= 15) return; setTimeout(retry, 1000); };
      setTimeout(retry, 1000); return true;
    },
    celebrate: id => { cv.hop(id); cv.ring(id); },
    coffeeBreak: (id, secs) => cv.coffee(id, secs),
    gatherAll: () => cv.gather(true),
    disperseAll: () => cv.gather(false),
    micro: id => { const s = cv.actorState(id); if (!s || s.state !== 'sit' || s.busy) return false; cv.hop(id); return true; },
    focus: id => cv.ring(id),
    unfocus() {}, resetCam() { cv.setPan(0); cv.setZoom(1); },
    // the room's clock
    setTime,
    timeInfo() { const d = virtualNow(); return { h: +(d.getHours() + d.getMinutes() / 60).toFixed(3), hhmm: d.toTimeString().slice(0, 5), mode: timeCtl.mode, night: +state.night.toFixed(2), phase: state.phase, pajamas: state.night > 0.6 }; },
    clock: () => clockT,
    dispose() { running = false; clearInterval(timer); },
  };
}
