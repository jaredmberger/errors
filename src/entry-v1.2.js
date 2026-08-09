import base from './entry-v1.1.js';

const ACTIVE = new Set(['active', 'degraded']);
const GROUP_WINDOW_MS = 60 * 1000;
const SOURCE_URLS = {
  'Ocean Liner Curator': 'https://oceanliners.net/',
  'Curator Intelligence': 'https://tools.oceanliners.net/',
  'CuratorOS': 'https://curator.oceanliners.net/',
  'Site Health': 'https://site-health.oceanliners.net/',
  'Search Intelligence': 'https://search-intelligence.oceanliners.net/',
  'Link Map': 'https://link-map.oceanliners.net/',
  'Curator Integrity': 'https://integrity.oceanliners.net/',
  'Curator Speed': 'https://speed.oceanliners.net/',
  'Curator Indexer': 'https://curator-indexer.oceanliners.net/',
  'Page Studio': 'https://page-studio.oceanliners.net/',
  'CuratorOS Launcher': 'https://launch.oceanliners.net/',
  'CuratorOS Error Bus': 'https://errors.oceanliners.net/'
};

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
  const activeGroups = groupIncidents(active);
  const recoveredGroups = groupIncidents(recovered);
  const p0 = active.filter(item => item.severity === 'p0').length;
  const p1 = active.filter(item => item.severity === 'p1').length;
  const state = p0 ? 'critical' : active.length ? 'attention' : 'healthy';
  const label = p0 ? 'Critical incident active' : active.length ? 'System needs attention' : 'All systems normal';
  const detail = p0
    ? `${p0} critical incident${p0 === 1 ? '' : 's'} require immediate attention.`
    : active.length
      ? `${active.length} active incident${active.length === 1 ? '' : 's'} across ${activeGroups.length} dashboard group${activeGroups.length === 1 ? '' : 's'}.`
      : 'No active infrastructure incidents are recorded.';

  const groupCard = group => {
    const navigation = group.navigation;
    const where = navigation.location
      ? `<p class="where"><span>Where</span>${escapeHtml(navigation.location)}</p>`
      : '';
    const actions = navigation.actions.length
      ? `<div class="actions">${navigation.actions.map(action => `<a class="action" href="${escapeHtml(action.href)}" target="_blank" rel="noopener">${escapeHtml(action.label)} <span aria-hidden="true">↗</span></a>`).join('')}</div>`
      : '';
    const details = group.items.length > 1
      ? `<details class="group-details"><summary>Show ${group.items.length} related incident records</summary><div class="detail-list">${group.items.map(item => `<div class="detail-row"><strong>${escapeHtml(String(item.severity || '').toUpperCase())}</strong><span>${escapeHtml(item.component)} · ${escapeHtml(item.type)}</span><p>${escapeHtml(item.message)}</p><small>${escapeHtml(item.firstSeenAt || '')} → ${escapeHtml(item.lastSeenAt || '')} · ${Number(item.occurrences || 1)} occurrence${Number(item.occurrences || 1) === 1 ? '' : 's'}</small></div>`).join('')}</div></details>`
      : '';

    return `<article class="incident ${escapeHtml(group.severity)}"><header><strong>${escapeHtml(String(group.severity || '').toUpperCase())}</strong><span>${escapeHtml(group.status)}</span></header><h2>${escapeHtml(group.title)}</h2><p class="component">${escapeHtml(group.summary)}</p><p>${escapeHtml(group.message)}</p>${where}${actions}${details}<small>First ${escapeHtml(group.firstSeenAt || '')} · Last ${escapeHtml(group.lastSeenAt || '')} · ${group.eventCount} event${group.eventCount === 1 ? '' : 's'} across ${group.items.length} incident record${group.items.length === 1 ? '' : 's'}</small></article>`;
  };

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08110f"><title>CuratorOS Error Bus</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#08110f;color:#f4efe5;font-family:system-ui,-apple-system,sans-serif}main{width:min(1100px,calc(100% - 32px));margin:auto;padding:max(36px,env(safe-area-inset-top)) 0 max(70px,env(safe-area-inset-bottom))}.eyebrow{color:#bfa46a;text-transform:uppercase;letter-spacing:.13em;font-size:.75rem;font-weight:700}h1{font-family:Georgia,serif;font-size:clamp(2rem,6vw,4rem);margin:.2em 0}.lead{color:#c8c3b8;max-width:760px;line-height:1.6}.status-panel{display:flex;align-items:center;gap:20px;margin:28px 0 22px;padding:20px 22px;border:1px solid #34413d;border-radius:20px;background:#0e1916;box-shadow:0 18px 48px rgba(0,0,0,.22)}.status-light{width:58px;height:58px;flex:0 0 58px;border-radius:50%;position:relative}.status-light::after{content:"";position:absolute;inset:9px;border-radius:50%;background:rgba(255,255,255,.18);filter:blur(5px)}.healthy .status-light{background:#4fca78;box-shadow:0 0 0 7px rgba(79,202,120,.09),0 0 28px rgba(79,202,120,.55)}.attention .status-light{background:#e0aa48;box-shadow:0 0 0 7px rgba(224,170,72,.09),0 0 28px rgba(224,170,72,.52)}.critical .status-light{background:#e25757;box-shadow:0 0 0 7px rgba(226,87,87,.1),0 0 30px rgba(226,87,87,.58)}.status-copy strong{display:block;font-family:Georgia,serif;font-size:clamp(1.25rem,4vw,1.8rem);margin-bottom:4px}.status-copy span{display:block;color:#aeb8b3;line-height:1.45}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0 28px}.pill{padding:10px 14px;border:1px solid #3b4541;border-radius:999px;background:#101b18}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.incident{border:1px solid #34413d;border-radius:16px;padding:18px;background:#0e1916}.incident.p0{border-color:#8f3f3f}.incident.p1{border-color:#8b6937}.incident header{display:flex;justify-content:space-between;color:#bfa46a;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}.incident h2{margin:.65em 0 .1em;font-family:Georgia,serif}.component{color:#a9b3ae;font-size:.9rem}.where{margin:14px 0 0;padding:10px 12px;border-left:2px solid rgba(191,164,106,.5);background:rgba(191,164,106,.045);color:#b9c2bd;font-size:.84rem;line-height:1.45;overflow-wrap:anywhere}.where span{display:block;margin-bottom:3px;color:#bfa46a;text-transform:uppercase;letter-spacing:.08em;font-size:.68rem;font-weight:700}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:13px}.action{display:inline-flex;align-items:center;gap:5px;padding:8px 11px;border:1px solid rgba(191,164,106,.36);border-radius:9px;background:rgba(191,164,106,.055);color:#dbc58f;text-decoration:none;font-size:.82rem;font-weight:650}.action:hover,.action:focus-visible{border-color:rgba(191,164,106,.7);background:rgba(191,164,106,.1)}.group-details{margin-top:14px;border-top:1px solid #27332f;padding-top:12px}.group-details summary{cursor:pointer;color:#d7c08a;font-size:.82rem;font-weight:700}.detail-list{display:grid;gap:8px;margin-top:10px}.detail-row{padding:10px;border:1px solid #293630;border-radius:10px;background:#0a1412}.detail-row strong{color:#bfa46a;font-size:.72rem;margin-right:8px}.detail-row span{color:#aeb8b3;font-size:.78rem}.detail-row p{margin:7px 0 4px;font-size:.83rem}.detail-row small{margin:0;font-size:.72rem}.incident small{display:block;color:#8e9994;margin-top:14px;line-height:1.5}section{margin-top:40px}h3{font-family:Georgia,serif;font-size:1.5rem}.empty{border:1px dashed #3b4541;border-radius:16px;padding:24px;color:#9da7a2}a{color:#d9c18d}@media(max-width:560px){.status-panel{align-items:flex-start;padding:18px}.status-light{width:46px;height:46px;flex-basis:46px}.actions{flex-direction:column}.action{justify-content:center;width:100%;padding:10px 12px}}
</style></head><body><main><p class="eyebrow">CuratorOS infrastructure</p><h1>Error Bus</h1><p class="lead">Persistent incident registry, recovery history, heartbeat monitoring, browser telemetry, and public-site infrastructure failsafe.</p><div class="status-panel ${state}" role="status" aria-label="System status: ${escapeHtml(label)}"><div class="status-light" aria-hidden="true"></div><div class="status-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div></div><div class="summary"><span class="pill">${active.length} active raw</span><span class="pill">${activeGroups.length} active groups</span><span class="pill">${p0} P0</span><span class="pill">${p1} P1</span><span class="pill">${recovered.length} recovered raw</span></div><section><h3>Active incidents</h3><div class="grid">${activeGroups.length ? activeGroups.map(groupCard).join('') : '<div class="empty">No active infrastructure incidents are recorded.</div>'}</div></section><section><h3>Recent recovered incidents</h3><div class="grid">${recoveredGroups.length ? recoveredGroups.slice(0,20).map(groupCard).join('') : '<div class="empty">No recovered incidents are recorded yet.</div>'}</div></section></main></body></html>`;
}

