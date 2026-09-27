const KV = 'CURATOR_ERROR_RECORDS';
const OBSERVATION_PREFIX = 'observation:client-resource:';
const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const OBSERVATION_TTL = 60 * 60 * 24 * 7;
const RECOVERED_TTL = 60 * 60 * 24 * 180;
const PUBLIC_HOST_RE = /(^|\.)oceanliners\.net$/i;
const CLOUDFLARE_MANAGED_PATH_RE = /^\/cdn-cgi\/zaraz(?:\/|$)/i;

export function isClientResourceKind(kind) {
  return String(kind || '') === 'resource-error';
}

export async function handleClientResourceError(request, env, raw) {
  const origin = request.headers.get('origin') || '';
  const resource = normalizePublicResource(raw?.resource);

  if (resource && isCloudflareManagedResource(resource)) {
    await recordObservation(env, raw, origin, {
      classification: 'cloudflare-managed-resource-observation',
      reason: 'Cloudflare Zaraz is edge-managed infrastructure; standalone browser resource failures are not promoted to OceanLiners.net incidents.'
    });
    return resourceJson({
      ok: true,
      observation: true,
      promoted: false,
      classification: 'cloudflare-managed-resource-observation'
    }, 202, origin);
  }

  if (!resource) {
    await recordObservation(env, raw, origin, {
      classification: 'unverified-resource-observation',
      reason: 'Resource URL is missing, opaque, or outside the OceanLiners.net zone.'
    });
    return resourceJson({
      ok: true,
      observation: true,
      promoted: false,
      classification: 'unverified-resource-observation'
    }, 202, origin);
  }

  // First-party resources continue into the established verification pipeline.
  // That pipeline independently confirms failure before an incident is eligible.
  return null;
}

export async function retireUnprovenResourceIncidents(env) {
  if (!env?.[KV]) return { recovered: 0, checked: 0 };

  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let recovered = 0;
  let checked = 0;

  for (const item of listed.keys) {
    const incident = await env[KV].get(item.name, 'json');
    if (!incident || !['active', 'degraded'].includes(incident.status)) continue;
    if (incident.type !== 'client-resource-error') continue;
    checked++;

    const resource = normalizePublicResource(incident?.context?.resource);
    let verification = null;
    let reason = '';

    if (resource && isCloudflareManagedResource(resource)) {
      reason = 'Cloudflare Zaraz is edge-managed infrastructure; this browser resource incident is non-actionable telemetry and has been retired.';
    } else if (!resource) {
      reason = 'Resource report was missing, opaque, or outside the OceanLiners.net zone; browser-only resource observations are not active incidents.';
    } else {
      verification = await verifyFirstPartyResource(resource);
      if (!verification.ok) continue;
      reason = `First-party resource is currently healthy (HTTP ${verification.status}, ${verification.bytes} bytes); stale browser resource incident retired.`;
    }

    const current = await env[KV].get(item.name, 'json');
    if (!current || !['active', 'degraded'].includes(current.status)) continue;

    const now = new Date().toISOString();
    const next = {
      ...current,
      status: 'recovered',
      recoveredAt: now,
      lastSuccessfulAt: now,
      recoveryMessage: reason,
      resourceVerification: verification
    };

    await env[KV].put(item.name, JSON.stringify(next), { expirationTtl: RECOVERED_TTL });
    await writeRecoveryEvent(env, next);
    recovered++;
  }

  return { recovered, checked };
}

async function recordObservation(env, raw, origin, extra = {}) {
  if (!env?.[KV]) return null;
  const now = new Date().toISOString();
  const signature = await shortHash(`${origin}|${raw?.pageUrl || ''}|${raw?.message || ''}|${raw?.resource || ''}`);
  const key = `${OBSERVATION_PREFIX}${now}:${signature}`;
  const record = {
    at: now,
    origin,
    page: String(raw?.pageUrl || '').slice(0, 800),
    kind: 'resource-error',
    message: String(raw?.message || 'Resource failed to load').slice(0, 1000),
    resource: String(raw?.resource || '').slice(0, 1000),
    ...extra
  };
  await env[KV].put(key, JSON.stringify(record), { expirationTtl: OBSERVATION_TTL });
  return record;
}

async function verifyFirstPartyResource(resource) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const target = new URL(resource);
    target.searchParams.set('errorBusResourceRetire', String(Date.now()));
    const response = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        accept: '*/*',
        'user-agent': 'CuratorOS-Error-Bus-Resource-Retirement/1.0'
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const body = await response.text();
    const bytes = new TextEncoder().encode(body).byteLength;
    const looksLikeErrorPage = /<title>\s*(?:404|500|error|not found)|cloudflare.*error/i.test(body.slice(0, 1500));
    return {
      ok: response.ok && bytes > 0 && !looksLikeErrorPage,
      status: response.status,
      bytes,
      durationMs: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      bytes: 0,
      durationMs: Date.now() - started,
      error: error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function isCloudflareManagedResource(value) {
  try {
    const url = new URL(String(value || ''));
    return PUBLIC_HOST_RE.test(url.hostname) && CLOUDFLARE_MANAGED_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizePublicResource(value) {
  try {
    const url = new URL(String(value || ''), 'https://oceanliners.net/');
    if (url.protocol !== 'https:' || !PUBLIC_HOST_RE.test(url.hostname)) return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

async function writeRecoveryEvent(env, incident) {
  const now = new Date().toISOString();
  const key = `${EVENT_PREFIX}${now}:${Math.random().toString(36).slice(2, 8)}`;
  await env[KV].put(key, JSON.stringify({
    kind: 'client-resource-observation-recovery',
    at: now,
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    component: incident.component,
    severity: incident.severity,
    status: incident.status,
    message: incident.recoveryMessage
  }), { expirationTtl: RECOVERED_TTL });
}

async function shortHash(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || '')));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function resourceCors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    vary: 'Origin'
  };
}

function resourceJson(value, status, origin) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...resourceCors(origin)
    }
  });
}
