import base from './entry-v1.7.js';

const KV = 'CURATOR_ERROR_RECORDS';
const TRANSIENT_PREFIX = 'transient:';
const PROVISIONAL_PREFIX = 'provisional:';
const INCIDENT_PREFIX = 'incident:';
const TRANSIENT_TTL = 60 * 60 * 24 * 7;
const PROVISIONAL_TTL = 60 * 60;
const PUBLIC_HOST_RE = /(^|\.)oceanliners\.net$/i;
const RETRYABLE_KINDS = new Set(['resource-error', 'fetch-network-error', 'fetch-http-error']);
const NOISE_RE = /runtime\.sendMessage|tab not found|receiving end does not exist|message port closed|extension context invalidated|chrome-extension:\/\/|moz-extension:\/\/|safari-web-extension:\/\/|webkit-masked-url/i;
const FIRST_PARTY_RE = /(^|\.)oceanliners\.net/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      return verifyClientObservation(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/check-now') {
      await recoverEnvironmentalNoise(env).catch(() => {});
      return base.fetch(request, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      await recoverEnvironmentalNoise(env).catch(() => {});
      const response = await base.fetch(request, env, ctx);
      const markup = await response.text();
      const transients = await listRecentTransients(env).catch(() => []);
      return new Response(injectTransientSummary(markup, transients), {
        status: response.status,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(recoverEnvironmentalNoise(env).catch(error => console.error('Environmental-noise cleanup failed', error)));
    return result;
  }
};

async function verifyClientObservation(request, env) {
  const origin = request.headers.get('origin') || '';
  const clone = request.clone();
  let body;
  try { body = await clone.json(); }
  catch { return base.fetch(request, env, {}); }

  const kind = String(body?.kind || 'browser-error');
  const message = String(body?.message || 'Unknown browser error');
  const stack = String(body?.stack || '');
  const resource = normalizePublicResource(body?.resource);
  const method = String(body?.method || 'GET').toUpperCase();
  const material = `${message}\n${stack}\n${body?.filename || ''}\n${body?.resource || ''}`;

  if (NOISE_RE.test(material)) {
    await recordTransient(env, body, origin, {
      classification: 'environmental-noise',
      resolution: 'Ignored as browser/extension runtime noise.',
      confirmedHealthy: true
    });
    return clientJson({ ok:true, transient:true, promoted:false, classification:'environmental-noise' }, 202, origin);
  }

  if (RETRYABLE_KINDS.has(kind) && method === 'GET' && resource) {
    const verification = await boundedRetry(resource, kind);
    if (verification.recovered) {
      await recordTransient(env, body, origin, {
        classification: 'self-corrected-network-event',
        resolution: `Automatic retry succeeded on attempt ${verification.successAttempt}.`,
        confirmedHealthy: true,
        verification
      });
      return clientJson({ ok:true, transient:true, promoted:false, classification:'self-corrected-network-event', verification }, 202, origin);
    }
    // Two independent server-side failures are enough evidence to let the
    // established Error Bus incident pipeline promote the observation.
    return base.fetch(request, env, {});
  }

  if (kind === 'unhandled-rejection') {
    const firstParty = FIRST_PARTY_RE.test(stack) || FIRST_PARTY_RE.test(String(body?.filename || ''));
    const specific = message && !/^unhandled promise rejection$/i.test(message.trim());
    if (!firstParty || !specific) {
      const state = await provisionalObservation(env, body, origin, 3);
      if (!state.promote) {
        return clientJson({ ok:true, transient:true, promoted:false, classification:'provisional-promise-rejection', observations:state.count, threshold:state.threshold }, 202, origin);
      }
    }
  }

  if (kind === 'javascript-error') {
    const syntaxLike = /syntaxerror|unexpected token|expected .*argument list|unterminated|invalid or unexpected token/i.test(material);
    const firstParty = FIRST_PARTY_RE.test(stack) || FIRST_PARTY_RE.test(String(body?.filename || ''));
    if (!syntaxLike && !firstParty) {
      const state = await provisionalObservation(env, body, origin, 2);
      if (!state.promote) {
        return clientJson({ ok:true, transient:true, promoted:false, classification:'provisional-runtime-error', observations:state.count, threshold:state.threshold }, 202, origin);
      }
    }
  }

  return base.fetch(request, env, {});
}

async function boundedRetry(resource, kind) {
  const attempts = [];
  for (let i = 1; i <= 2; i++) {
    if (i > 1) await new Promise(resolve => setTimeout(resolve, 900));
    const result = await verifyResource(resource, kind, i);
    attempts.push(result);
    if (result.ok) return { recovered:true, successAttempt:i, attempts };
  }
  return { recovered:false, successAttempt:null, attempts };
}

async function verifyResource(resource, kind, attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const target = new URL(resource);
    target.searchParams.set('errorBusRetry', `${Date.now()}-${attempt}`);
    const response = await fetch(target.href, {
      method:'GET', redirect:'follow', cache:'no-store',
      headers:{ accept:kind === 'resource-error' ? '*/*' : 'text/html,*/*;q=0.8', 'user-agent':'CuratorOS-Error-Bus-Verification-v2/1.0' },
      signal:controller.signal,
      cf:{ cacheTtl:0, cacheEverything:false }
    });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const looksLikeErrorPage = /<title>\s*(?:404|500|error|not found)|cloudflare.*error/i.test(text.slice(0,1500));
    return { attempt, ok:response.ok && bytes > 0 && !looksLikeErrorPage, status:response.status, bytes, durationMs:Date.now()-started };
  } catch (error) {
    return { attempt, ok:false, status:null, bytes:0, durationMs:Date.now()-started, error:error?.message || String(error) };
  } finally { clearTimeout(timer); }
}

async function provisionalObservation(env, body, origin, threshold) {
  requireKv(env);
  const signature = await shortHash(`${origin}|${body?.kind}|${body?.message}|${body?.filename || ''}|${body?.resource || ''}`);
  const key = `${PROVISIONAL_PREFIX}${signature}`;
  const now = new Date().toISOString();
  const previous = await env[KV].get(key, 'json');
  const count = Math.max(1, Number(previous?.count || 0) + 1);
  const record = { signature, kind:body?.kind || '', message:String(body?.message || '').slice(0,600), origin, firstSeenAt:previous?.firstSeenAt || now, lastSeenAt:now, count, threshold };
  await env[KV].put(key, JSON.stringify(record), { expirationTtl:PROVISIONAL_TTL });
  await recordTransient(env, body, origin, { classification:'provisional-observation', resolution:`Observed ${count}/${threshold}; not yet promoted to an incident.`, confirmedHealthy:false, provisional:true });
  if (count >= threshold) {
    await env[KV].delete(key);
    return { promote:true, count, threshold };
  }
  return { promote:false, count, threshold };
}

async function recordTransient(env, body, origin, extra = {}) {
  requireKv(env);
  const now = new Date().toISOString();
  const key = `${TRANSIENT_PREFIX}${now}:${Math.random().toString(36).slice(2,8)}`;
  const record = {
    at:now,
    origin,
    page:String(body?.pageUrl || '').slice(0,800),
    kind:String(body?.kind || '').slice(0,100),
    message:String(body?.message || '').slice(0,1000),
    resource:String(body?.resource || '').slice(0,1000),
    ...extra
  };
  await env[KV].put(key, JSON.stringify(record), { expirationTtl:TRANSIENT_TTL });
  return record;
}

async function listRecentTransients(env) {
  requireKv(env);
  const listed = await env[KV].list({ prefix:TRANSIENT_PREFIX, limit:100 });
  const rows = [];
  for (const key of listed.keys) {
    const value = await env[KV].get(key.name, 'json');
    if (value) rows.push(value);
  }
  return rows.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||''))).slice(0,12);
}

