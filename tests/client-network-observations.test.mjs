import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import network from '../src/client-network-observations.js';
import legacy from '../src/entry-v1.29.js';

test('v1.29 is only a compatibility shim',async()=>{
  const source=await readFile(new URL('../src/entry-v1.29.js',import.meta.url),'utf8');
  assert.match(source,/export \{ default \} from '\.\/client-network-observations\.js'/);
  assert.ok(source.split('\n').length < 6);
});

test('legacy v1.29 shim exports network observation module',()=>{
  assert.equal(legacy,network);
});

test('network observation module preserves observation-only policy',async()=>{
  const source=await readFile(new URL('../src/client-network-observations.js',import.meta.url),'utf8');
  assert.match(source,/observation:client-network:/);
  assert.match(source,/fetch-network-error/);
  assert.match(source,/classification: 'observation'/);
  assert.match(source,/escalated: false/);
  assert.match(source,/maintenance:client-network-observation-migration:v1/);
});

test('production no longer imports any entry-v1.2x wrapper',async()=>{
  const source=await readFile(new URL('../src/error-bus.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/client-network-observations\.js'/);
  assert.doesNotMatch(source,/entry-v1\.2\d\.js/);
});
