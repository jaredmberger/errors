import base from './entry-v1.9.js';

const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const ACTIVE = new Set(['active','degraded']);
const RETRYABLE_CLIENT_TYPES = new Set([
  'client-resource-error',
  'client-fetch-network-error',
  'client-fetch-http-error'
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/clear-recheck') {
      try {
        const result = await clearAndRecheck(env, ctx);
        return json(result, 200);
      } catch (error) {
        return json({ ok:false, error:error?.message || String(error) }, 500);
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const response = await base.fetch(request, env, ctx);
      const markup = await response.text();
      return new Response(injectClearRecheck(markup), {
        status: response.status,
        headers: {
          'content-type':'text/html; charset=utf-8',
          'cache-control':'no-store'
        }
      });
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

async function clearAndRecheck(env, ctx) {
  requireKv(env);
  const startedAt = new Date().toISOString();
  const before = await activeIncidents(env);

  // Archive the current active presentation state first. This is not deletion:
  // every incident remains preserved with an explicit manual-recheck recovery.
  for (const incident of before) {
    await archiveForRecheck(env, incident, startedAt);
  }

  // Re-run the Error Bus' authoritative immediate checks. This re-evaluates
  // heartbeats and public-site infrastructure from scratch and recreates any
  // failures that are still genuinely present.
  let systemCheck = null;
  try {
    const response = await base.fetch(new Request('https://errors.oceanliners.net/api/check-now', {
      method:'POST',
      headers:{ accept:'application/json' }
    }), env, ctx);
    systemCheck = await response.json().catch(() => ({ ok:response.ok, status:response.status }));
  } catch (error) {
    systemCheck = { ok:false, error:error?.message || String(error) };
  }

  // Browser fetch/resource failures get a fresh independent server-side check.
  // If they still fail twice, restore them as confirmed active incidents.
  const browserRechecks = [];
  for (const incident of before) {
    if (!RETRYABLE_CLIENT_TYPES.has(String(incident.type || ''))) continue;
    const resource = publicResource(incident?.context?.resource || incident?.context?.page);
    if (!resource) continue;
    const verification = await verifyTwice(resource);
    browserRechecks.push({ incidentId:incident.id, resource, ...verification });
    if (!verification.ok) await restoreConfirmedIncident(env, incident, verification);
  }

  const after = await activeIncidents(env);
  const checkedAt = new Date().toISOString();
  await writeEvent(env, {
    kind:'manual-clear-recheck',
    at:checkedAt,
    clearedCount:before.length,
    remainingCount:after.length,
    message:`Manual Clear & Recheck archived ${before.length} active incident${before.length===1?'':'s'} and fresh verification left ${after.length} confirmed active.`
  });

  return {
    ok:true,
    checkedAt,
    clearedCount:before.length,
    confirmedActiveCount:after.length,
    quiet:after.length===0,
    systemCheck,
    browserRechecks,
    activeIncidents:after.map(x=>({
      id:x.id, source:x.source, component:x.component, type:x.type,
      severity:x.severity, message:x.message, lastSeenAt:x.lastSeenAt
    })),
    note:'Runtime-only browser errors are archived and must recur to become active again; they are not silently assumed to persist.'
  };
}

async function archiveForRecheck(env, incident, at) {
  const key = INCIDENT_PREFIX + incident.fingerprint;
  const current = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  if (!current || !ACTIVE.has(current.status)) return;
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify({
    ...current,
    status:'recovered',
    recoveredAt:at,
    lastSuccessfulAt:current.lastSuccessfulAt || at,
    recoveryMessage:'Cleared from active status for a manual Clear & Recheck. The incident remains in history and will immediately return if fresh verification still fails or the browser error recurs.'
  }), { expirationTtl:60*60*24*180 });
}

async function restoreConfirmedIncident(env, incident, verification) {
  const now = new Date().toISOString();
  const key = INCIDENT_PREFIX + incident.fingerprint;
  const restored = {
    ...incident,
    status:'active',
    recoveredAt:null,
    lastSeenAt:now,
    occurrences:Math.max(1, Number(incident.occurrences || 1) + 1),
    recoveryMessage:null,
    context:{
      ...(incident.context || {}),
      manualRecheckConfirmed:true,
      manualRecheckAt:now,
      manualRecheckAttempts:verification.attempts
    }
  };
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(restored));
  await writeEvent(env, {
    kind:'manual-recheck-confirmed-incident', at:now,
    incidentId:restored.id, fingerprint:restored.fingerprint,
    source:restored.source, component:restored.component,
    severity:restored.severity, status:'active', message:restored.message
  });
}

async function verifyTwice(resource) {
  const attempts = [];
  for (let n=1; n<=2; n++) {
    if (n>1) await new Promise(resolve=>setTimeout(resolve,850));
    const attempt = await verifyResource(resource, n);
    attempts.push(attempt);
    if (attempt.ok) return { ok:true, recovered:true, attempts };
  }
  return { ok:false, recovered:false, attempts };
}

async function verifyResource(resource, attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),10000);
  try {
    const target = new URL(resource);
    target.searchParams.set('clearRecheck', `${Date.now()}-${attempt}`);
    const response = await fetch(target.href, {
      method:'GET', redirect:'follow', cache:'no-store',
      headers:{ accept:'*/*', 'user-agent':'CuratorOS-Error-Bus-Clear-Recheck/1.0' },
      signal:controller.signal,
      cf:{ cacheTtl:0, cacheEverything:false }
    });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const badBody = /<title>\s*(?:404|500|error|not found)|cloudflare.*error/i.test(text.slice(0,1500));
    return { attempt, ok:response.ok && bytes>0 && !badBody, status:response.status, bytes, durationMs:Date.now()-started };
  } catch (error) {
    return { attempt, ok:false, status:null, bytes:0, durationMs:Date.now()-started, error:error?.message || String(error) };
  } finally { clearTimeout(timer); }
}

