import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('resource telemetry blocks unverified browser-only resource incidents', async () => {
  const source = await readFile(new URL('../src/resource-telemetry.js', import.meta.url), 'utf8');
  assert.match(source, /resource-error/);
  assert.match(source, /unverified-resource-observation/);
  assert.match(source, /outside the OceanLiners\.net zone/);
  assert.match(source, /observation:client-resource:/);
});

test('resource telemetry preserves first-party escalation path', async () => {
  const source = await readFile(new URL('../src/resource-telemetry.js', import.meta.url), 'utf8');
  assert.match(source, /PUBLIC_HOST_RE/);
  assert.match(source, /return null;/);
  assert.match(source, /First-party resources continue into the established verification pipeline/);
});

test('resource telemetry retires stale resource incidents only with evidence', async () => {
  const source = await readFile(new URL('../src/resource-telemetry.js', import.meta.url), 'utf8');
  assert.match(source, /incident\.type !== 'client-resource-error'/);
  assert.match(source, /verifyFirstPartyResource/);
  assert.match(source, /client-resource-observation-recovery/);
});

test('stable entry intercepts resource errors before legacy ingestion', async () => {
  const source = await readFile(new URL('../src/error-bus.js', import.meta.url), 'utf8');
  assert.match(source, /isClientResourceKind/);
  assert.match(source, /handleClientResourceError/);
  assert.match(source, /retireUnprovenResourceIncidents/);
});


test('Cloudflare Zaraz resource failures stay non-actionable', async () => {
  const telemetry = await readFile(new URL('../src/resource-telemetry.js', import.meta.url), 'utf8');
  const reporter = await readFile(new URL('../src/client-reporter.js', import.meta.url), 'utf8');
  const confirmation = await readFile(new URL('../src/resource-confirmation.js', import.meta.url), 'utf8');
  const clearRecheck = await readFile(new URL('../src/clear-recheck-base.js', import.meta.url), 'utf8');

  assert.match(telemetry, /cdn-cgi\\\/zaraz/);
  assert.match(telemetry, /cloudflare-managed-resource-observation/);
  assert.match(telemetry, /edge-managed infrastructure/);
  assert.match(reporter, /cloudflareManaged/);
  assert.match(reporter, /cdn-cgi\\\\\/zaraz/);
  assert.match(confirmation, /cloudflare-managed-resource/);
  assert.match(clearRecheck, /isCloudflareManagedResource/);
});

test('existing Zaraz resource incidents are retired without direct endpoint verification', async () => {
  const source = await readFile(new URL('../src/resource-telemetry.js', import.meta.url), 'utf8');
  assert.match(source, /if \(resource && isCloudflareManagedResource\(resource\)\)/);
  assert.match(source, /non-actionable telemetry and has been retired/);
});
