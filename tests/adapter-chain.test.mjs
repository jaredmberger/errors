import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const files = {
  manual: '../src/manual-recheck.js',
  ops: '../src/hardware-ops.js',
  incidents: '../src/hardware-incidents.js',
  exclusion: '../src/console-exclusion.js',
  top: '../src/top-errors.js'
};

test('manual recheck owns active incident verification endpoint', async () => {
  const source = await readFile(new URL(files.manual, import.meta.url), 'utf8');
  assert.match(source, /\/api\/recheck-active/);
  assert.match(source, /hardware-recheck:lock:v1/);
  assert.match(source, /MAX_PER_PASS = 12/);
  assert.match(source, /hardware-recheck-recovery/);
});

test('hardware ops owns heartbeat, console, and liveness adapters', async () => {
  const source = await readFile(new URL(files.ops, import.meta.url), 'utf8');
  assert.match(source, /opsProbe/);
  assert.match(source, /\/api\/hardware-console/);
  assert.match(source, /\/api\/heartbeat/);
  assert.match(source, /maxAgeMinutes, 3, 10080, 180/);
  assert.match(source, /import base from '\.\/manual-recheck\.js'/);
});

test('hardware incidents owns compact incident feed', async () => {
  const source = await readFile(new URL(files.incidents, import.meta.url), 'utf8');
  assert.match(source, /\/api\/hardware\/incidents/);
  assert.match(source, /import base from '\.\/hardware-ops\.js'/);
});

test('console exclusion owns intentionally unmonitored physical console behavior', async () => {
  const source = await readFile(new URL(files.exclusion, import.meta.url), 'utf8');
  assert.match(source, /CuratorOS Mini Console/);
  assert.match(source, /monitoring-disabled/);
  assert.match(source, /intentionally excluded from staleness monitoring/);
  assert.match(source, /import base from '\.\/hardware-incidents\.js'/);
});

test('top errors owns current incident-occurrence analytics and bypasses v1.27', async () => {
  const source = await readFile(new URL(files.top, import.meta.url), 'utf8');
  assert.match(source, /metric: 'incident-occurrences'/);
  assert.match(source, /import base from '\.\/console-exclusion\.js'/);
  assert.doesNotMatch(source, /entry-v1\.27\.js/);
});

test('network observations import top-errors directly', async () => {
  const source = await readFile(new URL('../src/client-network-observations.js', import.meta.url), 'utf8');
  assert.match(source, /import base from '\.\/top-errors\.js'/);
  assert.doesNotMatch(source, /entry-v1\.28\.js/);
});

test('legacy numbered adapter files are compatibility shims', async () => {
  for (const [name,target] of [
    ['entry-v1.23.js','manual-recheck.js'],
    ['entry-v1.24.js','hardware-ops.js'],
    ['entry-v1.25.js','hardware-incidents.js'],
    ['entry-v1.26.js','console-exclusion.js'],
    ['entry-v1.28.js','top-errors.js']
  ]) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length < 6, `${name} should remain a tiny shim`);
  }
});
