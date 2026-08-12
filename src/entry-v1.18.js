import base from './entry-v1.13.js';

const KV = 'CURATOR_ERROR_RECORDS';
const INCIDENT_PREFIX = 'incident:';
const ACTIVE = new Set(['active', 'degraded']);
const AVAILABILITY_KEY = 'availability:public-site-v3';
const OFFLINE_INCIDENT_KEY = 'incident:public-site-offline';
const PUBLIC_URL = 'https://oceanliners.net/';
const WATCHDOG_HOST = 'errors.oceanlinercurator.com';
const PUBLIC_HEALTH_PREFIX = 'client-health:ocean-liner-curator:';
const FAILURE_OBSERVATIONS = 3;
const RECOVERY_OBSERVATIONS = 2;
const MIN_GAP_MS = 45 * 1000;
const VISITOR_EVIDENCE_WINDOW_MS = 5 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/out-of-band-probe') {
      if (url.hostname !== WATCHDOG_HOST) return json({ ok:false, error:'Watchdog host required.' }, 403);
      if (!env.ERROR_REPORT_KEY || request.headers.get('x-curator-error-key') !== env.ERROR_REPORT_KEY) {
        return json({ ok:false, error:'Unauthorized.' }, 401);
      }
      const result = await observeOutOfBand(env, 'cross-zone-watchdog');
      return json({ ok:true, ...result });
    }

    if (request.method === 'GET' && url.pathname === '/api/status') {
      await retireLegacyFalseOffline(env);
      const incidents = await activeIncidents(env);
      const availability = await readAvailability(env);
      const counts = countSeverities(incidents);
      const ordinary = counts.p0 ? 'critical' : counts.p1 ? 'degraded' : incidents.length ? 'attention' : 'healthy';
      return json({
        ok:true,
        generatedAt:new Date().toISOString(),
        status:availability.status === 'offline' ? 'offline' : ordinary,
        activeIncidentCount:incidents.length,
        counts,
        publicSiteAvailability:availability
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/curator-intelligence') {
      await retireLegacyFalseOffline(env);
      const incidents = await activeIncidents(env);
      const payload = buildQuietIntelligencePayload(incidents);
      const callback = safeCallback(url.searchParams.get('callback'));
      return callback ? javascript(payload, callback) : json(payload);
    }

    if (request.method === 'POST' && url.pathname === '/api/client-health') {
      const origin = request.headers.get('origin') || '';
      const response = await base.fetch(request, env, ctx);
      if (response.ok && /^https:\/\/(?:www\.)?oceanliners\.net$/i.test(origin)) {
        ctx.waitUntil(markReachableFromVisitor(env).catch(()=>{}));
      }
      return response;
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (controller?.cron === '* * * * *') {
      ctx.waitUntil(triggerCrossZoneWatchdog(env));
      return;
    }
    return base.scheduled(controller, env, ctx);
  }
};

async function triggerCrossZoneWatchdog(env) {
  await retireLegacyFalseOffline(env);
  if (!env.ERROR_REPORT_KEY) return;
  try {
    await fetch(`https://${WATCHDOG_HOST}/api/out-of-band-probe`, {
      method:'POST',
      headers:{ 'x-curator-error-key':env.ERROR_REPORT_KEY, accept:'application/json' },
      cache:'no-store',
      cf:{ cacheTtl:0, cacheEverything:false }
    });
  } catch (error) {
    console.error('Cross-zone watchdog invocation failed', error);
  }
}

async function observeOutOfBand(env, source) {
  requireKv(env);
  const recent = await recentPublicVisitorHealth(env);
  if (recent && Date.now() - Date.parse(recent.lastHealthyAt) <= VISITOR_EVIDENCE_WINDOW_MS) {
    await markReachableFromVisitor(env, recent);
    return { availability:await readAvailability(env), vetoedByVisitorEvidence:true };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const previous = await env[KV].get(AVAILABILITY_KEY, 'json') || defaultAvailability();
  const lastMs = Date.parse(previous.lastObservedAt || 0);
  if (Number.isFinite(lastMs) && nowMs - lastMs < MIN_GAP_MS) {
    return { availability:publicAvailabilityView(previous), rateLimited:true };
  }

  const probes = [];
  const first = await probePublicSite(1); probes.push(first);
  let observationOk = first.ok;
  if (!first.ok) {
    await sleep(1800);
    const second = await probePublicSite(2); probes.push(second);
    observationOk = second.ok;
  }

  let next = { ...previous, lastObservedAt:now, lastObservationSource:source, lastProbes:probes };
  if (observationOk) {
    const successes = Number(previous.consecutiveSuccessfulObservations || 0) + 1;
    next = { ...next, consecutiveSuccessfulObservations:successes, consecutiveFailedObservations:0, lastSuccessfulAt:now, suspectSince:null };
    if (previous.status === 'offline' && successes < RECOVERY_OBSERVATIONS) {
      next.status = 'offline';
    } else {
      next.status = 'online'; next.offlineSince = null;
      await recoverOfflineIncident(env, now, 'Cross-zone watchdog confirmed public reachability.');
    }
  } else {
    const failures = Number(previous.consecutiveFailedObservations || 0) + 1;
    next = { ...next, consecutiveFailedObservations:failures, consecutiveSuccessfulObservations:0, lastFailureAt:now, suspectSince:previous.suspectSince || now };
    if (previous.status === 'offline' || failures >= FAILURE_OBSERVATIONS) {
      next.status = 'offline'; next.offlineSince = previous.offlineSince || now;
      await upsertOfflineIncident(env, now, probes, failures, next.offlineSince);
    } else {
      next.status = 'suspect';
    }
  }

  await env[KV].put(AVAILABILITY_KEY, JSON.stringify(next));
  return { availability:publicAvailabilityView(next), probes };
}

async function probePublicSite(attempt) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),10000);
  try {
    const target = new URL(PUBLIC_URL);
    target.searchParams.set('externalWatchdog', `${Date.now()}-${attempt}`);
    const response = await fetch(target.href, {
      method:'GET', redirect:'follow', cache:'no-store',
      headers:{ accept:'text/html,*/*;q=0.8', 'user-agent':'CuratorOS-Cross-Zone-Watchdog/1.0' },
      signal:controller.signal,
      cf:{ cacheTtl:0, cacheEverything:false }
    });
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    const signature = /Ocean Liner Curator/i.test(text);
    const obviousError = /<title>\s*(?:404|500|502|503|504|error|not found)|cloudflare.*error/i.test(text.slice(0,2000));
    return { attempt, ok:response.ok && bytes>=1500 && signature && !obviousError, status:response.status, bytes, signature, durationMs:Date.now()-started };
  } catch (error) {
    return { attempt, ok:false, status:null, bytes:0, signature:false, durationMs:Date.now()-started, error:error?.name==='AbortError'?'timeout':(error?.message||String(error)) };
  } finally { clearTimeout(timer); }
}

