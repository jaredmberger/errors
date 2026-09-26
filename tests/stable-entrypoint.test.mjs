import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

test('production uses the stable Error Bus entrypoint', async () => {
  const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(wrangler, /main\s*=\s*"src\/error-bus\.js"/);
  assert.doesNotMatch(wrangler, /main\s*=\s*"src\/entry-v1\.\d+\.js"/);
});

test('stable entry preserves the hardened v1.31 behavior boundary', async () => {
  const source = await readFile(new URL('../src/error-bus.js', import.meta.url), 'utf8');
  assert.match(source, /import base from '\.\/entry-v1\.29\.js'/);
  assert.match(source, /\/api\/recovery-export/);
  assert.match(source, /\/api\/client-script-observations/);
  assert.match(source, /fetch-network-error|client-script/);
  assert.doesNotMatch(source, /entry-v1\.30\.js/);
});

test('versioned wrapper chain is frozen', async () => {
  const files = await readdir(new URL('../src/', import.meta.url));
  const newer = files.filter(name => {
    const match = name.match(/^entry-v1\.(\d+)\.js$/);
    return match && Number(match[1]) > 31;
  });
  assert.deepEqual(newer, [], 'Do not add new entry-v1.xx wrappers; edit src/error-bus.js or extracted modules instead.');
});
