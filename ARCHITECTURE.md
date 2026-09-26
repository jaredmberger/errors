# Error Bus Source Architecture

## Stable production entrypoint

Production now starts at:

`src/error-bus.js`

`wrangler.toml` must point to that stable file.

The historical `entry-v1.x.js` files are a compatibility implementation chain. They record how the Error Bus evolved, but they are no longer the naming convention for new production changes.

## Rule for future changes

Do **not** add `entry-v1.32.js`, `entry-v1.33.js`, and so on.

For a small change, edit `src/error-bus.js`.

For a substantial concern, extract a named module such as:

- `src/incidents.js`
- `src/heartbeats.js`
- `src/browser-telemetry.js`
- `src/public-site-watchdog.js`
- `src/recovery.js`

and import it from `src/error-bus.js`.

This lets the historical chain shrink gradually without forcing a risky all-at-once rewrite of proven incident behavior.

## Current compatibility boundary

The stable entry currently inherits from `entry-v1.29.js` for the remaining compatibility chain. Hardened browser-script policy now lives in `src/browser-telemetry.js`, and full-state recovery export lives in `src/recovery.js`.

It intentionally skips `entry-v1.30.js`, matching the production behavior before this refactor.

## Why this is simpler

Before this change, every significant feature tended to create another versioned wrapper and production was named after the latest historical layer. That made the implementation harder to reason about and encouraged indefinite chain growth.

Now:

- production has one permanent entrypoint name
- the version-wrapper chain is frozen
- new work has an obvious home
- behavior can be extracted into named modules incrementally
- deployment configuration no longer changes merely because a feature changes

The historical files can be retired progressively as their responsibilities are extracted and covered by focused tests.

## Current named modules

- `src/browser-telemetry.js` — browser script observations, corroboration thresholds, P2 triage creation, recurrence refresh, and the one-time legacy script-incident migration.
- `src/recovery.js` — authenticated complete-KV recovery export and integrity metadata.
- `src/core-registry.js` — foundational incident registry, recovery writes, heartbeat storage/evaluation, status/intelligence adapters, and the legacy root console.
- `src/entry.js` — tiny compatibility shim that re-exports `core-registry.js` for historical wrappers.
- `src/public-site-watchdog.js` — cross-zone public-site availability monitoring, visitor-evidence veto, Curator Verify confirmation, P0 outage creation/recovery, and triage-aware status/intelligence views.
- `src/entry-v1.19.js` — compatibility shim for the former watchdog layer; the live v1.20 layer imports `public-site-watchdog.js` directly.
- `src/verification-recovery.js` — bounded Curator Verify-assisted recovery for active public-site and browser incidents, including cooldown gates and browser-health confirmation.
- `src/entry-v1.20.js` — compatibility shim for the former verification-assisted recovery layer; v1.21 imports `verification-recovery.js` directly.
- `src/runtime-info.js` — current `/api/runtime` response with build metadata and Cloudflare version metadata; imports `verification-recovery.js` directly.
- `src/entry-v1.22.js` — compatibility shim for the former runtime/build metadata layer; v1.23 imports `runtime-info.js` directly.
- `src/entry-v1.21.js` — retained historical reference only; no longer part of the live runtime path.
- `src/error-bus.js` — thin production router/orchestrator.

The core incident/heartbeat layer, public-site watchdog, verification-assisted recovery layer, and runtime/build metadata endpoint are now extracted. The next preferred targets are the remaining manual-recheck, hardware-console, health, and analytics/adaptor wrappers.
