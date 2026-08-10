import base from './entry-v1.11.js';

const ALLOWED_ORIGIN = 'https://tools.oceanliners.net';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/clear-recheck') {
      const origin = request.headers.get('origin') || '';

      if (request.method === 'OPTIONS') {
        if (origin !== ALLOWED_ORIGIN) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, {
          status: 204,
          headers: corsHeaders(origin)
        });
      }

      if (request.method === 'POST') {
        const response = await base.fetch(request, env, ctx);
        const headers = new Headers(response.headers);
        if (origin === ALLOWED_ORIGIN) {
          for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
        }
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function corsHeaders(origin) {
  return {
    'access-control-allow-origin': origin,
    'vary': 'Origin',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
    'access-control-max-age': '86400'
  };
}
