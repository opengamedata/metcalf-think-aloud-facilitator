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

const BASE_CSS = `
  :root{--bg:#10151a;--panel:#161d24;--ink:#e6e9ec;--muted:#93a0ab;--accent:#4fb3c0;--warm:#e8a34a;--ok:#6eb891;--err:#e4735c;--rule:#26303a;--field:#0d1216}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
  button.primary{background:var(--accent);color:#06222a;border:0;border-radius:5px;padding:.65rem 1.4rem;font-weight:600;font-size:1rem;cursor:pointer}
  button.primary:disabled{opacity:.4;cursor:default}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#555;margin-right:6px;vertical-align:middle}
  .on{background:var(--ok)}.err{background:var(--err)}
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
  <button class="primary" id="start" disabled>Start</button>
</main>
<script>
const $=(s)=>document.querySelector(s);
const supported=!!(window.SpeechRecognition||window.webkitSpeechRecognition)&&!!window.MediaRecorder;
if(!supported){$('#gate').style.display='block';}
$('#consent').onchange=()=>{$('#start').disabled=!($('#consent').checked&&supported);};
$('#start').onclick=async()=>{
  $('#start').disabled=true;
  const body={slug:${JSON.stringify(campaign.slug)},consent:true};
  const code=document.querySelector('#code'); if(code&&code.value.trim())body.playerCode=code.value.trim();
  const r=await fetch('/api/session/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){alert('Could not start the session — please tell the researcher.');$('#start').disabled=false;return;}
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
  #side{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--rule);background:var(--panel)}
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
  #status{padding:6px 12px;font:11px ui-monospace,monospace;color:var(--muted);border-top:1px solid var(--rule)}
  #veil{position:fixed;inset:0;background:rgba(6,10,14,.9);display:flex;align-items:center;justify-content:center;z-index:99}
  #veil .card,#summary .card{max-width:32rem;background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:1.5rem 1.7rem}
  #summary{position:fixed;inset:0;background:var(--bg);display:none;align-items:center;justify-content:center;z-index:100}
  #summary dl{display:grid;grid-template-columns:auto auto;gap:.3rem 1.2rem;font-variant-numeric:tabular-nums}
  #summary dt{color:var(--muted)}
</style>
<div id="gwrap">
  <iframe id="game" src="/g/${sessionId}/" allow="autoplay; fullscreen"></iframe>
  <div id="gveil">paused — press Resume to continue</div>
</div>
<div id="side">
  ${checklist.length ? '<h2>Tasks</h2><div class="pane" id="tasks">' + checklist.map((c, i) =>
    `<label class="task"><input type="checkbox" data-item="${md(String(c.id ?? i)).replace(/<[^>]+>/g, '')}"> <span>${md(c.label).replace(/<\/?p>/g, '')}</span></label>`).join('') + '</div>' : ''}
  <h2>Your narration</h2>
  <div class="pane" id="tx"><div id="interim"></div></div>
  <div id="bar"><input id="say" placeholder="type instead of speaking…" autocomplete="off"><button class="primary" id="send">Send</button></div>
  <div id="controls"><button id="pause">Pause</button><button id="endbtn">End session</button></div>
  <div id="status"><span class="dot" id="mic"></span><span id="micTxt">mic idle</span></div>
</div>
<div id="veil"><div class="card">
  <h1 style="font-size:1.15rem;color:var(--accent)">Ready when you are</h1>
  <p>Press begin and allow the microphone. Say what you're thinking as you
  play — what you notice, what you expect, what surprises you. Use the
  checklist on the right, and end the session with the red button.</p>
  <button class="primary" id="begin">Begin</button>
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

function fit(){
  const w=Math.max(320,innerWidth-388);
  const sc=Math.min(1,w/${W},(innerHeight-4)/${H});
  $('#game').style.transform='scale('+sc+')';
  $('#gwrap').style.width=(${W}*sc)+'px';$('#gwrap').style.height=(${H}*sc)+'px';
  lane('marks',{kind:'scale',scale:Math.round(sc*1000)/1000});
}
addEventListener('resize',fit);fit();

const addLine=(text,t)=>{const e=document.createElement('div');e.className='line';
  e.innerHTML='<span class="t">'+clock(t)+'</span>'+text.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  $('#tx').insertBefore(e,$('#interim'));$('#tx').scrollTop=1e9;};

// speech (S3): continuous, auto-restart; finals -> transcript lane
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
let listening=false,wantMic=false,rec=null;
function startMic(){
  if(!SR){$('#micTxt').textContent='no speech support — type instead';$('#mic').className='dot err';return;}
  rec=new SR();rec.continuous=true;rec.interimResults=true;rec.lang='en-US';
  rec.onresult=(ev)=>{let interim='';
    for(let i=ev.resultIndex;i<ev.results.length;i++){
      const r=ev.results[i],txt=r[0].transcript.trim();
      if(r.isFinal&&txt){const t=at();addLine(txt,t);post([{lane:'transcript',t,text:txt}]);}
      else interim+=txt+' ';
    }
    $('#interim').textContent=interim;};
  rec.onerror=(e)=>{if(e.error!=='aborted'){$('#mic').className='dot err';$('#micTxt').textContent='mic: '+e.error+' — typing still works';}};
  rec.onend=()=>{listening=false;if(wantMic)try{rec.start();listening=true}catch{}};
  try{rec.start();listening=true;wantMic=true;$('#mic').className='dot on';$('#micTxt').textContent='listening';}
  catch(e){$('#micTxt').textContent='mic blocked — type instead';}
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
  if(paused){wantMic=false;try{rec&&rec.stop()}catch{}$('#micTxt').textContent='paused';}
  else{wantMic=true;startMic();}
};

$('#endbtn').onclick=async()=>{
  if(!confirm('End the session? This cannot be undone.'))return;
  wantMic=false;try{rec&&rec.stop()}catch{}
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
