import base from './entry-v1.27.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const SERVICE = 'CuratorOS Error Bus';
const VERSION = '1.28.0';
const VALID_WINDOWS = new Map([
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000]
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/top-errors') {
      try {
        const window = VALID_WINDOWS.has(url.searchParams.get('window'))
          ? url.searchParams.get('window')
          : '7d';
        const limit = clampInt(url.searchParams.get('limit'), 1, 50, 10);
        const payload = await topErrorsFromIncidents(env, window, limit);
        return json({ ok: true, service: SERVICE, version: VERSION, ...payload });
      } catch (error) {
        return json({
          ok: false,
          service: SERVICE,
          version: VERSION,
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

async function topErrorsFromIncidents(env, window, limit) {
  requireKv(env);

  const generatedAt = new Date().toISOString();
  const cutoffMs = Date.now() - VALID_WINDOWS.get(window);
  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });

  // Read incident records concurrently. The previous v1.27 implementation
  // walked potentially thousands of event records serially, which could make
  // this endpoint appear to hang. The incident registry already maintains the
  // deduplicated occurrence counter we need for frequency ranking.
  const records = await Promise.all(
    listed.keys.map(async (key) => {
      try {
        return await env[KV].get(key.name, 'json');
      } catch {
        return null;
      }
    })
  );

  const rows = [];
  for (const incident of records) {
    if (!incident) continue;

    const lastSeenMs = Date.parse(incident.lastSeenAt || incident.firstSeenAt || '');
    if (!Number.isFinite(lastSeenMs) || lastSeenMs < cutoffMs) continue;

    const occurrences = Math.max(1, Number(incident.occurrences || 1));
    rows.push({
      fingerprint: clean(incident.fingerprint, 240) || null,
      source: clean(incident.source, 160) || null,
      component: clean(incident.component, 160) || null,
      type: clean(incident.type, 160) || null,
      severity: clean(incident.severity, 40) || 'other',
      occurrences,
      currentStatus: clean(incident.status, 80) || null,
      firstSeenAt: normalizeIso(incident.firstSeenAt),
      lastSeenAt: normalizeIso(incident.lastSeenAt),
      recoveredAt: normalizeIso(incident.recoveredAt),
      message: clean(incident.message || incident.recoveryMessage, 1000) || null
    });
  }

  rows.sort((a, b) =>
    b.occurrences - a.occurrences ||
    severityRank(b.severity) - severityRank(a.severity) ||
    String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || ''))
  );

  const totalOccurrences = rows.reduce((sum, row) => sum + row.occurrences, 0);
  const topErrors = rows.slice(0, limit).map((row) => ({
    ...row,
    sharePct: totalOccurrences
      ? Number(((row.occurrences / totalOccurrences) * 100).toFixed(1))
      : 0
  }));

  return {
    generatedAt,
    window,
    windowStartAt: new Date(cutoffMs).toISOString(),
    limit,
    metric: 'incident-occurrences',
    note: 'Ranks deduplicated incident occurrence counters for incidents seen during the selected window. Occurrence counters are lifetime totals for each retained incident, not exact per-window event counts.',
    scannedIncidentCount: records.filter(Boolean).length,
    matchingIncidentCount: rows.length,
    totalOccurrences,
    topErrors
  };
}

function normalizeIso(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function severityRank(value) {
  if (value === 'p0') return 3;
  if (value === 'p1') return 2;
  if (value === 'p2') return 1;
  return 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
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
