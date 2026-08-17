import base from './entry-v1.23.js';
import { BUILD_META } from './build-meta.generated.js';

const KV = 'CURATOR_ERROR_RECORDS';
const HEARTBEAT_PREFIX = 'heartbeat:';
const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const RECOVERED_TTL = 60 * 60 * 24 * 180;
const SERVICE = 'CuratorOS Error Bus';
const VERSION = '1.24.0';
const REPOSITORY = 'jaredmberger/errors';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
      const auth = authorizeWrite(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: 'Expected a JSON request body.' }, 400);
      }

      try {
        const heartbeat = await writeHeartbeat(env, body);
        return json({ ok: true, heartbeat });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/hardware-console') {
      return json({ ok: true, console: await readHardwareConsole(env) });
    }

    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      const meta = env.CF_VERSION_METADATA || {};
      return json({
        ok: true,
        service: SERVICE,
        version: VERSION,
        repository: REPOSITORY,
        runtime: 'cloudflare-workers',
        build: {
          commit: BUILD_META.commit,
          branch: BUILD_META.branch,
          buildUuid: BUILD_META.buildUuid,
          source: BUILD_META.source
        },
        cloudflareVersion: {
          id: meta.id || null,
          tag: meta.tag || null,
          timestamp: meta.timestamp || null
        },
        observedAt: new Date().toISOString()
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

async function writeHeartbeat(env, raw) {
  requireKv(env);

  const source = clean(raw?.source, 100);
  const component = clean(raw?.component || 'monitor', 120);
  if (!source) throw new Error('source is required.');

  const now = new Date().toISOString();

  // Hardware monitors may legitimately report once per minute.
  // Allow a 3-minute stale threshold while preserving the existing
  // default of 180 minutes for callers that do not specify one.
  const maxAgeMinutes = clampInt(raw?.maxAgeMinutes, 3, 10080, 180);

  const heartbeat = {
    source,
    component,
    status: raw?.status === 'degraded' ? 'degraded' : 'ok',
    message: clean(raw?.message || 'Heartbeat received.', 800),
    at: now,
    maxAgeMinutes,
    context: sanitizeObject(raw?.context)
  };

  await env[KV].put(
    `${HEARTBEAT_PREFIX}${slug(source)}:${slug(component)}`,
    JSON.stringify(heartbeat)
  );

  if (heartbeat.status === 'ok') {
    await recoverStaleHeartbeatIncident(env, heartbeat);
  }

  return heartbeat;
}

async function recoverStaleHeartbeatIncident(env, heartbeat) {
  const fingerprint = `heartbeat-${slug(heartbeat.source)}-${slug(heartbeat.component)}`;
  const key = INCIDENT_PREFIX + fingerprint;
  const incident = await env[KV].get(key, 'json');

  if (!incident || !['active', 'degraded'].includes(incident.status)) return;

  const now = new Date().toISOString();
  const recovered = {
    ...incident,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: 'Heartbeat resumed.'
  };

  await env[KV].put(key, JSON.stringify(recovered), { expirationTtl: RECOVERED_TTL });
  await writeEvent(env, 'recovery', recovered);
}

async function readHardwareConsole(env) {
  requireKv(env);

  const source = 'CuratorOS Mini Console';
  const component = 'physical-console-01';
  const key = `${HEARTBEAT_PREFIX}${slug(source)}:${slug(component)}`;
  const heartbeat = await env[KV].get(key, 'json');

  if (!heartbeat) {
    return {
      source,
      component,
      status: 'unknown',
      lastHeartbeatAt: null,
      ageSeconds: null,
      maxAgeMinutes: 3,
      stale: null,
      context: null
    };
  }

  const at = Date.parse(heartbeat.at || 0);
  const ageMs = Number.isFinite(at) ? Math.max(0, Date.now() - at) : null;
  const maxAgeMinutes = Number(heartbeat.maxAgeMinutes || 3);
  const stale = ageMs == null ? null : ageMs > maxAgeMinutes * 60 * 1000;

  return {
    source: heartbeat.source,
    component: heartbeat.component,
    status: stale ? 'offline' : heartbeat.status === 'degraded' ? 'degraded' : 'online',
    lastHeartbeatAt: heartbeat.at || null,
    ageSeconds: ageMs == null ? null : Math.round(ageMs / 1000),
    maxAgeMinutes,
    stale,
    message: heartbeat.message || null,
    context: heartbeat.context || null
  };
}

async function writeEvent(env, kind, incident) {
  const at = new Date().toISOString();
  const key = `${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2, 8)}`;

  await env[KV].put(key, JSON.stringify({
    kind,
    at,
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    component: incident.component,
    severity: incident.severity,
    status: incident.status,
    message: incident.recoveryMessage || incident.message
  }), { expirationTtl: RECOVERED_TTL });
}

function authorizeWrite(request, env) {
  if (!env.ERROR_REPORT_KEY) {
    return {
      ok: false,
      status: 503,
      error: 'ERROR_REPORT_KEY is not configured; network write API is disabled.'
    };
  }

  const supplied = request.headers.get('x-curator-error-key') || '';
  if (supplied !== env.ERROR_REPORT_KEY) {
    return { ok: false, status: 401, error: 'Unauthorized.' };
  }

  return { ok: true };
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function slug(value) {
  return clean(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) continue;
    if (raw == null || ['string', 'number', 'boolean'].includes(typeof raw)) {
      out[clean(key, 80)] = typeof raw === 'string' ? clean(raw, 4000) : raw;
    }
  }
  return out;
}

function json(value, status = 200) {
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
