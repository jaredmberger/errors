import base from './entry-v1.1.js';

const ACTIVE = new Set(['active', 'degraded']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      const response = await base.fetch(new Request('https://errors.internal/api/incidents?active=0&limit=100'), env, ctx);
      const data = await response.json();
      const incidents = Array.isArray(data?.incidents) ? data.incidents : [];
      return new Response(renderConsole(incidents), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        }
      });
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function renderConsole(incidents) {
  const active = incidents.filter(item => ACTIVE.has(item.status));
  const recovered = incidents.filter(item => item.status === 'recovered');
  const p0 = active.filter(item => item.severity === 'p0').length;
  const p1 = active.filter(item => item.severity === 'p1').length;
  const state = p0 ? 'critical' : active.length ? 'attention' : 'healthy';
  const label = p0 ? 'Critical incident active' : active.length ? 'System needs attention' : 'All systems normal';
  const detail = p0
    ? `${p0} critical incident${p0 === 1 ? '' : 's'} require immediate attention.`
    : active.length
      ? `${active.length} active incident${active.length === 1 ? '' : 's'} currently recorded.`
      : 'No active infrastructure incidents are recorded.';

  const card = incident => `<article class="incident ${escapeHtml(incident.severity)}"><header><strong>${escapeHtml(String(incident.severity || '').toUpperCase())}</strong><span>${escapeHtml(incident.status)}</span></header><h2>${escapeHtml(incident.source)}</h2><p class="component">${escapeHtml(incident.component)} · ${escapeHtml(incident.type)}</p><p>${escapeHtml(incident.message)}</p><small>First ${escapeHtml(incident.firstSeenAt || '')} · Last ${escapeHtml(incident.lastSeenAt || '')} · ${Number(incident.occurrences || 1)} occurrence${Number(incident.occurrences || 1) === 1 ? '' : 's'}</small></article>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08110f"><title>CuratorOS Error Bus</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#08110f;color:#f4efe5;font-family:system-ui,-apple-system,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:max(36px,env(safe-area-inset-top)) 0 max(70px,env(safe-area-inset-bottom))}.eyebrow{color:#bfa46a;text-transform:uppercase;letter-spacing:.13em;font-size:.75rem;font-weight:700}h1{font-family:Georgia,serif;font-size:clamp(2rem,6vw,4rem);margin:.2em 0}.lead{color:#c8c3b8;max-width:760px;line-height:1.6}.status-panel{display:flex;align-items:center;gap:20px;margin:28px 0 22px;padding:20px 22px;border:1px solid #34413d;border-radius:20px;background:#0e1916;box-shadow:0 18px 48px rgba(0,0,0,.22)}.status-light{width:58px;height:58px;flex:0 0 58px;border-radius:50%;position:relative}.status-light::after{content:"";position:absolute;inset:9px;border-radius:50%;background:rgba(255,255,255,.18);filter:blur(5px)}.healthy .status-light{background:#4fca78;box-shadow:0 0 0 7px rgba(79,202,120,.09),0 0 28px rgba(79,202,120,.55)}.attention .status-light{background:#e0aa48;box-shadow:0 0 0 7px rgba(224,170,72,.09),0 0 28px rgba(224,170,72,.52)}.critical .status-light{background:#e25757;box-shadow:0 0 0 7px rgba(226,87,87,.1),0 0 30px rgba(226,87,87,.58)}.status-copy strong{display:block;font-family:Georgia,serif;font-size:clamp(1.25rem,4vw,1.8rem);margin-bottom:4px}.status-copy span{display:block;color:#aeb8b3;line-height:1.45}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0 28px}.pill{padding:10px 14px;border:1px solid #3b4541;border-radius:999px;background:#101b18}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.incident{border:1px solid #34413d;border-radius:16px;padding:18px;background:#0e1916}.incident.p0{border-color:#8f3f3f}.incident.p1{border-color:#8b6937}.incident header{display:flex;justify-content:space-between;color:#bfa46a;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}.incident h2{margin:.65em 0 .1em;font-family:Georgia,serif}.component{color:#a9b3ae;font-size:.9rem}.incident small{display:block;color:#8e9994;margin-top:14px;line-height:1.5}section{margin-top:40px}h3{font-family:Georgia,serif;font-size:1.5rem}.empty{border:1px dashed #3b4541;border-radius:16px;padding:24px;color:#9da7a2}a{color:#d9c18d}@media(max-width:560px){.status-panel{align-items:flex-start;padding:18px}.status-light{width:46px;height:46px;flex-basis:46px}}
</style></head><body><main><p class="eyebrow">CuratorOS infrastructure</p><h1>Error Bus</h1><p class="lead">Persistent incident registry, recovery history, heartbeat monitoring, browser telemetry, and public-site infrastructure failsafe.</p><div class="status-panel ${state}" role="status" aria-label="System status: ${escapeHtml(label)}"><div class="status-light" aria-hidden="true"></div><div class="status-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div></div><div class="summary"><span class="pill">${active.length} active</span><span class="pill">${p0} P0</span><span class="pill">${p1} P1</span><span class="pill">${recovered.length} recovered</span></div><section><h3>Active incidents</h3><div class="grid">${active.length ? active.map(card).join('') : '<div class="empty">No active infrastructure incidents are recorded.</div>'}</div></section><section><h3>Recent recovered incidents</h3><div class="grid">${recovered.length ? recovered.slice(0,20).map(card).join('') : '<div class="empty">No recovered incidents are recorded yet.</div>'}</div></section></main></body></html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
