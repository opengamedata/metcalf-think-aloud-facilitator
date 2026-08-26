// Spike recorder — injected into proxied game HTML before any game script.
// Three jobs, all ported from proven ai-playtester code:
//   1. input capture (cowatch.mjs init script): clicks, keys, wheel, dwells
//   2. OGD tap (telemetry.mjs): patch fetch/XHR/sendBeacon, count log posts,
//      sniff the player code from payloads
//   3. video (spike 02): canvas.captureStream -> MediaRecorder -> 5s chunks
(() => {
  if (window.__metcalfRecorder) return;
  window.__metcalfRecorder = true;

  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const origFetch = window.fetch.bind(window);

  // --- event queue ---------------------------------------------------------
  let queue = [];
  const send = () => {
    if (!queue.length) return;
    const batch = queue; queue = [];
    origFetch('/spike-events', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch), keepalive: true,
    }).catch(() => { queue = batch.concat(queue); });
  };
  const push = (ev) => { queue.push({ t: at(), ...ev }); if (queue.length > 40) send(); };
  setInterval(send, 1000);
  addEventListener('visibilitychange', send);
  push({ kind: 'init', url: location.href, ua: navigator.userAgent });

  // --- OGD tap (before any game script runs) -------------------------------
  // Hosts/paths that carry Open Game Data traffic (fieldday-web.wcer.wisc.edu
  // /wsgi-bin/opengamedata.wsgi/... observed live from Field Day games), vs.
  // everything that must never count: analytics beacons and static assets.
  const OGD = /opengamedata|ogdlogger|fieldday-web|log\.fielddaylab/i;
  const BORING = /googletagmanager|google-analytics|analytics\.google|doubleclick|\/spike-|\.(png|jpe?g|gif|svg|ogg|mp3|wav|css|wasm|unityweb|data|json)(\?|$)/i;
  const codeFrom = (body) => {
    if (typeof body !== 'string') return undefined;
    const m = body.match(/(?:user_id|player_id|player_code)"?\s*[:=]\s*"?([A-Za-z0-9_-]{2,24})/);
    return m ? m[1] : undefined;
  };
  const tap = (how, url, body) => {
    try {
      const s = String(url);
      if (BORING.test(s) || !OGD.test(s)) return;
      const bytes = typeof body === 'string' ? body.length : (body?.byteLength ?? body?.size ?? 0);
      push({ kind: 'ogd', how, url: s.slice(0, 200), bytes, playerCode: codeFrom(body) });
    } catch {}
  };
  window.fetch = function (i, init) { tap('fetch', (i && i.url) || i, init?.body); return origFetch(i, init); };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) { tap('xhr', this.__u, b); return os.apply(this, arguments); };
  if (navigator.sendBeacon) {
    const ob = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (u, d) => { tap('beacon', u, d); return ob(u, d); };
  }

  // --- input capture (cowatch port) ----------------------------------------
  let n = 0;
  addEventListener('pointerdown', (e) => {
    push({ kind: 'click', n: ++n, x: Math.round(e.clientX), y: Math.round(e.clientY) });
  }, { capture: true });
  addEventListener('keydown', (e) => push({ kind: 'key', key: e.key, code: e.code }), { capture: true });
  addEventListener('wheel', (e) => push({
    kind: 'wheel', x: Math.round(e.clientX), y: Math.round(e.clientY),
    dx: Math.round(e.deltaX), dy: Math.round(e.deltaY),
  }), { capture: true, passive: true });

  let lx = -1, ly = -1, lastSent = 0, stillSince = 0, dwellSent = false;
  addEventListener('pointermove', (e) => {
    const now = performance.now();
    const x = Math.round(e.clientX), y = Math.round(e.clientY);
    if (Math.hypot(x - lx, y - ly) > 8) {
      if (now - lastSent > 80) { push({ kind: 'move', x, y }); lastSent = now; }
      lx = x; ly = y; stillSince = now; dwellSent = false;
    } else if (!dwellSent && stillSince && now - stillSince > 350) {
      push({ kind: 'dwell', x: lx, y: ly, ms: Math.round(now - stillSince) });
      dwellSent = true;
    }
  }, { capture: true, passive: true });

  // --- video (spike 02): first canvas that appears -------------------------
  // The game canvas is the LARGEST one, and only once it has real size —
  // helper scripts (html2canvas, snapshot tools) create small decoy canvases
  // first, and Wake's decoy (300x150) is exactly what a naive querySelector
  // grabs before Unity boots.
  let recording = false;
  const tryCapture = () => {
    if (recording) return;
    const canvas = [...document.querySelectorAll('canvas')]
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!canvas || !canvas.captureStream || canvas.width < 600) return;
    try {
      const stream = canvas.captureStream(10);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      let seq = 0;
      const chunkT0 = at();
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        origFetch(`/spike-video?seq=${seq++}&t=${at()}`, { method: 'POST', body: e.data }).catch(() => {});
      };
      rec.start(5000);
      recording = true;
      push({ kind: 'video', state: 'recording', canvas: `${canvas.width}x${canvas.height}`, t0: chunkT0 });
    } catch (err) {
      push({ kind: 'video', state: 'error', error: String(err).slice(0, 120) });
    }
  };
  const poll = setInterval(() => { tryCapture(); if (recording) clearInterval(poll); }, 1000);
})();
