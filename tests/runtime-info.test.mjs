import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import runtimeInfo from '../src/runtime-info.js';
import legacy from '../src/entry-v1.22.js';

test('v1.22 is only a compatibility shim',async()=>{
  const source=await readFile(new URL('../src/entry-v1.22.js',import.meta.url),'utf8');
  assert.match(source,/export \{ default \} from '\.\/runtime-info\.js'/);
  assert.ok(source.split('\n').length < 6);
});

test('legacy v1.22 shim exports runtime module',()=>{
  assert.equal(legacy,runtimeInfo);
});

test('runtime module owns current build and Cloudflare metadata payload',async()=>{
  const response=await runtimeInfo.fetch(
    new Request('https://errors.test/api/runtime'),
    {CF_VERSION_METADATA:{id:'version-id',tag:'production',timestamp:'2026-09-26T00:00:00Z'}},
    {}
  );
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.service,'CuratorOS Error Bus');
  assert.equal(body.version,'1.22.0');
  assert.equal(body.repository,'jaredmberger/errors');
  assert.equal(body.runtime,'cloudflare-workers');
  assert.ok(body.build);
  assert.equal(body.cloudflareVersion.id,'version-id');
  assert.equal(body.cloudflareVersion.tag,'production');
});

test('runtime module bypasses historical v1.21 wrapper',async()=>{
  const source=await readFile(new URL('../src/runtime-info.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/verification-recovery\.js'/);
  assert.doesNotMatch(source,/entry-v1\.21\.js/);
});

test('manual recheck imports named runtime module directly',async()=>{
  const source=await readFile(new URL('../src/manual-recheck.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/runtime-info\.js'/);
  assert.doesNotMatch(source,/entry-v1\.22\.js/);
});
