import base from './entry-v1.10.js';

const INCIDENT_PREFIX = 'incident:';
const EVENT_PREFIX = 'event:';
const ACTIVE = new Set(['active','degraded']);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/clear-recheck') {
      try {
        const result = await clearAndRecheckBrowserAware(request, env, ctx);
        return json(result, 200);
      } catch (error) {
        return json({ ok:false, error:error?.message || String(error) }, 500);
      }
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

async function clearAndRecheckBrowserAware(request, env, ctx) {
  requireKv(env);
  const startedAt = new Date().toISOString();
  const original = await activeIncidents(env);
  const browser = original.filter(isBrowserIncident);
  const system = original.filter(item => !isBrowserIncident(item));

  // Browser-originated incidents are archived first. A synthetic Worker request
  // may corroborate browser health, but it is not allowed to resurrect a
  // browser incident by itself because the two environments are not equivalent.
  for (const incident of browser) {
    await archiveBrowserIncident(env, incident, startedAt);
  }

  // Run the existing Clear & Recheck implementation for authoritative
  // server-side incidents (heartbeats, infrastructure probes, etc.). Because the
  // browser incidents are no longer active, v1.10 will not restore them from a
  // synthetic fetch.
  const response = await base.fetch(new Request('https://errors.oceanliners.net/api/clear-recheck', {
    method:'POST',
    headers:{ accept:'application/json' }
  }), env, ctx);
  const baseResult = await response.json().catch(() => ({ ok:response.ok }));

  // Perform browser-resource checks only as diagnostics. Success is useful
  // evidence that the condition is gone; failure is explicitly inconclusive and
  // cannot re-promote the browser incident. Real recurrence must come from the
  // browser reporter itself.
  const browserDiagnostics = [];
  for (const incident of browser) {
    const resource = publicResource(incident?.context?.resource || incident?.context?.page);
    if (!resource) {
      browserDiagnostics.push({
        incidentId:incident.id,
        type:incident.type,
        result:'browser-recurrence-required',
        note:'No independently testable public resource was attached; the browser must report recurrence.'
      });
      continue;
    }
    const verification = await verifyTwice(resource);
    browserDiagnostics.push({
      incidentId:incident.id,
      type:incident.type,
      resource,
      result:verification.ok ? 'server-check-healthy' : 'server-check-inconclusive',
      verification,
      note:verification.ok
        ? 'Synthetic verification succeeded; browser incident remains cleared.'
        : 'Synthetic verification failed, but this alone is not proof that the browser problem persists. Browser recurrence is required.'
    });
  }

  const after = await activeIncidents(env);
  const checkedAt = new Date().toISOString();
  await writeEvent(env, {
    kind:'manual-clear-recheck-browser-aware',
    at:checkedAt,
    originalActiveCount:original.length,
    browserArchivedCount:browser.length,
    serverIncidentCount:system.length,
    confirmedActiveCount:after.length,
    message:`Browser-aware Clear & Recheck evaluated ${original.length} active incident${original.length===1?'':'s'}; ${after.length} remain confirmed active. Browser incidents require browser recurrence before re-promotion.`
  });

  return {
    ...baseResult,
    ok:true,
    checkedAt,
    clearedCount:original.length,
    browserArchivedCount:browser.length,
    serverIncidentCount:system.length,
    confirmedActiveCount:after.length,
    quiet:after.length===0,
    browserDiagnostics,
    activeIncidents:after.map(x=>({
      id:x.id, source:x.source, component:x.component, type:x.type,
      severity:x.severity, message:x.message, lastSeenAt:x.lastSeenAt
    })),
    note:'Browser-originated incidents are never resurrected by a Worker-side synthetic failure alone. They must recur in an actual browser session.'
  };
}

function isBrowserIncident(incident) {
  return String(incident?.type || '').startsWith('client-') || Boolean(incident?.context?.clientReported);
}

async function archiveBrowserIncident(env, incident, at) {
  const key = INCIDENT_PREFIX + incident.fingerprint;
  const current = await env.CURATOR_ERROR_RECORDS.get(key, 'json');
  if (!current || !ACTIVE.has(current.status)) return;
  await env.CURATOR_ERROR_RECORDS.put(key, JSON.stringify({
    ...current,
    status:'recovered',
    recoveredAt:at,
    lastSuccessfulAt:current.lastSuccessfulAt || at,
    recoveryMessage:'Cleared by browser-aware Clear & Recheck. Synthetic Worker verification cannot re-promote this browser-originated incident; it must recur in an actual browser session.'
  }), { expirationTtl:60*60*24*180 });
}

async function verifyTwice(resource) {
  const attempts=[];
  for (let n=1;n<=2;n++) {
    if (n>1) await new Promise(resolve=>setTimeout(resolve,850));
    const attempt=await verifyResource(resource,n);
    attempts.push(attempt);
    if (attempt.ok) return { ok:true, attempts };
  }
  return { ok:false, attempts };
}

async function verifyResource(resource, attempt) {
  const started=Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const target=new URL(resource);
    target.searchParams.set('clearRecheckDiagnostic',`${Date.now()}-${attempt}`);
    const response=await fetch(target.href,{
      method:'GET',redirect:'follow',cache:'no-store',
      headers:{accept:'*/*','user-agent':'CuratorOS-Error-Bus-Browser-Diagnostic/1.0'},
      signal:controller.signal,
      cf:{cacheTtl:0,cacheEverything:false}
    });
    const text=await response.text();
    const bytes=new TextEncoder().encode(text).byteLength;
    const badBody=/<title>\s*(?:404|500|error|not found)|cloudflare.*error/i.test(text.slice(0,1500));
    return {attempt,ok:response.ok&&bytes>0&&!badBody,status:response.status,bytes,durationMs:Date.now()-started};
  } catch(error) {
    return {attempt,ok:false,status:null,bytes:0,durationMs:Date.now()-started,error:error?.message||String(error)};
  } finally { clearTimeout(timer); }
}

async function activeIncidents(env) {
  const listed=await env.CURATOR_ERROR_RECORDS.list({prefix:INCIDENT_PREFIX,limit:1000});
  const rows=[];
  for (const item of listed.keys) {
    const value=await env.CURATOR_ERROR_RECORDS.get(item.name,'json');
    if (value&&ACTIVE.has(value.status)) rows.push(value);
  }
  return rows;
}

function publicResource(value) {
  try {
    const url=new URL(String(value||''),'https://oceanliners.net/');
    if(url.protocol!=='https:'||!/(^|\.)oceanliners\.net$/i.test(url.hostname))return'';
    url.username='';url.password='';url.hash='';
    return url.href;
  } catch { return ''; }
}

async function writeEvent(env,event) {
  const at=event.at||new Date().toISOString();
  await env.CURATOR_ERROR_RECORDS.put(`${EVENT_PREFIX}${at}:${Math.random().toString(36).slice(2,8)}`,JSON.stringify(event),{expirationTtl:60*60*24*180});
}

function requireKv(env){if(!env.CURATOR_ERROR_RECORDS)throw new Error('CURATOR_ERROR_RECORDS KV binding is not configured.');}
function json(value,status=200){return new Response(JSON.stringify(value,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
