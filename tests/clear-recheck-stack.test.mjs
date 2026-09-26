import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('clear-recheck base owns archival and authoritative recheck behavior', async () => {
  const source = await readFile(new URL('../src/clear-recheck-base.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/clear-recheck/);
  assert.match(source, /manual-clear-recheck/);
  assert.match(source, /restoreConfirmedIncident/);
});

test('browser-aware layer preserves recurrence-only browser policy', async () => {
  const source = await readFile(new URL('../src/clear-recheck-browser-aware.js', import.meta.url), 'utf8');
  assert.match(source, /browser-recurrence-required/);
  assert.match(source, /manual-clear-recheck-browser-aware/);
  assert.match(source, /import base from '\.\/clear-recheck-base\.js'/);
});

test('CORS layer preserves tools origin restriction', async () => {
  const source = await readFile(new URL('../src/clear-recheck-cors.js', import.meta.url), 'utf8');
  assert.match(source, /https:\/\/tools\.oceanliners\.net/);
  assert.match(source, /access-control-allow-origin/);
  assert.match(source, /import base from '\.\/clear-recheck-browser-aware\.js'/);
});

test('shortcut layer preserves authenticated aliases', async () => {
  const source = await readFile(new URL('../src/shortcut-recheck.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/clear-reset/);
  assert.match(source, /\/api\/shortcut\/clear-recheck/);
  assert.match(source, /ERROR_REPORT_KEY/);
  assert.match(source, /x-curator-error-key/);
  assert.match(source, /import base from '\.\/clear-recheck-cors\.js'/);
});

test('watchdog imports shortcut module directly', async () => {
  const source = await readFile(new URL('../src/public-site-watchdog.js', import.meta.url), 'utf8');
  assert.match(source, /import base from '\.\/shortcut-recheck\.js'/);
  assert.doesNotMatch(source, /entry-v1\.13\.js/);
});

test('v1.10-v1.13 are compatibility shims', async () => {
  const pairs = [
    ['entry-v1.10.js','clear-recheck-base.js'],
    ['entry-v1.11.js','clear-recheck-browser-aware.js'],
    ['entry-v1.12.js','clear-recheck-cors.js'],
    ['entry-v1.13.js','shortcut-recheck.js']
  ];
  for (const [name,target] of pairs) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length < 6);
  }
});