async function recoverEnvironmentalNoise(env) {
  requireKv(env);
  const listed = await env[KV].list({ prefix:INCIDENT_PREFIX, limit:1000 });
  let recovered = 0;
  for (const key of listed.keys) {
    const incident = await env[KV].get(key.name, 'json');
    if (!incident || !['active','degraded'].includes(incident.status)) continue;
    const material = `${incident.message || ''}\n${incident?.context?.stack || ''}\n${incident?.context?.file || ''}\n${incident?.context?.resource || ''}`;
    if (!NOISE_RE.test(material)) continue;
    const now = new Date().toISOString();
    await env[KV].put(key.name, JSON.stringify({ ...incident, status:'recovered', recoveredAt:now, lastSuccessfulAt:now, recoveryMessage:'Reclassified by Incident Verification v2 as browser/extension environmental noise; no CuratorOS application failure confirmed.' }), { expirationTtl:60*60*24*180 });
    recovered++;
  }
  return recovered;
}

function injectTransientSummary(markup, rows) {
  const resolved = rows.filter(x=>x.confirmedHealthy).length;
  const provisional = rows.filter(x=>x.provisional).length;
  const cards = rows.slice(0,6).map(x=>`<div class="detail-row"><strong>${escapeHtml(x.confirmedHealthy?'QUIET':'OBSERVED')}</strong><span>${escapeHtml(x.kind || x.classification || 'event')}</span><p>${escapeHtml(x.message || 'Transient browser event')}</p><small>${escapeHtml(x.resolution || '')} · ${escapeHtml(x.at || '')}</small></div>`).join('');
  const section = `<section><h3>Recent transient events</h3><p class="lead">These observations were preserved for diagnostics but are <strong>not active incidents</strong> unless verification or recurrence promotes them.</p><div class="summary"><span class="pill">${rows.length} recent transient</span><span class="pill">${resolved} self-cleared / environmental</span><span class="pill">${provisional} provisional</span></div>${rows.length?`<div class="detail-list">${cards}</div>`:'<div class="empty">All’s quiet — no recent transient browser events are recorded.</div>'}</section>`;
  const marker = '<section><h3>Active incidents</h3>';
  return markup.includes(marker) ? markup.replace(marker, `${section}${marker}`) : markup.replace('</main>', `${section}</main>`);
}

function normalizePublicResource(value) {
  try {
    const url = new URL(String(value || ''), 'https://oceanliners.net/');
    if (url.protocol !== 'https:' || !PUBLIC_HOST_RE.test(url.hostname)) return '';
    url.username=''; url.password=''; url.hash='';
    return url.href;
  } catch { return ''; }
}

async function shortHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);
}
function requireKv(env) { if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`); }
function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
function clientCors(origin) { return { 'access-control-allow-origin':origin || '*', vary:'Origin', 'access-control-allow-methods':'POST,OPTIONS', 'access-control-allow-headers':'content-type' }; }
function clientJson(value, status, origin) { return new Response(JSON.stringify(value), { status, headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...clientCors(origin) } }); }
