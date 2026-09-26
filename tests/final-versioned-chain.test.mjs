import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const namedModules = [
  'client-monitoring-base.js',
  'console-dashboard.js',
  'console-check-now-ui.js',
  'client-reporter-filter.js',
  'quiet-client-recovery.js',
  'client-reporter.js',
  'resource-confirmation.js',
  'incident-verification.js',
  'generic-rejection-cleanup.js',
  'clear-recheck-base.js',
  'clear-recheck-browser-aware.js',
  'clear-recheck-cors.js',
  'shortcut-recheck.js',
  'public-site-watchdog.js',
  'verification-recovery.js',
  'runtime-info.js',
  'manual-recheck.js',
  'hardware-ops.js',
  'hardware-incidents.js',
  'console-exclusion.js',
  'top-errors.js',
  'client-network-observations.js',
  'browser-telemetry.js',
  'recovery.js',
  'error-bus.js'
];

test('named production modules do not import versioned entry wrappers', async () => {
  for (const name of namedModules) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\/entry-v1\.\d+\.js['"]/, `${name} still imports a versioned wrapper`);
  }
});

test('v1.1-v1.9 are compatibility shims only', async () => {
  const mapping = [
    ['entry-v1.1.js','client-monitoring-base.js'],
    ['entry-v1.2.js','console-dashboard.js'],
    ['entry-v1.3.js','console-check-now-ui.js'],
    ['entry-v1.4.js','client-reporter-filter.js'],
    ['entry-v1.5.js','quiet-client-recovery.js'],
    ['entry-v1.6.js','client-reporter.js'],
    ['entry-v1.7.js','resource-confirmation.js'],
    ['entry-v1.8.js','incident-verification.js'],
    ['entry-v1.9.js','generic-rejection-cleanup.js']
  ];

  for (const [name,target] of mapping) {
    const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`export \\{ default \\} from '\\.\\/${target.replace('.', '\\.')}';`));
    assert.ok(source.split('\n').length < 6, `${name} should remain a tiny compatibility shim`);
  }
});

test('final named chain preserves core pre-watchdog responsibilities', async () => {
  const base = await readFile(new URL('../src/client-monitoring-base.js', import.meta.url), 'utf8');
  const consoleUi = await readFile(new URL('../src/console-dashboard.js', import.meta.url), 'utf8');
  const checkUi = await readFile(new URL('../src/console-check-now-ui.js', import.meta.url), 'utf8');
  const reporter = await readFile(new URL('../src/client-reporter.js', import.meta.url), 'utf8');
  const verification = await readFile(new URL('../src/incident-verification.js', import.meta.url), 'utf8');
  const rejection = await readFile(new URL('../src/generic-rejection-cleanup.js', import.meta.url), 'utf8');

  assert.match(base, /\/api\/public-site-probe/);
  assert.match(base, /\/api\/client-health/);
  assert.match(consoleUi, /CuratorOS infrastructure/);
  assert.match(checkUi, /Check Now/);
  assert.match(reporter, /client-reporter\.js/);
  assert.match(verification, /environmental-noise/);
  assert.match(rejection, /unproven one-off browser promise rejection/);
});

test('no new versioned wrapper above v1.31 exists', async () => {
  const files = await readdir(new URL('../src/', import.meta.url));
  const newer = files.filter(name => {
    const match = name.match(/^entry-v1\.(\d+)\.js$/);
    return match && Number(match[1]) > 31;
  });
  assert.deepEqual(newer, []);
});
