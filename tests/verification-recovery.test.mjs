import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import verificationRecovery from '../src/verification-recovery.js';
import legacy from '../src/entry-v1.20.js';

test('v1.20 is only a compatibility shim',async()=>{
  const source=await readFile(new URL('../src/entry-v1.20.js',import.meta.url),'utf8');
  assert.match(source,/export \{ default \} from '\.\/verification-recovery\.js'/);
  assert.ok(source.split('\n').length < 6);
});

test('legacy v1.20 shim exports the verification recovery worker',()=>{
  assert.equal(legacy,verificationRecovery);
});

test('verification recovery module preserves bounded recovery policy',async()=>{
  const source=await readFile(new URL('../src/verification-recovery.js',import.meta.url),'utf8');
  assert.match(source,/verify-gate:/);
  assert.match(source,/VERIFY_COOLDOWN_MS = 5 \* 60 \* 1000/);
  assert.match(source,/MAX_PER_PASS = 12/);
  assert.match(source,/verify-assisted-recovery/);
  assert.match(source,/public-site-infrastructure-failure/);
  assert.match(source,/client-/);
  assert.match(source,/browserHealthConfirmed/);
});

test('runtime layer imports named verification recovery module directly',async()=>{
  const source=await readFile(new URL('../src/entry-v1.21.js',import.meta.url),'utf8');
  assert.match(source,/import base from '\.\/verification-recovery\.js'/);
  assert.doesNotMatch(source,/entry-v1\.20\.js/);
});
