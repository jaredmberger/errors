import base from './entry-v1.16.js';

const KV = 'CURATOR_ERROR_RECORDS';
const AVAILABILITY_KEY = 'availability:public-site-v2';
const OFFLINE_INCIDENT_KEY = 'incident:public-site-offline';
const PUBLIC_HEALTH_PREFIX = 'client-health:ocean-liner-curator:';
const ACTIVE = new Set(['active', 'degraded']);
const VISITOR_EVIDENCE_WINDOW_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // A clean browser health beacon from the public site is stronger evidence
    // of visitor reachability than a same-zone Worker->custom-domain probe.
    // Let the existing handler record the beacon first, then immediately use
    // it to clear any suspect/offline availability state.
    if (request.method === 'POST' && url.pathname === '/api/client-health') {
      const origin = request.headers.get('origin') || '';
      const response = await base.fetch(request, env, ctx);
      if (response.ok && /^https:\/\/(?:www\.)?oceanliners\.net$/i.test(origin)) {
        ctx.waitUntil(markPublicSiteReachableFromVisitor(env).catch(error => console.error('Visitor reachability update failed', error)));
      }
      return response;
    }

    // Before reporting an offline status, check whether an actual visitor has
    // successfully loaded the public site recently. If so, the Worker probe is
    // demonstrably a false negative and the availability state is corrected.
    if (request.method === 'GET' && url.pathname === '/api/status') {
      const recent = await recentPublicVisitorHealth(env);
      if (recent && Date.now() - Date.parse(recent.lastHealthyAt) <= VISITOR_EVIDENCE_WINDOW_MS) {
        await markPublicSiteReachableFromVisitor(env, recent);
      }
      return base.fetch(request, env, ctx);
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Do not allow the availability cron to accumulate a false outage while
    // fresh browser evidence proves that visitors are successfully reaching the
    // public site. Otherwise preserve the v1.16 monitoring behavior.
    if (controller?.cron === '* * * * *') {
      const recent = await recentPublicVisitorHealth(env).catch(() => null);
      if (recent && Date.now() - Date.parse(recent.lastHealthyAt) <= VISITOR_EVIDENCE_WINDOW_MS) {
        ctx.waitUntil(markPublicSiteReachableFromVisitor(env, recent).catch(error => console.error('Visitor reachability update failed', error)));
        return;
      }
    }
    return base.scheduled(controller, env, ctx);
  }
};

async function recentPublicVisitorHealth(env) {
  requireKv(env);
  const listed = await env[KV].list({ prefix: PUBLIC_HEALTH_PREFIX, limit: 1000 });
  let newest = null;
  let newestMs = -Infinity;
  for (const item of listed.keys) {
    const value = await env[KV].get(item.name, 'json');
    if (!value?.lastHealthyAt) continue;
    const at = Date.parse(value.lastHealthyAt);
    if (!Number.isFinite(at) || at <= newestMs) continue;
    newestMs = at;
    newest = value;
  }
  return newest;
}

async function markPublicSiteReachableFromVisitor(env, evidence = null) {
  requireKv(env);
  const now = new Date().toISOString();
  const recent = evidence || await recentPublicVisitorHealth(env);
  if (!recent) return false;

  const healthyMs = Date.parse(recent.lastHealthyAt || 0);
  if (!Number.isFinite(healthyMs) || Date.now() - healthyMs > VISITOR_EVIDENCE_WINDOW_MS) return false;

  const previous = await env[KV].get(AVAILABILITY_KEY, 'json') || {};
  await env[KV].put(AVAILABILITY_KEY, JSON.stringify({
    ...previous,
    status: 'online',
    consecutiveFailedObservations: 0,
    consecutiveSuccessfulObservations: Math.max(1, Number(previous.consecutiveSuccessfulObservations || 0) + 1),
    lastSuccessfulAt: recent.lastHealthyAt,
    suspectSince: null,
    offlineSince: null,
    visitorEvidence: {
      page: recent.page || '/',
      lastHealthyAt: recent.lastHealthyAt,
      healthyObservations: Number(recent.healthyObservations || 1),
      acceptedAt: now,
      reason: 'Recent clean public-site browser health proves visitor reachability.'
    }
  }));

  const incident = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  if (incident && ACTIVE.has(incident.status)) {
    await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify({
      ...incident,
      status: 'recovered',
      recoveredAt: now,
      lastSuccessfulAt: recent.lastHealthyAt,
      recoveryMessage: 'Recovered immediately because a clean public-site browser health observation proved the site was reachable to a visitor.',
      context: {
        ...(incident.context || {}),
        visitorReachabilityEvidence: true,
        visitorHealthyAt: recent.lastHealthyAt,
        visitorPage: recent.page || '/'
      }
    }), { expirationTtl: 60 * 60 * 24 * 180 });
  }

  return true;
}

function requireKv(env) {
  if (!env[KV]) throw new Error(`${KV} KV binding is not configured.`);
}
