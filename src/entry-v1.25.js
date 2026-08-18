import base from './entry-v1.24.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const ACTIVE = new Set(['active', 'degraded']);
const SERVICE = 'CuratorOS Error Bus';
const VERSION = '1.25.0';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Compact read-only payload intended for the physical Mini Error Bus.
    // It exposes only operational incident fields already suitable for display.
    if (request.method === 'GET' && url.pathname === '/api/hardware/incidents') {
      try {
        const incidents = await activeIncidents(env);
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          generatedAt: new Date().toISOString(),
          activeIncidentCount: incidents.length,
          incidents: incidents.map((incident) => ({
            id: incident.id || incident.fingerprint || null,
            fingerprint: incident.fingerprint || null,
            source: incident.source || null,
            component: incident.component || null,
            type: incident.type || null,
            severity: incident.severity || 'other',
            status: incident.status || null,
            message: incident.message || null,
            firstSeenAt: incident.firstSeenAt || null,
            lastSeenAt: incident.lastSeenAt || null,
            occurrences: Number(incident.occurrences || 1),
            page: incident?.context?.page || null,
            resource: incident?.context?.resource || incident?.context?.url || null
          }))
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }, 500);
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

async function activeIncidents(env) {
  requireKv(env);

  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  const rows = [];

  for (const item of listed.keys) {
    const value = await env[KV].get(item.name, 'json');
    if (value && ACTIVE.has(value.status)) rows.push(value);
  }

  rows.sort((a, b) => {
    const severity = severityRank(b.severity) - severityRank(a.severity);
    if (severity !== 0) return severity;
    return String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''));
  });

  return rows;
}

function severityRank(value) {
  if (value === 'p0') return 3;
  if (value === 'p1') return 2;
  if (value === 'p2') return 1;
  return 0;
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
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
