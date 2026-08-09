import base from './entry.js';
import { handleClientError, clientReporterScript } from './client-errors.js';

const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/client-reporter.js' && request.method === 'GET') {
      return clientReporterScript();
    }

    if (url.pathname === '/api/client-error') {
      return handleClientError(request, env, upsertClientIncident);
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

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
  const eventKey = `${EVENT_PREFIX}${now}:${Math.random().toString(36).slice(2, 8)}`;
  await env.CURATOR_ERROR_RECORDS.put(eventKey, JSON.stringify({
    kind: 'client-incident',
    at: now,
    incidentId: incident.id,
    fingerprint,
    source,
    component,
    severity,
    status: incident.status,
    message,
  }), { expirationTtl: 60 * 60 * 24 * 180 });

  return incident;
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
