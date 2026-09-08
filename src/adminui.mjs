// Main application: / and /admin (login + campaigns + sessions table), plus
// /admin/replay/<sessionId> (video + time slider + synchronized lanes).
// Single-file pages, cookie auth against the /api/admin routes.

import { LANE_CONFIG, laneConfigSource } from './replay-lanes.mjs';

const SID = /^[a-f0-9]{16}$/;

const CSS = `
  :root{--bg:#10151a;--panel:#161d24;--ink:#e6e9ec;--muted:#93a0ab;--accent:#4fb3c0;--warm:#e8a34a;--ok:#6eb891;--err:#e4735c;--rule:#26303a;--field:#0d1216}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
  a{color:var(--accent)}
  h1{font-size:1.2rem;color:var(--accent)}
  h2{font-size:.95rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  input,textarea,select{background:var(--field);border:1px solid var(--rule);color:var(--ink);border-radius:4px;padding:.45rem .6rem;font:13px/1.4 inherit;width:100%}
  textarea{min-height:5.5rem;font-family:ui-monospace,Menlo,monospace}
  label{display:block;margin:.7rem 0 .2rem;color:var(--muted);font-size:12px}
  button{background:var(--accent);color:#06222a;border:0;border-radius:4px;padding:.5rem 1rem;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;color:var(--accent);border:1px solid var(--rule)}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--rule);padding:.4rem .6rem}
  td{border-bottom:1px solid var(--rule);padding:.45rem .6rem}
  tr:hover td{background:#141b22}
  .card{background:var(--panel);border:1px solid var(--rule);border-radius:8px;padding:1.1rem 1.3rem;margin:1rem 0}
  .mono{font-family:ui-monospace,Menlo,monospace;font-size:12px}
`;

