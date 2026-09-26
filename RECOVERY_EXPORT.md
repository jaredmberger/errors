# Error Bus Recovery Export

The Error Bus provides a complete, read-only backup of the shared `CURATOR_ERROR_RECORDS` Cloudflare KV namespace at:

`GET /api/recovery-export`

## Security

Because this namespace contains operational incidents, observations, heartbeats, and shared monitoring state, the export requires a dedicated Worker secret:

`RECOVERY_EXPORT_TOKEN`

Send it in:

`X-Curator-Recovery-Key: <RECOVERY_EXPORT_TOKEN>`

If the secret is absent, the endpoint returns 503 and remains disabled.

## Scope

The exporter paginates the entire shared namespace and preserves every key/value pair exactly as stored.

Known categories include:

- `incident:*`
- `event:*`
- `heartbeat:*`
- `observation:*`
- `maintenance:*`

Unknown/shared future keys are also included. This matters because `CURATOR_ERROR_RECORDS` is used by more than one CuratorOS monitoring component.

Each backup includes total key count, category counts, namespace identity, export timestamp, and SHA-256 integrity metadata.

## Validation

```bash
npm run recovery:validate -- /path/to/error-bus-recovery-....json
```

The validator checks backup format, duplicate keys, count agreement, and SHA-256 integrity.

## iPad / iPhone backup

Use Shortcuts:

1. Get Contents of URL
2. URL: `https://errors.oceanliners.net/api/recovery-export`
3. Method: GET
4. Header: `X-Curator-Recovery-Key` = the configured recovery token
5. Save File

Keep the resulting JSON outside GitHub and outside Cloudflare.

## Restore policy

There is intentionally no production restore endpoint.

Any restore must first target an explicitly named disposable KV namespace and verify the complete keyset before any production decision is made.
