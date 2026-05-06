# ADB Pre-check Runbook

Operator playbook for the `adb-precheck` plugin. Endpoints assume the local
Dispatch service on `http://127.0.0.1:7890`.

## Health checks

- `curl http://127.0.0.1:7890/api/v1/plugins/adb-precheck/health` — 200 + JSON status
- `curl http://127.0.0.1:7890/api/v1/plugins/adb-precheck/admin/locks` — list of `scan:<pasta>` and `note.pasta_summary:<pasta>` locks held now
- `curl 'http://127.0.0.1:7890/api/v1/plugins/adb-precheck/admin/probe-snapshots?since=2026-05-06'` — recent unknown UI snapshots persisted to disk

## Trigger a manual sweep

When deals from earlier scans still have phones with `outcome='error'`, kick the manual sweep entrypoint:

```bash
curl -X POST http://127.0.0.1:7890/api/v1/plugins/adb-precheck/retry-errors \
  -H 'content-type: application/json' \
  -d '{"pasta":"15516752-A"}'
```

Optional body fields: `since_iso` (default 7d ago), `max_deals` (default 200), `dry_run` (default false).

The endpoint returns 202 with `{ job_id, deals_planned, status }`. Poll
`/api/v1/plugins/adb-precheck/scan/<job_id>` for progress; the response
includes `retry_stats`, `ui_state_distribution`, and `snapshots_captured`.

## Inspect note revision history for a pasta

```bash
curl http://127.0.0.1:7890/api/v1/plugins/adb-precheck/notes/15516752-A/history | jq .
```

Each revision shows `verb` (POST or PUT), `revises_row_id` (linking the chain),
`triggered_by` (manual scan vs sweep), and `pipedrive_response_id`.

## SQL dashboards (against `dispatch.db`)

### Retry-level save rate (last 7 days)

```sql
SELECT attempt_phase, result, COUNT(*) AS n, ROUND(AVG(latency_ms)) AS avg_ms
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day')
GROUP BY attempt_phase, result
ORDER BY attempt_phase, result;
```

Read: how often `probe_recover` (Level 1) and `scan_retry` (Level 2) save phones from `error`.

### UI states leaking as inconclusive

```sql
SELECT json_extract(evidence,'$.ui_state') AS state,
       COUNT(*) AS hits,
       SUM(CASE WHEN result = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive_n
FROM wa_contact_checks
WHERE checked_at > datetime('now','-7 day') AND source='adb_probe'
GROUP BY state
ORDER BY hits DESC;
```

Read: which UI states the classifier sees most. A high `inconclusive_n` for any
named state means the classifier's recovery rule is misfiring — open the
snapshot calibration playbook.

### Pastas with the most lingering errors

```sql
SELECT pasta, COUNT(*) AS deals_with_errors
FROM adb_precheck_deals
WHERE phones_json LIKE '%"outcome":"error"%'
  AND scanned_at > datetime('now','-7 day')
GROUP BY pasta
ORDER BY deals_with_errors DESC
LIMIT 20;
```

Read: pastas that need a sweep run.

### Sweep lineage

```sql
SELECT j.id AS sweep_job, j.created_at, j.parent_job_id, j.triggered_by
FROM adb_precheck_jobs j
WHERE j.triggered_by = 'retry-errors-sweep'
ORDER BY j.created_at DESC
LIMIT 50;
```

Read: history of sweep jobs and which parent jobs they recovered.

## When a scan returns 409 `scan_in_progress`

Another scan or sweep already holds the `scan:<pasta>` lock for that pasta
(or `scan:all` for unfiltered scans). The 409 response body carries the
current holder's metadata:

```json
{
  "error": "scan_in_progress",
  "pasta": "15516752-A",
  "current": {
    "key": "scan:15516752-A",
    "fenceToken": 17,
    "acquiredAt": "...",
    "expiresAt": "...",
    "context": { "job_id": "...", "pasta": "..." }
  }
}
```

Options:
1. Wait for the current job to finish (the lock TTL is 1h max).
2. Cancel the current job: `POST /api/v1/plugins/adb-precheck/scan/<id>/cancel`.
3. If the lock looks stale (no real job running), wait 5 minutes — the
   periodic reaper clears expired rows automatically; `/admin/locks` will
   show it disappear.

## E2E smoke test

`./scripts/e2e-precheck-scale.sh 15516752-A 100` runs a scan, polls status,
and prints the final stats + note revision + locks + recent snapshots.

Use this to validate a deployment after upgrading.