const ADMIN_PAGE = `<!doctype html><meta charset="utf-8"><title>metcalf admin</title>
<style>${CSS}
  main{max-width:64rem;margin:0 auto;padding:2rem 1.4rem 4rem}
  #login{max-width:22rem}
  .row{display:flex;gap:1rem}.row>*{flex:1}
  #campList .item{display:flex;justify-content:space-between;align-items:center;padding:.5rem 0;border-bottom:1px solid var(--rule);cursor:pointer}
  #campList .item:hover{color:var(--accent)}
</style>
<main>
  <h1>metcalf · think-aloud facilitator</h1>
  <div id="login" class="card">
    <label>Researcher password</label><input id="pw" type="password">
    <p><button id="doLogin">Log in</button> <span id="loginMsg" style="color:var(--err)"></span></p>
  </div>
  <div id="app" style="display:none">
    <div class="card"><h2>Campaigns</h2><div id="campList"></div>
      <p><button class="ghost" id="newCamp">New campaign</button></p></div>
    <div class="card" id="editor" style="display:none">
      <h2 id="edTitle">Campaign</h2>
      <div class="row"><div><label>Name</label><input id="f-name"></div>
        <div><label>Slug (url: /c/&lt;slug&gt;)</label><input id="f-slug"></div></div>
      <label>Game URL</label><input id="f-gameUrl" placeholder="https://fielddaylab.org/play/wake/ci/production/">
      <label>Instructions (markdown)</label><textarea id="f-instructionsMd"></textarea>
      <label>Consent text (markdown)</label><textarea id="f-consentMd"></textarea>
      <label>Checklist — one task per line, "id | label"</label><textarea id="f-checklist"></textarea>
      <label>Thank-you text (markdown)</label><textarea id="f-thankyouMd"></textarea>
      <label><input type="checkbox" id="f-promptCode" style="width:auto"> Ask participants for a player code</label>
      <p><button id="save">Save campaign</button>
         <span class="mono" id="campUrl"></span></p>
    </div>
    <div class="card" id="sessions" style="display:none">
      <h2>Sessions — <span id="sessSlug"></span>
        <a id="dl" style="float:right;font-weight:400" href="#">download package.zip</a></h2>
      <table><thead><tr><th>player code</th><th>started</th><th>duration</th>
        <th>utterances</th><th>clicks</th><th>OGD logs</th><th>status</th><th></th></tr></thead>
        <tbody id="sessRows"></tbody></table>
    </div>
  </div>
</main>
<script>
const $=(s)=>document.querySelector(s);
const api=(p,opt)=>fetch('/api/admin/'+p,opt).then(r=>{if(r.status===401)throw 401;return r.json()});
const clock=(ms)=>{if(ms==null)return '—';const s=Math.round(ms/1000);return (s/60|0)+':'+String(s%60).padStart(2,'0')};
let current=null;
// mirrors src/slugify.mjs so the preview matches what the server stores
const slugify=(v)=>String(v==null?'':v).toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
function previewSlug(){
  const s=slugify($('#f-slug').value);
  $('#campUrl').textContent=s.length>=3?location.origin+'/c/'+s:'slug needs at least 3 letters, digits or dashes';
  return s;
}

async function boot(){
  try{await api('campaigns');$('#login').style.display='none';$('#app').style.display='block';loadCampaigns();}
  catch{ /* stay on login */ }
}
$('#doLogin').onclick=async()=>{
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});
  if(!r.ok){$('#loginMsg').textContent=r.status===503?'server has no ADMIN_PASSWORD set':'wrong password';return;}
  boot();
};
$('#pw').addEventListener('keydown',(e)=>{if(e.key==='Enter')$('#doLogin').click()});

async function loadCampaigns(){
  const list=await api('campaigns');
  $('#campList').innerHTML=list.map(c=>'<div class="item" data-slug="'+c.slug+'"><span>'+c.name+'</span><span class="mono">/c/'+c.slug+'</span></div>').join('')||'<p style="color:var(--muted)">none yet</p>';
  document.querySelectorAll('#campList .item').forEach(el=>el.onclick=()=>edit(el.dataset.slug));
}
function fill(c){
  current=c.slug??null;
  $('#editor').style.display='block';
  for(const k of ['name','slug','gameUrl','instructionsMd','consentMd','thankyouMd'])$('#f-'+k).value=c[k]??'';
  $('#f-checklist').value=(c.checklist??[]).map(t=>t.id+' | '+t.label).join('\\n');
  $('#f-promptCode').checked=!!(c.options&&c.options.promptPlayerCode);
  previewSlug();
}
$('#f-slug').addEventListener('input',previewSlug);
$('#newCamp').onclick=()=>{fill({});$('#sessions').style.display='none';};
async function edit(slug){fill(await api('campaigns/'+slug));loadSessions(slug);}
$('#save').onclick=async()=>{
  const c={slug:previewSlug(),name:$('#f-name').value.trim(),gameUrl:$('#f-gameUrl').value.trim(),
    instructionsMd:$('#f-instructionsMd').value,consentMd:$('#f-consentMd').value,thankyouMd:$('#f-thankyouMd').value,
    checklist:$('#f-checklist').value.split('\\n').map(l=>l.trim()).filter(Boolean).map(l=>{const [id,...rest]=l.split('|');return {id:id.trim(),label:rest.join('|').trim()||id.trim()}}),
    options:{promptPlayerCode:$('#f-promptCode').checked}};
  const r=await fetch('/api/admin/campaigns',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(c)});
  const out=await r.json();
  if(!r.ok){alert(out.error);return;}
  c.slug=out.slug??c.slug;               // server normalizes (lowercase etc.)
  fill(c);loadCampaigns();loadSessions(c.slug);
};
async function loadSessions(slug){
  const rows=await api('campaigns/'+slug+'/sessions');
  $('#sessions').style.display='block';$('#sessSlug').textContent=slug;
  $('#dl').href='/api/admin/campaigns/'+slug+'/package.zip';
  $('#sessRows').innerHTML=rows.map(r=>'<tr><td>'+(r.playerCode??'—')+'</td><td>'+r.startedAt.replace('T',' ').slice(0,16)+'</td><td>'+clock(r.durationMs)+'</td><td>'+r.utterances+'</td><td>'+r.clicks+'</td><td>'+r.ogdLogs+'</td><td>'+r.status+'</td><td><a href="/admin/replay/'+r.sessionId+'">replay</a></td></tr>').join('')||'<tr><td colspan="8" style="color:var(--muted)">no sessions yet</td></tr>';
}
boot();
</script>`;