async function retireLegacyFalseOffline(env) {
  requireKv(env);
  const state = await env[KV].get(AVAILABILITY_KEY, 'json');
  if (state?.status === 'offline') return;
  const incident = await env[KV].get(OFFLINE_INCIDENT_KEY, 'json');
  if (!incident || !ACTIVE.has(incident.status)) return;
  const now = new Date().toISOString();
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify({
    ...incident,
    status:'recovered',
    recoveredAt:now,
    lastSuccessfulAt:now,
    recoveryMessage:'Retired during v1.18 migration because the prior same-zone availability detector was not authoritative. Future offline incidents require the cross-zone watchdog.'
  }), { expirationTtl:60*60*24*180 });
}

async function recentPublicVisitorHealth(env) {
  const listed = await env[KV].list({ prefix:PUBLIC_HEALTH_PREFIX, limit:1000 });
  let newest=null, newestMs=-Infinity;
  for (const item of listed.keys) {
    const value=await env[KV].get(item.name,'json');
    const at=Date.parse(value?.lastHealthyAt || 0);
    if (Number.isFinite(at) && at>newestMs) { newestMs=at; newest=value; }
  }
  return newest;
}

async function markReachableFromVisitor(env, evidence=null) {
  requireKv(env);
  const recent=evidence || await recentPublicVisitorHealth(env);
  if (!recent) return false;
  const healthyMs=Date.parse(recent.lastHealthyAt || 0);
  if (!Number.isFinite(healthyMs) || Date.now()-healthyMs>VISITOR_EVIDENCE_WINDOW_MS) return false;
  const previous=await env[KV].get(AVAILABILITY_KEY,'json') || defaultAvailability();
  await env[KV].put(AVAILABILITY_KEY, JSON.stringify({
    ...previous, status:'online', consecutiveFailedObservations:0,
    consecutiveSuccessfulObservations:Math.max(1,Number(previous.consecutiveSuccessfulObservations||0)+1),
    lastSuccessfulAt:recent.lastHealthyAt, suspectSince:null, offlineSince:null,
    visitorEvidence:{ page:recent.page||'/', lastHealthyAt:recent.lastHealthyAt, acceptedAt:new Date().toISOString() }
  }));
  await recoverOfflineIncident(env, new Date().toISOString(), 'A clean public-site browser health observation proved visitor reachability.');
  return true;
}

