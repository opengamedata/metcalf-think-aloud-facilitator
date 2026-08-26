// Production recorder — injected into every proxied game HTML document,
// before any game script. Ports the spike recorder onto the session API:
// input -> clicks/input lanes, OGD taps -> ogd lane (cross-origin only,
// player code sniffed from responses), game canvas -> chunked webm upload.
//
// The session id arrives via window.__METCALF_SESSION (inline tag injected
// by the proxy). The clock epoch lives in sessionStorage so it survives
// in-game navigations; the parent session page sets it once.
(() => {
  if (window.__metcalfRecorder || !window.__METCALF_SESSION) return;
  window.__metcalfRecorder = true;
  const SID = window.__METCALF_SESSION;
  const API = (p) => `/api/s/${SID}/${p}`;

  if (!sessionStorage.getItem('metcalf-t0')) sessionStorage.setItem('metcalf-t0', String(Date.now()));
  const T0 = Number(sessionStorage.getItem('metcalf-t0'));
  const at = () => Date.now() - T0;
  const origFetch = window.fetch.bind(window);

  // --- batched event queue -------------------------------------------------
  let queue = [];
  const send = () => {
    if (!queue.length) return;
    const batch = queue; queue = [];
    origFetch(API('events'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }), keepalive: true,
    }).catch(() => { queue = batch.concat(queue); });
  };
  const push = (lane, ev) => { queue.push({ lane, t: at(), ...ev }); if (queue.length > 40) send(); };
  setInterval(send, 2000);
  addEventListener('visibilitychange', send);
  addEventListener('pagehide', send);

  // --- OGD tap (S1: host-strict, cross-origin only; code in RESPONSES) -----
  const OGD = /opengamedata|ogdlogger|fieldday-web|log\.fielddaylab/i;
  const BORING = /googletagmanager|google-analytics|analytics\.google|doubleclick|\.(png|jpe?g|gif|svg|ogg|mp3|wav|css|wasm|unityweb|data|json)(\?|$)/i;
  const isOgd = (s) => /^https?:\/\//i.test(s) && !s.startsWith(location.origin) && OGD.test(s) && !BORING.test(s);
  const codeIn = (text) => {
    if (typeof text !== 'string') return undefined;
    const m = text.match(/(?:user_id|player_id|player_code)"?\s*[:=]\s*"?([A-Za-z0-9_-]{2,24})/);
    return m ? m[1] : undefined;
  };
  const tap = (how, url, body) => {
    const bytes = typeof body === 'string' ? body.length : (body?.byteLength ?? body?.size ?? 0);
    push('ogd', { how, url: String(url).slice(0, 200), bytes, playerCode: codeIn(body) });
  };
  window.fetch = function (i, init) {
    const url = String((i && i.url) || i);
    const p = origFetch(i, init);
    if (isOgd(url)) {
      tap('fetch', url, init?.body);
      p.then((r) => r.clone().text()).then((text) => {
        const code = codeIn(text);
        if (code) push('ogd', { how: 'response', url: url.slice(0, 200), bytes: 0, playerCode: code });
      }).catch(() => {});
    }
    return p;
  };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = String(u); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (isOgd(this.__u)) {
      tap('xhr', this.__u, b);
      this.addEventListener('load', () => {
        const code = codeIn(this.responseText);
        if (code) push('ogd', { how: 'response', url: this.__u.slice(0, 200), bytes: 0, playerCode: code });
      });
    }
    return os.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => { if (isOgd(String(u))) tap('beacon', u, d); return ob(u, d); };
  }

  // --- input capture -------------------------------------------------------
  let n = Number(sessionStorage.getItem('metcalf-n') ?? 0);
  addEventListener('pointerdown', (e) => {
    sessionStorage.setItem('metcalf-n', String(++n));
    push('clicks', { n, x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, { capture: true });
  addEventListener('keydown', (e) => push('input', { kind: 'key', key: e.key, code: e.code }), { capture: true });
  addEventListener('wheel', (e) => push('input', {
    kind: 'wheel', x: Math.round(e.clientX), y: Math.round(e.clientY),
    dx: Math.round(e.deltaX), dy: Math.round(e.deltaY),
  }), { capture: true, passive: true });
  let lx = -1, ly = -1, lastSent = 0, stillSince = 0, dwellSent = false;
  addEventListener('pointermove', (e) => {
    const now = performance.now();
    const x = Math.round(e.clientX), y = Math.round(e.clientY);
    if (Math.hypot(x - lx, y - ly) > 8) {
      if (now - lastSent > 80) { push('input', { kind: 'move', x, y }); lastSent = now; }
      lx = x; ly = y; stillSince = now; dwellSent = false;
    } else if (!dwellSent && stillSince && now - stillSince > 350) {
      push('input', { kind: 'dwell', x: lx, y: ly, ms: Math.round(now - stillSince) });
      dwellSent = true;
    }
  }, { capture: true, passive: true });

  // --- video (S2: largest canvas, once real; 5s chunks) --------------------
  let rec = null;
  let seq = Number(sessionStorage.getItem('metcalf-seq') ?? 0);
  const tryCapture = () => {
    if (rec) return;
    const canvas = [...document.querySelectorAll('canvas')]
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas || !canvas.captureStream || canvas.width < 600) return;
    try {
      rec = new MediaRecorder(canvas.captureStream(10), { mimeType: 'video/webm' });
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        sessionStorage.setItem('metcalf-seq', String(seq + 1));
        origFetch(API(`video?seq=${seq++}&t=${at()}`), { method: 'POST', body: e.data }).catch(() => {});
      };
      rec.start(5000);
    } catch (err) { rec = null; }
  };
  const poll = setInterval(() => { tryCapture(); if (rec) clearInterval(poll); }, 1000);

  // Parent session page drives pause/resume (Q4: clock keeps running; the
  // interval is annotated via marks by the parent).
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    try {
      if (e.data.metcalf === 'pause' && rec?.state === 'recording') rec.pause();
      if (e.data.metcalf === 'resume' && rec?.state === 'paused') rec.resume();
    } catch {}
  });
})();
