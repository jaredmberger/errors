const INCIDENT_PREFIX = 'incident:';
const HEARTBEAT_PREFIX = 'heartbeat:';
const EVENT_PREFIX = 'event:';
const MAX_INCIDENTS = 250;
const ACTIVE_STATUSES = new Set(['active', 'degraded']);
const SEVERITY_RANK = { p0: 4, critical: 4, p1: 3, high: 3, p2: 2, medium: 2, low: 1, info: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/' && request.method === 'GET') {
      const incidents = await listIncidents(env, { activeOnly: false, limit: 100 });
      return html(renderConsole(incidents));
    }

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const incidents = await listIncidents(env, { activeOnly: true, limit: MAX_INCIDENTS });
      return json(buildStatus(incidents));
    }

    if (url.pathname === '/api/incidents' && request.method === 'GET') {
      const activeOnly = url.searchParams.get('active') !== '0';
      const limit = clampInt(url.searchParams.get('limit'), 1, MAX_INCIDENTS, 100);
      const incidents = await listIncidents(env, { activeOnly, limit });
      return json({ ok: true, generatedAt: new Date().toISOString(), activeOnly, count: incidents.length, incidents });
    }

    if (url.pathname === '/api/heartbeats' && request.method === 'GET') {
      const heartbeats = await listHeartbeats(env);
      return json({ ok: true, generatedAt: new Date().toISOString(), count: heartbeats.length, heartbeats });
    }

    if (url.pathname === '/api/report' && request.method === 'POST') {
      const auth = authorizeWrite(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      const body = await readJson(request);
      if (!body.ok) return json({ ok: false, error: body.error }, 400);
      try {
        const incident = await upsertIncident(env, body.value);
        return json({ ok: true, incident }, 201);
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (url.pathname === '/api/recover' && request.method === 'POST') {
      const auth = authorizeWrite(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      const body = await readJson(request);
      if (!body.ok) return json({ ok: false, error: body.error }, 400);
      try {
        const incident = await recoverIncident(env, body.value);
        return json({ ok: true, incident });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (url.pathname === '/api/heartbeat' && request.method === 'POST') {
      const auth = authorizeWrite(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
      const body = await readJson(request);
      if (!body.ok) return json({ ok: false, error: body.error }, 400);
      try {
        const heartbeat = await writeHeartbeat(env, body.value);
        return json({ ok: true, heartbeat });
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (url.pathname === '/api/curator-intelligence' && request.method === 'GET') {
      const incidents = await listIncidents(env, { activeOnly: true, limit: MAX_INCIDENTS });
      const payload = buildIntelligencePayload(incidents);
      const callback = safeCallback(url.searchParams.get('callback'));
      return callback ? javascript(payload, callback) : json(payload);
    }

    return json({ ok: false, error: 'Not found.' }, 404);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(evaluateHeartbeats(env).catch(error => console.error('CuratorOS Error Bus heartbeat evaluation failed', error)));
  }
};

async function upsertIncident(env, raw) {
  requireKv(env);
  const now = new Date().toISOString();
  const source = clean(raw?.source, 100);
  const component = clean(raw?.component || 'unknown', 120);
  const type = clean(raw?.type || 'runtime-error', 100);
  const message = clean(raw?.message, 1200);
  if (!source || !message) throw new Error('source and message are required.');

  const severity = normalizeSeverity(raw?.severity);
  const fingerprint = clean(raw?.fingerprint, 200) || await fingerprintFor(source, component, type, message);
  const key = INCIDENT_PREFIX + fingerprint;
  const previous = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  const occurrence = Math.max(1, Number(previous?.occurrences || 0) + 1);
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
    occurrences: occurrence,
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null,
  };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(incident));
  await writeEvent(env, 'incident', incident);
  return incident;
}

async function recoverIncident(env, raw) {
  requireKv(env);
  const fingerprint = clean(raw?.fingerprint, 200);
  let key = fingerprint ? INCIDENT_PREFIX + fingerprint : null;
  let incident = key ? await env.CURATOR_ERROR_RECORDS.get(key, 'json') : null;

  if (!incident && raw?.source && raw?.component) {
    const incidents = await listIncidents(env, { activeOnly: true, limit: MAX_INCIDENTS });
    incident = incidents.find(item => item.source === raw.source && item.component === raw.component && (!raw.type || item.type === raw.type)) || null;
    if (incident) key = INCIDENT_PREFIX + incident.fingerprint;
  }
  if (!incident || !key) throw new Error('Active incident not found.');

  const now = new Date().toISOString();
  const recovered = {
    ...incident,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: clean(raw?.message || 'Component reported recovery.', 800),
  };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(recovered), { expirationTtl: 60 * 60 * 24 * 180 });
  await writeEvent(env, 'recovery', recovered);
  return recovered;
}

async function writeHeartbeat(env, raw) {
  requireKv(env);
  const source = clean(raw?.source, 100);
  const component = clean(raw?.component || 'monitor', 120);
  if (!source) throw new Error('source is required.');
  const now = new Date().toISOString();
  const maxAgeMinutes = clampInt(raw?.maxAgeMinutes, 15, 10080, 180);
  const heartbeat = {
    source,
    component,
    status: raw?.status === 'degraded' ? 'degraded' : 'ok',
    message: clean(raw?.message || 'Heartbeat received.', 800),
    at: now,
    maxAgeMinutes,
    context: sanitizeObject(raw?.context),
  };
  await env.CURATOR_ERROR_RECORDS.put(`${HEARTBEAT_PREFIX}${slug(source)}:${slug(component)}`, JSON.stringify(heartbeat));

  if (heartbeat.status === 'ok') {
    const incidents = await listIncidents(env, { activeOnly: true, limit: MAX_INCIDENTS });
    const stale = incidents.find(item => item.type === 'heartbeat-stale' && item.source === source && item.component === component);
    if (stale) await recoverIncident(env, { fingerprint: stale.fingerprint, message: 'Heartbeat resumed.' });
  }
  return heartbeat;
}

async function evaluateHeartbeats(env) {
  requireKv(env);
  const now = Date.now();
  const heartbeats = await listHeartbeats(env);
  for (const heartbeat of heartbeats) {
    const ageMs = now - Date.parse(heartbeat.at || 0);
    const maxAgeMs = Number(heartbeat.maxAgeMinutes || 180) * 60 * 1000;
    if (!Number.isFinite(ageMs) || ageMs <= maxAgeMs) continue;
    await upsertIncident(env, {
      source: heartbeat.source,
      component: heartbeat.component,
      severity: 'p1',
      type: 'heartbeat-stale',
      fingerprint: `heartbeat-${slug(heartbeat.source)}-${slug(heartbeat.component)}`,
      message: `No successful heartbeat has been recorded for ${Math.round(ageMs / 60000)} minutes.`,
      context: { lastHeartbeatAt: heartbeat.at, expectedWithinMinutes: heartbeat.maxAgeMinutes },
    });
  }
}

async function listIncidents(env, { activeOnly, limit }) {
  requireKv(env);
  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  const incidents = [];
  for (const key of listed.keys) {
    const value = await env.CURATOR_ERROR_RECORDS.get(key.name, 'json');
    if (!value) continue;
    if (activeOnly && !ACTIVE_STATUSES.has(value.status)) continue;
    incidents.push(value);
  }
  incidents.sort((a, b) => severityValue(b.severity) - severityValue(a.severity) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  return incidents.slice(0, limit);
}

async function listHeartbeats(env) {
  requireKv(env);
  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix: HEARTBEAT_PREFIX, limit: 1000 });
  const heartbeats = [];
  for (const key of listed.keys) {
    const value = await env.CURATOR_ERROR_RECORDS.get(key.name, 'json');
    if (value) heartbeats.push(value);
  }
  return heartbeats.sort((a, b) => String(a.source).localeCompare(String(b.source)) || String(a.component).localeCompare(String(b.component)));
}

function buildStatus(incidents) {
  const counts = { p0: 0, p1: 0, p2: 0, other: 0 };
  for (const incident of incidents) {
    const sev = normalizeSeverity(incident.severity);
    if (counts[sev] !== undefined) counts[sev] += 1; else counts.other += 1;
  }
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    status: counts.p0 ? 'critical' : counts.p1 ? 'degraded' : incidents.length ? 'attention' : 'healthy',
    activeIncidentCount: incidents.length,
    counts,
  };
}

function buildIntelligencePayload(incidents) {
  const status = buildStatus(incidents);
  const p0 = status.counts.p0;
  const p1 = status.counts.p1;
  const systemStatus = p0 ? 'critical' : p1 ? 'warning' : incidents.length ? 'warning' : 'good';
  const label = p0 ? 'System incident' : p1 ? 'Degraded' : incidents.length ? 'Attention' : 'Connected';
  const value = incidents.length ? `${incidents.length} active incident${incidents.length === 1 ? '' : 's'}` : 'No active incidents';

  return {
    ok: true,
    schemaVersion: 1,
    generatedAt: status.generatedAt,
    system: {
      id: 'error-bus',
      name: 'CuratorOS Error Bus',
      status: systemStatus,
      statusLabel: label,
      value,
      summary: incidents.length
        ? `${incidents.length} active infrastructure incident${incidents.length === 1 ? '' : 's'} require system attention before lower-priority optimization work.`
        : 'The CuratorOS Error Bus is online and no active infrastructure incidents are recorded.',
      detail: `P0 ${p0} · P1 ${p1} · P2 ${status.counts.p2}`,
      url: 'https://errors.oceanliners.net/'
    },
    metrics: {
      activeIncidentCount: incidents.length,
      p0Count: p0,
      p1Count: p1,
      p2Count: status.counts.p2,
      heartbeatMonitoring: true,
      persistentIncidentHistory: true,
    },
    priorities: incidents.slice(0, 20).map((incident, index) => ({
      title: `${incident.source}: ${incident.component} failure`,
      summary: `${incident.message}${incident.occurrences > 1 ? ` Repeated ${incident.occurrences} times; last seen ${incident.lastSeenAt}.` : ''}`,
      entity: incident.source,
      severity: incident.severity === 'p0' ? 'critical' : incident.severity === 'p1' ? 'high' : 'medium',
      score: Math.max(70, 120 - index - (incident.severity === 'p0' ? 0 : incident.severity === 'p1' ? 10 : 25)),
      sources: ['CuratorOS Error Bus'],
      systemIncident: true,
      incidentId: incident.id,
      incidentType: incident.type,
      component: incident.component,
      firstSeenAt: incident.firstSeenAt,
      lastSeenAt: incident.lastSeenAt,
      occurrences: incident.occurrences,
    })),
    opportunities: [],
    activity: incidents.slice(0, 8).map(incident => ({
      title: `${incident.severity.toUpperCase()} incident active — ${incident.source}`,
      summary: `${incident.component}: ${incident.message}`,
      meta: `CuratorOS Error Bus · ${incident.lastSeenAt}`,
    })),
    capabilities: {
      persistentIncidentRegistry: true,
      deduplication: true,
      recoveryTracking: true,
      heartbeatStalenessDetection: true,
      directKvReporting: true,
    }
  };
}

async function writeEvent(env, kind, incident) {
  const stamp = new Date().toISOString();
  const random = Math.random().toString(36).slice(2, 8);
  const event = { kind, at: stamp, incidentId: incident.id, fingerprint: incident.fingerprint, source: incident.source, component: incident.component, severity: incident.severity, status: incident.status, message: incident.message };
  await env.CURATOR_ERROR_RECORDS.put(`${EVENT_PREFIX}${stamp}:${random}`, JSON.stringify(event), { expirationTtl: 60 * 60 * 24 * 180 });
}

function authorizeWrite(request, env) {
  if (!env.ERROR_REPORT_KEY) return { ok: false, status: 503, error: 'ERROR_REPORT_KEY is not configured; network write API is disabled. Direct KV reporting remains available to bound Workers.' };
  const supplied = request.headers.get('x-curator-error-key') || '';
  if (supplied !== env.ERROR_REPORT_KEY) return { ok: false, status: 401, error: 'Unauthorized.' };
  return { ok: true };
}

function requireKv(env) {
  if (!env.CURATOR_ERROR_RECORDS) throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.');
}

async function fingerprintFor(source, component, type, message) {
  const normalized = `${source}|${component}|${type}|${message}`.toLowerCase().replace(/\d{4}-\d\d-\d\d[t ][\d:.z+-]+/g, '<timestamp>').replace(/\b\d{6,}\b/g, '<number>');
  const bytes = new TextEncoder().encode(normalized);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function normalizeSeverity(value) {
  const raw = String(value || '').toLowerCase();
  if (['p0', 'critical'].includes(raw)) return 'p0';
  if (['p1', 'high'].includes(raw)) return 'p1';
  if (['p2', 'medium', 'warning'].includes(raw)) return 'p2';
  return 'p2';
}
function severityValue(value) { return SEVERITY_RANK[String(value || '').toLowerCase()] || 0; }
function clean(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function slug(value) { return clean(value, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown'; }
function clampInt(value, min, max, fallback) { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback; }
function sanitizeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) continue;
    if (raw == null || ['string', 'number', 'boolean'].includes(typeof raw)) out[clean(key, 80)] = typeof raw === 'string' ? clean(raw, 1000) : raw;
  }
  return out;
}
async function readJson(request) { try { return { ok: true, value: await request.json() }; } catch { return { ok: false, error: 'Request body must be valid JSON.' }; } }
function safeCallback(value) { return /^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(String(value || '')) ? String(value) : ''; }
function corsHeaders() { return { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-curator-error-key' }; }
function json(value, status = 200) { return new Response(JSON.stringify(value, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() } }); }
function javascript(value, callback) { return new Response(`${callback}(${JSON.stringify(value)});`, { status: 200, headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
function html(value) { return new Response(value, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }); }

function renderConsole(incidents) {
  const active = incidents.filter(item => ACTIVE_STATUSES.has(item.status));
  const recovered = incidents.filter(item => item.status === 'recovered');
  const card = incident => `<article class="incident ${escapeHtml(incident.severity)}"><header><strong>${escapeHtml(incident.severity.toUpperCase())}</strong><span>${escapeHtml(incident.status)}</span></header><h2>${escapeHtml(incident.source)}</h2><p class="component">${escapeHtml(incident.component)} · ${escapeHtml(incident.type)}</p><p>${escapeHtml(incident.message)}</p><small>First ${escapeHtml(incident.firstSeenAt || '')} · Last ${escapeHtml(incident.lastSeenAt || '')} · ${Number(incident.occurrences || 1)} occurrence${Number(incident.occurrences || 1) === 1 ? '' : 's'}</small></article>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CuratorOS Error Bus</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#08110f;color:#f4efe5;font-family:system-ui,-apple-system,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:44px 0 70px}.eyebrow{color:#bfa46a;text-transform:uppercase;letter-spacing:.13em;font-size:.75rem;font-weight:700}h1{font-family:Georgia,serif;font-size:clamp(2rem,6vw,4rem);margin:.2em 0}.lead{color:#c8c3b8;max-width:760px;line-height:1.6}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0}.pill{padding:10px 14px;border:1px solid #3b4541;border-radius:999px;background:#101b18}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.incident{border:1px solid #34413d;border-radius:16px;padding:18px;background:#0e1916}.incident.p0{border-color:#8f3f3f}.incident.p1{border-color:#8b6937}.incident header{display:flex;justify-content:space-between;color:#bfa46a;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}.incident h2{margin:.65em 0 .1em;font-family:Georgia,serif}.component{color:#a9b3ae;font-size:.9rem}.incident small{display:block;color:#8e9994;margin-top:14px;line-height:1.5}section{margin-top:40px}h3{font-family:Georgia,serif;font-size:1.5rem}.empty{border:1px dashed #3b4541;border-radius:16px;padding:24px;color:#9da7a2}a{color:#d9c18d}</style></head><body><main><p class="eyebrow">CuratorOS infrastructure</p><h1>Error Bus</h1><p class="lead">Persistent incident registry, recovery history, and heartbeat failsafe for the CuratorOS tool ecosystem.</p><div class="summary"><span class="pill">${active.length} active</span><span class="pill">${active.filter(x=>x.severity==='p0').length} P0</span><span class="pill">${active.filter(x=>x.severity==='p1').length} P1</span><span class="pill">${recovered.length} recovered</span></div><section><h3>Active incidents</h3><div class="grid">${active.length ? active.map(card).join('') : '<div class="empty">No active infrastructure incidents are recorded.</div>'}</div></section><section><h3>Recent recovered incidents</h3><div class="grid">${recovered.length ? recovered.slice(0,20).map(card).join('') : '<div class="empty">No recovered incidents are recorded yet.</div>'}</div></section></main></body></html>`;
}
function escapeHtml(value) { return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }
