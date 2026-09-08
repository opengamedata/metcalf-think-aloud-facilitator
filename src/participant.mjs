// Participant-facing surface (PLAN §2): /c/<slug> instructions+consent,
// /play/<sessionId> session page, /g/<sessionId>/* game proxy with recorder
// injection and an immutable-asset disk cache (cohort starts must not
// re-download a 100MB Unity build per player).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sessionDir } from './store.mjs';

const SID = /^[a-f0-9]{16}$/;

// Minimal, safe markdown: escape everything, then allow ##/###, **bold**,
// *italic*, - lists, and blank-line paragraphs. Researcher text only.
export function md(src) {
  const esc = String(src ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const blocks = esc.split(/\n\s*\n/).map((b) => {
    const lines = b.trim().split('\n');
    if (lines.every((l) => /^- /.test(l))) return '<ul>' + lines.map((l) => `<li>${l.slice(2)}</li>`).join('') + '</ul>';
    if (/^### /.test(b)) return `<h3>${b.slice(4)}</h3>`;
    if (/^## /.test(b)) return `<h2>${b.slice(3)}</h2>`;
    return `<p>${lines.join('<br>')}</p>`;
  });
  return blocks.join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// Mic health vocabulary. Extends the existing .dot/.on/.err dot classes with a
// .warn level; one map so the page, the marks lane and the tests agree on what
// a dead microphone looks like.
export const MIC_STATES = {
  idle: { cls: 'dot', text: 'mic idle', level: 'idle' },
  listening: { cls: 'dot on', text: 'listening', level: 'ok' },
  paused: { cls: 'dot', text: 'paused', level: 'idle' },
  silent: { cls: 'dot warn', text: 'no sound detected \u2014 check your microphone', level: 'warn' },
  denied: { cls: 'dot err', text: 'microphone blocked \u2014 typing still works', level: 'err' },
  error: { cls: 'dot err', text: 'mic error \u2014 typing still works', level: 'err' },
  unsupported: { cls: 'dot err', text: 'no speech support \u2014 type instead', level: 'err' },
};

export function micState(state, detail) {
  const s = MIC_STATES[state] ?? MIC_STATES.idle;
  if (state === 'error' && detail) return { cls: s.cls, level: s.level, text: 'mic error: ' + detail + ' \u2014 typing still works' };
  return { cls: s.cls, level: s.level, text: s.text };
}

// How long a listening mic may stay silent before we call it broken.
export const SILENT_MS = 20000;

// Play-screen geometry. Serialized into the page so the browser and the tests
// share one rule; a stock 1366x768 Chromebook must still fit checklist,
// narration and the End-session button beside the scaled game.
export function layout(vw, vh, w, h) {
  const side = Math.round(Math.min(388, Math.max(300, vw * 0.28)));
  const compact = vh < 820 || vw < 1440;
  const avail = Math.max(320, vw - side);
  const scale = Math.min(1, avail / w, (vh - (compact ? 2 : 4)) / h);
  return { side, compact, scale: Math.floor(scale * 1000) / 1000 };
}

// No per-campaign duration field exists (that lives in api/db, not ours), so
// use one defensively if a campaign happens to carry it and stay honest if not.
export function durationHint(campaign) {
  const raw = campaign?.durationMin ?? campaign?.options?.durationMin ?? campaign?.estimatedMinutes;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return `This usually takes about ${Math.round(n)} minutes.`;
  return 'There is no fixed length \u2014 most sessions run about half a class period.';
}

const BASE_CSS = `
  :root{--bg:#10151a;--panel:#161d24;--ink:#e6e9ec;--muted:#93a0ab;--accent:#4fb3c0;--warm:#e8a34a;--ok:#6eb891;--err:#e4735c;--rule:#26303a;--field:#0d1216}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
  button.primary{background:var(--accent);color:#06222a;border:0;border-radius:5px;padding:.65rem 1.4rem;font-weight:600;font-size:1rem;cursor:pointer}
  button.primary:disabled{opacity:.4;cursor:default}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;margin-right:6px;vertical-align:middle}
  .on{background:var(--ok)}.err{background:var(--err)}.warn{background:var(--warm)}
  button.ghost{background:transparent;color:var(--muted);border:1px solid var(--rule);border-radius:5px;padding:.6rem 1.1rem;font-size:.95rem;cursor:pointer}
  button.ghost:hover{color:var(--ink);border-color:var(--muted)}
`;

function consentPage(campaign) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${md(campaign.name).replace(/<[^>]+>/g, '')}</title>
<style>${BASE_CSS}
  main{max-width:38rem;margin:0 auto;padding:3rem 1.4rem 4rem}
  h1{font-size:1.4rem;color:var(--accent)}
  .card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:1.2rem 1.4rem;margin:1.2rem 0}
  label{display:flex;gap:.6rem;align-items:flex-start;cursor:pointer}
  input[type=checkbox]{width:1.1rem;height:1.1rem;margin-top:.2rem}
  #gate{color:var(--err);display:none}
  #consentHint{color:var(--muted);font-size:.9rem;margin:.4rem 0 .9rem}
  button.primary[aria-disabled="true"]{opacity:.4;cursor:default}
  #code{background:var(--field);border:1px solid var(--rule);color:var(--ink);border-radius:4px;padding:.5rem .6rem;font-size:1rem;width:12rem}
</style>
<main>
  <h1>${campaign.name}</h1>
  <div class="card">${md(campaign.instructionsMd)}</div>
  <div class="card">
    ${md(campaign.consentMd)}
    <label><input type="checkbox" id="consent"> <span>I have read the above and agree to participate.</span></label>
  </div>
  ${campaign.options?.promptPlayerCode ? '<div class="card"><label for="code">Player code (if you have one)</label><br><input id="code" autocomplete="off"></div>' : ''}
  <p id="gate">This study needs Google Chrome or Microsoft Edge — voice transcription and recording are not supported in this browser.</p>
  <p id="consentHint">Tick the consent box above to turn on the Start button.</p>
  <button class="primary" id="start" aria-disabled="true" aria-describedby="consentHint">Start</button>
</main>
<script>
const $=(s)=>document.querySelector(s);
const supported=!!(window.SpeechRecognition||window.webkitSpeechRecognition)&&!!window.MediaRecorder;
if(!supported){$('#gate').style.display='block';}
// Start stays focusable and says why it is inert: aria-disabled plus a hint it
// points at. The two reasons stay distinguishable — #consentHint for the tick
// box, #gate for an unsupported browser.
let busy=false;
function gate(){
  const ticked=$('#consent').checked;
  $('#start').setAttribute('aria-disabled',String(!(ticked&&supported&&!busy)));
  $('#consentHint').style.display=ticked?'none':'block';
  const why=[];if(!ticked)why.push('consentHint');if(!supported)why.push('gate');
  $('#start').setAttribute('aria-describedby',why.join(' ')||'consentHint');
}
$('#consent').onchange=gate;gate();
$('#start').onclick=async()=>{
  if($('#start').getAttribute('aria-disabled')==='true')return;
  busy=true;gate();
  const body={slug:${JSON.stringify(campaign.slug)},consent:true};
  const code=document.querySelector('#code'); if(code&&code.value.trim())body.playerCode=code.value.trim();
  const r=await fetch('/api/session/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){alert('Could not start the session — please tell the researcher.');busy=false;gate();return;}
  const {sessionId}=await r.json();
  sessionStorage.setItem('metcalf-t0',String(Date.now()));
  location.href='/play/'+sessionId;
};
</script>`;
}

function sessionPage(campaign, sessionId) {
  const W = campaign.game?.w ?? 1280, H = campaign.game?.h ?? 800;
  const checklist = campaign.checklist ?? [];
  return `<!doctype html><meta charset="utf-8"><title>${md(campaign.name).replace(/<[^>]+>/g, '')}</title>
<style>${BASE_CSS}
  body{display:flex;height:100vh;overflow:hidden}
  #gwrap{flex:0 0 auto;overflow:hidden;position:relative}
  #game{width:${W}px;height:${H}px;border:0;background:#000;transform-origin:top left}
  #gveil{position:absolute;inset:0;background:rgba(6,10,14,.86);display:none;align-items:center;justify-content:center;color:var(--muted);font-size:1.2rem}
  #side{flex:1 1 auto;min-width:300px;display:flex;flex-direction:column;border-left:1px solid var(--rule);background:var(--panel)}
  h2{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0;padding:10px 12px 6px;font-weight:600}
  .pane{overflow-y:auto;padding:0 12px 10px}
  #tasks{flex:0 0 auto;max-height:30vh;border-bottom:1px solid var(--rule)}
  #tx{flex:1 1 auto;border-bottom:1px solid var(--rule)}
  .line{margin:3px 0}.line .t{color:var(--muted);font:10px ui-monospace,monospace;margin-right:6px}
  #interim{color:var(--muted);font-style:italic}
  .task{display:flex;gap:.5rem;align-items:flex-start;margin:.35rem 0;cursor:pointer}
  #bar{flex:0 0 auto;padding:8px;display:flex;gap:6px}
  #say{flex:1;background:var(--field);border:1px solid var(--rule);color:var(--ink);border-radius:4px;padding:7px 8px;font:13px inherit}
  #controls{flex:0 0 auto;display:flex;gap:6px;padding:8px;border-top:1px solid var(--rule)}
  #controls button{flex:1;border:0;border-radius:4px;padding:.55rem;font-weight:600;cursor:pointer}
  #pause{background:var(--warm);color:#3a2708}
  #endbtn{background:var(--err);color:#2d0d06}
  #status{padding:6px 12px;font:11px ui-monospace,monospace;color:var(--muted);border-top:1px solid var(--rule);display:flex;align-items:center;gap:8px}
  #meter{flex:1 1 auto;min-width:40px;height:6px;border-radius:3px;background:var(--field);border:1px solid var(--rule);overflow:hidden}
  #meterFill{display:block;height:100%;width:0;background:var(--muted);transition:width .08s linear}
  #meter.live #meterFill{background:var(--ok)}
  #veil{position:fixed;inset:0;background:rgba(6,10,14,.9);display:flex;align-items:center;justify-content:center;z-index:99}
  #veil .card,#summary .card,#left .card{max-width:32rem;background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:1.5rem 1.7rem}
  #summary{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;z-index:100}
  #summary dl{display:grid;grid-template-columns:auto auto;gap:.3rem 1.2rem;font-variant-numeric:tabular-nums}
  #summary dt{color:var(--muted)}
  #left{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;z-index:101}
  #howlong{color:var(--muted)}
  #veilbtns{display:flex;gap:.7rem;align-items:center;flex-wrap:wrap}
  /* Chromebook (1366x768): claw back vertical padding so the checklist, the
     narration pane and the End-session button all stay reachable. */
  body.compact #tasks{max-height:22vh}
  body.compact h2{padding:6px 12px 3px}
  body.compact .pane{padding:0 10px 6px}
  body.compact #bar,body.compact #controls{padding:6px}
  body.compact #controls button{padding:.45rem}
  body.compact #status{padding:4px 12px}
</style>
<div id="gwrap">
  <iframe id="game" src="/g/${sessionId}/" allow="autoplay; fullscreen"></iframe>
  <div id="gveil">paused — press Resume to continue</div>
</div>
<div id="side">
  ${checklist.length ? '<h2 id="tasks-h">Tasks</h2><div class="pane" id="tasks" role="group" aria-labelledby="tasks-h">' + checklist.map((c, i) =>
    `<label class="task"><input type="checkbox" data-item="${md(String(c.id ?? i)).replace(/<[^>]+>/g, '')}"> <span>${md(c.label).replace(/<\/?p>/g, '')}</span></label>`).join('') + '</div>' : ''}
  <h2>Your narration</h2>
  <div class="pane" id="tx"><div id="interim"></div></div>
  <div id="bar"><input id="say" placeholder="type instead of speaking…" autocomplete="off"><button class="primary" id="send">Send</button></div>
  <div id="controls"><button id="pause">Pause</button><button id="endbtn">End session</button></div>
  <div id="status"><span class="dot" id="mic"></span><span id="micTxt" role="status" aria-live="polite">mic idle</span>
  <span id="meter" role="meter" aria-label="microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="meterFill"></i></span></div>
</div>
<div id="veil"><div class="card">
  <h1 style="font-size:1.15rem;color:var(--accent)">Ready when you are</h1>
  <p>Press begin and allow the microphone. Say what you're thinking as you
  play — what you notice, what you expect, what surprises you. Use the
  checklist on the right, and end the session with the red button.</p>
  <p id="howlong">${durationHint(campaign)} You can stop whenever you want \u2014
  nothing here is graded and there are no wrong answers.</p>
  <div id="veilbtns"><button class="primary" id="begin">Begin</button>
  <button class="ghost" id="leave">Leave without participating</button></div>
</div></div>
<div id="left"><div class="card">
  <h1 style="font-size:1.15rem;color:var(--accent)">That's completely fine</h1>
  <p>You have left without taking part. Nothing was recorded and nobody minds \u2014
  you can close this tab now. If you change your mind, tell the researcher and
  they can set you up again.</p>
</div></div>
<div id="summary"><div class="card">
  <h1 style="font-size:1.15rem;color:var(--accent)">Session complete</h1>
  <dl><dt>Session length</dt><dd id="s-dur"></dd>
  <dt>Things you said</dt><dd id="s-utt"></dd>
  <dt>Game data logs sent</dt><dd id="s-ogd"></dd></dl>
  <div id="thanks">${md(campaign.thankyouMd)}</div>
</div></div>
<script>
const $=(s)=>document.querySelector(s);
const SID=${JSON.stringify(sessionId)};
if(!sessionStorage.getItem('metcalf-t0'))sessionStorage.setItem('metcalf-t0',String(Date.now()));
const T0=Number(sessionStorage.getItem('metcalf-t0'));
const at=()=>Date.now()-T0;
const clock=(ms)=>{const s=Math.round(ms/1000);return (s/60|0)+':'+String(s%60).padStart(2,'0')};
const post=(events)=>fetch('/api/s/'+SID+'/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({events}),keepalive:true}).catch(()=>{});
const lane=(l,ev)=>post([Object.assign({lane:l,t:at()},ev)]);

const layout=${layout.toString()};
function fit(){
  const L=layout(innerWidth,innerHeight,${W},${H});
  document.body.classList.toggle('compact',L.compact);
  $('#side').style.minWidth=L.side+'px';
  $('#game').style.transform='scale('+L.scale+')';
  $('#gwrap').style.width=(${W}*L.scale)+'px';$('#gwrap').style.height=(${H}*L.scale)+'px';
  lane('marks',{kind:'scale',scale:L.scale});
}
addEventListener('resize',fit);fit();

const addLine=(text,t)=>{const e=document.createElement('div');e.className='line';
  e.innerHTML='<span class="t">'+clock(t)+'</span>'+text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  $('#tx').insertBefore(e,$('#interim'));$('#tx').scrollTop=1e9;};

// speech (S3): continuous, auto-restart; finals -> transcript lane
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let listening=false,wantMic=false,rec=null;

// mic health: SpeechRecognition gives words but never levels, so we hold our
// own getUserMedia stream and read an AnalyserNode for the meter. A listening
// mic that stays silent for SILENT_MS is reported as broken, not as a quiet
// participant, and that transition goes on the marks lane for the replay.
const MIC_STATES=${JSON.stringify(MIC_STATES)};
const SILENT_MS=${SILENT_MS};
const micState=${micState.toString()};
let micNow='';
function setMic(state,detail){
  if(state===micNow&&!detail)return;
  micNow=state;
  const s=micState(state,detail);
  $('#mic').className=s.cls;$('#micTxt').textContent=s.text;
  $('#meter').classList.toggle('live',s.level==='ok');
  if(s.level!=='ok')$('#meterFill').style.width='0%';
  if(s.level==='warn'||s.level==='err')lane('marks',{kind:'mic',state,text:s.text});
}

let ac=null,an=null,micStream=null,lastSound=0,raf=0;
async function startMeter(){
  if(an||!navigator.mediaDevices)return;
  try{micStream=await navigator.mediaDevices.getUserMedia({audio:true});}
  catch(e){setMic('denied');return;}
  try{
    ac=new (window.AudioContext||window.webkitAudioContext)();
    an=ac.createAnalyser();an.fftSize=512;
    ac.createMediaStreamSource(micStream).connect(an);
  }catch(e){return;}
  const buf=new Uint8Array(an.fftSize);
  lastSound=Date.now();
  (function loop(){
    raf=requestAnimationFrame(loop);
    an.getByteTimeDomainData(buf);
    let sum=0;for(let i=0;i<buf.length;i++){const v=(buf[i]-128)/128;sum+=v*v;}
    const rms=Math.sqrt(sum/buf.length);
    const pct=Math.min(100,Math.round(rms*400));
    $('#meterFill').style.width=pct+'%';
    $('#meter').setAttribute('aria-valuenow',String(pct));
    if(rms>0.02){lastSound=Date.now();if(micNow==='silent')setMic('listening');}
    else if(micNow==='listening'&&Date.now()-lastSound>SILENT_MS)setMic('silent');
  })();
}
function stopMeter(){
  if(raf)cancelAnimationFrame(raf);raf=0;
  try{micStream&&micStream.getTracks().forEach(t=>t.stop())}catch{}
  try{ac&&ac.close()}catch{}
  ac=null;an=null;micStream=null;$('#meterFill').style.width='0%';
}

function startMic(){
  if(!SR){setMic('unsupported');return;}
  rec=new SR();rec.continuous=true;rec.interimResults=true;rec.lang='en-US';
  rec.onresult=(ev)=>{let interim='';
    for(let i=ev.resultIndex;i<ev.results.length;i++){
      const r=ev.results[i],txt=r[0].transcript.trim();
      if(r.isFinal&&txt){const t=at();addLine(txt,t);post([{lane:'transcript',t,text:txt}]);}
      else interim+=txt+' ';
    }
    $('#interim').textContent=interim;};
  rec.onerror=(e)=>{if(e.error!=='aborted')setMic(e.error==='not-allowed'?'denied':'error',e.error);};
  rec.onend=()=>{listening=false;if(wantMic)try{rec.start();listening=true}catch{}};
  try{rec.start();listening=true;wantMic=true;setMic('listening');startMeter();}
  catch(e){setMic('denied');}
}

$('#send').onclick=()=>{const v=$('#say').value.trim();if(!v)return;
  const t=at();addLine(v,t);post([{lane:'transcript',t,text:v,typed:true}]);$('#say').value='';};
$('#say').addEventListener('keydown',(e)=>{if(e.key==='Enter')$('#send').click()});

document.querySelectorAll('.task input').forEach((cb)=>{
  cb.onchange=()=>lane('checklist',{item:cb.dataset.item,checked:cb.checked});});

let paused=false;
$('#pause').onclick=()=>{
  paused=!paused;
  $('#gveil').style.display=paused?'flex':'none';
  $('#pause').textContent=paused?'Resume':'Pause';
  lane('marks',{kind:paused?'pause':'resume'});
  $('#game').contentWindow.postMessage({metcalf:paused?'pause':'resume'},location.origin);
  if(paused){wantMic=false;try{rec&&rec.stop()}catch{}stopMeter();setMic('paused');}
  else{wantMic=true;startMic();}
};

$('#endbtn').onclick=async()=>{
  if(!confirm('End the session? This cannot be undone.'))return;
  wantMic=false;try{rec&&rec.stop()}catch{}stopMeter();setMic('idle');
  await new Promise(r=>setTimeout(r,600));   // let last batches land
  const r=await fetch('/api/s/'+SID+'/end',{method:'POST'});
  const s=await r.json();
  $('#s-dur').textContent=clock(s.durationMs||at());
  $('#s-utt').textContent=s.utterances;
  $('#s-ogd').textContent=s.ogdLogs;
  $('#summary').style.display='flex';
  sessionStorage.removeItem('metcalf-t0');sessionStorage.removeItem('metcalf-n');sessionStorage.removeItem('metcalf-seq');
};

$('#begin').onclick=()=>{$('#veil').remove();startMic();lane('marks',{kind:'begin'});};

// Withdrawal before the session starts: no confirm, no microphone, no scolding.
// The veil covers the controls, so the way out has to live on the veil itself.
$('#leave').onclick=async()=>{
  $('#leave').disabled=true;
  lane('marks',{kind:'withdraw'});
  try{await fetch('/api/s/'+SID+'/end',{method:'POST',keepalive:true})}catch{}
  sessionStorage.removeItem('metcalf-t0');
  $('#veil').remove();$('#left').style.display='flex';
};
</script>`;
}

// ---------------------------------------------------------------- proxy
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'content-security-policy',
  'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security']);
const CACHEABLE = /\.(js|wasm|unityweb|data|png|jpe?g|gif|svg|webp|ogg|mp3|wav|json|txt|css|woff2?|bundle|mem)(\?|$)/i;

async function proxyGame(req, res, u, { gameUrl, sessionId, dataDir, restPath }) {
  const GAME = new URL(gameUrl);
  const hdrs = { 'user-agent': req.headers['user-agent'] ?? 'metcalf' };

  const cacheDir = path.join(dataDir, 'cache');
  const upstreamUrl = new URL(restPath + u.search, GAME);
  const key = crypto.createHash('sha1').update(upstreamUrl.href).digest('hex');
  const cPath = path.join(cacheDir, key);
  const cacheable = req.method === 'GET' && CACHEABLE.test(restPath);

  if (cacheable && fs.existsSync(cPath) && fs.existsSync(cPath + '.meta')) {
    const meta = JSON.parse(fs.readFileSync(cPath + '.meta', 'utf8'));
    res.writeHead(200, { 'content-type': meta.ct, 'content-length': fs.statSync(cPath).size, 'x-metcalf-cache': 'hit' });
    fs.createReadStream(cPath).pipe(res);
    return;
  }

  let r;
  try {
    const reqBody = ['GET', 'HEAD'].includes(req.method) ? undefined
      : await new Promise((resolve) => { const p = []; req.on('data', (d) => p.push(d)); req.on('end', () => resolve(Buffer.concat(p))); });
    r = await fetch(upstreamUrl, { method: req.method, headers: hdrs, body: reqBody });
    if (r.status === 404 && restPath) {
      r = await fetch(new URL('/' + restPath + u.search, GAME.origin), { method: req.method, headers: hdrs });
    }
  } catch (e) {
    res.writeHead(502); return res.end(String(e));
  }

  const ct = r.headers.get('content-type') ?? '';
  const headers = {};
  for (const [k, v] of r.headers) if (!DROP.has(k.toLowerCase())) headers[k] = v;

  if (ct.includes('text/html')) {
    let html = await r.text();
    const tag = `<script>window.__METCALF_SESSION=${JSON.stringify(sessionId)}</script><script src="/assets/recorder.js"></script>`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
    res.writeHead(r.status, { ...headers, 'content-type': ct });
    return res.end(html);
  }

  if (cacheable && r.status === 200) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(cPath, buf);
    fs.writeFileSync(cPath + '.meta', JSON.stringify({ ct, url: upstreamUrl.href }));
    res.writeHead(r.status, { ...headers, 'content-type': ct, 'content-length': buf.length });
    return res.end(buf);
  }

  res.writeHead(r.status, headers);
  if (r.body) for await (const chunk of r.body) res.write(chunk);
  res.end();
}

// ---------------------------------------------------------------- routes
const RECORDER = fs.readFileSync(path.join(import.meta.dirname, 'recorder.js'), 'utf8');

export function createParticipant({ db, dataDir }) {
  const gameUrlFor = (sessionId) => {
    const row = db.getSession(sessionId);
    if (!row) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(sessionDir(dataDir, row.slug, row.sessionId), 'session.json'), 'utf8'));
      return meta.url ?? db.getCampaign(row.slug)?.gameUrl ?? null;
    } catch { return db.getCampaign(row.slug)?.gameUrl ?? null; }
  };

  return async function participantRoutes(req, res, u) {
    const seg = u.pathname.split('/').filter(Boolean);
    const html = (page) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); };

    if (u.pathname === '/assets/recorder.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(RECORDER);
      return true;
    }
    if (seg[0] === 'c' && seg.length === 2) {
      const campaign = db.getCampaign(seg[1]);
      if (!campaign) return false;
      html(consentPage(campaign));
      return true;
    }
    if (seg[0] === 'play' && SID.test(seg[1] ?? '') && seg.length === 2) {
      const row = db.getSession(seg[1]);
      const campaign = row && db.getCampaign(row.slug);
      if (!campaign) return false;
      html(sessionPage(campaign, seg[1]));
      return true;
    }
    if (seg[0] === 'g' && SID.test(seg[1] ?? '')) {
      const gameUrl = gameUrlFor(seg[1]);
      if (!gameUrl) return false;
      await proxyGame(req, res, u, {
        gameUrl, sessionId: seg[1], dataDir,
        restPath: u.pathname.replace(`/g/${seg[1]}`, '').replace(/^\//, ''),
      });
      return true;
    }
    // Absolute-path asset that escaped /g/<sid>/ — recognized by referer.
    const ref = (req.headers.referer ?? '').match(/\/g\/([a-f0-9]{16})\//);
    if (ref) {
      const gameUrl = gameUrlFor(ref[1]);
      if (gameUrl) {
        await proxyGame(req, res, u, {
          gameUrl, sessionId: ref[1], dataDir, restPath: u.pathname.replace(/^\//, ''),
        });
        return true;
      }
    }
    return false;
  };
}