async function activeIncidents(env) {
  requireKv(env);
  const listed = await env.CURATOR_ERROR_RECORDS.list({ prefix:INCIDENT_PREFIX, limit:1000 });
  const rows=[];
  for (const item of listed.keys) {
    const value=await env.CURATOR_ERROR_RECORDS.get(item.name,'json');
    if (value && ACTIVE.has(value.status)) rows.push(value);
  }
  return rows;
}

function publicResource(value) {
  try {
    const url = new URL(String(value || ''), 'https://oceanliners.net/');
    if (url.protocol !== 'https:' || !/(^|\.)oceanliners\.net$/i.test(url.hostname)) return '';
    url.username=''; url.password=''; url.hash='';
    return url.href;
  } catch { return ''; }
}

async function writeEvent(env, event) {
  const at = event.at || new Date().toISOString();
  const key = `${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2,8)}`;
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify(event), { expirationTtl:60*60*24*180 });
}

function injectClearRecheck(markup) {
  const css = `<style>
.clear-recheck-wrap{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 24px}.clear-recheck{appearance:none;border:1px solid rgba(191,164,106,.58);border-radius:12px;background:rgba(191,164,106,.07);color:#ead9aa;padding:12px 18px;font:700 .9rem/1 system-ui,-apple-system,sans-serif;cursor:pointer}.clear-recheck:hover,.clear-recheck:focus-visible{border-color:#bfa46a;background:rgba(191,164,106,.13)}.clear-recheck:disabled{opacity:.6;cursor:wait}.clear-recheck-state{font-size:.84rem;color:#9fa9a4;line-height:1.45}.clear-recheck-state.good{color:#82d99e}.clear-recheck-state.warn{color:#e1b767}@media(max-width:560px){.clear-recheck-wrap{align-items:stretch;flex-direction:column}.clear-recheck{width:100%;padding:14px 16px}.clear-recheck-state{text-align:center}}
</style>`;
  const ui = `<div class="clear-recheck-wrap"><button class="clear-recheck" id="error-bus-clear-recheck" type="button">Clear &amp; Recheck</button><span class="clear-recheck-state" id="error-bus-clear-recheck-state" role="status">Archives the current active status, immediately verifies it again, and restores anything still failing.</span></div>`;
  const script = `<script>(function(){const b=document.getElementById('error-bus-clear-recheck'),s=document.getElementById('error-bus-clear-recheck-state');if(!b||!s)return;b.addEventListener('click',async()=>{b.disabled=true;b.textContent='Clearing & checking…';s.className='clear-recheck-state';s.textContent='Archiving current status and running fresh verification…';try{const r=await fetch('/api/clear-recheck',{method:'POST',cache:'no-store',headers:{accept:'application/json'}}),d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||('HTTP '+r.status));s.className='clear-recheck-state '+(d.quiet?'good':'warn');s.textContent=d.quiet?'Fresh verification complete — all’s quiet. Refreshing…':'Fresh verification complete — '+d.confirmedActiveCount+' problem'+(d.confirmedActiveCount===1?'':'s')+' still confirmed. Refreshing…';b.textContent='Checked';setTimeout(()=>location.reload(),900);}catch(e){s.className='clear-recheck-state warn';s.textContent='Clear & Recheck could not complete: '+(e&&e.message?e.message:String(e));b.disabled=false;b.textContent='Clear & Recheck';}});})();</script>`;
  let out=markup.replace('</head>',`${css}</head>`);
  const marker='<div class="summary">';
  out=out.includes(marker)?out.replace(marker,`${ui}${marker}`):out.replace('</main>',`${ui}</main>`);
  return out.replace('</body>',`${script}</body>`);
}

function requireKv(env) { if (!env.CURATOR_ERROR_RECORDS) throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.'); }
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
