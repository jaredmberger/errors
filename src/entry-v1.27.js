import base from './entry-v1.26.js';

const KV = 'CURATOR_ERROR_RECORDS';
const EVENT_PREFIX = 'event:';
const INCIDENT_PREFIX = 'incident:';
const SERVICE = 'CuratorOS Error Bus';
const VERSION = '1.27.0';
const MAX_SCAN_EVENTS = 20000;
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
        const analytics = await topErrors(env, window, limit);
        return json({
          ok: true,
          service: SERVICE,
          version: VERSION,
          ...analytics
        });
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

async function topErrors(env, window, limit) {
  requireKv(env);

  const generatedAt = new Date().toISOString();
  const cutoffMs = Date.now() - VALID_WINDOWS.get(window);
  const groups = new Map();
  let cursor;
  let scannedEventCount = 0;
  let matchedErrorEventCount = 0;
  let truncated = false;

  do {
    const listed = await env[KV].list({
      prefix: EVENT_PREFIX,
      limit: Math.min(1000, MAX_SCAN_EVENTS - scannedEventCount),
      ...(cursor ? { cursor } : {})
    });

    if (!listed.keys.length) break;

    for (const key of listed.keys) {
      if (scannedEventCount >= MAX_SCAN_EVENTS) {
        truncated = true;
        break;
      }

      scannedEventCount++;

      const keyTime = eventTimeFromKey(key.name);
      if (keyTime != null && keyTime < cutoffMs) continue;

      const event = await env[KV].get(key.name, 'json');
      if (!event || !isErrorEvent(event)) continue;

      const eventMs = Date.parse(event.at || '');
      if (Number.isFinite(eventMs) && eventMs < cutoffMs) continue;

      matchedErrorEventCount++;
      const groupKey = errorGroupKey(event);
      let row = groups.get(groupKey);

      if (!row) {
        row = {
          key: groupKey,
          fingerprint: clean(event.fingerprint, 240) || null,
          source: clean(event.source, 160) || null,
          component: clean(event.component, 160) || null,
          type: clean(event.type, 160) || typeFromFingerprint(event.fingerprint) || null,
          severity: clean(event.severity, 40) || 'other',
          count: 0,
          firstSeenAt: null,
          lastSeenAt: null,
          message: clean(event.message, 1000) || null,
          latestEventKind: clean(event.kind, 120) || null,
          latestEventStatus: clean(event.status, 80) || null
        };
        groups.set(groupKey, row);
      }

      row.count++;

      const at = normalizeIso(event.at) || normalizeIsoFromKey(key.name);
      if (at && (!row.firstSeenAt || at < row.firstSeenAt)) row.firstSeenAt = at;
      if (at && (!row.lastSeenAt || at > row.lastSeenAt)) {
        row.lastSeenAt = at;
        row.message = clean(event.message, 1000) || row.message;
        row.latestEventKind = clean(event.kind, 120) || row.latestEventKind;
        row.latestEventStatus = clean(event.status, 80) || row.latestEventStatus;
        row.severity = clean(event.severity, 40) || row.severity;
      }
    }

    if (truncated) break;
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor && scannedEventCount < MAX_SCAN_EVENTS);

  const sorted = [...groups.values()]
    .sort((a, b) => b.count - a.count || severityRank(b.severity) - severityRank(a.severity) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))
    .slice(0, limit);

  for (const row of sorted) {
    const incident = row.fingerprint
      ? await env[KV].get(`${INCIDENT_PREFIX}${row.fingerprint}`, 'json')
      : null;

    row.currentStatus = clean(incident?.status, 80) || null;
    row.currentOccurrences = Number.isFinite(Number(incident?.occurrences))
      ? Number(incident.occurrences)
      : null;
    row.incidentFirstSeenAt = normalizeIso(incident?.firstSeenAt) || null;
    row.incidentLastSeenAt = normalizeIso(incident?.lastSeenAt) || null;
    row.sharePct = matchedErrorEventCount
      ? Number(((row.count / matchedErrorEventCount) * 100).toFixed(1))
      : 0;

    delete row.key;
  }

  return {
    generatedAt,
    window,
    windowStartAt: new Date(cutoffMs).toISOString(),
    limit,
    scannedEventCount,
    matchedErrorEventCount,
    uniqueErrorCount: groups.size,
    truncated,
    topErrors: sorted
  };
}

function isErrorEvent(event) {
  const kind = clean(event?.kind, 120).toLowerCase();
  const status = clean(event?.status, 80).toLowerCase();

  if (kind.includes('recovery') || kind.includes('recovered')) return false;
  if (kind === 'monitoring-disabled' || kind.includes('heartbeat-ok')) return false;
  if (status === 'recovered' || status === 'healthy' || status === 'ok') return false;

  if (status === 'active' || status === 'degraded' || status === 'persistent' || status === 'error' || status === 'failed') return true;
  if (kind.includes('error') || kind.includes('incident') || kind.includes('failure') || kind.includes('degraded') || kind.includes('stale')) return true;

  return Boolean(event?.fingerprint && event?.message);
}

function errorGroupKey(event) {
  const fingerprint = clean(event?.fingerprint, 240);
  if (fingerprint) return `fingerprint:${fingerprint}`;

  return [
    'fallback',
    slug(event?.source),
    slug(event?.component),
    slug(event?.type || event?.kind),
    slug(normalizeMessage(event?.message))
  ].join(':');
}

function normalizeMessage(value) {
  return clean(value, 500)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, '<timestamp>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function typeFromFingerprint(value) {
  const fingerprint = clean(value, 240);
  if (!fingerprint) return null;
  return fingerprint.replace(/-[a-f0-9]{8,}$/i, '').slice(0, 160) || null;
}

function eventTimeFromKey(name) {
  const match = String(name || '').match(/^event:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z):/);
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeIsoFromKey(name) {
  const ms = eventTimeFromKey(name);
  return ms == null ? null : new Date(ms).toISOString();
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

function slug(value) {
  return clean(value, 240)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
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
