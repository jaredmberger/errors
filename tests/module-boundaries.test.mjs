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


test('verification recovery owns bounded Curator Verify cleanup policy', async () => {
  const source = await readFile(new URL('../src/verification-recovery.js', import.meta.url), 'utf8');
  assert.match(source, /VERIFY_COOLDOWN_MS/);
  assert.match(source, /MAX_PER_PASS/);
  assert.match(source, /verify-assisted-recovery/);
  assert.match(source, /browserHealthConfirmed/);
});


test('runtime info owns the current deployment metadata endpoint', async () => {
  const source = await readFile(new URL('../src/runtime-info.js', import.meta.url), 'utf8');
  assert.match(source, /BUILD_META/);
  assert.match(source, /CF_VERSION_METADATA/);
  assert.match(source, /\/api\/runtime/);
  assert.match(source, /cloudflare-workers/);
});


test('named adapter modules own manual, hardware, and analytics surfaces', async () => {
  const manual = await readFile(new URL('../src/manual-recheck.js', import.meta.url), 'utf8');
  const ops = await readFile(new URL('../src/hardware-ops.js', import.meta.url), 'utf8');
  const incidents = await readFile(new URL('../src/hardware-incidents.js', import.meta.url), 'utf8');
  const exclusion = await readFile(new URL('../src/console-exclusion.js', import.meta.url), 'utf8');
  const top = await readFile(new URL('../src/top-errors.js', import.meta.url), 'utf8');
  assert.match(manual, /\/api\/recheck-active/);
  assert.match(ops, /opsProbe/);
  assert.match(incidents, /\/api\/hardware\/incidents/);
  assert.match(exclusion, /monitoring-disabled/);
  assert.match(top, /incident-occurrences/);
});


test('client network observations own low-confidence fetch telemetry', async () => {
  const source = await readFile(new URL('../src/client-network-observations.js', import.meta.url), 'utf8');
  assert.match(source, /observation:client-network:/);
  assert.match(source, /fetch-network-error/);
  assert.match(source, /escalated: false/);
});


test('named clear-recheck modules own manual reset and shortcut surfaces', async () => {
  const base = await readFile(new URL('../src/clear-recheck-base.js', import.meta.url), 'utf8');
  const browserAware = await readFile(new URL('../src/clear-recheck-browser-aware.js', import.meta.url), 'utf8');
  const cors = await readFile(new URL('../src/clear-recheck-cors.js', import.meta.url), 'utf8');
  const shortcut = await readFile(new URL('../src/shortcut-recheck.js', import.meta.url), 'utf8');
  assert.match(base, /\/api\/clear-recheck/);
  assert.match(browserAware, /browser-recurrence-required/);
  assert.match(cors, /tools\.oceanliners\.net/);
  assert.match(shortcut, /\/api\/clear-reset/);
});
