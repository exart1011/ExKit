// ==UserScript==
// @name         EP9 Wrench: speed + damage x2 + range x1.5
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

    // Damage output multiplier. Both mechanisms are gated: each needs values that
    // come from the game, and none was supplied, so all are UNSET (null).
    // Observed so far (user capture): outgoing frames 0x01c0 / 0x2394 contain ids
    // and small constants, no value identified as damage. Where damage lives is
    // unknown; use __wrench.ws.find(<on-screen damage number>) to look for it.
    damage: {
      multiplier: 2,
      // Mechanism A, client-state field: window path to an object + the name of a
      // numeric damage field on it. Multiplied from its captured base value.
      playerPath: null,
      damageField: null,
      // Mechanism B, outgoing-packet field: the opcode (number, e.g. 0x2394), the
      // byte offset FROM THE START OF THE FRAME (header is 8 bytes), and the type
      // ('u16' | 'u32' | 'f32', little-endian). Multiplied in a copy before send.
      packet: { opcode: null, offset: null, type: null },
      // Mechanism C, INCOMING packet field (what the client receives and shows).
      // Source: user capture. Typed damage 5053 = 0x13bd was found at frame offset
      // 12 of inbound opcode 0x02ed (len 25: [id 0xb1][5053][0][0xb33f]), inside
      // a message batched with a 0x0379 frame. That 0x02ed is a damage report is
      // my reading of one hit, NOT confirmed. This changes what the client
      // receives, not what the server computed.
      // A list: one entry per inbound frame kind that carries a damage number.
      //  - 0x02ed @12: 5053 (monster hit, user capture).
      //  - 0x2555 @16: person hit, user typed 1459 = 0x05b3 and it sits at frame
      //    offset 16 in 3 captures (len 34: [0xb33f][0x12716][1459][x][0x17a7][0x100]);
      //    the field at @20 changes per hit (2903, 4596) and is NOT doubled.
      // That these are damage reports is my reading of the matches, not confirmed.
      incoming: [
        { opcode: 0x02ed, offset: 12, type: 'u32' },
        { opcode: 0x2555, offset: 16, type: 'u32' },
      ],
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
        return rawSend(damage.patchOut(data));
      };
      const nativeAdd = ws.addEventListener.bind(ws);
      const nativeRemove = ws.removeEventListener.bind(ws);
      const wrapped = new Map();   // page fn -> wrapped fn
      const wrap = (fn) => {
        if (typeof fn !== 'function') return fn;
        if (!wrapped.has(fn)) wrapped.set(fn, function (ev) { return fn.call(this, damage.patchIn(ev)); });
        return wrapped.get(fn);
      };
      ws.addEventListener = (type, fn, opts) => nativeAdd(type, type === 'message' ? wrap(fn) : fn, opts);
      ws.removeEventListener = (type, fn, opts) => nativeRemove(type, type === 'message' && wrapped.has(fn) ? wrapped.get(fn) : fn, opts);
      const omDesc = Object.getOwnPropertyDescriptor(orig.WebSocket.prototype, 'onmessage');
      if (omDesc && omDesc.set) {
        let pageOnMessage = null;
        Object.defineProperty(ws, 'onmessage', {
          configurable: true,
          get: () => pageOnMessage,
          set: (fn) => { pageOnMessage = fn; omDesc.set.call(ws, typeof fn === 'function' ? wrap(fn) : fn); },
        });
      }
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

  // ---------------------------------------------------------------------------
  // Damage output multiplier. Fully gated on config (see CONFIG.damage).
  //  A) client field: multiplies a numeric field on window[playerPath].
  //  B) outgoing packet: multiplies one field of one opcode in a copy of the frame.
  // ---------------------------------------------------------------------------
  const damage = (() => {
    let enabled = false;
    let base = null;
    let rafId = 0;
    let patched = 0;

    const fieldCfg = () => { const d = CONFIG.damage; return d.playerPath !== null && d.damageField !== null; };
    const pktCfg = () => { const p = CONFIG.damage.packet; return p.opcode !== null && p.offset !== null && p.type !== null; };
    const incList = () => (Array.isArray(CONFIG.damage.incoming) ? CONFIG.damage.incoming.filter((p) => p && p.opcode !== null && p.offset !== null && p.type !== null) : []);
    const incCfg = () => incList().length > 0;
    let incPatched = 0;
    let incBlobSkipped = 0;
    const SIZES = { u16: 2, u32: 4, f32: 4 };

    const status = () => {
      const d = CONFIG.damage;
      if (!isFiniteNumber(d.multiplier) || d.multiplier <= 0) return 'bad multiplier';
      if (!fieldCfg() && !pktCfg() && !incCfg()) return 'UNSET field/packet/incoming';
      if (d.playerPath !== null && d.damageField !== null) {
        const player = resolvePath(window, d.playerPath);
        if (player === null || typeof player !== 'object') return 'playerPath does not resolve';
        if (!isFiniteNumber(player[d.damageField])) return 'damageField not a finite number';
      }
      if (pktCfg() && !(d.packet.type in SIZES)) return 'packet.type invalid';
      if (incList().some((p) => !(p.type in SIZES))) return 'incoming.type invalid';
      return enabled ? 'ON' : 'ready';
    };

    const tick = () => {
      rafId = orig.raf(tick);
      if (!enabled || !fieldCfg()) return;
      const d = CONFIG.damage;
      const player = resolvePath(window, d.playerPath);
      if (!player || !isFiniteNumber(player[d.damageField])) return;
      if (base === null) base = player[d.damageField];
      player[d.damageField] = base * d.multiplier;
    };

    const restore = () => {
      const d = CONFIG.damage;
      if (base !== null && d.playerPath !== null && d.damageField !== null) {
        const player = resolvePath(window, d.playerPath);
        if (player && typeof player === 'object') player[d.damageField] = base;
      }
      base = null;
    };

    const stop = () => {
      enabled = false;
      restore();
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };

    const toggle = () => {
      const s = status();
      if (s === 'ON') { stop(); return 'OFF'; }
      if (s !== 'ready') return s;
      enabled = true;
      patched = 0;
      incPatched = 0;
      incBlobSkipped = 0;
      if (fieldCfg()) rafId = orig.raf(tick);
      return 'ON';
    };

    // Called for every outgoing message. Returns the original data unless it is
    // the configured opcode, in which case it returns a patched copy.
    const patchOut = (data) => {
      if (!enabled || !pktCfg()) return data;
      const p = CONFIG.damage.packet;
      const size = SIZES[p.type];
      if (!size) return data;
      const bytes = toBytes(data);
      if (bytes === null) return data;
      const f = parseFrame(bytes);
      if (!f || f.opcode !== p.opcode) return data;
      if (p.offset < 8 || p.offset + size > bytes.length) return data;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const m = CONFIG.damage.multiplier;
      if (p.type === 'f32') view.setFloat32(p.offset, view.getFloat32(p.offset, true) * m, true);
      else if (p.type === 'u32') view.setUint32(p.offset, Math.min(0xffffffff, Math.round(view.getUint32(p.offset, true) * m)), true);
      else view.setUint16(p.offset, Math.min(0xffff, Math.round(view.getUint16(p.offset, true) * m)), true);
      patched += 1;
      return bytes;
    };

    const mulAt = (view, offset, type) => {
      const m = CONFIG.damage.multiplier;
      if (type === 'f32') view.setFloat32(offset, view.getFloat32(offset, true) * m, true);
      else if (type === 'u32') view.setUint32(offset, Math.min(0xffffffff, Math.round(view.getUint32(offset, true) * m)), true);
      else view.setUint16(offset, Math.min(0xffff, Math.round(view.getUint16(offset, true) * m)), true);
    };

    // Wraps a page message handler so it receives the event with patched data.
    // A message may hold several frames back to back, so each is walked by its
    // length field. Only ArrayBuffer data is patched (Blob data is counted).
    const patchIn = (ev) => {
      if (!enabled || !incCfg()) return ev;
      const d = ev.data;
      if (typeof Blob !== 'undefined' && d instanceof Blob) { incBlobSkipped += 1; return ev; }
      if (!(d instanceof ArrayBuffer)) return ev;
      const targets = incList();
      const buf = d.slice(0);
      const view = new DataView(buf);
      let hit = false;
      for (let off = 0; off + 8 <= buf.byteLength;) {
        const flen = view.getUint32(off, true);
        if (flen < 8 || off + flen > buf.byteLength) break;
        const op = view.getUint32(off + 4, true);
        for (const p of targets) {
          const size = SIZES[p.type];
          if (size && op === p.opcode && p.offset >= 8 && p.offset + size <= flen) {
            mulAt(view, off + p.offset, p.type);
            incPatched += 1;
            hit = true;
          }
        }
        off += flen;
      }
      if (!hit) return ev;
      return new Proxy(ev, {
        get(t, k) {
          if (k === 'data') return buf;
          const v = Reflect.get(t, k, t);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    };

    return {
      status, toggle, stop, patchOut, patchIn,
      get patched() { return patched; },
      get incomingPatched() { return incPatched; },
      get incomingBlobSkipped() { return incBlobSkipped; },
    };
  })();

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
  // HUD + hotkeys.  ]  faster   [  slower   \  1x   '  damage on/off   ;  range on/off
  // ---------------------------------------------------------------------------
  let hud = null;
  const render = () => {
    if (hud) hud.textContent = `speed x${clock.scale} | damage x${CONFIG.damage.multiplier}: ${damage.status()} | range x${CONFIG.range.multiplier}: ${range.status()}`;
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
    else if (e.key === "'") { damage.toggle(); render(); }
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
    damage,
    range,
    ws: {
      dump: () => wsLog.slice(),
      clear: () => { wsLog.length = 0; stats.clear(); },
      stats: wsStats,
      find,
    },
    parseFrame,
    resolvePath,
  };

  // ---------------------------------------------------------------------------
  // RECIPE to find where damage lives (nothing below is known yet):
  //  1. __wrench.CONFIG.ws.previewBytes = 256; __wrench.ws.clear()
  //  2. Hit something once and note the exact damage number on screen (N).
  //  3. __wrench.ws.find(N). A hit on an 'in' frame means the server reports the
  //     damage (client multiplication cannot change what the server computed). A
  //     hit on an 'out' frame gives opcode + offset + type for CONFIG.damage.packet.
  //  4. For a client-side number, give CONFIG.damage.playerPath/damageField from
  //     the game bundle instead. Then ' toggles it; HUD shows the status.
  // ---------------------------------------------------------------------------
})();
