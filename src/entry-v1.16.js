import base from './entry-v1.13.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const AVAILABILITY_KEY = 'availability:public-site-v2';
const OFFLINE_INCIDENT_KEY = 'incident:public-site-offline';
const PUBLIC_URL = 'https://oceanliners.net/';
const ACTIVE = new Set(['active', 'degraded']);
const OFFLINE_TYPE = 'public-site-offline';
const FAILURE_OBSERVATIONS = 3;
const RECOVERY_OBSERVATIONS = 2;
const MIN_OBSERVATION_GAP_MS = 45 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Status is deliberately read-only. Merely checking status must never be
    // capable of declaring the public site offline.
    if (request.method === 'GET' && url.pathname === '/api/status') {
      const incidents = await activeIncidents(env);
      const availability = await readAvailability(env);
      const counts = countSeverities(incidents);
      const ordinaryStatus = counts.p0 ? 'critical' : counts.p1 ? 'degraded' : incidents.length ? 'attention' : 'healthy';
      return json({
        ok: true,
        generatedAt: new Date().toISOString(),
        status: availability.status === 'offline' ? 'offline' : ordinaryStatus,
        activeIncidentCount: incidents.length,
        counts,
        publicSiteAvailability: availability
      });
    }

    // Preserve the quieter, triage-aware Curator Intelligence feed introduced
    // in v1.15 without routing through the superseded v1.14 outage detector.
    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      const incidents = await activeIncidents(env);
      const payload = buildQuietIntelligencePayload(incidents);
      const callback = safeCallback(url.searchParams.get('callback'));
      return callback ? javascript(payload, callback) : json(payload);
    }

    // A manual system check may contribute one availability observation, but
    // the persisted 45-second separation rule prevents repeated calls in a
    // burst from manufacturing an outage.
    if (request.method === 'POST' && url.pathname === '/api/check-now') {
      const response = await base.fetch(request, env, ctx);
      await observePublicAvailability(env, 'manual-check').catch(() => {});
      return response;
    }

    // Clear/reset remains focused on incident triage. It does not itself cast
    // an outage vote; the independent availability monitor owns that state.
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Dedicated minutely availability cron: do not run all Error Bus
    // housekeeping every minute.
    if (controller?.cron === '* * * * *') {
      ctx.waitUntil(observePublicAvailability(env, 'availability-cron').catch(error => console.error('Public-site availability observation failed', error)));
      return;
    }

    // Existing hourly Error Bus housekeeping remains unchanged.
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(observePublicAvailability(env, 'hourly-housekeeping').catch(error => console.error('Public-site availability observation failed', error)));
    return result;
  }
};

async function observePublicAvailability(env, source) {
  requireKv(env);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const previous = await env[KV].get(AVAILABILITY_KEY, 'json') || defaultAvailability();

  const lastObservationMs = Date.parse(previous.lastObservedAt || 0);
  if (Number.isFinite(lastObservationMs) && nowMs - lastObservationMs < MIN_OBSERVATION_GAP_MS) {
    return publicAvailabilityView(previous, [], true);
  }

  // One observation gets two close probes. Only if BOTH fail does this minute
  // count as one failed observation toward the outage threshold.
  const probes = [];
  const first = await probePublicSite(1);
  probes.push(first);
  let observationOk = first.ok;
  if (!first.ok) {
    await sleep(1800);
    const second = await probePublicSite(2);
    probes.push(second);
    observationOk = second.ok;
  }

  let next = {
    ...previous,
    lastObservedAt: now,
    lastObservationSource: source,
    lastProbes: probes
  };

  if (observationOk) {
    const successes = Number(previous.consecutiveSuccessfulObservations || 0) + 1;
    next.consecutiveSuccessfulObservations = successes;
    next.consecutiveFailedObservations = 0;
    next.lastSuccessfulAt = now;
    next.suspectSince = null;

    if (previous.status === 'offline') {
      if (successes >= RECOVERY_OBSERVATIONS) {
        next.status = 'online';
        next.offlineSince = null;
        await recoverOfflineIncident(env, now, probes);
      } else {
        next.status = 'offline';
      }
    } else {
      next.status = 'online';
      next.offlineSince = null;
      await recoverOfflineIncident(env, now, probes);
    }
  } else {
    const failures = Number(previous.consecutiveFailedObservations || 0) + 1;
    next.consecutiveFailedObservations = failures;
    next.consecutiveSuccessfulObservations = 0;
    next.lastFailureAt = now;
    next.suspectSince = previous.suspectSince || now;

    if (previous.status === 'offline' || failures >= FAILURE_OBSERVATIONS) {
      next.status = 'offline';
      next.offlineSince = previous.offlineSince || now;
      await upsertOfflineIncident(env, now, probes, next.offlineSince, failures);
    } else {
      next.status = 'suspect';
      // Important: suspect observations do not create a P0 incident.
    }
  }

  await env[KV].put(AVAILABILITY_KEY, JSON.stringify(next));
  return publicAvailabilityView(next, probes, false);
}

