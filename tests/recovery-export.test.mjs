import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/entry-v1.31.js';

function makeStore(values){
  const keys=Object.keys(values).sort();
  return{
    async list({cursor}={}){
      if(!cursor)return{keys:keys.slice(0,2).map(name=>({name})),list_complete:keys.length<=2,cursor:'next'};
      return{keys:keys.slice(2).map(name=>({name})),list_complete:true,cursor:''};
    },
    async get(key,type){
      if(type==='text')return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null;
      if(type==='json')return Object.prototype.hasOwnProperty.call(values,key)?JSON.parse(values[key]):null;
      return Object.prototype.hasOwnProperty.call(values,key)?values[key]:null;
    },
    async put(){}
  };
}

test('recovery export is disabled without RECOVERY_EXPORT_TOKEN',async()=>{
  const response=await worker.fetch(new Request('https://example.test/api/recovery-export'),{CURATOR_ERROR_RECORDS:makeStore({})},{});
  assert.equal(response.status,503);
});

test('recovery export rejects wrong token',async()=>{
  const response=await worker.fetch(new Request('https://example.test/api/recovery-export',{headers:{'x-curator-recovery-key':'wrong'}}),{
    RECOVERY_EXPORT_TOKEN:'right',
    CURATOR_ERROR_RECORDS:makeStore({})
  },{});
  assert.equal(response.status,401);
});

test('recovery export paginates the complete shared namespace',async()=>{
  const values={
    'incident:test':JSON.stringify({id:'test',status:'active'}),
    'event:2026:test':JSON.stringify({kind:'test'}),
    'heartbeat:ops':JSON.stringify({service:'ops'}),
    'observation:client-script:test':JSON.stringify({fingerprint:'test'}),
    'maintenance:migration':JSON.stringify({completed:true}),
    'shared:future-key':'plain-text-value'
  };
  const response=await worker.fetch(new Request('https://example.test/api/recovery-export',{headers:{'x-curator-recovery-key':'secret'}}),{
    RECOVERY_EXPORT_TOKEN:'secret',
    CURATOR_ERROR_RECORDS:makeStore(values)
  },{});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.format,'curator-error-bus-kv-recovery');
  assert.equal(body.summary.keyCount,6);
  assert.equal(body.summary.categories.incidents,1);
  assert.equal(body.summary.categories.events,1);
  assert.equal(body.summary.categories.heartbeats,1);
  assert.equal(body.summary.categories.observations,1);
  assert.equal(body.summary.categories.maintenance,1);
  assert.equal(body.summary.categories.other,1);
  assert.deepEqual(body.data.entries.map(x=>x.key),Object.keys(values).sort());
  assert.match(body.integrity.dataSha256,/^[a-f0-9]{64}$/);
});