async function upsertOfflineIncident(env, now, probes, failures, offlineSince) {
  const previous=await env[KV].get(OFFLINE_INCIDENT_KEY,'json');
  const incident={
    id:previous?.id || 'incident_public-site-offline', fingerprint:'public-site-offline', source:'Ocean Liner Curator',
    component:'public-site-availability', severity:'p0', type:'public-site-offline',
    message:'OceanLiners.net is confirmed unavailable to public visitors by the cross-zone watchdog after repeated time-separated observations.',
    context:{ url:PUBLIC_URL, watchdogHost:WATCHDOG_HOST, confirmationObservations:failures, probes:JSON.stringify(probes).slice(0,4000) },
    firstSeenAt:previous?.firstSeenAt || offlineSince || now, lastSeenAt:now,
    occurrences:Math.max(1,Number(previous?.occurrences||0)+1), status:'active', recoveredAt:null, recoveryMessage:null,
    lastSuccessfulAt:previous?.lastSuccessfulAt || null
  };
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify(incident));
}

async function recoverOfflineIncident(env, now, message) {
  const incident=await env[KV].get(OFFLINE_INCIDENT_KEY,'json');
  if (!incident || !ACTIVE.has(incident.status)) return;
  await env[KV].put(OFFLINE_INCIDENT_KEY, JSON.stringify({ ...incident, status:'recovered', recoveredAt:now, lastSuccessfulAt:now, recoveryMessage:message }), { expirationTtl:60*60*24*180 });
}

async function activeIncidents(env) {
  requireKv(env);
  const listed=await env[KV].list({ prefix:INCIDENT_PREFIX, limit:1000 });
  const rows=[];
  for (const item of listed.keys) { const value=await env[KV].get(item.name,'json'); if (value && ACTIVE.has(value.status)) rows.push(value); }
  rows.sort((a,b)=>severityRank(b.severity)-severityRank(a.severity)||String(b.lastSeenAt||'').localeCompare(String(a.lastSeenAt||'')));
  return rows;
}

function countSeverities(rows){const c={p0:0,p1:0,p2:0,other:0};for(const x of rows){if(x.severity==='p0')c.p0++;else if(x.severity==='p1')c.p1++;else if(x.severity==='p2')c.p2++;else c.other++;}return c;}
function defaultAvailability(){return{status:'unknown',consecutiveFailedObservations:0,consecutiveSuccessfulObservations:0,lastObservedAt:null,lastSuccessfulAt:null,lastFailureAt:null,suspectSince:null,offlineSince:null,lastProbes:[]};}
async function readAvailability(env){return publicAvailabilityView(await env[KV].get(AVAILABILITY_KEY,'json')||defaultAvailability());}
function publicAvailabilityView(s){return{status:s.status||'unknown',url:PUBLIC_URL,watchdogHost:WATCHDOG_HOST,lastObservedAt:s.lastObservedAt||null,lastSuccessfulAt:s.lastSuccessfulAt||null,lastFailureAt:s.lastFailureAt||null,suspectSince:s.suspectSince||null,offlineSince:s.offlineSince||null,consecutiveFailedObservations:Number(s.consecutiveFailedObservations||0),consecutiveSuccessfulObservations:Number(s.consecutiveSuccessfulObservations||0),requiredFailedObservations:FAILURE_OBSERVATIONS,requiredRecoveryObservations:RECOVERY_OBSERVATIONS,minimumObservationGapSeconds:Math.round(MIN_GAP_MS/1000),visitorEvidence:s.visitorEvidence||null};}

