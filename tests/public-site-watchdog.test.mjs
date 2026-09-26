import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import watchdog from '../src/public-site-watchdog.js';
import legacy from '../src/entry-v1.19.js';

test('v1.19 is only a compatibility shim',async()=>{
  const source=await readFile(new URL('../src/entry-v1.19.js',import.meta.url),'utf8');
  assert.match(source,/export \{ default \} from '\.\/public-site-watchdog\.js'/);
  assert.ok(source.split('\n').length < 6);
});

test('legacy v1.19 shim exports the watchdog worker',()=>{
  assert.equal(legacy,watchdog);
});

test('watchdog module preserves public-site availability policy',async()=>{
  const source=await readFile(new URL('../src/public-site-watchdog.js',import.meta.url),'utf8');
  assert.match(source,/availability:public-site-v4/);
  assert.match(source,/FAILURE_OBSERVATIONS = 3/);
  assert.match(source,/RECOVERY_OBSERVATIONS = 2/);
  assert.match(source,/MIN_GAP_MS = 45 \* 1000/);
  assert.match(source,/VISITOR_EVIDENCE_WINDOW_MS = 5 \* 60 \* 1000/);
  assert.match(source,/verify\.oceanlinercurator\.com\/api\/verify/);
  assert.match(source,/\/api\/out-of-band-probe/);
  assert.match(source,/public-site-offline/);
});

test('verification layer imports named watchdog module directly',async()=>{
  const source=await readFile(new URL('../src/verification-recovery.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/public-site-watchdog\.js'/);
  assert.doesNotMatch(source,/entry-v1\.19\.js/);
});
