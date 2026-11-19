// ==UserScript==
// @name         EP9 Wrench: speed + attack speed
// @match        https://ep9-online.com/play/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // CONFIG. Every game-specific value lives here.
  // null = UNSET (not 0). Nothing below was read from the EP9 client; the client
  // was not reachable from the build container, so these stay unset until you
  // fill them from the client you actually load (see recipe at the bottom).
  // ---------------------------------------------------------------------------
  const CONFIG = {
    time: {
      // Source: my choice, not game data.
      scaleSteps: [0.5, 1, 1.5, 2, 3, 4, 6, 8],
      startIndex: 1,
    },
    attack: {
      // Dotted path from window to the local player object, e.g. "a.b.c".
      // Source: UNSET, derive from client (recipe step 3).
      playerPath: null,
      // Field on that object that counts DOWN to the next allowed attack. Unset.
      cooldownField: null,
      // Field holding the delay BETWEEN attacks (ms or frames, unit unknown). Unset.
      intervalField: null,
      // Interval divisor applied when intervalField is set.
      intervalDivisor: 2,
    },
    ws: { logCap: 500, previewBytes: 32 },
  };

  // ---------------------------------------------------------------------------
  // Pure helpers (checkable without the game)
  // ---------------------------------------------------------------------------
  const resolvePath = (root, path) => {
    if (typeof path !== 'string' || path.length === 0) return undefined;
    let cur = root;
    for (const key of path.split('.')) {
      if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) return undefined;
      cur = cur[key];
    }
    return cur;
  };

  const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

  // ---------------------------------------------------------------------------
  // Originals, captured before the page can touch them
  // ---------------------------------------------------------------------------
  const orig = {
    perfNow: performance.now.bind(performance),
    dateNow: Date.now,
    DateCtor: Date,
    raf: window.requestAnimationFrame.bind(window),
    setTimeout: window.setTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    WebSocket: window.WebSocket,
  };

  // ---------------------------------------------------------------------------
  // Virtual clock. Re-anchored on every scale change so time never jumps.
  // ---------------------------------------------------------------------------
  const clock = (() => {
    let scale = CONFIG.time.scaleSteps[CONFIG.time.startIndex];
    let realAnchor = orig.perfNow();
    let virtAnchor = realAnchor;
    const epochAtStart = orig.dateNow.call(Date);
    const virtAtStart = virtAnchor;

    const now = () => virtAnchor + (orig.perfNow() - realAnchor) * scale;
    const setScale = (s) => {
      if (!isFiniteNumber(s) || s <= 0 || s > 64) return false;
      const r = orig.perfNow();
      virtAnchor += (r - realAnchor) * scale;
      realAnchor = r;
      scale = s;
      return true;
    };
    return {
      now,
      epochNow: () => epochAtStart + (now() - virtAtStart),
      setScale,
      get scale() { return scale; },
    };
  })();

  performance.now = () => clock.now();

  class ScaledDate extends orig.DateCtor {
    constructor(...args) {
      if (args.length === 0) super(clock.epochNow());
      else super(...args);
    }
    static now() { return clock.epochNow(); }
  }
  window.Date = ScaledDate;

  window.requestAnimationFrame = (cb) => orig.raf(() => cb(clock.now()));

  const scaleDelay = (d) => {
    const n = Number(d);
    return Number.isFinite(n) && n > 0 ? n / clock.scale : 0;
  };
  window.setTimeout = (fn, d, ...args) => orig.setTimeout(fn, scaleDelay(d), ...args);
  window.setInterval = (fn, d, ...args) => orig.setInterval(fn, scaleDelay(d), ...args);
  // Note: an existing interval keeps the delay it was created with. Games that
  // create one long-lived setInterval pick up the scale only after it is re-created
  // (reload the page with the scale already set, or see "timers" in the recipe).

  // ---------------------------------------------------------------------------
  // WebSocket send logger (capture aid for finding the attack packet and its rate)
  // ---------------------------------------------------------------------------
  const wsLog = [];
  const logFrame = (url, data) => {
    let kind, size, preview;
    if (typeof data === 'string') {
      kind = 'text'; size = data.length; preview = data.slice(0, CONFIG.ws.previewBytes);
    } else if (data instanceof ArrayBuffer) {
      kind = 'bin'; size = data.byteLength;
      preview = toHex(new Uint8Array(data, 0, Math.min(size, CONFIG.ws.previewBytes)));
    } else if (ArrayBuffer.isView(data)) {
      kind = 'bin'; size = data.byteLength;
      preview = toHex(new Uint8Array(data.buffer, data.byteOffset, Math.min(size, CONFIG.ws.previewBytes)));
    } else {
      kind = typeof data; size = -1; preview = '';
    }
    wsLog.push({ t: Math.round(orig.perfNow()), url, kind, size, preview });
    if (wsLog.length > CONFIG.ws.logCap) wsLog.shift();
  };

  window.WebSocket = new Proxy(orig.WebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      const url = String(args[0]);
      const send = ws.send.bind(ws);
      ws.send = (data) => { logFrame(url, data); return send(data); };
      return ws;
    },
  });

  // ---------------------------------------------------------------------------
  // Attack speed module. Fully gated on config; does nothing while unset.
  // ---------------------------------------------------------------------------
  const attack = (() => {
    let enabled = false;
    let baseInterval = null;
    let rafId = 0;

    const status = () => {
      const a = CONFIG.attack;
      if (a.playerPath === null) return 'UNSET playerPath';
      if (a.cooldownField === null && a.intervalField === null) return 'UNSET cooldownField/intervalField';
      const player = resolvePath(window, a.playerPath);
      if (player === null || typeof player !== 'object') return 'playerPath does not resolve';
      if (a.cooldownField !== null && !isFiniteNumber(player[a.cooldownField])) return 'cooldownField not a finite number';
      if (a.intervalField !== null && !isFiniteNumber(player[a.intervalField])) return 'intervalField not a finite number';
      return enabled ? 'ON' : 'ready';
    };

    const tick = () => {
      rafId = orig.raf(tick);
      const s = status();
      if (s !== 'ON') { if (s !== 'ready') stop(); return; }
      const a = CONFIG.attack;
      const player = resolvePath(window, a.playerPath);
      if (a.cooldownField !== null) player[a.cooldownField] = 0;
      if (a.intervalField !== null) {
        if (baseInterval === null) baseInterval = player[a.intervalField];
        player[a.intervalField] = baseInterval / a.intervalDivisor;
      }
    };

    const stop = () => {
      enabled = false;
      const a = CONFIG.attack;
      const player = a.playerPath === null ? null : resolvePath(window, a.playerPath);
      if (player && a.intervalField !== null && baseInterval !== null) player[a.intervalField] = baseInterval;
      baseInterval = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };

    const toggle = () => {
      const s = status();
      if (s.startsWith('UNSET') || s.includes('not') || s.includes('does not')) return s;
      if (enabled) { stop(); return 'OFF'; }
      enabled = true;
      rafId = orig.raf(tick);
      return 'ON';
    };
    return { status, toggle, stop };
  })();

  // ---------------------------------------------------------------------------
  // HUD + hotkeys.  ]  faster   [  slower   \  reset to 1x   '  attack toggle
  // ---------------------------------------------------------------------------
  let hud = null;
  const render = () => {
    if (hud) hud.textContent = `speed x${clock.scale}  |  attack: ${attack.status()}`;
  };

  const stepScale = (dir) => {
    const steps = CONFIG.time.scaleSteps;
    let i = steps.findIndex((v) => v >= clock.scale - 1e-9);
    if (i < 0) i = steps.length - 1;
    i = Math.min(steps.length - 1, Math.max(0, i + dir));
    clock.setScale(steps[i]);
    render();
  };

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ']') stepScale(+1);
    else if (e.key === '[') stepScale(-1);
    else if (e.key === '\\') { clock.setScale(1); render(); }
    else if (e.key === "'") { attack.toggle(); render(); }
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:4px;left:4px;z-index:2147483647;font:12px monospace;color:#fff;background:#000a;padding:2px 6px;pointer-events:none';
    document.documentElement.appendChild(hud);
    render();
    orig.setInterval(render, 500);
  });

  window.__wrench = {
    CONFIG,
    setScale: (s) => { const ok = clock.setScale(s); render(); return ok; },
    attack,
    ws: { dump: () => wsLog.slice(), clear: () => { wsLog.length = 0; } },
    resolvePath,
  };

  // ---------------------------------------------------------------------------
  // RECIPE to fill CONFIG.attack (nothing here is verified against EP9):
  //  1. Open DevTools > Sources, find the main game bundle, search for "attack",
  //     "cooldown", "atkSpeed", "swing" and the key/click handler that fires it.
  //  2. Console: __wrench.ws.dump() after attacking ~10 times. Packets of the
  //     same size/prefix at a fixed interval are the attack packet. If the server
  //     enforces the interval, client-side attack speed will not change real rate.
  //  3. Find the object holding your character in the bundle's globals (or a
  //     module export exposed on window). Set playerPath, then the cooldown
  //     (counts down) or interval (delay between attacks) field. Confirm via
  //     __wrench.resolvePath(window, "<path>") in the console.
  //  4. Timers: if speed does not change game logic, the game likely uses its own
  //     delta from rAF timestamps (already scaled) or a Worker timer (not hooked).
  // ---------------------------------------------------------------------------
})();