function groupIncidents(incidents) {
  const sorted = [...incidents].sort((a, b) => Date.parse(a.firstSeenAt || a.lastSeenAt || 0) - Date.parse(b.firstSeenAt || b.lastSeenAt || 0));
  const groups = [];

  for (const incident of sorted) {
    const navigation = incidentNavigation(incident);
    const location = navigation.location || SOURCE_URLS[incident?.source] || incident?.source || 'unknown';
    const source = incident?.source || 'Unknown source';
    const status = incident?.status || 'active';
    const started = Date.parse(incident?.firstSeenAt || incident?.lastSeenAt || 0);
    const ended = Date.parse(incident?.lastSeenAt || incident?.firstSeenAt || 0);

    let group = groups.find(candidate => {
      if (candidate.source !== source || candidate.status !== status || candidate.location !== location) return false;
      const candidateEnd = Date.parse(candidate.lastSeenAt || 0);
      return Number.isFinite(started) && Number.isFinite(candidateEnd) && Math.abs(started - candidateEnd) <= GROUP_WINDOW_MS;
    });

    if (!group) {
      group = {
        source,
        status,
        location,
        navigation,
        items: [],
        firstSeenAt: incident.firstSeenAt || incident.lastSeenAt || '',
        lastSeenAt: incident.lastSeenAt || incident.firstSeenAt || '',
      };
      groups.push(group);
    }

    group.items.push(incident);
    if (Number.isFinite(started) && (!Date.parse(group.firstSeenAt || 0) || started < Date.parse(group.firstSeenAt || 0))) group.firstSeenAt = incident.firstSeenAt || incident.lastSeenAt || group.firstSeenAt;
    if (Number.isFinite(ended) && (!Date.parse(group.lastSeenAt || 0) || ended > Date.parse(group.lastSeenAt || 0))) group.lastSeenAt = incident.lastSeenAt || incident.firstSeenAt || group.lastSeenAt;
  }

  for (const group of groups) finalizeGroup(group);
  groups.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
  return groups;
}

