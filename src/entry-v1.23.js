import base from './entry-v1.22.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const HEALTH_PREFIX = 'client-health:';
const VERIFY_URL = 'https://verify.oceanlinercurator.com/api/verify';
const PUBLIC_SOURCE = 'Ocean Liner Curator';
const MAX_PER_PASS = 12;
const RECOVERED_TTL = 60 * 60 * 24 * 180;
const RECHECK_LOCK_KEY = 'hardware-recheck:lock:v1';
const RECHECK_LOCK_TTL = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/recheck-active') {
      try {
        return json(await recheckActive(env));
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

async function recheckActive(env) {
  requireKv(env);

  if (!env.VERIFY_WRITE_KEY) {
    return {
      ok: false,
      error: 'VERIFY_WRITE_KEY is not configured.',
      checkedAt: new Date().toISOString()
    };
  }

  const lock = await env[KV].get(RECHECK_LOCK_KEY);
  if (lock) {
    return {
      ok: true,
      rateLimited: true,
      message: 'A recheck was run within the last 30 seconds.',
      checkedAt: new Date().toISOString(),
      activeIncidentCount: await activeIncidentCount(env)
    };
  }

  await env[KV].put(RECHECK_LOCK_KEY, new Date().toISOString(), { expirationTtl: RECHECK_LOCK_TTL });

  const before = await activeIncidentCount(env);
  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let checked = 0;
  let recovered = 0;
  const results = [];

  for (const key of listed.keys) {
    if (checked >= MAX_PER_PASS) break;

    const incident = await env[KV].get(key.name, 'json');
    if (!incident || incident.status !== 'active') continue;
    if (incident.source !== PUBLIC_SOURCE) continue;
    if (incident.type === 'public-site-offline') continue;

    if (incident.type === 'public-site-infrastructure-failure') {
      const target = safeOceanlinersUrl(incident?.context?.url);
      if (!target) continue;

      checked++;
      const verification = await verifyReachable(env, target, incident, 'Manual hardware-console recheck of a public-site infrastructure incident.');
      let didRecover = false;

      if (verification.verdict === 'confirmed') {
        await recoverIncident(
          env,
          key.name,
          incident,
          verification,
          'Recovered after a hardware-console recheck and independent Curator Verify confirmation.'
        );
        recovered++;
        didRecover = true;
      }

      results.push(resultRow(incident, verification, didRecover));
      continue;
    }

    if (String(incident.type || '').startsWith('client-')) {
      const pagePath = normalizePagePath(incident?.context?.page);
      const target = `https://oceanliners.net${pagePath}`;

      checked++;
      const verification = await verifyReachable(env, target, incident, 'Manual hardware-console recheck of a browser-reported incident.');
      let didRecover = false;

      if (verification.verdict === 'confirmed') {
        const health = await pageHealthAfterIncident(env, pagePath, incident);
        if (health) {
          await recoverIncident(
            env,
            key.name,
            incident,
            verification,
            `Recovered after a hardware-console recheck, Curator Verify confirmation, and a clean browser-health observation at ${health.lastHealthyAt}.`,
            health
          );
          recovered++;
          didRecover = true;
        }
      }

      results.push(resultRow(incident, verification, didRecover));
    }
  }

  const after = await activeIncidentCount(env);

  return {
    ok: true,
    rateLimited: false,
    checkedAt: new Date().toISOString(),
    checkedIncidentCount: checked,
    recoveredIncidentCount: recovered,
    activeIncidentCountBefore: before,
    activeIncidentCountAfter: after,
    results
  };
}

async function verifyReachable(env, target, incident, note) {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-curator-verify-key': env.VERIFY_WRITE_KEY
      },
      body: JSON.stringify({
        url: target,
        claim: 'reachable',
        source: 'error-bus-hardware-recheck',
        incidentId: incident.id || incident.fingerprint || '',
        note
      }),
      signal: controller.signal,
      cache: 'no-store',
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (!response.ok) {
      return {
        verdict: 'inconclusive',
        checkedAt,
        httpStatus: response.status,
        reason: 'Verify API did not return success.',
        target
      };
    }

    const payload = await response.json();
    const verification = payload?.verification;

    if (!verification || !['confirmed', 'not_confirmed', 'inconclusive'].includes(verification.verdict)) {
      return {
        verdict: 'inconclusive',
        checkedAt,
        reason: 'Verify returned an invalid response.',
        target
      };
    }

    return {
      verdict: verification.verdict,
      checkedAt: verification.checkedAt || checkedAt,
      verificationId: verification.id || null,
      target,
      evidence: verification.evidence || null
    };
  } catch (error) {
    return {
      verdict: 'inconclusive',
      checkedAt,
      target,
      reason: error?.name === 'AbortError' ? 'Verify request timed out.' : (error?.message || String(error))
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pageHealthAfterIncident(env, pagePath, incident) {
  const key = `${HEALTH_PREFIX}${slug(PUBLIC_SOURCE)}:${await shortHash(pagePath)}`;
  const health = await env[KV].get(key, 'json');
  if (!health?.lastHealthyAt) return null;

  const healthyMs = Date.parse(health.lastHealthyAt);
  const errorMs = Date.parse(incident.lastSeenAt || 0);
  if (!Number.isFinite(healthyMs) || !Number.isFinite(errorMs)) return null;
  if (healthyMs <= errorMs) return null;
  return health;
}

async function recoverIncident(env, key, incident, verification, message, health = null) {
  const now = new Date().toISOString();
  const recovered = {
    ...incident,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: health?.lastHealthyAt || verification.checkedAt || now,
    recoveryMessage: message,
    context: {
      ...(incident.context || {}),
      curatorVerify: true,
      verificationVerdict: verification.verdict,
      verificationId: verification.verificationId || null,
      verificationCheckedAt: verification.checkedAt || now,
      verificationTarget: verification.target || null,
      browserHealthConfirmed: Boolean(health),
      browserHealthyAt: health?.lastHealthyAt || null,
      hardwareConsoleRecheck: true
    }
  };

  await env[KV].put(key, JSON.stringify(recovered), { expirationTtl: RECOVERED_TTL });
  await writeRecoveryEvent(env, recovered);
}

async function writeRecoveryEvent(env, incident) {
  const at = new Date().toISOString();
  const key = `event:${at}:${Math.random().toString(36).slice(2, 8)}`;

  await env[KV].put(key, JSON.stringify({
    kind: 'hardware-recheck-recovery',
    at,
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    component: incident.component,
    severity: incident.severity,
    status: incident.status,
    message: incident.recoveryMessage
  }), { expirationTtl: RECOVERED_TTL });
}

async function activeIncidentCount(env) {
  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let count = 0;

  for (const key of listed.keys) {
    const incident = await env[KV].get(key.name, 'json');
    if (incident && (incident.status === 'active' || incident.status === 'degraded')) count++;
  }

  return count;
}

function resultRow(incident, verification, recovered) {
  return {
    id: incident.id || incident.fingerprint || null,
    type: incident.type || null,
    target: verification.target || null,
    verdict: verification.verdict,
    recovered,
    checkedAt: verification.checkedAt || new Date().toISOString()
  };
}

function safeOceanlinersUrl(value) {
  if (!value) return null;

  try {
    const url = new URL(value, 'https://oceanliners.net');
    if (url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();
    if (host !== 'oceanliners.net' && host !== 'www.oceanliners.net' && !host.endsWith('.oceanliners.net')) return null;

    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normalizePagePath(value) {
  try {
    const url = new URL(value || '/', 'https://oceanliners.net');
    if (!['oceanliners.net', 'www.oceanliners.net'].includes(url.hostname.toLowerCase())) return '/';
    return url.pathname || '/';
  } catch {
    return '/';
  }
}

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

async function shortHash(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow, noarchive'
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}
