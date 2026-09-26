# CuratorOS Error Bus

Central infrastructure incident registry and evidence-driven monitoring layer for the CuratorOS ecosystem.

Production domain: `https://errors.oceanliners.net`

## Production runtime

Current production entrypoint:

- `src/error-bus.js`

The historical `entry-v1.x.js` chain remains temporarily as a compatibility implementation beneath the stable entrypoint, but the version-wrapper pattern is frozen. Browser script telemetry, recovery export, the foundational incident/heartbeat registry, the public-site watchdog, verification-assisted recovery, runtime/build metadata, manual recheck, hardware adapters, console exclusion, and top-error analytics are now extracted into named modules. `src/entry.js` is reduced to a compatibility shim and `src/error-bus.js` remains a thin router/orchestrator. Future simplification should continue by extracting responsibilities from the compatibility chain rather than adding numbered wrappers. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

The stable entry preserves the hardened v1.31 behavior boundary and deliberately continues to bypass v1.30's superseded client-script escalation layer.

## Storage

Cloudflare KV binding:

- Binding: `CURATOR_ERROR_RECORDS`
- Namespace: `447306da3a754b44830d2ac8608322c0`

## Operating standard

The Error Bus is for infrastructure and operational reliability signals, not ordinary editorial, SEO, content, or optimization findings.

The system favors corroboration over alarm:

- isolated browser failures are observations, not incidents
- repeated browser script failures must recur within a bounded window and across more than one hashed client signature before they can create an incident
- browser telemetry alone creates only a P2 triage incident
- browser-originated incidents are not allowed to become high-confidence priorities without recheck or corroborating system evidence
- public-site outage escalation requires repeated failed observations and independent confirmation
- successful visitor evidence can veto a false public-site outage claim
- active incidents recover from positive health evidence, not merely because a later observation falls below an escalation threshold

## Core behavior

The Error Bus provides:

- persistent incident records
- deduplication by stable fingerprint
- occurrence counts and first/last seen timestamps
- recovery history
- heartbeat/staleness detection
- browser observation feeds
- public-site cross-zone watchdog checks
- independent verification before P0 public-site outage escalation
- P0 / P1 / P2 infrastructure severity
- Curator Intelligence and hardware-console adapters
- top-error analytics

## Severity

- **P0** — independently confirmed system-critical failure, including verified public-site unavailability
- **P1** — degraded or failed infrastructure component supported by operational evidence
- **P2** — lower-risk system warning or triage incident that warrants review but is not yet a high-confidence outage
- **Observation** — low-confidence telemetry retained for pattern detection but not counted as an operational incident

Do not use the Error Bus for ordinary editorial, SEO, or content findings. Those remain specialist intelligence signals.

## Browser telemetry policy

### Client network failures

Single-browser `fetch-network-error` reports are stored as observations. They do not directly create operational incidents because local connectivity, browser state, extensions, VPNs, and transient routing can produce misleading failures.

### Client script failures

JavaScript errors and unhandled promise rejections use an observation-first policy.

A script pattern becomes escalation-eligible only when it reaches:

- 4 occurrences
- within 15 minutes
- across at least 2 distinct hashed client signatures

The client signature is derived from page path plus a normalized user-agent family and is stored only as a short hash.

Even after that threshold is met, browser telemetry alone creates a **P2 triage incident**, not a P1. A recheck or stronger system evidence is required before Curator Intelligence should treat it as a confirmed priority.

Once a script pattern is an active incident, later recurrences refresh the incident's `lastSeenAt` and occurrence count. A recurrence never counts as evidence of recovery.

Client incidents recover through the inherited positive-health policy after sufficient healthy observations and a quiet period without recurrence.

## Public-site availability

The public-site watchdog runs on the minutely cron and is intentionally separate from ordinary hourly housekeeping.

The availability policy requires:

1. repeated failed cross-zone observations
2. at least 3 failed observations before offline escalation
3. a minimum observation gap
4. recent successful visitor evidence to veto a false outage claim
5. independent Curator Verify confirmation before a P0 `public-site-offline` incident can be created

Recovery requires successful evidence rather than a single optimistic probe.

## Heartbeats

Scheduled components should:

1. run the actual scheduled operation
2. call `reportSystemSuccess(...)` only after the operation truly succeeds
3. call `reportSystemError(...)` when it fails
4. set `maxAgeMinutes` to a reasonable interval greater than the normal schedule

The Error Bus evaluator treats an established heartbeat that exceeds its `maxAgeMinutes` as a P1 `heartbeat-stale` incident. A component is not considered stale until it has successfully published at least one heartbeat.

Request-driven Pages Functions should not publish artificial cadence heartbeats unless the route is expected to execute on a defined schedule.

## Disaster recovery

The complete shared `CURATOR_ERROR_RECORDS` namespace can be exported through authenticated `GET /api/recovery-export`. Configure the Worker secret `RECOVERY_EXPORT_TOKEN`; the route remains disabled if the secret is absent. See [`RECOVERY_EXPORT.md`](RECOVERY_EXPORT.md) for backup and validation instructions.

## API

Read-only endpoints include:

- `GET /api/recovery-export` — authenticated full-KV recovery export; requires `X-Curator-Recovery-Key`

- `GET /`
- `GET /api/status`
- `GET /api/incidents`
- `GET /api/incidents?active=0`
- `GET /api/heartbeats`
- `GET /api/curator-intelligence`
- `GET /api/client-network-observations`
- `GET /api/client-script-observations`
- `GET /api/top-errors`
- `GET /api/runtime`
- `GET /api/hardware/incidents`
- `GET /api/hardware-console`

Operational endpoints include:

- `POST /api/report`
- `POST /api/recover`
- `POST /api/heartbeat`
- `POST /api/client-error`
- `POST /api/client-health`
- `POST /api/check-now`
- `POST /api/recheck-active`
- protected reset/recheck and watchdog endpoints used by CuratorOS

Network infrastructure writes require the appropriate Worker secrets. Browser telemetry endpoints are origin-restricted and intentionally treated as untrusted observation input.

## Top-error analytics

`GET /api/top-errors` ranks retained deduplicated incident counters for incidents whose most recent sighting falls inside the requested window.

Important: the occurrence count is the retained lifetime counter for that incident, not an exact count of events occurring only inside the selected window. Treat the endpoint as a ranking aid, not exact time-window event analytics.

## Scheduling

Current Worker cron triggers:

- `* * * * *` — public-site cross-zone watchdog plus the bounded verification-assisted noise check inherited from v1.20
- `47 * * * *` — ordinary Error Bus housekeeping and inherited maintenance

The minutely schedule is deliberately intercepted by the availability layer so the full hourly housekeeping chain does not run once per minute. One-time observation migrations may also execute after a release until their migration marker is written.
