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


test('core registry owns foundational incident and heartbeat behavior', async () => {
  const source = await readFile(new URL('../src/core-registry.js', import.meta.url), 'utf8');
  assert.match(source, /async function upsertIncident/);
  assert.match(source, /async function recoverIncident/);
  assert.match(source, /async function writeHeartbeat/);
  assert.match(source, /async function evaluateHeartbeats/);
  assert.match(source, /\/api\/status/);
  assert.match(source, /\/api\/incidents/);
  assert.match(source, /\/api\/heartbeats/);
});


test('public-site watchdog owns outage confirmation policy', async () => {
  const source = await readFile(new URL('../src/public-site-watchdog.js', import.meta.url), 'utf8');
  assert.match(source, /cross-zone-watchdog/);
  assert.match(source, /independent confirmation required|independentVerificationRequired|verifyRequiredForOffline/i);
  assert.match(source, /visitorEvidence/);
  assert.match(source, /public-site-offline/);
});
