// ==UserScript==
// @name         EP9 Wrench: speed + range x1.5
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

    // Skill attack range = 1.5x normal. Client-state field only (gated): window
    // path to an object + numeric range field. Both UNSET: no range field was
    // identified in any capture or file I have seen.
    range: { multiplier: 1.5, playerPath: null, rangeField: null },

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
  // WebSocket capture: outgoing + incoming frames and per-opcode timing.
  // ---------------------------------------------------------------------------
  const wsLog = [];
  const stats = new Map();          // "dir:opcode" -> { dir, opcode, count, lastT, gaps[] }

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
        record('out', url, data);
        return rawSend(data);
      };
      const nativeAdd = ws.addEventListener.bind(ws);
      nativeAdd('message', (ev) => {
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

  // Skill attack range multiplier (client-state field, gated on CONFIG.range).
  const range = (() => {
    let enabled = false;
    let base = null;
    let rafId = 0;
    const cfgSet = () => CONFIG.range.playerPath !== null && CONFIG.range.rangeField !== null;
    const target = () => (cfgSet() ? resolvePath(window, CONFIG.range.playerPath) : undefined);

    const status = () => {
      const r = CONFIG.range;
      if (!isFiniteNumber(r.multiplier) || r.multiplier <= 0) return 'bad multiplier';
      if (!cfgSet()) return 'UNSET playerPath/rangeField';
      const o = target();
      if (o === null || typeof o !== 'object') return 'playerPath does not resolve';
      if (!isFiniteNumber(o[r.rangeField])) return 'rangeField not a finite number';
      return enabled ? 'ON' : 'ready';
    };
    const tick = () => {
      rafId = orig.raf(tick);
      const o = target();
      if (!enabled || !o || !isFiniteNumber(o[CONFIG.range.rangeField])) return;
      if (base === null) base = o[CONFIG.range.rangeField];
      o[CONFIG.range.rangeField] = base * CONFIG.range.multiplier;
    };
    const stop = () => {
      enabled = false;
      const o = target();
      if (base !== null && o && typeof o === 'object') o[CONFIG.range.rangeField] = base;
      base = null;
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };
    const toggle = () => {
      const st = status();
      if (st === 'ON') { stop(); return 'OFF'; }
      if (st !== 'ready') return st;
      enabled = true;
      rafId = orig.raf(tick);
      return 'ON';
    };
    return { status, toggle, stop };
  })();

  // Walk own data properties of window (cycle-safe, bounded) and list the paths
  // whose numeric value equals `value`. Accessors are not invoked, DOM nodes and
  // typed arrays are skipped. Use it with a number the game shows you (e.g. a
  // skill's range). A hit is a lead, not proof of what the field is. If the game
  // keeps its state in closures, nothing under window will match.
  const scan = (value, opts = {}) => {
    const maxDepth = opts.maxDepth === undefined ? 4 : opts.maxDepth;
    const maxNodes = opts.maxNodes === undefined ? 30000 : opts.maxNodes;
    const eps = opts.eps === undefined ? 1e-6 : opts.eps;
    const seen = new WeakSet();
    const hits = [];
    let nodes = 0;
    const walk = (obj, path, depth) => {
      if (depth > maxDepth) return;
      let keys;
      try { keys = Object.getOwnPropertyNames(obj); } catch (e) { return; }
      for (const k of keys) {
        if (nodes >= maxNodes) return;
        nodes += 1;
        if (depth === 0 && k === '__wrench') continue;
        let d;
        try { d = Object.getOwnPropertyDescriptor(obj, k); } catch (e) { continue; }
        if (!d || !('value' in d)) continue;
        const v = d.value;
        const p = path ? path + '.' + k : k;
        if (typeof v === 'number') {
          if (Math.abs(v - value) <= eps) hits.push({ path: p, value: v });
        } else if (v !== null && typeof v === 'object' && !seen.has(v)) {
          if (typeof Node !== 'undefined' && v instanceof Node) continue;
          if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
          seen.add(v);
          walk(v, p, depth + 1);
        }
      }
    };
    walk(window, '', 0);
    return { hits, nodes, truncated: nodes >= maxNodes };
  };

  // Search logged frame previews for a number (e.g. the damage you saw on
  // screen) as u16 / u32 / f32 little-endian at every byte offset. Raise
  // CONFIG.ws.previewBytes first (e.g. 256) so previews hold whole frames.
  const find = (value) => {
    const hits = [];
    for (const e of wsLog) {
      if (!e.preview) continue;
      const bytes = Uint8Array.from(e.preview.split(' '), (h) => parseInt(h, 16));
      const dv = new DataView(bytes.buffer);
      for (let o = 0; o + 2 <= bytes.length; o++) {
        const add = (type) => hits.push({ t: e.t, dir: e.dir, opcode: e.opcode, offset: o, type });
        if (dv.getUint16(o, true) === value) add('u16');
        if (o + 4 <= bytes.length) {
          if (dv.getUint32(o, true) === value) add('u32');
          if (Math.abs(dv.getFloat32(o, true) - value) < 1e-3) add('f32');
        }
      }
    }
    return hits;
  };

  // ---------------------------------------------------------------------------
  // HUD + hotkeys.  ]  faster   [  slower   \  1x    ;  range on/off
  // ---------------------------------------------------------------------------
  let hud = null;
  const render = () => {
    if (hud) hud.textContent = `speed x${clock.scale} | range x${CONFIG.range.multiplier}: ${range.status()}`;
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
    else if (e.key === ';') { range.toggle(); render(); }
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
    range,
    ws: {
      dump: () => wsLog.slice(),
      clear: () => { wsLog.length = 0; stats.clear(); },
      stats: wsStats,
      find,
    },
    scan,
    parseFrame,
    resolvePath,
  };
})();
