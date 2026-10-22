/* One event path for mouse, pen and touch. Keep press/release edges in order. */
(function () {
  'use strict';
  var el = Module.canvas, head = 0;
  var keys = new Map(), pointers = new Map();
  var buttonCounts = [0, 0, 0], pointerButtons = new Map();
  var queueSamples = [], frameSamples = [], lastFrame = 0, frameN = 0, focusAcked = false;
  var mouseButtons = 0;
  var benchmark = null;
  Module.gdBeginBenchmark = function (durationMs) {
    benchmark = {duration: Math.max(1000, Math.min(60000, durationMs || 20000)),
      start: null, previous: 0, frames: [], input: [], heap: 0};
    Module.gdBenchmark = {running: true, elapsedMs: 0};
  };
  Module.gdKeyState = new Uint8Array(256);
  Module.gdInputStats = {samples: 0, queueMs: 0, queueP95Ms: 0, frameP95Ms: 0, pointerClient: null, pointerGame: null};
  function ready() { return window.__gdInputReady === true; }
  function timestamp(e) {
    var now = performance.now(), stamp = e && e.timeStamp;
    return stamp > 0 && stamp <= now && now - stamp < 60000 ? stamp : now;
  }
  function push(msg, wp, lp, time) {
    Module.gdInputQueue.push([msg | 0, wp | 0, lp | 0, time || performance.now()]);
  }
  function position(e) {
    var r = el.getBoundingClientRect();
    var width = el.width || 1920, height = el.height || 1080;
    var x = Math.max(0, Math.min(width - 1, Math.round((e.clientX - r.left) * width / r.width)));
    var y = Math.max(0, Math.min(height - 1, Math.round((e.clientY - r.top) * height / r.height)));
    Module.gdCursorPos[0] = x; Module.gdCursorPos[1] = y;
    Module.gdInputStats.pointerClient = [e.clientX, e.clientY];
    Module.gdInputStats.pointerGame = [x, y];
    return (x & 65535) | (y << 16);
  }
  function cursor() { return (Module.gdCursorPos[0] & 65535) | (Module.gdCursorPos[1] << 16); }
  function percentile(values) {
    if (!values.length) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  Module.gdPollInput = function () {
    if (head >= Module.gdInputQueue.length) return null;
    var entry = Module.gdInputQueue[head++];
    if (entry[0] === 0x100 || entry[0] === 0x201 || entry[0] === 0x204) {
      var delay = Math.max(0, performance.now() - entry[3]);
      queueSamples.push(delay); if (queueSamples.length > 120) queueSamples.shift();
      Module.gdInputStats.queueMs = delay; Module.gdInputStats.samples++;
      Module.gdInputStats.queueP95Ms = percentile(queueSamples);
      if (benchmark) benchmark.input.push(delay);
    }
    if (head >= Module.gdInputQueue.length) { Module.gdInputQueue.length = 0; head = 0; }
    return entry;
  };
  Module.gdMeasureFrame = function () {
    var now = performance.now();
    if (benchmark && !document.hidden) {
      var b = benchmark;
      if (b.start === null) b.start = now;
      else b.frames.push(now - b.previous);
      b.previous = now;
      if (Module.HEAPU8) b.heap = Math.max(b.heap, Module.HEAPU8.byteLength / 1048576);
      var elapsed = now - b.start;
      Module.gdBenchmark.elapsedMs = elapsed;
      if (elapsed >= b.duration && b.frames.length) {
        Module.gdBenchmark = {running: false, frames: b.frames.length,
          elapsedMs: elapsed, meanFps: b.frames.length * 1000 / elapsed,
          frameP95Ms: percentile(b.frames), frameMaxMs: Math.max.apply(null, b.frames),
          inputP95Ms: b.input.length ? percentile(b.input) : null, heapMiB: b.heap};
        benchmark = null;
      }
    }
    if (lastFrame && !document.hidden) {
      frameSamples.push(now - lastFrame);
      if (frameSamples.length > 120) frameSamples.shift();
      if (++frameN % 30 === 0) Module.gdInputStats.frameP95Ms = percentile(frameSamples);
    }
    lastFrame = now;
  };
  function acknowledgeFocus() {
    if (focusAcked || !ready()) return;
    focusAcked = true; push(6, 1, 0); push(7, 0, 0); push(0x1c, 1, 0);
  }
  window.__gdAckFocus = acknowledgeFocus;
  var downMsg = [0x201, 0x207, 0x204], upMsg = [0x202, 0x208, 0x205];
  function setButton(b, down, lp, time) {
    var count = buttonCounts[b];
    buttonCounts[b] += down ? 1 : -1;
    var vk = [1, 4, 2][b];
    Module.gdKeyState[vk] = buttonCounts[b] ? 1 : 0;
    if (down && count === 0) push(downMsg[b], b === 2 ? 2 : b === 1 ? 16 : 1, lp, time);
    if (!down && buttonCounts[b] === 0) { push(upMsg[b], 0, lp, time); push(0x200, 0, lp, time); }
  }
  function syncMouse(mask, lp, time) {
    [1, 4, 2].forEach(function (bit, b) {
      if ((mouseButtons & bit) !== (mask & bit)) setButton(b, !!(mask & bit), lp, time);
    });
    mouseButtons = mask;
  }
  function releasePointer(id, time) {
    if (!pointers.has(id)) return;
    var button = pointerButtons.get(id), lp = pointers.get(id);
    pointers.delete(id); pointerButtons.delete(id);
    setButton(button, false, lp, time);
  }
  el.addEventListener('pointerdown', function (e) {
    if (!ready() || e.button > 2) return;
    acknowledgeFocus();
    el.focus({preventScroll: true});
    var lp = position(e), b = e.pointerType === 'mouse' ? e.button : 0;
    if (e.pointerType === 'mouse') {
      syncMouse(e.buttons === undefined ? (mouseButtons | [1, 4, 2][b]) : e.buttons, lp, timestamp(e));
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault(); return;
    }
    if (pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, lp); pointerButtons.set(e.pointerId, b);
    setButton(b, true, lp, timestamp(e));
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }, {passive: false});
  el.addEventListener('pointermove', function (e) {
    if (!ready()) return;
    var lp = position(e);
    if (e.pointerType === 'mouse' && e.buttons !== undefined) syncMouse(e.buttons, lp, timestamp(e));
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, lp);
    var wp = (buttonCounts[0] ? 1 : 0) | (buttonCounts[2] ? 2 : 0) | (buttonCounts[1] ? 16 : 0);
    var q = Module.gdInputQueue, tail = q[q.length - 1];
    if (q.length > head && tail[0] === 0x200) q[q.length - 1] = [0x200, wp, lp, timestamp(e)];
    else push(0x200, wp, lp, timestamp(e));
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (name) {
    el.addEventListener(name, function (e) {
      if (e.pointerType === 'mouse') syncMouse(name === 'pointerup' ? (e.buttons || 0) : 0, cursor(), timestamp(e));
      else releasePointer(e.pointerId, timestamp(e));
    });
  });
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  el.addEventListener('wheel', function (e) {
    if (!ready() || (!e.deltaX && !e.deltaY)) return;
    var vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    var notch = (vertical ? -e.deltaY : -e.deltaX) > 0 ? 120 : -120;
    push(vertical ? 0x20a : 0x20e, (notch & 65535) << 16, position(e), timestamp(e));
    e.preventDefault();
  }, {passive: false});
  var VK = {Escape:27, Space:32, Enter:13, Backspace:8, Tab:9, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40};
  var scan = {Escape:1, Space:57, Enter:28, Backspace:14, Tab:15, ArrowLeft:75, ArrowUp:72, ArrowRight:77, ArrowDown:80,
    KeyW:17, KeyA:30, KeyS:31, KeyD:32, KeyQ:16, KeyE:18, KeyR:19, KeyF:33, KeyP:25};
  function key(e, down) {
    if (!ready()) return;
    var vk = VK[e.code] || e.keyCode || 0;
    if (!vk || vk > 255) return;
    if (down && (e.ctrlKey || e.metaKey || e.altKey || e.target.closest && e.target.closest('button,input,textarea,select,a'))) return;
    if (!down && !keys.has(vk)) return;
    if (e.repeat && (e.code === 'Space' || e.code.indexOf('Arrow') === 0)) { e.preventDefault(); return; }
    var lp = 1 | ((scan[e.code] || 0) << 16);
    if (e.code.indexOf('Arrow') === 0) lp |= 0x1000000;
    if (down && keys.has(vk)) lp |= 0x40000000;
    if (!down) lp |= -1073741824;
    Module.gdKeyState[vk] = down ? 1 : 0;
    if (down) keys.set(vk, lp); else keys.delete(vk);
    push(down ? 0x100 : 0x101, vk, lp, timestamp(e));
    if (down) {
      var ch = e.key && e.key.length === 1 ? e.key.charCodeAt(0) : e.code === 'Backspace' ? 8 : e.code === 'Enter' ? 13 : 0;
      if (ch) push(0x102, ch, lp, timestamp(e));
    }
    if (VK[e.code]) e.preventDefault();
  }
  window.addEventListener('keydown', function (e) { key(e, true); }, {capture: true});
  window.addEventListener('keyup', function (e) { key(e, false); }, {capture: true});
  function releaseAll() {
    if (benchmark) {
      benchmark = null;
      Module.gdBenchmark = {running: false, error: 'Interrupted: keep the game focused for the test'};
    }
    syncMouse(0, cursor());
    pointers.forEach(function (_, id) { releasePointer(id); });
    keys.forEach(function (lp, vk) { push(0x101, vk, lp | -1073741824); });
    keys.clear(); Module.gdKeyState.fill(0); focusAcked = false;
    lastFrame = 0; frameSamples.length = 0;
  }
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', function () { if (document.hidden) releaseAll(); });
  el.tabIndex = 0;
})();
