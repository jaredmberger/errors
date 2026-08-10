import base from './entry-v1.6.js';

const PUBLIC_HOST_RE = /(^|\.)oceanliners\.net$/i;
const CONFIRMABLE_KINDS = new Set(['resource-error', 'fetch-network-error', 'fetch-http-error']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      const clone = request.clone();
      try {
        const body = await clone.json();
        const kind = String(body?.kind || '');
        const method = String(body?.method || 'GET').toUpperCase();
        const resource = normalizePublicResource(body?.resource);

        if (CONFIRMABLE_KINDS.has(kind) && method === 'GET' && resource) {
          const confirmation = await verifyPublicResource(resource, kind);
          if (confirmation.ok) {
            return new Response(JSON.stringify({
              ok: true,
              ignored: true,
              reason: 'resource-confirmed-healthy',
              verification: confirmation,
            }), {
              status: 202,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                'access-control-allow-origin': request.headers.get('origin') || '*',
                'vary': 'Origin'
              }
            });
          }
        }
      } catch {
        // Fall through to the existing ingestion pipeline when confirmation
        // cannot be performed. Runtime JS exceptions remain unaffected.
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function normalizePublicResource(value) {
  try {
    const url = new URL(String(value || ''), 'https://oceanliners.net/');
    if (url.protocol !== 'https:') return '';
    if (!PUBLIC_HOST_RE.test(url.hostname)) return '';
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

async function verifyPublicResource(resource, kind) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const target = new URL(resource);
    target.searchParams.set('errorBusConfirm', String(Date.now()));
    const response = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: kind === 'resource-error' ? '*/*' : 'text/html,*/*;q=0.8',
        'user-agent': 'CuratorOS-Error-Bus-Client-Confirmation/1.0'
      },
      signal: controller.signal,
      cf: { cacheTtl: 0, cacheEverything: false }
    });

    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const contentType = response.headers.get('content-type') || '';
    const looksLikeErrorPage = /<title>\s*(?:404|500|error|not found)|cloudflare.*error/i.test(text.slice(0, 1500));

    return {
      ok: response.ok && bytes > 0 && !looksLikeErrorPage,
      status: response.status,
      bytes,
      contentType,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      bytes: 0,
      durationMs: Date.now() - started,
      error: error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
