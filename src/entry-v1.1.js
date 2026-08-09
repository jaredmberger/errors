import base from './entry.js';
import { handleClientError, clientReporterScript } from './client-errors.js';

const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const PUBLIC_SITE_SOURCE = 'Ocean Liner Curator';
const PUBLIC_SITE_PROBES = [
  { id: 'homepage', url: 'https://oceanliners.net/', severity: 'p0', minBytes: 5000, expect: /Ocean Liner Curator/i },
  { id: 'shared-header-js', url: 'https://oceanliners.net/assets/header.js', severity: 'p0', minBytes: 2000, expect: /olc:header-ready|injectHeader/i },
  { id: 'shared-nav-js', url: 'https://oceanliners.net/assets/nav.js', severity: 'p0', minBytes: 1000, expect: /wireNavDropdowns|Navigation initialized/i },
  { id: 'shared-header-partial', url: 'https://oceanliners.net/partials/header.html', severity: 'p0', minBytes: 200, expect: /site-header|site-nav/i },
  { id: 'nav-css', url: 'https://oceanliners.net/assets/nav.css', severity: 'p1', minBytes: 500, expect: /site-nav|nav-dropdown/i },
  { id: 'related-liners-js', url: 'https://oceanliners.net/assets/related-liners.js', severity: 'p1', minBytes: 1000, expect: /Related Liners|related-liners/i },
  { id: 'random-ship-js', url: 'https://oceanliners.net/assets/random-ship.js', severity: 'p1', minBytes: 1000, expect: /shipUrls|ships\//i },
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/client-reporter.js' && request.method === 'GET') {
      return clientReporterScript();
    }

    if (url.pathname === '/api/client-error') {
      return handleClientError(request, env, upsertClientIncident);
    }

    if (url.pathname === '/api/public-site-probe' && request.method === 'GET') {
      const results = await runPublicSiteInfrastructureProbe(env);
      return new Response(JSON.stringify({ ok: results.every(x => x.ok), generatedAt: new Date().toISOString(), results }, null, 2), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    base.scheduled(controller, env, ctx);
    ctx.waitUntil(runPublicSiteInfrastructureProbe(env).catch(error => console.error('Public site infrastructure probe failed', error)));
  }
};

async function runPublicSiteInfrastructureProbe(env) {
  if (!env.CURATOR_ERROR_RECORDS) throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.');
  const results = [];
  for (const probe of PUBLIC_SITE_PROBES) {
    results.push(await runProbe(env, probe));
  }
  return results;
}

async function runProbe(env, probe) {
  const started = Date.now();
  const fingerprint = `public-site-infrastructure-${probe.id}`;
  let ok = false;
  let status = null;
  let bytes = 0;
  let message = '';

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(`${probe.url}${probe.url.includes('?') ? '&' : '?'}probe=${Date.now()}`, {
        method: 'GET',
        redirect: 'follow',
        headers: { accept: '*/*', 'user-agent': 'CuratorOS-Error-Bus-Public-Site-Probe/1.0' },
        signal: controller.signal,
        cf: { cacheTtl: 0, cacheEverything: false }
      });
    } finally {
      clearTimeout(timer);
    }

    status = response.status;
    const text = await response.text();
    bytes = new TextEncoder().encode(text).byteLength;

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (bytes < probe.minBytes) throw new Error(`Response unexpectedly small: ${bytes} bytes`);
    if (probe.expect && !probe.expect.test(text)) throw new Error('Expected infrastructure signature was not found in the response');

    ok = true;
    message = `Healthy · HTTP ${status} · ${bytes} bytes · ${Date.now() - started} ms`;
    await recoverInfrastructureIncident(env, fingerprint, message);
  } catch (error) {
    message = error?.name === 'AbortError' ? 'Probe timed out after 12 seconds' : (error?.message || String(error));
    await upsertInfrastructureIncident(env, {
      fingerprint,
      component: `public-site:${probe.id}`,
      severity: probe.severity,
      message: `${probe.url} failed infrastructure validation: ${message}`,
      context: { url: probe.url, httpStatus: status, responseBytes: bytes, durationMs: Date.now() - started }
    });
  }

  return { id: probe.id, url: probe.url, ok, status, bytes, durationMs: Date.now() - started, message };
}

async function upsertInfrastructureIncident(env, raw) {
  const now = new Date().toISOString();
  const key = INCIDENT_PREFIX + raw.fingerprint;
  const previous = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  const incident = {
    id: previous?.id || `incident_${raw.fingerprint}`,
    fingerprint: raw.fingerprint,
    source: PUBLIC_SITE_SOURCE,
    component: raw.component,
    severity: raw.severity === 'p0' ? 'p0' : 'p1',
    type: 'public-site-infrastructure-failure',
    message: clean(raw.message, 1200),
    context: sanitizeObject(raw.context),
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    occurrences: Math.max(1, Number(previous?.occurrences || 0) + 1),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null,
  };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(incident));
  await writeEvent(env, 'public-site-infrastructure-incident', incident);
  return incident;
}

async function recoverInfrastructureIncident(env, fingerprint, message) {
  const key = INCIDENT_PREFIX + fingerprint;
  const previous = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  if (!previous || !['active', 'degraded'].includes(previous.status)) return null;
  const now = new Date().toISOString();
  const recovered = {
    ...previous,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: clean(message || 'Infrastructure probe recovered.', 800),
  };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(recovered), { expirationTtl: 60 * 60 * 24 * 180 });
  await writeEvent(env, 'public-site-infrastructure-recovery', recovered);
  return recovered;
}

async function upsertClientIncident(env, raw) {
  if (!env.CURATOR_ERROR_RECORDS) throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.');
  const now = new Date().toISOString();
  const source = clean(raw?.source, 100);
  const component = clean(raw?.component || 'frontend-runtime', 120);
  const type = clean(raw?.type || 'client-browser-error', 100);
  const message = clean(raw?.message || 'Unknown browser error', 1200);
  const severity = raw?.severity === 'p1' ? 'p1' : 'p2';
  const fingerprint = clean(raw?.fingerprint, 200) || await fingerprintFor(source, component, type, message);
  const key = INCIDENT_PREFIX + fingerprint;
  const previous = await env.CURATOR_ERROR_RECORDS.get(key, 'json');

  const incident = {
    id: previous?.id || `incident_${fingerprint.slice(0, 20)}`,
    fingerprint,
    source,
    component,
    severity,
    type,
    message,
    context: sanitizeObject(raw?.context),
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    occurrences: Math.max(1, Number(previous?.occurrences || 0) + 1),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null,
  };

  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(incident));
  await writeEvent(env, 'client-incident', incident);
  return incident;
}

async function writeEvent(env, kind, incident) {
  const now = new Date().toISOString();
  const eventKey = `${EVENT_PREFIX}${now}:${Math.random().toString(36).slice(2, 8)}`;
  await env.CURATOR_ERROR_RECORDS.put(eventKey, JSON.stringify({
    kind,
    at: now,
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    component: incident.component,
    severity: incident.severity,
    status: incident.status,
    message: incident.message,
  }), { expirationTtl: 60 * 60 * 24 * 180 });
}

async function fingerprintFor(source, component, type, message) {
  const bytes = new TextEncoder().encode(`${source}|${component}|${type}|${message}`.toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'client-' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function sanitizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) continue;
    if (raw == null || ['string', 'number', 'boolean'].includes(typeof raw)) out[clean(key, 80)] = typeof raw === 'string' ? clean(raw, 4000) : raw;
  }
  return out;
}