async function readAvailability(env) {
  requireKv(env);
  const value = await env[KV].get(AVAILABILITY_KEY, 'json') || defaultAvailability();
  return publicAvailabilityView(value, value.lastProbes || [], false);
}

function defaultAvailability() {
  return {
    status: 'unknown',
    consecutiveFailedObservations: 0,
    consecutiveSuccessfulObservations: 0,
    lastObservedAt: null,
    lastSuccessfulAt: null,
    lastFailureAt: null,
    suspectSince: null,
    offlineSince: null,
    lastProbes: []
  };
}

function publicAvailabilityView(state, probes, rateLimited) {
  const status = ['offline', 'suspect', 'online'].includes(state.status) ? state.status : 'unknown';
  let confirmation = 'No availability observation has been recorded yet.';
  if (status === 'online') confirmation = 'Public site reachable.';
  if (status === 'suspect') confirmation = `${state.consecutiveFailedObservations || 0} of ${FAILURE_OBSERVATIONS} required failed time-separated observations recorded; no outage declared.`;
  if (status === 'offline') confirmation = `Confirmed after at least ${FAILURE_OBSERVATIONS} failed observations separated by at least ${Math.round(MIN_OBSERVATION_GAP_MS / 1000)} seconds.`;

  return {
    status,
    url: PUBLIC_URL,
    lastObservedAt: state.lastObservedAt || null,
    offlineSince: state.offlineSince || null,
    suspectSince: state.suspectSince || null,
    lastSuccessfulAt: state.lastSuccessfulAt || null,
    lastFailureAt: state.lastFailureAt || null,
    consecutiveFailedObservations: Number(state.consecutiveFailedObservations || 0),
    consecutiveSuccessfulObservations: Number(state.consecutiveSuccessfulObservations || 0),
    requiredFailedObservations: FAILURE_OBSERVATIONS,
    requiredRecoveryObservations: RECOVERY_OBSERVATIONS,
    minimumObservationGapSeconds: Math.round(MIN_OBSERVATION_GAP_MS / 1000),
    confirmation,
    rateLimited: Boolean(rateLimited),
    probes
  };
}

async function probePublicSite(attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const target = new URL(PUBLIC_URL);
    target.searchParams.set('errorBusAvailability', `${Date.now()}-${attempt}`);
    const response = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        accept: 'text/html,*/*;q=0.8',
        'user-agent': 'CuratorOS-Error-Bus-Availability/2.0'
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const signature = /Ocean Liner Curator/i.test(text);
    const obviousError = /<title>\s*(?:404|500|502|503|504|error|not found)|cloudflare.*error/i.test(text.slice(0, 2000));
    return {
      attempt,
      ok: response.ok && bytes >= 1500 && signature && !obviousError,
      status: response.status,
      bytes,
      signature,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      attempt,
      ok: false,
      status: null,
      bytes: 0,
      signature: false,
      durationMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

async function upsertOfflineIncident(env, now, probes, offlineSince, failures) {
  const previous = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  const incident = {
    id: previous?.id || 'incident_public-site-offline',
    fingerprint: 'public-site-offline',
    source: 'Ocean Liner Curator',
    component: 'public-site-availability',
    severity: 'p0',
    type: OFFLINE_TYPE,
    message: 'OceanLiners.net is confirmed unavailable to public visitors after repeated time-separated observations.',
    context: {
      url: PUBLIC_URL,
      confirmationObservations: failures,
      minimumObservationGapSeconds: Math.round(MIN_OBSERVATION_GAP_MS / 1000),
      probes: JSON.stringify(probes).slice(0, 4000)
    },
    firstSeenAt: previous?.firstSeenAt || offlineSince || now,
    lastSeenAt: now,
    occurrences: Math.max(1, Number(previous?.occurrences || 0) + 1),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null
  };
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify(incident));
}

async function recoverOfflineIncident(env, now, probes) {
  const previous = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  if (!previous || !ACTIVE.has(previous.status)) return;
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify({
    ...previous,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: `Public site availability recovered after ${RECOVERY_OBSERVATIONS} successful time-separated observations.`,
    context: {
      ...(previous.context || {}),
      recoveryProbes: JSON.stringify(probes).slice(0, 4000)
    }
  }), { expirationTtl: 60 * 60 * 24 * 180 });
}

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

