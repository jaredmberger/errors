import base from './entry-v1.8.js';

const INCIDENT_PREFIX = 'incident:';
const GENERIC_REJECTION_RE = /^unhandled promise rejection$/i;
const FIRST_PARTY_RE = /(^|\.)oceanliners\.net/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if ((request.method === 'GET' && url.pathname === '/') || (request.method === 'POST' && url.pathname === '/api/check-now')) {
      await demoteUnprovenGenericRejections(env).catch(() => {});
    }
    return base.fetch(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const result = base.scheduled(controller, env, ctx);
    ctx.waitUntil(demoteUnprovenGenericRejections(env).catch(error => console.error('Generic rejection cleanup failed', error)));
    return result;
  }
};

async function demoteUnprovenGenericRejections(env) {
  if (!env.CURATOR_ERROR_RECORDS) return 0;
  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix:INCIDENT_PREFIX, limit:1000 });
  let recovered = 0;
  for (const key of listed.keys) {
    const incident = await env.CURATOR_ERROR_RECORDS.get(key.name, 'json');
    if (!incident || !['active','degraded'].includes(incident.status)) continue;
    if (incident.type !== 'client-unhandled-rejection') continue;
    if (!GENERIC_REJECTION_RE.test(String(incident.message || '').trim())) continue;
    if (Number(incident.occurrences || 1) > 1) continue;
    const evidence = `${incident?.context?.stack || ''}\n${incident?.context?.file || ''}`;
    if (FIRST_PARTY_RE.test(evidence)) continue;
    const now = new Date().toISOString();
    await env.CURATOR_ERROR_RECORDS.put(key.name, JSON.stringify({
      ...incident,
      status:'recovered',
      recoveredAt:now,
      lastSuccessfulAt:now,
      recoveryMessage:'Reclassified by Incident Verification v2 as an unproven one-off browser promise rejection. Future occurrences require recurrence before promotion.'
    }), { expirationTtl:60*60*24*180 });
    recovered++;
  }
  return recovered;
}
