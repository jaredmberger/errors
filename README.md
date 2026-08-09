# CuratorOS Error Bus

Central infrastructure incident registry for the CuratorOS ecosystem.

Production domain: `https://errors.oceanliners.net`

## Storage

Cloudflare KV binding:

- Binding: `CURATOR_ERROR_RECORDS`
- Namespace: `447306da3a754b44830d2ac8608322c0`

## Core behavior

The Error Bus provides:

- persistent incident records
- deduplication by stable fingerprint
- occurrence counts and first/last seen timestamps
- automatic recovery history
- heartbeat/staleness detection
- P0 / P1 / P2 infrastructure severity
- a read-only Curator Intelligence adapter

Infrastructure incidents are intended to outrank ordinary optimization findings in Curator Intelligence.

## Reporting pattern

Cloudflare Workers in the CuratorOS ecosystem should bind the shared `CURATOR_ERROR_RECORDS` namespace and write directly through the standard `error-bus.js` helper pattern. Direct KV reporting avoids creating a network dependency on the error-reporting system itself.

Scheduled components should:

1. run the actual scheduled operation
2. call `reportSystemSuccess(...)` only after the operation truly succeeds
3. call `reportSystemError(...)` when it fails
4. set `maxAgeMinutes` to a reasonable interval greater than the normal schedule

The Error Bus hourly evaluator treats an established heartbeat that exceeds its `maxAgeMinutes` as a P1 `heartbeat-stale` incident. A component is not considered stale until it has successfully published at least one heartbeat.

Request-driven Pages Functions may report uncaught failures through middleware and recover the matching route incident after a later successful request. They should not publish artificial cadence heartbeats unless the route is expected to execute on a defined schedule.

## API

Read-only endpoints:

- `GET /`
- `GET /api/status`
- `GET /api/incidents`
- `GET /api/incidents?active=0`
- `GET /api/heartbeats`
- `GET /api/curator-intelligence`
- `GET /api/curator-intelligence?callback=...`

Optional network write endpoints:

- `POST /api/report`
- `POST /api/recover`
- `POST /api/heartbeat`

Network writes require the `ERROR_REPORT_KEY` Worker secret in the Error Bus and the matching `x-curator-error-key` request header. If that secret is not configured, network writes are intentionally disabled. Current CuratorOS Workers use direct KV reporting and do not require this secret.

## Severity

- **P0** — system-critical failure; highest priority
- **P1** — degraded or failed infrastructure component
- **P2** — lower-risk system/data-quality warning

Do not use the Error Bus for ordinary editorial, SEO, or content findings. Those remain specialist intelligence signals.
