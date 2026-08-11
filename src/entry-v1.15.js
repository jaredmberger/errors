import base from './entry-v1.14.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const ACTIVE = new Set(['active', 'degraded']);
const OFFLINE_TYPE = 'public-site-offline';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Curator Intelligence gets a deliberately quieter view of the Error Bus.
    // The Error Bus remains the authoritative incident console; ordinary fresh
    // observations should send the curator there for triage, not become a pile
    // of high-priority intelligence cards before Clear & Recheck has had a
    // chance to confirm persistence.
    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      const incidents = await activeIncidents(env);
      const payload = buildQuietIntelligencePayload(incidents);
      const callback = safeCallback(url.searchParams.get('callback'));
      return callback ? javascript(payload, callback) : json(payload);
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
  rows.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  return rows;
}

function buildQuietIntelligencePayload(incidents) {
  const p0 = incidents.filter(x => x.severity === 'p0').length;
  const p1 = incidents.filter(x => x.severity === 'p1').length;
  const p2 = incidents.filter(x => x.severity === 'p2').length;
  const offline = incidents.filter(x => x.type === OFFLINE_TYPE);
  const confirmed = incidents.filter(isConfirmedPersistent);
  const triageOnly = incidents.filter(x => !offline.includes(x) && !confirmed.includes(x));

  const priorityIncidents = uniqueByFingerprint([...offline, ...confirmed]);
  const isOffline = offline.length > 0;
  const hasConfirmed = priorityIncidents.length > 0;
  const hasTriage = incidents.length > 0;

  let systemStatus = 'good';
  let statusLabel = 'Connected';
  let value = 'No active incidents';
  let summary = 'The CuratorOS Error Bus is online and no active infrastructure incidents are recorded.';

  if (isOffline) {
    systemStatus = 'critical';
    statusLabel = 'SITE OFFLINE';
    value = 'Public site unavailable';
    summary = 'OceanLiners.net is confirmed unavailable to public visitors. Immediate attention is required.';
  } else if (hasConfirmed) {
    systemStatus = priorityIncidents.some(x => x.severity === 'p0') ? 'critical' : 'warning';
    statusLabel = 'Confirmed incident';
    value = `${priorityIncidents.length} confirmed incident${priorityIncidents.length === 1 ? '' : 's'}`;
    summary = `${priorityIncidents.length} incident${priorityIncidents.length === 1 ? ' has' : 's have'} survived verification or recurred after triage and warrant prioritized attention.`;
  } else if (hasTriage) {
    // Keep the system tile informative without promoting unconfirmed incidents
    // into Prioritized Intelligence. The Error Bus itself owns this triage step.
    systemStatus = 'warning';
    statusLabel = 'Review Error Bus';
    value = `${incidents.length} incident${incidents.length === 1 ? '' : 's'} awaiting triage`;
    summary = 'The Error Bus has active observations. Open the full Error Bus and use Clear & Recheck; only persistent or recurring failures are promoted to prioritized intelligence.';
  }

  return {
    ok: true,
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    system: {
      id: 'error-bus',
      name: 'CuratorOS Error Bus',
      status: systemStatus,
      statusLabel,
      value,
      summary,
      detail: `P0 ${p0} · P1 ${p1} · P2 ${p2}${triageOnly.length ? ` · ${triageOnly.length} awaiting triage` : ''}`,
      url: 'https://errors.oceanliners.net/'
    },
    metrics: {
      activeIncidentCount: incidents.length,
      p0Count: p0,
      p1Count: p1,
      p2Count: p2,
      awaitingTriageCount: triageOnly.length,
      confirmedPriorityCount: priorityIncidents.length,
      publicSiteOffline: isOffline,
      heartbeatMonitoring: true,
      persistentIncidentHistory: true,
      triageAwarePrioritization: true
    },
    priorities: priorityIncidents.slice(0, 20).map((incident, index) => ({
      title: incident.type === OFFLINE_TYPE
        ? 'OceanLiners.net is offline'
        : `${incident.source}: ${incident.component} failure`,
      summary: `${incident.message}${incident.occurrences > 1 ? ` Repeated ${incident.occurrences} times; last seen ${incident.lastSeenAt}.` : ''}`,
      entity: incident.source,
      severity: incident.type === OFFLINE_TYPE || incident.severity === 'p0' ? 'critical' : incident.severity === 'p1' ? 'high' : 'medium',
      score: incident.type === OFFLINE_TYPE ? 150 : Math.max(80, 120 - index - (incident.severity === 'p0' ? 0 : incident.severity === 'p1' ? 10 : 25)),
      sources: ['CuratorOS Error Bus'],
      systemIncident: true,
      confirmedPersistent: true,
      incidentId: incident.id,
      incidentType: incident.type,
      component: incident.component,
      firstSeenAt: incident.firstSeenAt,
      lastSeenAt: incident.lastSeenAt,
      occurrences: incident.occurrences
    })),
    opportunities: [],
    activity: priorityIncidents.slice(0, 8).map(incident => ({
      title: incident.type === OFFLINE_TYPE ? 'Public site confirmed offline' : `${String(incident.severity || 'p2').toUpperCase()} incident confirmed — ${incident.source}`,
      summary: `${incident.component}: ${incident.message}`,
      meta: `CuratorOS Error Bus · ${incident.lastSeenAt}`
    })),
    capabilities: {
      persistentIncidentRegistry: true,
      deduplication: true,
      recoveryTracking: true,
      heartbeatStalenessDetection: true,
      directKvReporting: true,
      triageAwarePrioritization: true,
      offlineImmediateEscalation: true
    }
  };
}

function isConfirmedPersistent(incident) {
  if (!incident || incident.type === OFFLINE_TYPE) return false;
  const context = incident.context || {};

  // Explicit confirmation from Clear & Recheck is authoritative.
  if (context.manualRecheckConfirmed === true) return true;

  // Browser-aware Clear & Recheck archives browser incidents. If the same
  // fingerprint later becomes active again, it necessarily recurred after that
  // triage. The recovery fields from the archived record survive the upsert.
  if (String(incident.type || '').startsWith('client-') && incident.recoveredAt) return true;

  // Non-browser infrastructure incidents are already generated by independent
  // probes/heartbeat evaluation rather than a single browser observation. Keep
  // P0 infrastructure failures visible, while ordinary P1/P2 observations stay
  // in the Error Bus until the curator confirms them.
  if (!String(incident.type || '').startsWith('client-') && incident.severity === 'p0') return true;

  return false;
}

function uniqueByFingerprint(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row.fingerprint || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function severityRank(value) {
  return value === 'p0' ? 3 : value === 'p1' ? 2 : 1;
}

function safeCallback(value) {
  const raw = String(value || '');
  return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,120}$/.test(raw) ? raw : '';
}
function javascript(value, callback) {
  return new Response(`${callback}(${JSON.stringify(value)});`, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}
