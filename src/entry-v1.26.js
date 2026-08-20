import base from './entry-v1.25.js';

const KV = 'CURATOR_ERROR_RECORDS';
const HEARTBEAT_KEY = 'heartbeat:curatoros-mini-console:physical-console-01';
const INCIDENT_KEY = 'incident:heartbeat-curatoros-mini-console-physical-console-01';
const EVENT_TTL = 60 * 60 * 24 * 180;
const DEVICE_SOURCE = 'CuratorOS Mini Console';
const DEVICE_COMPONENT = 'physical-console-01';
const VERSION = '1.26.0';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // This particular physical console is intentionally not monitored.
    // Its existing firmware may continue to POST heartbeats; accept them
    // harmlessly so the device does not need to be reflashed.
    if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
      const forwarded = request.clone();
      let body = null;
      try {
        body = await request.json();
      } catch {
        return base.fetch(forwarded, env, ctx);
      }

      if (body?.source === DEVICE_SOURCE && body?.component === DEVICE_COMPONENT) {
        await disableConsoleMonitoring(env);
        return json({
          ok: true,
          monitoring: 'disabled',
          ignored: true,
          source: DEVICE_SOURCE,
          component: DEVICE_COMPONENT,
          message: 'Heartbeat accepted but this console is intentionally excluded from staleness monitoring.'
        });
      }

      return base.fetch(forwarded, env, ctx);
    }

    if (request.method === 'GET' && url.pathname === '/api/hardware-console') {
      await disableConsoleMonitoring(env);
      return json({
        ok: true,
        console: {
          source: DEVICE_SOURCE,
          component: DEVICE_COMPONENT,
          status: 'unmonitored',
          monitoring: 'disabled',
          stale: false,
          version: VERSION
        }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    // Remove the old heartbeat before the inherited evaluator runs, so it
    // can never create a heartbeat-stale incident for this console.
    await disableConsoleMonitoring(env);
    return base.scheduled(controller, env, ctx);
  }
};

async function disableConsoleMonitoring(env) {
  requireKv(env);

  await env[KV].delete(HEARTBEAT_KEY);

  const incident = await env[KV].get(INCIDENT_KEY, 'json');
  if (!incident || !['active', 'degraded'].includes(incident.status)) return;

  const now = new Date().toISOString();
  const recovered = {
    ...incident,
    status: 'recovered',
    recoveredAt: now,
    lastSuccessfulAt: now,
    recoveryMessage: 'Monitoring disabled for this physical console by operator choice.'
  };

  await env[KV].put(INCIDENT_KEY, JSON.stringify(recovered), { expirationTtl: EVENT_TTL });

  const eventKey = `event:${now}:${Math.random().toString(36).slice(2, 8)}`;
  await env[KV].put(eventKey, JSON.stringify({
    kind: 'monitoring-disabled',
    at: now,
    incidentId: recovered.id || null,
    fingerprint: recovered.fingerprint || null,
    source: DEVICE_SOURCE,
    component: DEVICE_COMPONENT,
    severity: recovered.severity || 'p1',
    status: 'recovered',
    message: recovered.recoveryMessage
  }), { expirationTtl: EVENT_TTL });
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
