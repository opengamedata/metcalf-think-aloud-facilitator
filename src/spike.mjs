// M1 manual-spike routes, served through the production tunnel so S3 (Web
// Speech) and S4 (Chromebook) can be run from any participant device with
// zero setup:
//
//   /spike/speech   — mic + continuous recognition test page
//   /spike/play/…   — Wake proxied with the recorder injected (S1+S2 live)
//   /spike/status   — JSON counters so results are readable remotely
//
// Results are held in memory only — these are spikes, not sessions.

import fs from 'node:fs';
import path from 'node:path';

const GAME = new URL(process.env.SPIKE_GAME_URL ?? 'https://fielddaylab.org/play/wake/ci/production/');
const RECORDER = fs.readFileSync(path.join(import.meta.dirname, '..', 'spike', 'recorder.js'), 'utf8');

const state = {
  startedAt: new Date().toISOString(),
  counts: {}, videoChunks: 0, videoBytes: 0,
  speech: [], last: [],
};
const note = (ev) => {
  state.counts[ev.kind] = (state.counts[ev.kind] ?? 0) + 1;
  state.last.push(ev); if (state.last.length > 50) state.last.shift();
};

const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'content-security-policy',
  'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security']);

const SPEECH_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>metcalf · speech spike</title>
<style>
  body{margin:0;background:#10151a;color:#e6e9ec;font:16px/1.5 system-ui;padding:2rem;max-width:44rem;margin-inline:auto}
  h1{font-size:1.2rem;color:#4fb3c0}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#555;margin-right:6px}
  .on{background:#6eb891}.err{background:#e4735c}
  #log{margin-top:1rem;border-top:1px solid #26303a;padding-top:1rem}
  .line{margin:.2rem 0}.line .t{color:#93a0ab;font:12px ui-monospace,monospace;margin-right:8px}
  #interim{color:#93a0ab;font-style:italic}
  button{background:#4fb3c0;color:#06222a;border:0;border-radius:5px;padding:.6rem 1.2rem;font-weight:600;font-size:1rem;cursor:pointer}
  #env{font:12px ui-monospace,monospace;color:#93a0ab;margin-top:.6rem}
</style>
<h1>Speech spike (S3)</h1>
<p>Press start, allow the mic, and narrate for a few minutes with deliberate
silences. Finals are timestamped and reported; interim text shows below.</p>
<button id="go">Start listening</button>
<div id="env"></div>
<p><span class="dot" id="mic"></span><span id="micTxt">idle</span></p>
<div id="log"><div id="interim"></div></div>
<script>
const $=(s)=>document.querySelector(s);
$('#env').textContent = navigator.userAgent + ' · secure=' + isSecureContext;
const clock=(ms)=>{const s=Math.round(ms/1000);return (s/60|0)+':'+String(s%60).padStart(2,'0')};
const T0=Date.now();
const report=(text,t)=>fetch('/spike-events',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify([{kind:'speech',t,text}])}).catch(()=>{});
const addLine=(text,t)=>{const e=document.createElement('div');e.className='line';
  e.innerHTML='<span class="t">'+clock(t)+'</span>'+text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  $('#log').insertBefore(e,$('#interim'));};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
if(!SR){$('#micTxt').textContent='SpeechRecognition NOT SUPPORTED in this browser';$('#mic').className='dot err';
  report('[unsupported] '+navigator.userAgent,0);}
$('#go').onclick=()=>{
  if(!SR)return;
  const r=new SR(); r.continuous=true; r.interimResults=true; r.lang='en-US';
  r.onresult=(ev)=>{let interim='';
    for(let i=ev.resultIndex;i<ev.results.length;i++){
      const res=ev.results[i],txt=res[0].transcript.trim();
      if(res.isFinal&&txt){const t=Date.now()-T0;addLine(txt,t);report(txt,t);}
      else interim+=txt+' ';
    }
    $('#interim').textContent=interim;
  };
  r.onerror=(e)=>{$('#mic').className='dot err';$('#micTxt').textContent='error: '+e.error;report('[error] '+e.error,Date.now()-T0);};
  r.onend=()=>{try{r.start()}catch{}};
  try{r.start();$('#mic').className='dot on';$('#micTxt').textContent='listening';report('[started]',Date.now()-T0);}
  catch(e){$('#micTxt').textContent='failed: '+e}
};
</script>`;

/** Returns true if the request was handled. */
export async function spikeRoutes(req, res, u) {
  if (u.pathname === '/recorder.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(RECORDER);
    return true;
  }
  if (u.pathname === '/spike/speech') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SPEECH_PAGE);
    return true;
  }
  if (u.pathname === '/spike/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state, null, 2));
    return true;
  }
  if (req.method === 'POST' && u.pathname === '/spike-events') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        for (const ev of JSON.parse(body)) {
          note(ev);
          if (ev.kind === 'speech') state.speech.push({ t: ev.t, text: ev.text });
        }
      } catch {}
      res.writeHead(204); res.end();
    });
    return true;
  }
  if (req.method === 'POST' && u.pathname === '/spike-video') {
    let bytes = 0;
    req.on('data', (d) => (bytes += d.length));
    req.on('end', () => {
      state.videoChunks += 1; state.videoBytes += bytes;
      res.writeHead(204); res.end();
    });
    return true;
  }

  // /spike/play/... proxies the demo game with the recorder injected. A
  // request that escaped the prefix (absolute-path asset reference) is only
  // recognized by its referer — everything else stays with the app server.
  const isPlay = u.pathname.startsWith('/spike/play');
  const escaped = (req.headers.referer ?? '').includes('/spike/play');
  if (!isPlay && !escaped) return false;

  const rest = isPlay ? u.pathname.replace(/^\/spike\/play\/?/, '') : u.pathname.slice(1);
  const hdrs = { 'user-agent': req.headers['user-agent'] ?? 'metcalf-spike' };
  let r;
  try {
    r = await fetch(new URL(rest + u.search, GAME), { headers: hdrs });
    if (r.status === 404 && rest) r = await fetch(new URL('/' + rest + u.search, GAME.origin), { headers: hdrs });
  } catch (e) {
    res.writeHead(502); res.end(String(e));
    return true;
  }
  const ct = r.headers.get('content-type') ?? '';
  const headers = {};
  for (const [k, v] of r.headers) if (!DROP.has(k.toLowerCase())) headers[k] = v;
  if (ct.includes('text/html')) {
    let html = await r.text();
    const tag = '<script src="/recorder.js"></script>';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
    res.writeHead(r.status, { ...headers, 'content-type': ct });
    res.end(html);
    return true;
  }
  res.writeHead(r.status, headers);
  if (r.body) for await (const chunk of r.body) res.write(chunk);
  res.end();
  return true;
}
