import base from './entry-v1.29.js';

const KV = 'CURATOR_ERROR_RECORDS';
const OBSERVATION_PREFIX = 'observation:client-script:';
const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const MIGRATION_KEY = 'maintenance:client-script-observation-migration:v2';
const OBSERVATION_TTL = 60 * 60 * 24 * 30;
const RECOVERED_TTL = 60 * 60 * 24 * 180;
const EVENT_TTL = 60 * 60 * 24 * 180;
const ESCALATION_WINDOW_MS = 15 * 60 * 1000;
const ESCALATION_OCCURRENCES = 4;
const ESCALATION_DISTINCT_CLIENTS = 2;
const VERSION = '1.31.0';
const ALLOWED_HOST_RE = /^(?:[a-z0-9-]+\.)*oceanliners\.net$/i;
const SCRIPT_KINDS = new Set(['javascript-error', 'unhandled-rejection']);
const ACTIVE = new Set(['active', 'degraded']);


async function requireRecoveryExportToken(request, env) {
  if (!env.RECOVERY_EXPORT_TOKEN) {
    return plainJson({
      ok: false,
      error: 'Recovery export is disabled because RECOVERY_EXPORT_TOKEN is not configured.'
    }, 503);
  }

  const supplied = request.headers.get('x-curator-recovery-key');
  if (supplied === env.RECOVERY_EXPORT_TOKEN) return null;

  return plainJson({
    ok: false,
    error: 'Unauthorized recovery export request.'
  }, 401);
}