function finalizeGroup(group) {
  group.severity = group.items.reduce((best, item) => severityRank(item.severity) > severityRank(best) ? item.severity : best, 'p2');
  group.eventCount = group.items.reduce((sum, item) => sum + Math.max(1, Number(item.occurrences || 1)), 0);
  const byType = new Map();
  for (const item of group.items) {
    const label = incidentTypeLabel(item);
    byType.set(label, (byType.get(label) || 0) + Math.max(1, Number(item.occurrences || 1)));
  }
  group.summary = [...byType.entries()].map(([label, count]) => `${count} ${label}`).join(' · ');
  group.title = group.items.length > 1 ? `${group.source} — related frontend events` : group.source;
  group.message = group.items.length > 1
    ? `${group.eventCount} related event${group.eventCount === 1 ? '' : 's'} were recorded at the same location within a short time window.`
    : (group.items[0]?.message || 'Incident recorded.');
}

function incidentTypeLabel(incident) {
  const type = String(incident?.type || '').toLowerCase();
  if (type.includes('fetch')) return 'network failure' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  if (type.includes('resource')) return 'resource failure' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  if (type.includes('javascript')) return 'JavaScript error' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  if (type.includes('rejection')) return 'promise rejection' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  if (type.includes('heartbeat')) return 'heartbeat alert' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  if (type.includes('infrastructure')) return 'infrastructure failure' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
  return 'incident' + (Number(incident?.occurrences || 1) === 1 ? '' : 's');
}

function severityRank(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'p0' || raw === 'critical') return 3;
  if (raw === 'p1' || raw === 'high') return 2;
  return 1;
}

function incidentNavigation(incident) {
  const context = incident && incident.context && typeof incident.context === 'object' ? incident.context : {};
  const sourceRoot = SOURCE_URLS[incident?.source] || '';
  const actions = [];
  const seen = new Set();

  const pageUrl = resolveIncidentUrl(context.page || context.pageUrl, sourceRoot);
  const resourceUrl = resolveIncidentUrl(context.resource || context.url, sourceRoot);
  const fileUrl = resolveIncidentUrl(context.file, sourceRoot);

  addAction(actions, seen, pageUrl, 'Open affected page');
  if (resourceUrl && resourceUrl !== pageUrl) addAction(actions, seen, resourceUrl, 'Open resource');
  if (fileUrl && fileUrl !== pageUrl && fileUrl !== resourceUrl) addAction(actions, seen, fileUrl, 'Open file');
  if (sourceRoot && !seen.has(sourceRoot)) addAction(actions, seen, sourceRoot, 'Open tool');

  const location = pageUrl || resourceUrl || fileUrl || sourceRoot || '';
  return { location, actions: actions.slice(0, 3) };
}

function addAction(actions, seen, href, label) {
  if (!href || seen.has(href)) return;
  seen.add(href);
  actions.push({ href, label });
}

function resolveIncidentUrl(value, sourceRoot) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const base = sourceRoot || 'https://oceanliners.net/';
    const url = new URL(raw, base);
    if (url.protocol !== 'https:') return '';
    if (!/(^|\.)oceanliners\.net$/i.test(url.hostname)) return '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
