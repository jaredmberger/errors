import base from './entry-v1.4.js';

const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const QUIET_MS = 60 * 60 * 1000;
const PUBLIC_SOURCE = 'Ocean Liner Curator';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/check-now') {
      const baseResponse = await base.fetch(request, env, ctx);
      let baseResult = {};
      try { baseResult = await baseResponse.clone().json(); } catch {}

      const fallback = await recoverQuietPublicClientIncidents(env);
      const statusResponse = await base.fetch(new Request('https://errors.internal/api/status'), env, ctx);
      let status = {};
      try { status = await statusResponse.json(); } catch {}

      return new Response(JSON.stringify({
        ...baseResult,
        ok: baseResponse.ok && baseResult?.ok !== false,
        fallbackRecovery: fallback,
        status,
      }, null, 2), {
        status: baseResponse.ok ? 200 : baseResponse.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(recoverQuietPublicClientIncidents(env).catch(error => console.error('Fallback frontend recovery failed', error)));
    return result;
  }
};

async function recoverQuietPublicClientIncidents(env) {
  if (!env.CURATOR_ERROR_RECORDS) throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.');

  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix: INCIDENT_PREFIX, limit: 1000 });
  const now = Date.now();
  const recovered = [];
  const waiting = [];

  for (const item of listed.keys) {
    const incident = await env.CURATOR_ERROR_RECORDS.get(item.name, 'json');
    if (!incident || incident.status !== 'active') continue;
    if (incident.source !== PUBLIC_SOURCE) continue;
    if (!String(incident.type || '').startsWith('client-')) continue;

    const lastSeenMs = Date.parse(incident.lastSeenAt || 0);
    if (!Number.isFinite(lastSeenMs)) continue;

    const quietForMs = now - lastSeenMs;
    if (quietForMs < QUIET_MS) {
      waiting.push({ id: incident.id, quietMinutes: Math.floor(quietForMs / 60000) });
      continue;
    }

    const page = normalizePublicUrl(incident?.context?.page || '/');
    if (!page) continue;

    const verification = await verifyPublicPage(page);
    if (!verification.ok) continue;

    // Re-read after the network verification so an incident that recurred
    // during the check cannot be incorrectly recovered.
    const current = await env.CURATOR_ERROR_RECORDS.get(item.name, 'json');
    if (!current || current.status !== 'active') continue;
    const currentLastSeenMs = Date.parse(current.lastSeenAt || 0);
    if (!Number.isFinite(currentLastSeenMs) || Date.now() - currentLastSeenMs < QUIET_MS) continue;

    const recoveredAt = new Date().toISOString();
    const next = {
      ...current,
      status: 'recovered',
      recoveredAt,
      lastSuccessfulAt: recoveredAt,
      recoveryMessage: `Recovered after 60+ minutes without recurrence and a fresh successful verification of ${page}.`,
    };

    await env.CURATOR_ERROR_RECORDS.put(item.name, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 180 });
    await writeRecoveryEvent(env, next);
    recovered.push({ id: next.id, page, status: verification.status, bytes: verification.bytes });
  }

  return { recoveredCount: recovered.length, recovered, waitingCount: waiting.length, waiting };
}

async function verifyPublicPage(url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const target = new URL(url);
    target.searchParams.set('errorBusVerify', String(Date.now()));
    const response = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'text/html,*/*;q=0.8', 'user-agent': 'CuratorOS-Error-Bus-Recovery-Verify/1.0' },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const contentType = response.headers.get('content-type') || '';
    const htmlLike = /text\/html|application\/xhtml\+xml/i.test(contentType) || /<!doctype html|<html/i.test(text.slice(0, 1000));
    return {
      ok: response.ok && bytes >= 500 && htmlLike,
      status: response.status,
      bytes,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, status: null, bytes: 0, durationMs: Date.now() - started, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function normalizePublicUrl(value) {
  try {
    const url = new URL(String(value || '/'), 'https://oceanliners.net/');
    if (url.protocol !== 'https:') return '';
    if (!/(^|\.)oceanliners\.net$/i.test(url.hostname)) return '';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

async function writeRecoveryEvent(env, incident) {
  const now = new Date().toISOString();
  const key = `${EVENT_PREFIX}${now}:${Math.random().toString(36).slice(2, 8)}`;
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify({
    kind: 'client-quiet-window-verified-recovery',
    at: now,
    incidentId: incident.id,
    fingerprint: incident.fingerprint,
    source: incident.source,
    component: incident.component,
    severity: incident.severity,
    status: incident.status,
    message: incident.recoveryMessage,
  }), { expirationTtl: 60 * 60 * 24 * 180 });
}