function buildQuietIntelligencePayload(incidents) {
  const p0=incidents.filter(x=>x.severity==='p0').length,p1=incidents.filter(x=>x.severity==='p1').length,p2=incidents.filter(x=>x.severity==='p2').length;
  const offline=incidents.filter(x=>x.type==='public-site-offline');
  const confirmed=incidents.filter(x=>x.type!=='public-site-offline' && (x?.context?.manualRecheckConfirmed===true || (String(x.type||'').startsWith('client-') && x.recoveredAt) || (!String(x.type||'').startsWith('client-') && x.severity==='p0')));
  const priority=[...new Map([...offline,...confirmed].map(x=>[x.fingerprint||x.id,x])).values()];
  const triageOnly=incidents.filter(x=>!priority.includes(x));
  const isOffline=offline.length>0, hasConfirmed=priority.length>0, hasTriage=incidents.length>0;
  let systemStatus='good',statusLabel='Connected',value='No active incidents',summary='The CuratorOS Error Bus is online and no active infrastructure incidents are recorded.';
  if(isOffline){systemStatus='critical';statusLabel='SITE OFFLINE';value='Public site unavailable';summary='OceanLiners.net is confirmed unavailable to public visitors. Immediate attention is required.';}
  else if(hasConfirmed){systemStatus=priority.some(x=>x.severity==='p0')?'critical':'warning';statusLabel='Confirmed incident';value=`${priority.length} confirmed incident${priority.length===1?'':'s'}`;summary='Confirmed or recurring incidents warrant prioritized attention.';}
  else if(hasTriage){systemStatus='warning';statusLabel='Review Error Bus';value=`${incidents.length} incident${incidents.length===1?'':'s'} awaiting triage`;summary='The Error Bus has active observations; use Clear & Recheck before prioritization.';}
  return {ok:true,schemaVersion:3,generatedAt:new Date().toISOString(),system:{id:'error-bus',name:'CuratorOS Error Bus',status:systemStatus,statusLabel,value,summary,detail:`P0 ${p0} · P1 ${p1} · P2 ${p2}${triageOnly.length?` · ${triageOnly.length} awaiting triage`:''}`,url:'https://errors.oceanliners.net/'},metrics:{activeIncidentCount:incidents.length,p0Count:p0,p1Count:p1,p2Count:p2,awaitingTriageCount:triageOnly.length,confirmedPriorityCount:priority.length,publicSiteOffline:isOffline,triageAwarePrioritization:true,crossZoneWatchdog:true},priorities:priority.slice(0,20).map((x,i)=>({title:x.type==='public-site-offline'?'OceanLiners.net is offline':`${x.source}: ${x.component} failure`,summary:x.message,entity:x.source,severity:x.type==='public-site-offline'||x.severity==='p0'?'critical':x.severity==='p1'?'high':'medium',score:x.type==='public-site-offline'?150:Math.max(80,120-i),sources:['CuratorOS Error Bus'],systemIncident:true,confirmedPersistent:true,incidentId:x.id,incidentType:x.type,component:x.component,firstSeenAt:x.firstSeenAt,lastSeenAt:x.lastSeenAt,occurrences:x.occurrences})),opportunities:[],activity:priority.slice(0,8).map(x=>({title:x.type==='public-site-offline'?'Public site confirmed offline':`${String(x.severity||'p2').toUpperCase()} incident confirmed — ${x.source}`,summary:`${x.component}: ${x.message}`,meta:`CuratorOS Error Bus · ${x.lastSeenAt}`})),capabilities:{persistentIncidentRegistry:true,deduplication:true,recoveryTracking:true,heartbeatStalenessDetection:true,directKvReporting:true,triageAwarePrioritization:true,crossZoneWatchdog:true}};
}

function safeCallback(v){const s=String(v||'');return /^[A-Za-z_$][0-9A-Za-z_$\.]{0,120}$/.test(s)?s:'';}
function javascript(v,cb){return new Response(`${cb}(${JSON.stringify(v)});`,{status:200,headers:{'content-type':'application/javascript; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function json(v,status=200){return new Response(JSON.stringify(v,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'}});}
function severityRank(v){return v==='p0'?3:v==='p1'?2:1;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function requireKv(env){if(!env[KV])throw new Error(`${KV} KV binding is not configured.`);}
