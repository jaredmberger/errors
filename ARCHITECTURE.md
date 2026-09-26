# Error Bus Source Architecture

## Stable production entrypoint

Production now starts at:

`src/error-bus.js`

`wrangler.toml` must point to that stable file.

The historical `entry-v1.x.js` files are now compatibility/history shims rather than part of the production import chain. They record how the Error Bus evolved, but named modules own live behavior.

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

Production modules no longer import any numbered `entry-v1.x.js` wrapper. The numbered files remain only as tiny compatibility shims or retained historical references. The stable entrypoint remains `src/error-bus.js`, and named modules own all live routing and behavior.

`entry-v1.30.js` remains intentionally superseded and is not part of production.

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
- `src/manual-recheck.js` — manual active-incident recheck endpoint and hardware-console recovery workflow.
- `src/hardware-ops.js` — lightweight Ops liveness probe, hardware heartbeat handling, hardware-console status, and current runtime payload override.
- `src/hardware-incidents.js` — compact read-only incident feed for physical Error Bus displays.
- `src/console-exclusion.js` — intentional exclusion policy for the unmonitored CuratorOS Mini Console.
- `src/top-errors.js` — current incident-occurrence analytics endpoint; supersedes the old event-scan v1.27 implementation.
- `src/entry-v1.23.js`, `entry-v1.24.js`, `entry-v1.25.js`, `entry-v1.26.js`, and `entry-v1.28.js` — compatibility shims only.
- `src/entry-v1.27.js` — historical superseded analytics implementation; no longer part of the live runtime path.
- `src/client-network-observations.js` — low-confidence browser fetch/network telemetry, observation feed, and one-time migration of legacy network incidents.
- `src/entry-v1.29.js` — compatibility shim for the former client-network observation layer.
- `src/clear-recheck-base.js` — authoritative Clear & Recheck archival/revalidation behavior.
- `src/clear-recheck-browser-aware.js` — browser-aware Clear & Recheck semantics that require browser recurrence rather than synthetic re-promotion.
- `src/clear-recheck-cors.js` — Tools-origin CORS wrapper for Clear & Recheck.
- `src/shortcut-recheck.js` — authenticated Shortcut aliases for reset/recheck.
- `src/entry-v1.10.js` through `entry-v1.13.js` — compatibility shims only.
- `src/error-bus.js` — thin production router/orchestrator.

The final v1.1-v1.9 stack is now extracted into named modules as well. There are no live numbered-wrapper dependencies left in production.


## Final pre-watchdog modules

- `src/client-monitoring-base.js` — client ingestion/health, public-site infrastructure probes, immediate check, and client recovery evaluation.
- `src/console-dashboard.js` — Error Bus HTML dashboard and incident grouping/navigation.
- `src/console-check-now-ui.js` — dashboard Check Now controls.
- `src/client-reporter-filter.js` — opaque HTTP-0 suppression and reporter compatibility behavior.
- `src/quiet-client-recovery.js` — quiet-window client recovery verification.
- `src/client-reporter.js` — current browser reporter script.
- `src/resource-confirmation.js` — server-side confirmation for first-party resource/network reports.
- `src/incident-verification.js` — transient/provisional browser noise verification and environmental-noise cleanup.
- `src/generic-rejection-cleanup.js` — one-off generic unhandled-rejection cleanup.

The numbered v1.1-v1.9 files are compatibility shims to those modules.
