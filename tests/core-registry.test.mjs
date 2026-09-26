import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import core from '../src/core-registry.js';
import legacy from '../src/entry.js';

function makeStore(initial={}){
  const values=new Map(Object.entries(initial));
  return {
    async list({prefix=''}={}){
      const keys=[...values.keys()].filter(k=>k.startsWith(prefix)).sort().map(name=>({name}));
      return {keys,list_complete:true,cursor:''};
    },
    async get(key,type){
      if(!values.has(key))return null;
      const raw=values.get(key);
      if(type==='json')return JSON.parse(raw);
      return raw;
    },
    async put(key,value){values.set(key,value);}
  };
}

test('legacy entry is only a compatibility shim', async()=>{
  const source=await readFile(new URL('../src/entry.js',import.meta.url),'utf8');
  assert.match(source,/export \{ default \} from '\.\/core-registry\.js'/);
  assert.ok(source.split('\n').length < 10);
});

test('legacy shim and core registry export the same worker object',()=>{
  assert.equal(legacy,core);
});

test('core registry still serves healthy empty status',async()=>{
  const env={CURATOR_ERROR_RECORDS:makeStore()};
  const response=await core.fetch(new Request('https://errors.test/api/status'),env,{waitUntil(){}});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.status,'healthy');
  assert.equal(body.activeIncidentCount,0);
});

test('core registry report and heartbeat APIs preserve key families',async()=>{
  const store=makeStore();
  const env={CURATOR_ERROR_RECORDS:store,ERROR_REPORT_KEY:'secret'};
  const headers={'content-type':'application/json','x-curator-error-key':'secret'};

  const incidentResponse=await core.fetch(new Request('https://errors.test/api/report',{
    method:'POST',headers,body:JSON.stringify({source:'Test Service',component:'worker',severity:'p1',type:'test-failure',message:'Synthetic failure'})
  }),env,{waitUntil(){}});
  assert.equal(incidentResponse.status,201);
  const incidentBody=await incidentResponse.json();
  assert.equal(incidentBody.incident.status,'active');
  assert.equal(incidentBody.incident.severity,'p1');

  const heartbeatResponse=await core.fetch(new Request('https://errors.test/api/heartbeat',{
    method:'POST',headers,body:JSON.stringify({source:'Test Service',component:'scheduled-monitor',status:'ok',maxAgeMinutes:60})
  }),env,{waitUntil(){}});
  assert.equal(heartbeatResponse.status,200);
  const heartbeatBody=await heartbeatResponse.json();
  assert.equal(heartbeatBody.heartbeat.status,'ok');

  const incidentList=await store.list({prefix:'incident:'});
  const heartbeatList=await store.list({prefix:'heartbeat:'});
  assert.equal(incidentList.keys.length,1);
  assert.equal(heartbeatList.keys.length,1);
});
