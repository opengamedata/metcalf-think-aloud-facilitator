// Participant-facing error surface. Middle schoolers on school Chromebooks hit
// these pages; raw JSON reads to a screen reader as "open brace quote error".
// Browsers get a calm HTML page, /api/ clients keep the JSON shape they parse.

import crypto from 'node:crypto';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Short, opaque, sayable-out-loud handle so a report ("it said B4K2QP") can be
// grepped out of the server log. No 0/O/1/I — kids read these aloud.
export function incidentId() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
}

// The HTML/JSON boundary. /api/ is a contract with existing fetch() callers and
// existing tests: it stays JSON whatever the browser asks for. Everything else
// is a human navigating, unless they explicitly asked for JSON only.
export function wantsJson(req, u) {
  const pathname = typeof u === 'string' ? u : (u?.pathname ?? '');
  if (pathname === '/api' || pathname.startsWith('/api/')) return true;
  const accept = String(req?.headers?.accept ?? '');
  if (/\btext\/html\b/i.test(accept)) return false;
  return /\bapplication\/json\b/i.test(accept);
}

const CSS = `
  :root{--bg:#10151a;--panel:#161d24;--ink:#e6e9ec;--muted:#93a0ab;--accent:#4fb3c0;--warm:#e8a34a;--ok:#6eb891;--err:#e4735c;--rule:#26303a;--field:#0d1216}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,sans-serif}
  main{max-width:34rem;margin:0 auto;padding:3.5rem 1.4rem 4rem}
  .card{background:var(--panel);border:1px solid var(--rule);border-top:3px solid var(--warm);border-radius:8px;padding:1.6rem}
  h1{font-size:1.5rem;line-height:1.3;margin:0 0 .8rem;color:var(--ink)}
  p{margin:0 0 .9rem}
  .hint{color:var(--muted)}
  a{color:var(--accent)}
  a:focus-visible,:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
  .go{display:inline-block;margin-top:.4rem;background:var(--accent);color:#06222a;border-radius:5px;padding:.6rem 1.2rem;font-weight:600;text-decoration:none}
  .ref{margin-top:1.6rem;color:var(--muted);font-size:.85rem}
  .ref code{font-family:ui-monospace,monospace;color:var(--ink);background:var(--field);border:1px solid var(--rule);border-radius:4px;padding:.1rem .35rem}
`;

// A whole document, not a fragment: landmark, one h1, real title, lang, viewport.
export function errorPage({ status = 500, title, message, hint, backLink, incident } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <div class="card">
    <h1>${esc(title)}</h1>
    <p>${esc(message)}</p>
    ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
    ${backLink ? `<p><a class="go" href="${esc(backLink.href)}">${esc(backLink.label)}</a></p>` : ''}
    ${incident ? `<p class="ref">If you tell a researcher about this, give them this code: <code>${esc(incident)}</code></p>` : ''}
  </div>
</main>
</body>
</html>`;
}

// Copy is written for a nervous 12-year-old and their teacher: no slug, no
// stack, no status code as the headline, nobody blamed.
export const COPY = {
  campaign: {
    title: 'This study link does not work',
    message: 'The link may have been typed a little differently from the one on your handout, or this study may have finished.',
    hint: 'Check the link with your teacher or the researcher — nothing you did caused this.',
  },
  notFound: {
    title: 'We could not find that page',
    message: 'The link may have been typed a little differently, or the page may have moved.',
    hint: 'Check the link with your teacher or the researcher.',
  },
  login: {
    title: 'Please log in first',
    message: 'This page is for researchers, and your session has expired or has not started yet.',
    hint: null,
    backLink: { href: '/admin', label: 'Go to the researcher login' },
  },
  server: {
    title: 'Sorry — something went wrong on our end',
    message: 'This is a problem with the study software, not with anything you did.',
    hint: 'Please tell the researcher or your teacher, and they can pick things up from here.',
  },
};

const JSON_MESSAGE = { 400: 'bad request', 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 500: 'internal error' };

// One place that decides HTML vs JSON, writes the response, and (for 5xx) logs
// the real exception against the incident id the user is shown. Returns the id.
export function sendError(req, res, u, { status = 500, error, log = console.error, ...page } = {}) {
  const incident = status >= 500 ? incidentId() : null;
  if (error) log(`[metcalf] ${incident ?? status} ${req?.method ?? ''} ${u?.pathname ?? ''} —`, error?.stack ?? error);
  if (res.headersSent) { res.end(); return incident; }

  if (wantsJson(req, u)) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(incident
      ? { error: JSON_MESSAGE[500], incident }
      : { error: JSON_MESSAGE[status] ?? 'error' }));
    return incident;
  }
  const copy = page.title ? page : (COPY[page.kind] ?? (status >= 500 ? COPY.server : COPY.notFound));
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(errorPage({ status, ...copy, incident }));
  return incident;
}
