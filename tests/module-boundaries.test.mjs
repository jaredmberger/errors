import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('browser telemetry owns script-specific policy', async () => {
  const source = await readFile(new URL('../src/browser-telemetry.js', import.meta.url), 'utf8');
  assert.match(source, /javascript-error/);
  assert.match(source, /unhandled-rejection/);
  assert.match(source, /ESCALATION_OCCURRENCES = 4/);
  assert.match(source, /ESCALATION_DISTINCT_CLIENTS = 2/);
  assert.match(source, /client-script-triage/);
});

test('recovery module owns full-state export', async () => {
  const source = await readFile(new URL('../src/recovery.js', import.meta.url), 'utf8');
  assert.match(source, /RECOVERY_EXPORT_TOKEN/);
  assert.match(source, /CURATOR_ERROR_RECORDS/);
  assert.match(source, /curator-error-bus-kv-recovery/);
  assert.match(source, /list_complete/);
  assert.match(source, /dataSha256/);
});

test('production entrypoint is orchestration-sized', async () => {
  const source = await readFile(new URL('../src/error-bus.js', import.meta.url), 'utf8');
  const lines = source.split('\n').length;
  assert.ok(lines < 100, `Expected orchestration entrypoint under 100 lines, found ${lines}`);
});