function countSeverities(incidents) {
  const counts = { p0: 0, p1: 0, p2: 0, other: 0 };
  for (const incident of incidents) {
    if (incident.severity === 'p0') counts.p0++;
    else if (incident.severity === 'p1') counts.p1++;
    else if (incident.severity === 'p2') counts.p2++;
    else counts.other++;
  }
  return counts;
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
    systemStatus = 'critical'; statusLabel = 'SITE OFFLINE'; value = 'Public site unavailable';
    summary = 'OceanLiners.net is confirmed unavailable to public visitors. Immediate attention is required.';
  } else if (hasConfirmed) {
    systemStatus = priorityIncidents.some(x => x.severity === 'p0') ? 'critical' : 'warning';
    statusLabel = 'Confirmed incident'; value = `${priorityIncidents.length} confirmed incident${priorityIncidents.length === 1 ? '' : 's'}`;
    summary = `${priorityIncidents.length} incident${priorityIncidents.length === 1 ? ' has' : 's have'} survived verification or recurred after triage and warrant prioritized attention.`;
  } else if (hasTriage) {
    systemStatus = 'warning'; statusLabel = 'Review Error Bus'; value = `${incidents.length} incident${incidents.length === 1 ? '' : 's'} awaiting triage`;
    summary = 'The Error Bus has active observations. Open the full Error Bus and use Clear & Recheck; only persistent or recurring failures are promoted to prioritized intelligence.';
  }

  return {
    ok: true, schemaVersion: 2, generatedAt: new Date().toISOString(),
    system: { id:'error-bus', name:'CuratorOS Error Bus', status:systemStatus, statusLabel, value, summary, detail:`P0 ${p0} · P1 ${p1} · P2 ${p2}${triageOnly.length ? ` · ${triageOnly.length} awaiting triage` : ''}`, url:'https://errors.oceanliners.net/' },
    metrics: { activeIncidentCount:incidents.length, p0Count:p0, p1Count:p1, p2Count:p2, awaitingTriageCount:triageOnly.length, confirmedPriorityCount:priorityIncidents.length, publicSiteOffline:isOffline, heartbeatMonitoring:true, persistentIncidentHistory:true, triageAwarePrioritization:true },
    priorities: priorityIncidents.slice(0,20).map((incident,index)=>({ title:incident.type===OFFLINE_TYPE?'OceanLiners.net is offline':`${incident.source}: ${incident.component} failure`, summary:`${incident.message}${incident.occurrences>1?` Repeated ${incident.occurrences} times; last seen ${incident.lastSeenAt}.`:''}`, entity:incident.source, severity:incident.type===OFFLINE_TYPE||incident.severity==='p0'?'critical':incident.severity==='p1'?'high':'medium', score:incident.type===OFFLINE_TYPE?150:Math.max(80,120-index-(incident.severity==='p0'?0:incident.severity==='p1'?10:25)), sources:['CuratorOS Error Bus'], systemIncident:true, confirmedPersistent:true, incidentId:incident.id, incidentType:incident.type, component:incident.component, firstSeenAt:incident.firstSeenAt, lastSeenAt:incident.lastSeenAt, occurrences:incident.occurrences })),
    opportunities: [],
    activity: priorityIncidents.slice(0,8).map(incident=>({ title:incident.type===OFFLINE_TYPE?'Public site confirmed offline':`${String(incident.severity||'p2').toUpperCase()} incident confirmed — ${incident.source}`, summary:`${incident.component}: ${incident.message}`, meta:`CuratorOS Error Bus · ${incident.lastSeenAt}` })),
    capabilities: { persistentIncidentRegistry:true, deduplication:true, recoveryTracking:true, heartbeatStalenessDetection:true, directKvReporting:true, triageAwarePrioritization:true, offlineImmediateEscalation:true }
  };
}

function isConfirmedPersistent(incident) {
  if (!incident || incident.type === OFFLINE_TYPE) return false;
  const context = incident.context || {};
  if (context.manualRecheckConfirmed === true) return true;
  if (String(incident.type || '').startsWith('client-') && incident.recoveredAt) return true;
  if (!String(incident.type || '').startsWith('client-') && incident.severity === 'p0') return true;
  return false;
}
function uniqueByFingerprint(rows){const seen=new Set();return rows.filter(row=>{const key=row.fingerprint||row.id;if(seen.has(key))return false;seen.add(key);return true;});}
function severityRank(value){return value==='p0'?3:value==='p1'?2:1;}
function safeCallback(value){const raw=String(value||'');return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,120}$/.test(raw)?raw:'';}
function javascript(value,callback){return new Response(`${callback}(${JSON.stringify(value)});`,{status:200,headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`);}
