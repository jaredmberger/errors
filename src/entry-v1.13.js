import base from './entry-v1.12.js';

const SHORTCUT_PATHS = new Set([
  '/api/clear-reset',
  '/api/shortcut/clear-recheck'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (SHORTCUT_PATHS.has(url.pathname)) {
      if (request.method !== 'POST') {
        return json({
          ok: false,
          error: 'Method not allowed. This endpoint requires POST.'
        }, 405, { allow: 'POST' });
      }

      const auth = authorizeShortcut(request, env);
      if (!auth.ok) {
        return json({ ok: false, error: auth.error }, auth.status);
      }

      const response = await base.fetch(new Request('https://errors.oceanliners.net/api/clear-recheck', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: '{}'
      }), env, ctx);

      let result;
      try {
        result = await response.json();
      } catch {
        result = { ok: response.ok };
      }

      return json({
        ...result,
        shortcut: true,
        endpoint: url.pathname,
        requestedAt: new Date().toISOString()
      }, response.ok ? 200 : response.status);
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function authorizeShortcut(request, env) {
  if (!env.ERROR_REPORT_KEY) {
    return {
      ok: false,
      status: 503,
      error: 'ERROR_REPORT_KEY is not configured; Shortcut reset API is disabled.'
    };
  }

  const supplied = request.headers.get('x-curator-error-key') || '';
  if (!supplied || supplied !== env.ERROR_REPORT_KEY) {
    return { ok: false, status: 401, error: 'Unauthorized.' };
  }

  return { ok: true };
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}
