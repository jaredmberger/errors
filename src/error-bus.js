import base from './entry-v1.29.js';
import {
  clientScriptObservationsResponse,
  handleClientScriptError,
  isAllowedClientOrigin,
  isClientScriptKind,
  retireLegacyScriptIncidentsOnce
} from './browser-telemetry.js';
import {
  authorizeRecoveryExport,
  recoveryExport
} from './recovery.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/api/recovery-export') {
      const authError = authorizeRecoveryExport(request, env);
      return authError || recoveryExport(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/client-script-observations') {
      return clientScriptObservationsResponse(env);
    }

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      const forwarded = request.clone();
      let raw;

      try {
        raw = await request.json();
      } catch {
        return base.fetch(forwarded, env, ctx);
      }

      if (!isClientScriptKind(raw?.kind)) {
        return base.fetch(forwarded, env, ctx);
      }

      const origin = request.headers.get('origin') || '';
      if (!isAllowedClientOrigin(origin)) {
        return base.fetch(forwarded, env, ctx);
      }

      return handleClientScriptError(request, env, raw);
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(
      retireLegacyScriptIncidentsOnce(env).catch(error =>
        console.warn(
          'Client script hardening migration skipped:',
          error?.message || String(error)
        )
      )
    );
    return result;
  }
};