export const replayPage = (sessionId) => `<!doctype html><meta charset="utf-8"><title>replay ${sessionId.slice(0, 6)}</title>
<style>${CSS}
  body{display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #main{display:flex;flex:1 1 auto;min-height:0}
  #left{flex:0 0 62%;display:flex;flex-direction:column;padding:12px;min-width:0}
  #stage{position:relative;background:#000;border:1px solid var(--rule)}
  #stage video{display:block;width:100%}
  .mark{position:absolute;width:18px;height:18px;margin:-9px;border:2px solid var(--warm);border-radius:50%;opacity:0;transition:opacity .15s}
  .mark.show{opacity:1}
  #bar{display:flex;gap:10px;align-items:center;padding:10px 2px}
  #scrub{flex:1}
  #right{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--rule);background:var(--panel)}
  .pane{overflow-y:auto;padding:0 12px 10px;flex:1}
  .ev{margin:3px 0;padding:2px 6px;border-left:2px solid transparent;color:var(--muted)}
  .ev .t{font:10px ui-monospace,monospace;margin-right:6px}
  .ev.past{color:var(--ink)}
  .ev.now{border-left-color:var(--accent);background:#16232a;color:var(--ink)}
  .ev.click{color:var(--warm)}.ev.ogd .t{color:var(--ok)}
  h2{margin:0;padding:10px 12px 4px}
  /* horizontal event lanes, pinned full width across the bottom */
  #strip{flex:0 0 auto;background:#0b1014;border-top:1px solid var(--rule);padding:8px 12px 10px;cursor:crosshair}
  #lanebody{position:relative}
  .lane{display:flex;align-items:center;margin:2px 0}
  .lanelabel{flex:0 0 64px;font:11px/1.4 ui-monospace,Menlo,monospace;color:var(--muted)}
  .track{position:relative;flex:1 1 auto;height:12px;background:#141b22;border-radius:2px}
  .m{position:absolute;top:2px;height:8px;background:currentColor}
  .m.dot{width:8px;margin-left:-4px;border-radius:50%}
  .m.tick{width:2px;margin-left:-1px}
  .m.bar{min-width:2px;border-radius:1px;opacity:.8}
  #ph{position:absolute;top:0;bottom:0;width:1px;background:var(--ink);opacity:.7;pointer-events:none}
</style>
<div id="main">
  <div id="left">
    <div id="stage"><video id="v"></video></div>
    <div id="bar"><button id="play">▶</button>
      <input id="scrub" type="range" min="0" max="1000" value="0">
      <span class="mono" id="tnow">0:00</span> / <span class="mono" id="ttot">0:00</span></div>
    <div class="mono" id="meta" style="color:var(--muted)"></div>
  </div>
  <div id="right"><h2>Timeline</h2><div class="pane" id="lanes"></div></div>
</div>
<div id="strip"><div id="lanebody">
  ${LANE_CONFIG.map((l) => `<div class="lane" data-lane="${l.id}"><span class="lanelabel">${l.label}</span><div class="track" id="track-${l.id}" style="color:${l.color}"></div></div>`).join('\n  ')}
  <div id="ph" style="left:64px"></div>
</div></div>
<script>
const $=(s)=>document.querySelector(s);
const SID=${JSON.stringify(sessionId)};
const clock=(ms)=>{const s=Math.max(0,Math.round(ms/1000));return (s/60|0)+':'+String(s%60).padStart(2,'0')};
const LABEL_W=64;
// one entry per lane — adding a lane is one entry, no per-type branching below
const LANE_CONFIG=${laneConfigSource()};
const posPct=(t,dur)=>(!Number.isFinite(t)||!Number.isFinite(dur)||dur<=0)?0:Math.min(100,Math.max(0,t/dur*100));
const laneFor=(e)=>{for(const l of LANE_CONFIG){if(!l.from(e))continue;
  return (l.needsTime&&!Number.isFinite(e.t))?null:l.id;}return null;};
let data,offset=0,dur=1,W=1280,H=800,els=[];

async function boot(){
  const r=await fetch('/api/admin/sessions/'+SID+'/timeline');
  if(r.status===401){document.body.innerHTML='<p style="padding:2rem">Log in at <a href="/admin">/admin</a> first.</p>';return;}
  data=await r.json();
  dur=Math.max(1,data.session.durationMs??1);
  const vs=data.events.find(e=>e.lane==='marks'&&e.kind==='video-start');
  offset=vs?vs.t:0;
  $('#meta').textContent=SID+' · '+(data.session.playerCode??'no player code')+' · '+data.session.startedAt;
  $('#ttot').textContent=clock(dur);
  if(data.video)$('#v').src=data.video;
  const lanes=$('#lanes');
  for(const e of data.events){
    if(e.lane==='input'&&e.kind==='move')continue;         // too dense to list
    const d=document.createElement('div');
    d.className='ev '+(e.lane==='clicks'?'click':e.lane);
    d.dataset.t=e.t;
    const what=e.lane==='transcript'?'“'+e.text+'”'
      :e.lane==='clicks'?'click #'+e.n+' ('+e.x+','+e.y+')'
      :e.lane==='ogd'?'OGD '+(e.how??'')+' '+(e.playerCode?'code='+e.playerCode:(e.bytes+'B'))
      :e.lane==='checklist'?'☑ '+e.item+(e.checked?'':' (unchecked)')
      :e.lane==='marks'?'— '+e.kind+(e.scale?' '+e.scale:'')+' —'
      :e.kind??'';
    d.innerHTML='<span class="t">'+clock(e.t)+'</span>'+String(what).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    if(e.lane==='clicks'){const m=document.createElement('div');m.className='mark';
      m.style.left=(e.x/W*100)+'%';m.style.top=(e.y/H*100)+'%';m.dataset.t=e.t;$('#stage').appendChild(m);}
    lanes.appendChild(d);
  }
  els=[...document.querySelectorAll('.ev')];
  buildStrip();
  tick();
}
// runs of near-adjacent point events become one bar spanning first..last
function burst(evs,gap){
  const out=[];
  for(const e of evs){
    const p=out[out.length-1];
    if(p&&e.t-(p.t+p.ms)<=gap){p.ms=e.t-p.t;continue;}
    out.push({t:e.t,ms:0});
  }
  return out;
}
// one innerHTML write per lane, no per-marker layout reads
function buildStrip(){
  const bucket=new Map(LANE_CONFIG.map(l=>[l.id,[]]));
  for(const e of data.events){
    if(!Number.isFinite(e.t))continue;
    const id=laneFor(e);
    if(id)bucket.get(id).push(e);
  }
  for(const l of LANE_CONFIG){
    let evs=bucket.get(l.id).sort((a,b)=>a.t-b.t);
    if(l.burstGapMs)evs=burst(evs,l.burstGapMs);
    $('#track-'+l.id).innerHTML=evs.map(e=>{
      const left=posPct(e.t,dur);
      if(l.shape!=='bar')return '<i class="m '+l.shape+'" style="left:'+left.toFixed(4)+'%"></i>';
      const w=Math.min(posPct(Math.max(Number(e[l.durKey])||0,dur/600),dur),100-left);
      return '<i class="m bar" style="left:'+left.toFixed(4)+'%;width:'+w.toFixed(4)+'%"></i>';
    }).join('');
  }
}
const now=()=>offset+($('#v').currentTime*1000||0);
const seek=(t)=>{$('#v').currentTime=Math.max(0,(t-offset)/1000);render(t);};
function render(t){
  $('#tnow').textContent=clock(t);
  $('#scrub').value=Math.round(t/dur*1000);
  $('#ph').style.left='calc('+LABEL_W+'px + (100% - '+LABEL_W+'px) * '+(posPct(t,dur)/100).toFixed(5)+')';
  let focus=null;
  for(const el of els){
    const et=Number(el.dataset.t);
    el.classList.toggle('past',et<=t);
    el.classList.toggle('now',et<=t&&t-et<2500);
    if(et<=t)focus=el;
  }
  if(focus&&!scrubbing)focus.scrollIntoView({block:'center',behavior:'instant'});
  for(const m of document.querySelectorAll('.mark')){
    const mt=Number(m.dataset.t);
    m.classList.toggle('show',t>=mt&&t-mt<1600);
  }
}
function tick(){render(now());requestAnimationFrame(tick);}
let scrubbing=false;
$('#scrub').addEventListener('input',()=>{scrubbing=true;
  const t=Number($('#scrub').value)/1000*dur;
  seek(t);});
$('#scrub').addEventListener('change',()=>{scrubbing=false;});
$('#strip').addEventListener('click',(ev)=>{
  const r=$('#lanebody').querySelector('.track').getBoundingClientRect();
  if(!r.width)return;
  seek(Math.min(1,Math.max(0,(ev.clientX-r.left)/r.width))*dur);
});
$('#play').onclick=()=>{const v=$('#v');if(v.paused){v.play();$('#play').textContent='⏸';}else{v.pause();$('#play').textContent='▶';}};
boot();
</script>`;

export function createAdminUi() {
  return function adminUiRoutes(req, res, u) {
    const html = (page) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); };
    if (u.pathname === '/' || u.pathname === '/admin') { html(ADMIN_PAGE); return true; }
    const m = u.pathname.match(/^\/admin\/replay\/([a-f0-9]{16})$/);
    if (m && SID.test(m[1])) { html(replayPage(m[1])); return true; }
    return false;
  };
}
