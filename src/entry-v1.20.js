import base from './entry-v1.19.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const VERIFY_GATE_PREFIX = 'verify-gate:';
const HEALTH_PREFIX = 'client-health:';
const VERIFY_URL = 'https://verify.oceanlinercurator.com/api/verify';
const PUBLIC_SOURCE = 'Ocean Liner Curator';
const VERIFY_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_PER_PASS = 12;
const RECOVERED_TTL = 60 * 60 * 24 * 180;

export default {
  async fetch(request, env, ctx) {
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    if (controller?.cron === '* * * * *') {
      ctx.waitUntil(verifyActiveNoise(env).catch(error => console.error('Verification-assisted recovery failed', error)));
    }
    return result;
  }
};

async function verifyActiveNoise(env) {
  requireKv(env);
  if (!env.VERIFY_WRITE_KEY) return;

  const listed = await env[KV].list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  let handled = 0;

  for (const key of listed.keys) {
    if (handled >= MAX_PER_PASS) break;
    const incident = await env[KV].get(key.name, 'json');
    if (!incident || incident.status !== 'active') continue;
    if (incident.source !== PUBLIC_SOURCE) continue;
    if (incident.type === 'public-site-offline') continue;

    if (incident.type === 'public-site-infrastructure-failure') {
      const target = safeOceanlinersUrl(incident?.context?.url);
      if (!target || !(await gateOpen(env, incident))) continue;
      handled++;
      const verification = await verifyReachable(env, target, incident, 'Independent retest of a public-site infrastructure failure.');
      await storeGate(env, incident, verification);
      if (verification.verdict === 'confirmed') {
        await recoverIncident(env, key.name, incident, verification,
          'Curator Verify independently reached the previously failing infrastructure resource.');
      }
      continue;
    }

    if (String(incident.type || '').startsWith('client-')) {
      const pagePath = normalizePagePath(incident?.context?.page);
      const target = `https://oceanliners.net${pagePath}`;
      if (!(await gateOpen(env, incident))) continue;
      handled++;

      const verification = await verifyReachable(env, target, incident, 'Independent page reachability check for a browser-reported incident.');
      await storeGate(env, incident, verification);
      if (verification.verdict !== 'confirmed') continue;

      const health = await pageHealthAfterIncident(env, pagePath, incident);
      if (!health) continue;

      await recoverIncident(env, key.name, incident, verification,
        `Recovered after Curator Verify reached the page and a clean browser-health observation followed the error at ${health.lastHealthyAt}.`, health);
    }
  }
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
        source: 'error-bus-verification-assisted-recovery',
        incidentId: incident.id || incident.fingerprint || '',
        note
      }),
      signal: controller.signal,
      cache: 'no-store',
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    if (!response.ok) {
      return { verdict: 'inconclusive', checkedAt, httpStatus: response.status, reason: 'Verify API did not return success.' };
    }
    const payload = await response.json();
    const v = payload?.verification;
    if (!v || !['confirmed', 'not_confirmed', 'inconclusive'].includes(v.verdict)) {
      return { verdict: 'inconclusive', checkedAt, reason: 'Verify returned an invalid response.' };
    }
    return {
      verdict: v.verdict,
      checkedAt: v.checkedAt || checkedAt,
      verificationId: v.id || null,
      target,
      evidence: v.evidence || null
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

async function gateOpen(env, incident) {
  const key = VERIFY_GATE_PREFIX + (incident.fingerprint || incident.id || 'unknown');
  const previous = await env[KV].get(key, 'json');
  const at = Date.parse(previous?.checkedAt || 0);
  return !Number.isFinite(at) || Date.now() - at >= VERIFY_COOLDOWN_MS;
}

async function storeGate(env, incident, verification) {
  const key = VERIFY_GATE_PREFIX + (incident.fingerprint || incident.id || 'unknown');
  await env[KV].put(key, JSON.stringify({
    checkedAt: verification.checkedAt || new Date().toISOString(),
    verdict: verification.verdict,
    verificationId: verification.verificationId || null,
    target: verification.target || null
  }), { expirationTtl: 60 * 60 * 24 });
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
      browserHealthyAt: health?.lastHealthyAt || null
    }
  };
  await env[KV].put(key, JSON.stringify(recovered), { expirationTtl: RECOVERED_TTL });
  await writeRecoveryEvent(env, recovered);
}

async function writeRecoveryEvent(env, incident) {
  const at = new Date().toISOString();
  const key = `event:${at}:${Math.random().toString(36).slice(2, 8)}`;
  await env[KV].put(key, JSON.stringify({
    kind: 'verify-assisted-recovery',
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
