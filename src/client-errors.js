const MAX_BODY_BYTES = 12000;
const ALLOWED_HOST_RE = /^(?:[a-z0-9-]+\.)*oceanliners\.net$/i;
const SOURCE_NAMES = {
  'oceanliners.net': 'Ocean Liner Curator',
  'www.oceanliners.net': 'Ocean Liner Curator',
  'tools.oceanliners.net': 'Curator Intelligence',
  'curator.oceanliners.net': 'CuratorOS',
  'site-health.oceanliners.net': 'Site Health',
  'search-intelligence.oceanliners.net': 'Search Intelligence',
  'link-map.oceanliners.net': 'Link Map',
  'integrity.oceanliners.net': 'Curator Integrity',
  'speed.oceanliners.net': 'Curator Speed',
  'curator-indexer.oceanliners.net': 'Curator Indexer',
  'page-studio.oceanliners.net': 'Page Studio',
  'launch.oceanliners.net': 'CuratorOS Launcher',
  'errors.oceanliners.net': 'CuratorOS Error Bus',
};

export async function handleClientError(request, env, upsertIncident) {
  const origin = request.headers.get('origin') || '';
  const allowed = allowedOrigin(origin);
  if (!allowed) return json({ ok: false, error: 'Origin not allowed.' }, 403, origin);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: clientCors(origin) });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405, origin);

  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: 'Report too large.' }, 413, origin);

  let raw;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Report too large.' }, 413, origin);
    raw = JSON.parse(text || '{}');
  } catch {
    return json({ ok: false, error: 'Request body must be valid JSON.' }, 400, origin);
  }

  const host = new URL(origin).hostname.toLowerCase();
  const source = SOURCE_NAMES[host] || host;
  const kind = safe(raw?.kind, 80) || 'browser-error';
  const message = safe(raw?.message, 1000) || 'Unknown browser error';
  const pagePath = safePath(raw?.pageUrl, host);
  const component = safe(raw?.component, 100) || browserComponent(kind, pagePath);
  const severity = clientSeverity(kind, raw);

  const context = {
    page: pagePath,
    kind,
    file: safeUrl(raw?.filename, host),
    line: finite(raw?.line),
    column: finite(raw?.column),
    resource: safeUrl(raw?.resource, host),
    status: finite(raw?.status),
    method: safe(raw?.method, 12),
    stack: sanitizeStack(raw?.stack),
    userAgent: safe(request.headers.get('user-agent'), 300),
    clientReported: true,
  };

  try {
    const incident = await upsertIncident(env, {
      source,
      component,
      severity,
      type: `client-${kind}`,
      message,
      context,
      fingerprint: await clientFingerprint(source, component, kind, message, context),
    });
    return json({ ok: true, incidentId: incident.id, severity: incident.severity }, 201, origin);
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500, origin);
  }
}

export function clientReporterScript() {
  const script = `(()=>{\n` +
`if(window.__CURATOR_CLIENT_ERROR_CAPTURE__)return;window.__CURATOR_CLIENT_ERROR_CAPTURE__=true;\n` +
`const ENDPOINT='https://errors.oceanliners.net/api/client-error';const seen=new Map();const COOLDOWN=60000;\n` +
`function clean(v,n=1200){return String(v??'').slice(0,n)}\n` +
`function send(payload){try{const key=[payload.kind,payload.message,payload.filename,payload.resource].join('|');const now=Date.now();if(now-(seen.get(key)||0)<COOLDOWN)return;seen.set(key,now);const body=JSON.stringify({...payload,pageUrl:location.href});if(navigator.sendBeacon){const blob=new Blob([body],{type:'application/json'});if(navigator.sendBeacon(ENDPOINT,blob))return;}fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body,keepalive:true,cache:'no-store',credentials:'omit'}).catch(()=>{});}catch{}}\n` +
`window.addEventListener('error',e=>{if(e.target&&e.target!==window){const tag=e.target.tagName||'resource';const src=e.target.src||e.target.href||'';send({kind:'resource-error',component:'frontend-resource',message:tag+' failed to load',resource:clean(src)});return;}send({kind:'javascript-error',component:'frontend-runtime',message:clean(e.message||'JavaScript error'),filename:clean(e.filename),line:e.lineno||null,column:e.colno||null,stack:clean(e.error&&e.error.stack,4000)});},true);\n` +
`window.addEventListener('unhandledrejection',e=>{const r=e.reason;send({kind:'unhandled-rejection',component:'frontend-runtime',message:clean(r&&r.message?r.message:r||'Unhandled promise rejection'),stack:clean(r&&r.stack,4000)});});\n` +
`const nativeFetch=window.fetch&&window.fetch.bind(window);if(nativeFetch){window.fetch=async function(input,init){try{const response=await nativeFetch(input,init);let u='';try{u=new URL(typeof input==='string'?input:input.url,location.href).href}catch{}if(!response.ok&&u&&!u.startsWith(ENDPOINT)){send({kind:'fetch-http-error',component:'frontend-network',message:'Fetch returned HTTP '+response.status,resource:clean(u),status:response.status,method:clean((init&&init.method)||'GET',12)});}return response;}catch(error){let u='';try{u=new URL(typeof input==='string'?input:input.url,location.href).href}catch{}if(!u.startsWith(ENDPOINT))send({kind:'fetch-network-error',component:'frontend-network',message:clean(error&&error.message||'Fetch failed'),resource:clean(u),method:clean((init&&init.method)||'GET',12),stack:clean(error&&error.stack,4000)});throw error;}}}\n` +
`window.__CURATOR_REPORT_ERROR__=(message,details={})=>send({kind:'manual-client-error',component:clean(details.component||'frontend-manual',100),message:clean(message),...details});\n` +
`})();`;
  return new Response(script, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
    },
  });
}

function allowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && ALLOWED_HOST_RE.test(url.hostname);
  } catch { return false; }
}

function clientSeverity(kind, raw) {
  if (kind === 'javascript-error' || kind === 'unhandled-rejection') return 'p1';
  if (kind === 'fetch-network-error') return 'p1';
  if (kind === 'fetch-http-error' && Number(raw?.status || 0) >= 500) return 'p1';
  return 'p2';
}
function browserComponent(kind, pagePath) {
  if (kind.includes('fetch')) return `frontend-network:${pagePath}`.slice(0, 120);
  if (kind === 'resource-error') return `frontend-resource:${pagePath}`.slice(0, 120);
  return `frontend-runtime:${pagePath}`.slice(0, 120);
}
async function clientFingerprint(source, component, kind, message, context) {
  const normalizedMessage = String(message).replace(/\b\d{4,}\b/g, '<n>').replace(/https?:\/\/[^\s]+/g, '<url>');
  const material = `${source}|${component}|${kind}|${normalizedMessage}|${context.file || ''}|${context.resource || ''}`.toLowerCase();
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return 'client-' + [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function sanitizeStack(value) {
  return safe(value, 4000).replace(/[?&](?:token|key|secret|auth|password)=[^\s&#]+/gi, '$1=<redacted>');
}
function safePath(value, expectedHost) {
  try { const u = new URL(value || '/', `https://${expectedHost}`); return u.hostname === expectedHost ? (u.pathname || '/') : '/'; } catch { return '/'; }
}
function safeUrl(value, expectedHost) {
  if (!value) return '';
  try {
    const u = new URL(value, `https://${expectedHost}`);
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.href.slice(0, 1000);
  } catch { return safe(value, 1000); }
}
function safe(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function clientCors(origin) {
  return {
    'access-control-allow-origin': origin,
    'vary': 'Origin',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}
function json(value, status, origin) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...clientCors(origin) },
  });
}
