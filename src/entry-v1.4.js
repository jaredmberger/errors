import base from './entry-v1.3.js';

const BUS = 'https://errors.oceanliners.net/';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/client-reporter.js') {
      return reporterScript();
    }

    if (request.method === 'POST' && url.pathname === '/api/client-error') {
      const clone = request.clone();
      try {
        const body = await clone.json();
        if (body?.kind === 'fetch-http-error' && Number(body?.status || 0) === 0) {
          return new Response(JSON.stringify({ ok: true, ignored: true, reason: 'opaque-http-0' }), {
            status: 202,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
          });
        }
      } catch {}
    }

    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    return base.scheduled(controller, env, ctx);
  }
};

function reporterScript() {
  const script = `(()=>{
if(window.__CURATOR_CLIENT_ERROR_CAPTURE__)return;
window.__CURATOR_CLIENT_ERROR_CAPTURE__=true;
const BUS='${BUS}';
const ERROR_ENDPOINT=BUS+'api/client-error';
const HEALTH_ENDPOINT=BUS+'api/client-health';
const seen=new Map();
const COOLDOWN=60000;
let pageHadRealError=false;
function clean(v,n=1200){return String(v??'').slice(0,n)}
function post(url,payload){try{return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),keepalive:true,cache:'no-store',credentials:'omit'}).catch(()=>{});}catch{}}
function send(payload){try{const key=[payload.kind,payload.message,payload.filename,payload.resource].join('|');const now=Date.now();if(now-(seen.get(key)||0)<COOLDOWN)return;seen.set(key,now);pageHadRealError=true;post(ERROR_ENDPOINT,{...payload,pageUrl:location.href});}catch{}}
function healthy(){if(pageHadRealError)return;post(HEALTH_ENDPOINT,{pageUrl:location.href});}
window.addEventListener('error',e=>{if(e.target&&e.target!==window){const tag=e.target.tagName||'resource';const src=e.target.src||e.target.href||'';send({kind:'resource-error',component:'frontend-resource',message:tag+' failed to load',resource:clean(src)});return;}send({kind:'javascript-error',component:'frontend-runtime',message:clean(e.message||'JavaScript error'),filename:clean(e.filename),line:e.lineno||null,column:e.colno||null,stack:clean(e.error&&e.error.stack,4000)});},true);
window.addEventListener('unhandledrejection',e=>{const r=e.reason;send({kind:'unhandled-rejection',component:'frontend-runtime',message:clean(r&&r.message?r.message:r||'Unhandled promise rejection'),stack:clean(r&&r.stack,4000)});});
const nativeFetch=window.fetch&&window.fetch.bind(window);
if(nativeFetch){window.fetch=async function(input,init){try{const response=await nativeFetch(input,init);let u='';try{u=new URL(typeof input==='string'?input:input.url,location.href).href}catch{}const opaque=response&&(response.status===0||response.type==='opaque'||response.type==='opaqueredirect');if(!opaque&&!response.ok&&u&&!u.startsWith(BUS)){send({kind:'fetch-http-error',component:'frontend-network',message:'Fetch returned HTTP '+response.status,resource:clean(u),status:response.status,method:clean((init&&init.method)||'GET',12)});}return response;}catch(error){let u='';try{u=new URL(typeof input==='string'?input:input.url,location.href).href}catch{}if(!u.startsWith(BUS))send({kind:'fetch-network-error',component:'frontend-network',message:clean(error&&error.message||'Fetch failed'),resource:clean(u),method:clean((init&&init.method)||'GET',12),stack:clean(error&&error.stack,4000)});throw error;}}}
window.addEventListener('load',()=>setTimeout(healthy,15000),{once:true});
window.__CURATOR_REPORT_ERROR__=(message,details={})=>send({kind:'manual-client-error',component:clean(details.component||'frontend-manual',100),message:clean(message),...details});
})();`;

  return new Response(script, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff'
    }
  });
}
