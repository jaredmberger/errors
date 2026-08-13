import base from './entry-v1.21.js';
import { BUILD_META } from './build-meta.generated.js';

const SERVICE = 'CuratorOS Error Bus';
const VERSION = '1.22.0';
const REPOSITORY = 'jaredmberger/errors';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/runtime') {
      const meta = env.CF_VERSION_METADATA || {};
      return json({
        ok: true,
        service: SERVICE,
        version: VERSION,
        repository: REPOSITORY,
        runtime: 'cloudflare-workers',
        build: {
          commit: BUILD_META.commit,
          branch: BUILD_META.branch,
          buildUuid: BUILD_META.buildUuid,
          source: BUILD_META.source
        },
        cloudflareVersion: {
          id: meta.id || null,
          tag: meta.tag || null,
          timestamp: meta.timestamp || null
        },
        observedAt: new Date().toISOString()
      });
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });
}
