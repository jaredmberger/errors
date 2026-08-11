import base from './entry-v1.13.js';

const KV = 'CURATOR_ERROR_RECORDS';
const AVAILABILITY_KEY = 'availability:public-site';
const OFFLINE_INCIDENT_KEY = 'incident:public-site-offline';
const OFFLINE_FINGERPRINT = 'public-site-offline';
const PUBLIC_URL = 'https://oceanliners.net/';
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/status') {
      const availability = await evaluatePublicAvailability(env);
      const response = await base.fetch(request, env, ctx);
      let status = {};
      try { status = await response.json(); } catch {}

      return json({
        ...status,
        status: availability.status === 'offline' ? 'offline' : status.status,
        publicSiteAvailability: availability,
      }, response.ok ? 200 : response.status);
    }

    if (request.method === 'POST' && (url.pathname === '/api/check-now' || url.pathname === '/api/clear-reset' || url.pathname === '/api/shortcut/clear-recheck')) {
      const response = await base.fetch(request, env, ctx);
      await evaluatePublicAvailability(env).catch(() => {});
      return response;
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(evaluatePublicAvailability(env).catch(error => console.error('Public-site availability evaluation failed', error)));
    return result;
  }
};

async function evaluatePublicAvailability(env) {
  requireKv(env);
  const now = new Date().toISOString();
  const previous = await env[KV].get(AVAILABILITY_KEY, 'json') || {
    status: 'unknown',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastCheckedAt: null,
    lastSuccessfulAt: null,
    lastFailureAt: null,
    offlineSince: null,
  };

  const checks = [];

  // When currently offline, two successful confirmations are required to recover.
  // Otherwise, three failed confirmations are required before declaring outage.
  const attemptsNeeded = previous.status === 'offline' ? RECOVERY_THRESHOLD : FAILURE_THRESHOLD;
  for (let attempt = 1; attempt <= attemptsNeeded; attempt++) {
    if (attempt > 1) await sleep(previous.status === 'offline' ? 1200 : 1800);
    const check = await probePublicSite(attempt);
    checks.push(check);

    if (previous.status === 'offline' && !check.ok) break;
    if (previous.status !== 'offline' && check.ok) break;
  }

  const allFailed = checks.length === FAILURE_THRESHOLD && checks.every(item => !item.ok);
  const allSucceeded = checks.length === RECOVERY_THRESHOLD && checks.every(item => item.ok);
  const anySuccess = checks.some(item => item.ok);

  let next = { ...previous, lastCheckedAt: now, lastChecks: checks };

  if (previous.status === 'offline') {
    if (allSucceeded) {
      next = {
        ...next,
        status: 'online',
        consecutiveFailures: 0,
        consecutiveSuccesses: RECOVERY_THRESHOLD,
        lastSuccessfulAt: now,
        offlineSince: null,
      };
      await recoverOfflineIncident(env, now, checks);
    } else {
      next = {
        ...next,
        status: 'offline',
        consecutiveFailures: Math.max(FAILURE_THRESHOLD, Number(previous.consecutiveFailures || 0) + 1),
        consecutiveSuccesses: 0,
        lastFailureAt: now,
        offlineSince: previous.offlineSince || now,
      };
      await upsertOfflineIncident(env, now, checks, next.offlineSince);
    }
  } else if (allFailed) {
    next = {
      ...next,
      status: 'offline',
      consecutiveFailures: FAILURE_THRESHOLD,
      consecutiveSuccesses: 0,
      lastFailureAt: now,
      offlineSince: previous.offlineSince || now,
    };
    await upsertOfflineIncident(env, now, checks, next.offlineSince);
  } else if (anySuccess) {
    next = {
      ...next,
      status: 'online',
      consecutiveFailures: 0,
      consecutiveSuccesses: Math.max(1, Number(previous.consecutiveSuccesses || 0) + 1),
      lastSuccessfulAt: now,
      offlineSince: null,
    };
    await recoverOfflineIncident(env, now, checks);
  }

  await env[KV].put(AVAILABILITY_KEY, JSON.stringify(next));

  return {
    status: next.status === 'offline' ? 'offline' : 'online',
    url: PUBLIC_URL,
    checkedAt: now,
    offlineSince: next.offlineSince || null,
    lastSuccessfulAt: next.lastSuccessfulAt || null,
    consecutiveFailures: Number(next.consecutiveFailures || 0),
    consecutiveSuccesses: Number(next.consecutiveSuccesses || 0),
    confirmation: next.status === 'offline'
      ? `${FAILURE_THRESHOLD} consecutive failed public-site checks`
      : 'public site reachable',
    checks,
  };
}

async function probePublicSite(attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const target = new URL(PUBLIC_URL);
    target.searchParams.set('errorBusAvailability', `${Date.now()}-${attempt}`);
    const response = await fetch(target.href, {
      method: 'GET',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        accept: 'text/html,*/*;q=0.8',
        'user-agent': 'CuratorOS-Error-Bus-Availability/1.0'
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
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      attempt,
      ok: false,
      status: null,
      bytes: 0,
      signature: false,
      durationMs: Date.now() - started,
      error: error?.name === 'AbortError' ? 'timeout' : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function upsertOfflineIncident(env, now, checks, offlineSince) {
  const previous = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  const incident = {
    id: previous?.id || 'incident_public-site-offline',
    fingerprint: OFFLINE_FINGERPRINT,
    source: 'Ocean Liner Curator',
    component: 'public-site-availability',
    severity: 'p0',
    type: 'public-site-offline',
    message: 'OceanLiners.net is confirmed unavailable to public visitors after repeated independent checks.',
    context: {
      url: PUBLIC_URL,
      confirmationFailures: FAILURE_THRESHOLD,
      checks: JSON.stringify(checks).slice(0, 4000),
    },
    firstSeenAt: previous?.firstSeenAt || offlineSince || now,
    lastSeenAt: now,
    occurrences: Math.max(1, Number(previous?.occurrences || 0) + 1),
    status: 'active',
    recoveredAt: null,
    recoveryMessage: null,
    lastSuccessfulAt: previous?.lastSuccessfulAt || null,
  };
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify(incident));
}

async function recoverOfflineIncident(env, now, checks) {
  const previous = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  if (!previous || !['active','degraded'].includes(previous.status)) return;
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify({
    ...previous,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: `Public site availability recovered after ${RECOVERY_THRESHOLD} consecutive successful checks.`,
    context: {
      ...(previous.context || {}),
      recoveryChecks: JSON.stringify(checks).slice(0, 4000),
    }
  }), { expirationTtl: 60 * 60 * 24 * 180 });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function requireKv(env) { if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`); }
function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
