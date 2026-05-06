#!/bin/bash
# E2E driver: starts a precheck scan over up to N deals of a pasta, polls until
# completion, prints retry stats and the resulting note revision.
#
# Usage: ./scripts/e2e-precheck-scale.sh <pasta> <max_deals>
# Defaults: pasta=15516752-A max_deals=100
# Env vars:
#   BASE_URL      — base API URL, defaults to http://127.0.0.1:7890
#   POLL_INTERVAL — seconds between status polls, defaults to 5
set -euo pipefail

PASTA="${1:-15516752-A}"
MAX="${2:-100}"
BASE="${BASE_URL:-http://127.0.0.1:7890}"
POLL="${POLL_INTERVAL:-5}"

echo "=== Starting scan: pasta=$PASTA max_deals=$MAX base=$BASE ==="
JOB_ID=$(curl -fsS -X POST "$BASE/api/v1/plugins/adb-precheck/scan" \
  -H 'content-type: application/json' \
  -d "{\"pasta_filter\":\"$PASTA\",\"max_deals\":$MAX}" \
  | jq -r .job_id)

if [ -z "$JOB_ID" ] || [ "$JOB_ID" = "null" ]; then
  echo "ERROR: failed to start scan (no job_id returned)" >&2
  exit 1
fi
echo "Job id: $JOB_ID"

echo "=== Polling status every ${POLL}s until completion ==="
while true; do
  STATUS=$(curl -fsS "$BASE/api/v1/plugins/adb-precheck/scan/$JOB_ID" | jq -r .status)
  echo "  status=$STATUS"
  case "$STATUS" in
    completed|failed|cancelled) break ;;
  esac
  sleep "$POLL"
done

echo
echo "=== Final job summary (retry_stats / ui_state_distribution / snapshots_captured) ==="
curl -fsS "$BASE/api/v1/plugins/adb-precheck/scan/$JOB_ID" \
  | jq '{status, retry_stats, ui_state_distribution, snapshots_captured}'

echo
echo "=== Note revision history for pasta $PASTA ==="
curl -fsS "$BASE/api/v1/plugins/adb-precheck/notes/$PASTA/history" | jq .

echo
echo "=== Active pasta locks (should be empty post-scan) ==="
curl -fsS "$BASE/api/v1/plugins/adb-precheck/admin/locks" | jq .

echo
echo "=== Recent probe snapshots (today) ==="
TODAY=$(date -u +%Y-%m-%d)
curl -fsS "$BASE/api/v1/plugins/adb-precheck/admin/probe-snapshots?since=$TODAY" \
  | jq --arg today "$TODAY" '.snapshots | length as $n | { since: $today, count: $n, sample: .[:3] }'

echo
echo "=== Done. Job: $JOB_ID ==="