async function listAllErrorState(env) {
  requireKv(env);

  const entries = [];
  let cursor;

  do {
    const page = await env[KV].list({
      limit: 1000,
      ...(cursor ? { cursor } : {})
    });

    for (const item of page.keys) {
      const raw = await env[KV].get(item.name, 'text');
      if (raw === null) {
        throw new Error(`Listed KV key disappeared during export: ${item.name}`);
      }
      entries.push({ key: item.name, value: raw });
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  entries.sort((a, b) => a.key.localeCompare(b.key));
  return entries;
}

function summarizeErrorState(entries) {
  const counts = {
    incidents: 0,
    events: 0,
    heartbeats: 0,
    observations: 0,
    maintenance: 0,
    other: 0
  };

  for (const entry of entries) {
    const key = entry.key;
    if (key.startsWith('incident:')) counts.incidents++;
    else if (key.startsWith('event:')) counts.events++;
    else if (key.startsWith('heartbeat:')) counts.heartbeats++;
    else if (key.startsWith('observation:')) counts.observations++;
    else if (key.startsWith('maintenance:')) counts.maintenance++;
    else counts.other++;
  }

  return counts;
}

async function sha256Text(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function recoveryExport(env) {
  try {
    const entries = await listAllErrorState(env);
    const data = { entries };
    const exportedAt = new Date().toISOString();
    const dataSha256 = await sha256Text(JSON.stringify(data));

    const payload = {
      format: 'curator-error-bus-kv-recovery',
      schemaVersion: 1,
      exportedAt,
      source: {
        service: 'CuratorOS Error Bus',
        binding: KV,
        namespaceId: '447306da3a754b44830d2ac8608322c0'
      },
      integrity: {
        algorithm: 'SHA-256',
        dataSha256
      },
      summary: {
        keyCount: entries.length,
        categories: summarizeErrorState(entries)
      },
      data
    };

    const stamp = exportedAt.replace(/[:.]/g, '-');
    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="error-bus-recovery-${stamp}.json"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-robots-tag': 'noindex, nofollow, noarchive'
      }
    });
  } catch (error) {
    return plainJson({
      ok: false,
      error: 'Recovery export failed.',
      detail: error instanceof Error ? error.message : String(error)
    }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);


    if (request.method === 'GET' && url.pathname === '/api/recovery-export') {
      const authError = await requireRecoveryExportToken(request, env);
      if (authError) return authError;
      return recoveryExport(env);
    }

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      const forwarded = request.clone();
      let raw = null;

      try {
        raw = await request.json();
      } catch {
        return base.fetch(forwarded, env, ctx);
      }

      if (SCRIPT_KINDS.has(raw?.kind)) {
        const origin = request.headers.get('origin') || '';
        if (!allowedOrigin(origin)) return base.fetch(forwarded, env, ctx);

        try {
          const observation = await recordScriptObservation(env, origin, raw, request);
          const active = await activeScriptIncident(env, observation.incidentFingerprint);

          if (active) {
            const refreshed = await refreshActiveIncident(env, active.key, active.incident, observation);
            return json({
              ok: true,
              version: VERSION,
              classification: 'active-incident-observation',
              escalated: true,
              incident: {
                id: refreshed.id,
                fingerprint: refreshed.fingerprint,
                severity: refreshed.severity,
                status: refreshed.status,
                lastSeenAt: refreshed.lastSeenAt,
                occurrences: refreshed.occurrences
              },
              observation: publicObservation(observation)
            }, 202, origin);
          }

          if (observation.escalationEligible) {
            const incident = await createTriageIncident(env, observation);
            return json({
              ok: true,
              version: VERSION,
              classification: 'triage-incident',
              escalated: true,
              incident: {
                id: incident.id,
                fingerprint: incident.fingerprint,
                severity: incident.severity,
                status: incident.status,
                lastSeenAt: incident.lastSeenAt,
                occurrences: incident.occurrences
              },
              escalationPolicy: policyView(),
              observation: publicObservation(observation)
            }, 201, origin);
          }

          return json({
            ok: true,
            version: VERSION,
            classification: 'observation',
            escalated: false,
            escalationPolicy: policyView(),
            observation: publicObservation(observation)
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

    if (request.method === 'GET' && url.pathname === '/api/client-script-observations') {
      try {
        return plainJson({
          ok: true,
          version: VERSION,
          classification: 'observation-first',
          escalationPolicy: policyView(),
          observations: await recentScriptObservations(env)
        });
      } catch (error) {
        return plainJson({
          ok: false,
          version: VERSION,
          error: error instanceof Error ? error.message : String(error)
        }, 500);
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(
      retireLegacyScriptIncidentsOnce(env).catch(error =>
        console.warn('Client script hardening migration skipped:', error?.message || String(error))
      )
    );
    return result;
  }
};

async function recordScriptObservation(env, origin, raw, request) {
  requireKv(env);

  const host = new URL(origin).hostname.toLowerCase();
  const page = safePath(raw?.pageUrl, host);
  const kind = clean(raw?.kind, 80) || 'javascript-error';
  const message = clean(raw?.message || 'Unknown browser script error', 1000);
  const file = safeUrl(raw?.filename, host);
  const line = finite(raw?.line);
  const column = finite(raw?.column);
  const userAgent = clean(request.headers.get('user-agent'), 300) || '';
  const normalized = [
    host,
    page,
    kind,
    normalizeMessage(message),
    normalizeResource(file)
  ].join('|');

  const short = await shortHash(normalized);
  const fingerprint = `client-script-${short}`;
  const incidentFingerprint = `client-script-triage-${short}`;
  const key = OBSERVATION_PREFIX + fingerprint;
  const previous = await env[KV].get(key, 'json');
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const previousLastSeenMs = Date.parse(previous?.lastSeenAt || '');
  const withinWindow = Number.isFinite(previousLastSeenMs)
    ? (nowMs - previousLastSeenMs) <= ESCALATION_WINDOW_MS
    : false;

  const previousWindow = withinWindow && Array.isArray(previous?.windowClientSignatures)
    ? previous.windowClientSignatures
    : [];
  const clientSignature = await shortHash(`${page}|${normalizeUserAgent(userAgent)}`);
  const windowClientSignatures = [...new Set([...previousWindow, clientSignature])].slice(-12);
  const windowOccurrences = previous && withinWindow
    ? Number(previous.windowOccurrences || 1) + 1
    : 1;

  const escalationEligible =
    windowOccurrences >= ESCALATION_OCCURRENCES &&
    windowClientSignatures.length >= ESCALATION_DISTINCT_CLIENTS;

  const observation = {
    fingerprint,
    incidentFingerprint,
    classification: escalationEligible ? 'escalation-eligible' : 'observation',
    source: host === 'oceanliners.net' || host === 'www.oceanliners.net'
      ? 'Ocean Liner Curator'
      : host,
    component: 'frontend-runtime',
    type: `client-${kind}`,
    severity: 'observation',
    kind,
    message,
    page,
    file: file || null,
    line,
    column,
    userAgent: userAgent || null,
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    occurrences: Number(previous?.occurrences || 0) + 1,
    windowOccurrences,
    distinctClientSignatures: windowClientSignatures.length,
    windowClientSignatures,
    escalationWindowMinutes: Math.round(ESCALATION_WINDOW_MS / 60000),
    escalationEligible
  };

  await env[KV].put(key, JSON.stringify(observation), { expirationTtl: OBSERVATION_TTL });
  return observation;
}

async function activeScriptIncident(env, fingerprint) {
  const key = INCIDENT_PREFIX + fingerprint;
  const incident = await env[KV].get(key, 'json');
  return incident && ACTIVE.has(incident.status) ? { key, incident } : null;
}

async function createTriageIncident(env, observation) {
  const key = INCIDENT_PREFIX + observation.incidentFingerprint;
  const previous = await env[KV].get(key, 'json');
  const now = observation.lastSeenAt;

  const incident = {
    id: previous?.id || `incident_${observation.incidentFingerprint.slice(0, 28)}`,
    fingerprint: observation.incidentFingerprint,
    source: observation.source,
    component: observation.component,
    severity: 'p2',
    type: observation.type,
    message: observation.message,
    context: {
      page: observation.page,
      file: observation.file,
      line: observation.line,
      column: observation.column,
      classification: 'browser-telemetry-triage',
      corroboration: 'multiple-client-signatures',
      distinctClientSignatures: observation.distinctClientSignatures,
      escalationWindowMinutes: observation.escalationWindowMinutes,
      browserTelemetryOnly: true,
      requiresRecheckForPriority: true
    },
    firstSeenAt: previous?.firstSeenAt || observation.firstSeenAt || now,
    lastSeenAt: now,
    occurrences: Math.max(
      Number(previous?.occurrences || 0) + 1,
      Number(observation.windowOccurrences || 1)
    ),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null
  };

  await env[KV].put(key, JSON.stringify(incident));
  await writeEvent(env, 'client-script-triage', incident);
  return incident;
}

async function refreshActiveIncident(env, key, incident, observation) {
  const refreshed = {
    ...incident,
    lastSeenAt: observation.lastSeenAt,
    occurrences: Math.max(1, Number(incident.occurrences || 0) + 1),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    context: {
      ...(incident.context || {}),
      page: observation.page,
      file: observation.file,
      lastObservationClassification: observation.classification,
      lastWindowOccurrences: observation.windowOccurrences,
      distinctClientSignatures: observation.distinctClientSignatures
    }
  };

  await env[KV].put(key, JSON.stringify(refreshed));
  await writeEvent(env, 'client-script-recurrence', refreshed);
  return refreshed;
}

async function retireLegacyScriptIncidentsOnce(env) {
  requireKv(env);
  if (await env[KV].get(MIGRATION_KEY)) return;

  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let retired = 0;

  for (const item of listed.keys) {
    const incident = await env[KV].get(item.name, 'json');
    if (!incident || !isLegacyScriptIncident(incident)) continue;
    if (!ACTIVE.has(incident.status)) continue;

    const now = new Date().toISOString();
    await env[KV].put(item.name, JSON.stringify({
      ...incident,
      status: 'recovered',
      recoveredAt: now,
      lastSuccessfulAt: now,
      recoveryMessage: 'Retired by Error Bus v1.31 hardening. Browser telemetry now requires corroborated recurrence and clean health evidence governs recovery.',
      context: {
        ...(incident.context || {}),
        classification: 'legacy-browser-incident-retired',
        reclassifiedBy: VERSION
      }
    }), { expirationTtl: RECOVERED_TTL });
    retired++;
  }

  await env[KV].put(
    MIGRATION_KEY,
    JSON.stringify({ completedAt: new Date().toISOString(), retired }),
    { expirationTtl: RECOVERED_TTL }
  );
}

function isLegacyScriptIncident(incident) {
  if (!['client-javascript-error', 'client-unhandled-rejection'].includes(incident?.type)) return false;
  return !String(incident?.fingerprint || '').startsWith('client-script-triage-');
}

async function recentScriptObservations(env) {
  requireKv(env);
  const listed = await env[KV].list({ prefix: OBSERVATION_PREFIX, limit: 250 });
  const rows = [];

  for (const item of listed.keys) {
    const value = await env[KV].get(item.name, 'json');
    if (value) {
      const copy = { ...value };
      delete copy.windowClientSignatures;
      rows.push(copy);
    }
  }

  rows.sort((a, b) =>
    Number(b.windowOccurrences || 0) - Number(a.windowOccurrences || 0) ||
    Number(b.distinctClientSignatures || 0) - Number(a.distinctClientSignatures || 0) ||
    Number(b.occurrences || 0) - Number(a.occurrences || 0) ||
    String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
  );

  return rows.slice(0, 50);
}

async function writeEvent(env, kind, incident) {
  const at = new Date().toISOString();
  const random = Math.random().toString(36).slice(2, 8);
  await env[KV].put(
    `${EVENT_PREFIX}${at}:${random}`,
    JSON.stringify({
      kind,
      at,
      incidentId: incident.id,
      fingerprint: incident.fingerprint,
      source: incident.source,
      component: incident.component,
      severity: incident.severity,
      status: incident.status,
      message: incident.message
    }),
    { expirationTtl: EVENT_TTL }
  );
}

function policyView() {
  return {
    occurrences: ESCALATION_OCCURRENCES,
    withinMinutes: Math.round(ESCALATION_WINDOW_MS / 60000),
    distinctClientSignatures: ESCALATION_DISTINCT_CLIENTS,
    initialIncidentSeverity: 'p2',
    browserTelemetryAloneCreatesPriorityIncident: false,
    recoveryPolicy: 'positive-health-evidence'
  };
}

function publicObservation(observation) {
  return {
    fingerprint: observation.fingerprint,
    occurrences: observation.occurrences,
    windowOccurrences: observation.windowOccurrences,
    distinctClientSignatures: observation.distinctClientSignatures,
    firstSeenAt: observation.firstSeenAt,
    lastSeenAt: observation.lastSeenAt
  };
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
  return clean(value, 1000)
    .toLowerCase()
    .replace(/\b\d{4,}\b/g, '<n>')
    .replace(/https?:\/\/[^\s]+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeResource(value) {
  return String(value || '').trim().replace(/[?#].*$/, '');
}

function normalizeUserAgent(value) {
  return clean(value, 300)
    .toLowerCase()
    .replace(/\b(version|chrome|crios|firefox|fxios|safari|edg|edgios)\/[\d.]+/g, '$1/<v>')
    .replace(/\bos [\d_]+/g, 'os <v>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function shortHash(value) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value || ''))
  );
  return [...new Uint8Array(hash)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
