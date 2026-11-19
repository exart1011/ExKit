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
  // null = UNSET (not 0).
  // ---------------------------------------------------------------------------
  const CONFIG = {
    time: {
      // Source: my choice, not game data.
      scaleSteps: [0.5, 1, 1.5, 2, 3, 4, 6, 8],
      startIndex: 1,
    },

    // Source: user's __wrench.ws.dump() capture, wss://ws7.ep9-online.com,
    // client-to-server frames only. Client build/version: unknown.
    // Framing (VERIFIED against every captured frame): u32le total length that
    // equals the byte count, then u32le opcode, then body. Opcode MEANINGS below
    // are hypotheses from the capture, not confirmed in-game.
    protocol: {
      opcodes: {
        0x019c: 'move?   len29: f32 x,y,z @8/@12/@16 (y~0.299 constant), u32=5 @20, f32 @24 (~52.28 while flag=1), u8 flag @28; ~every 200ms',
        0x2700: 'slot?   len11: u8=1, u8 0x65..0x6b, u8=0; sent twice around each 0x01c0',
        0x01c0: 'cast?   len16: u32 id (seen 0x65..0xb2), u32=2; follows 0x2700 in the same ms',
        0x2394: 'after-cast? len52 (u32le fields, assumed): [2, 0x0b, 9, id, 2, 0, 0, 0, 1, 0, 0xb33f]; id = same value as in 0x01c0; 0xb33f constant in 3/3 captures, meaning unknown; follows 0x2700 by ~17ms',
        0x23a7: 'target?  len13: u32 ~122000 slowly changing, u8=0',
        0x2609: 'ping?    len10: u16 0xea60 (60000) @8, ~every 20s',
        0x2658: 'beat?    len9, ~every 60s',
        0x00a1: 'beat2?   len21 all zero body, ~every 60s',
      },
    },

    attack: {
      // Dotted path from window to the local player object. UNSET (this is a
      // canvas game with a binary protocol; a JS-side path was not shown to me).
      playerPath: null,
      cooldownField: null,
      intervalField: null,
      intervalDivisor: 2,
    },

    replay: {
      // Opcodes of the frames to resend, in order, as one burst per tick (a
      // single skill-1 right-click was captured as the burst 0x2700, 0x01c0,
      // 0x2394 within ~20 ms). UNSET (null): which of them the server treats as
      // the cast is unknown. Suggested first test, not a result: [0x2394], then
      // add 0x01c0 / 0x2700 if the server ignores it. Example: [0x2394]
      opcodes: null,
      // Resend interval in real milliseconds. UNSET.
      intervalMs: null,
      minIntervalMs: 20,   // my floor, not game data
      maxCount: 500,       // my bound per start
    },

    ws: { logCap: 500, previewBytes: 32, gapCap: 200 },
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

  // Returns { length, opcode, view } or null when the frame does not match the
  // verified framing (length field must equal the byte count).
  const parseFrame = (data) => {
    let view;
    if (data instanceof ArrayBuffer) view = new DataView(data);
    else if (ArrayBuffer.isView(data)) view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    else return null;
    if (view.byteLength < 8) return null;
    const length = view.getUint32(0, true);
    if (length !== view.byteLength) return null;
    return { length, opcode: view.getUint32(4, true), view };
  };

  const median = (xs) => {
    if (xs.length === 0) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const toBytes = (data) => {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return null;
  };

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
    clearInterval: window.clearInterval.bind(window),
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
  // An interval keeps the delay it was created with. If the game builds its
  // 200ms movement timer once at startup, set the scale before the game starts
  // (reload with the scale already chosen) or the timer rate will not follow.

  // ---------------------------------------------------------------------------
  // WebSocket capture: outgoing + incoming frames, per-opcode timing, and the
  // last outgoing frame per opcode (with its socket) for the replay module.
  // ---------------------------------------------------------------------------
  const wsLog = [];
  const stats = new Map();          // "dir:opcode" -> { dir, opcode, count, lastT, gaps[] }
  const lastOut = new Map();        // opcode -> { socket, rawSend, bytes }

  const pushLog = (entry) => {
    wsLog.push(entry);
    if (wsLog.length > CONFIG.ws.logCap) wsLog.shift();
  };

  const record = (dir, url, data) => {
    const t = Math.round(orig.perfNow());
    const bytes = toBytes(data);
    if (bytes === null) {
      pushLog({ t, dir, url, kind: typeof data, size: -1, opcode: null, preview: '' });
      return null;
    }
    const f = parseFrame(bytes);
    const opcode = f ? f.opcode : null;
    pushLog({
      t, dir, url, kind: 'bin', size: bytes.length,
      opcode: opcode === null ? null : '0x' + opcode.toString(16).padStart(4, '0'),
      framed: f !== null,
      preview: toHex(bytes.subarray(0, CONFIG.ws.previewBytes)),
    });
    if (opcode !== null) {
      const key = dir + ':' + opcode;
      let s = stats.get(key);
      if (!s) { s = { dir, opcode, count: 0, lastT: null, gaps: [] }; stats.set(key, s); }
      s.count += 1;
      if (s.lastT !== null) {
        s.gaps.push(t - s.lastT);
        if (s.gaps.length > CONFIG.ws.gapCap) s.gaps.shift();
      }
      s.lastT = t;
    }
    return { opcode, bytes };
  };

  window.WebSocket = new Proxy(orig.WebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      const url = String(args[0]);
      const rawSend = ws.send.bind(ws);
      ws.send = (data) => {
        const r = record('out', url, data);
        if (r && r.opcode !== null) lastOut.set(r.opcode, { socket: ws, rawSend, bytes: r.bytes, url });
        return rawSend(data);
      };
      ws.addEventListener('message', (ev) => {
        const d = ev.data;
        if (d instanceof ArrayBuffer) record('in', url, d);
        else if (typeof Blob !== 'undefined' && d instanceof Blob) d.arrayBuffer().then((ab) => record('in', url, ab)).catch(() => {});
        else pushLog({ t: Math.round(orig.perfNow()), dir: 'in', url, kind: typeof d, size: -1, opcode: null, preview: String(d).slice(0, CONFIG.ws.previewBytes) });
      });
      return ws;
    },
  });

  const wsStats = () => Array.from(stats.values())
    .map((s) => ({
      dir: s.dir,
      opcode: '0x' + s.opcode.toString(16).padStart(4, '0'),
      count: s.count,
      minGapMs: s.gaps.length ? Math.min(...s.gaps) : null,
      medianGapMs: median(s.gaps),
      note: s.dir === 'out' ? (CONFIG.protocol.opcodes[s.opcode] || 'unknown') : '',
    }))
    .sort((a, b) => b.count - a.count);

  // ---------------------------------------------------------------------------
  // Replay: resend the last captured outgoing frame of each CONFIG.replay.opcodes entry at a
  // fixed real-time interval. Gated on config; stops on window blur, socket
  // close, count limit or stop(). The frame is sent byte-for-byte as captured,
  // so anything inside it (position, target id) is as stale as the capture.
  // ---------------------------------------------------------------------------
  const replay = (() => {
    let timer = 0;
    let sent = 0;

    const status = () => {
      const r = CONFIG.replay;
      const base = burstStatus();
      if (base !== 'ready') return base;
      if (r.intervalMs === null) return 'UNSET intervalMs';
      if (!isFiniteNumber(r.intervalMs) || r.intervalMs < r.minIntervalMs) return 'intervalMs below floor';
      return timer ? 'ON' : 'ready';
    };

    // Checks everything except the interval, so once() works without one.
    const burstStatus = () => {
      const r = CONFIG.replay;
      if (!Array.isArray(r.opcodes) || r.opcodes.length === 0) return 'UNSET opcodes';
      for (const op of r.opcodes) {
        const cap = lastOut.get(op);
        if (!cap) return 'no captured frame for 0x' + op.toString(16) + ' yet';
        if (cap.socket.readyState !== 1) return 'socket not open';
      }
      return 'ready';
    };

    // Send the last captured frame of each configured opcode, byte-for-byte, in order.
    const sendBurst = () => {
      for (const op of CONFIG.replay.opcodes) {
        const cap = lastOut.get(op);
        if (!cap || cap.socket.readyState !== 1) return false;
        cap.rawSend(cap.bytes.slice());
        // rawSend bypasses the ws.send hook, so log replays here (replayed:true).
        pushLog({
          t: Math.round(orig.perfNow()), dir: 'out', url: cap.url, kind: 'bin', size: cap.bytes.length,
          opcode: '0x' + op.toString(16).padStart(4, '0'), framed: true, replayed: true,
          preview: toHex(cap.bytes.subarray(0, CONFIG.ws.previewBytes)),
        });
      }
      return true;
    };

    // One manual test shot, no timer: use this first to see if the server reacts.
    const once = () => {
      const s = burstStatus();
      return s === 'ready' ? (sendBurst() ? 'sent' : 'failed') : s;
    };

    const stop = () => {
      if (timer) { orig.clearInterval(timer); timer = 0; }
      sent = 0;
    };

    const start = () => {
      const s = status();
      if (s !== 'ready') return s;
      const r = CONFIG.replay;
      timer = orig.setInterval(() => {
        if (sent >= r.maxCount || !sendBurst()) { stop(); return; }
        sent += 1;
      }, r.intervalMs);
      return 'ON';
    };

    window.addEventListener('blur', stop);
    return { status, once, start, stop, toggle: () => (timer ? (stop(), 'OFF') : start()) };
  })();

  // ---------------------------------------------------------------------------
  // Attack speed module (client-state fields). Fully gated on config.
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
  // HUD + hotkeys.  ]  faster   [  slower   \  1x   '  field attack   ;  packet replay
  // ---------------------------------------------------------------------------
  let hud = null;
  const render = () => {
    if (hud) hud.textContent = `speed x${clock.scale} | field-attack: ${attack.status()} | replay: ${replay.status()}`;
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
    else if (e.key === ';') { replay.toggle(); render(); }
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
    replay,
    ws: {
      dump: () => wsLog.slice(),
      clear: () => { wsLog.length = 0; stats.clear(); },
      stats: wsStats,
    },
    parseFrame,
    resolvePath,
  };

  // ---------------------------------------------------------------------------
  // RECIPE to finish attack speed:
  //  1. __wrench.ws.clear(), then do ONE action repeatedly (e.g. only basic
  //     attacks, or only skill key 1) for ~10 uses, then run
  //     console.table(__wrench.ws.stats()). The opcode whose count tracks your
  //     uses (and is not 0x019c movement or a heartbeat) is the attack/cast.
  //  2. Put that opcode in CONFIG.replay.opcodes ([0x2394] etc.) and a real-time interval in
  //     CONFIG.replay.intervalMs, then use ';' to toggle. Watch the 'in' rows
  //     in __wrench.ws.dump() for the server's reaction (accept vs. ignore).
  //  3. If the server ignores faster casts, attack speed is enforced
  //     server-side and only the cast rate it allows can be reached.
  // ---------------------------------------------------------------------------
})();
