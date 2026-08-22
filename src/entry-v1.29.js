import base from './entry-v1.28.js';

const KV = 'CURATOR_ERROR_RECORDS';
const OBSERVATION_PREFIX = 'observation:client-network:';
const INCIDENT_PREFIX = 'incident:';
const MIGRATION_KEY = 'maintenance:client-network-observation-migration:v1';
const OBSERVATION_TTL = 60 * 60 * 24 * 30;
const RECOVERED_TTL = 60 * 60 * 24 * 180;
const VERSION = '1.29.0';
const ALLOWED_HOST_RE = /^(?:[a-z0-9-]+\.)*oceanliners\.net$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      const forwarded = request.clone();
      let raw = null;
      try {
        raw = await request.json();
      } catch {
        return base.fetch(forwarded, env, ctx);
      }

      if (raw?.kind === 'fetch-network-error') {
        const origin = request.headers.get('origin') || '';
        if (!allowedOrigin(origin)) {
          return base.fetch(forwarded, env, ctx);
        }

        try {
          const observation = await recordNetworkObservation(env, origin, raw, request);
          ctx.waitUntil(retireMatchingLegacyIncident(env, observation).catch(() => {}));
          return json({
            ok: true,
            version: VERSION,
            classification: 'observation',
            escalated: false,
            observation: {
              fingerprint: observation.fingerprint,
              occurrences: observation.occurrences,
              firstSeenAt: observation.firstSeenAt,
              lastSeenAt: observation.lastSeenAt
            }
          }, 202, origin);
        } catch (error) {
          return json({
            ok: false,
            version: VERSION,
            error: error instanceof Error ? error.message : String(error)
          }, 500, origin);
        }
      }

      return base.fetch(forwarded, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/api/client-network-observations') {
      try {
        return plainJson({
          ok: true,
          version: VERSION,
          classification: 'observation-only',
          observations: await recentNetworkObservations(env)
        });
      } catch (error) {
        return plainJson({ ok: false, version: VERSION, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(retireLegacyNetworkIncidentsOnce(env).catch(error => console.warn('Client network observation migration skipped:', error?.message || String(error))));
    return result;
  }
};

async function recordNetworkObservation(env, origin, raw, request) {
  requireKv(env);

  const host = new URL(origin).hostname.toLowerCase();
  const page = safePath(raw?.pageUrl, host);
  const resource = safeUrl(raw?.resource, host);
  const message = clean(raw?.message || 'Fetch failed', 500);
  const method = clean(raw?.method || 'GET', 12);
  const fingerprint = `client-network-${await shortHash(`${host}|${page}|${resource}|${method}|${normalizeMessage(message)}`)}`;
  const key = OBSERVATION_PREFIX + fingerprint;
  const previous = await env[KV].get(key, 'json');
  const now = new Date().toISOString();

  const observation = {
    fingerprint,
    classification: 'observation',
    source: host === 'oceanliners.net' || host === 'www.oceanliners.net' ? 'Ocean Liner Curator' : host,
    component: 'frontend-network',
    type: 'client-fetch-network-error',
    severity: 'observation',
    message,
    page,
    resource: resource || null,
    method,
    userAgent: clean(request.headers.get('user-agent'), 300) || null,
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    occurrences: Number(previous?.occurrences || 0) + 1,
    escalated: false
  };

  await env[KV].put(key, JSON.stringify(observation), { expirationTtl: OBSERVATION_TTL });
  return observation;
}

async function retireMatchingLegacyIncident(env, observation) {
  requireKv(env);
  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  for (const item of listed.keys) {
    const incident = await env[KV].get(item.name, 'json');
    if (!incident || incident.type !== 'client-fetch-network-error') continue;
    if (!['active', 'degraded'].includes(incident.status)) continue;

    const samePage = normalizePath(incident?.context?.page) === normalizePath(observation.page);
    const sameResource = normalizeResource(incident?.context?.resource) === normalizeResource(observation.resource);
    if (!samePage || !sameResource) continue;

    await recoverAsObservation(env, item.name, incident);
  }
}

async function retireLegacyNetworkIncidentsOnce(env) {
  requireKv(env);
  if (await env[KV].get(MIGRATION_KEY)) return;

  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let retired = 0;
  for (const item of listed.keys) {
    const incident = await env[KV].get(item.name, 'json');
    if (!incident || incident.type !== 'client-fetch-network-error') continue;
    if (!['active', 'degraded'].includes(incident.status)) continue;
    await recoverAsObservation(env, item.name, incident);
    retired++;
  }

  await env[KV].put(MIGRATION_KEY, JSON.stringify({ completedAt: new Date().toISOString(), retired }), { expirationTtl: RECOVERED_TTL });
}

async function recoverAsObservation(env, key, incident) {
  const now = new Date().toISOString();
  await env[KV].put(key, JSON.stringify({
    ...incident,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: 'Reclassified as a low-confidence client network observation; isolated browser fetch failures no longer create operational incidents.',
    context: {
      ...(incident.context || {}),
      classification: 'observation',
      reclassifiedBy: VERSION
    }
  }), { expirationTtl: RECOVERED_TTL });
}

async function recentNetworkObservations(env) {
  requireKv(env);
  const listed = await env[KV].list({ prefix: OBSERVATION_PREFIX, limit: 250 });
  const rows = [];
  for (const item of listed.keys) {
    const value = await env[KV].get(item.name, 'json');
    if (value) rows.push(value);
  }
  rows.sort((a, b) => Number(b.occurrences || 0) - Number(a.occurrences || 0) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  return rows.slice(0, 50);
}

function allowedOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && ALLOWED_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

function safePath(value, expectedHost) {
  try {
    const url = new URL(value || '/', `https://${expectedHost}`);
    return url.hostname === expectedHost ? (url.pathname || '/') : '/';
  } catch {
    return '/';
  }
}

function safeUrl(value, expectedHost) {
  if (!value) return '';
  try {
    const url = new URL(value, `https://${expectedHost}`);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href.slice(0, 1000);
  } catch {
    return clean(value, 1000);
  }
}

function normalizeMessage(value) {
  return clean(value, 500).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizePath(value) {
  return String(value || '/').trim() || '/';
}

function normalizeResource(value) {
  return String(value || '').trim().replace(/[?#].*$/, '');
}

async function shortHash(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}

function clientCors(origin) {
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400'
  };
}

function json(value, status, origin) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...clientCors(origin)
    }
  });
}

function plainJson(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow, noarchive'
    }
  });
}
